/** PostgreSQL ownership, duplicate prevention, and bounded admission for mail. */
import { Pool, type PoolClient } from "pg";
import { z } from "zod";

import {
  MailError,
  type AdmissionLimits,
  type NewAttempt,
  type SendAttempt,
  type SendStore,
  type Submission,
} from "../mail/contracts";

const attemptSchema = z.object({
  owner: z.string().min(1),
  request_id: z.uuid(),
  digest_key_id: z.string().min(1),
  payload_digest: z.string().min(1),
  message_id: z.string().min(1),
  encryption_fingerprint: z.string().min(1),
  status: z.enum(["in_progress", "accepted", "rejected", "unknown"]),
  created_at: z.date(),
  active_until: z.date(),
  error_code: z.string().nullable(),
});

const limitsSchema = z.object({
  concurrent: z.number().int().positive(),
  perMinute: z.number().int().positive(),
  perDay: z.number().int().positive(),
  capacity: z.number().int().positive(),
  // The production function is killed after 60 seconds. A longer lease means
  // crashed workers cannot release capacity while their SMTP socket is alive.
  leaseMs: z.number().int().min(90_000).max(2_147_483_647),
});

const returningColumns = `owner, request_id, digest_key_id, payload_digest,
  message_id, encryption_fingerprint, status, created_at, active_until, error_code`;

/** Convert database values only after validating the external row boundary. */
function readAttempt(row: unknown): SendAttempt {
  const parsed = attemptSchema.parse(row);
  return {
    owner: parsed.owner,
    requestId: parsed.request_id,
    digest: { keyId: parsed.digest_key_id, value: parsed.payload_digest },
    messageId: parsed.message_id,
    fingerprint: parsed.encryption_fingerprint,
    status: parsed.status,
    createdAt: parsed.created_at,
    activeUntil: parsed.active_until,
    ...(parsed.error_code === null ? {} : { errorCode: parsed.error_code }),
  };
}

/** Preserve classified errors while keeping database messages out of public text. */
function databaseError(error: unknown): MailError {
  return error instanceof MailError
    ? error
    : new MailError("DATABASE_UNAVAILABLE", { cause: error });
}

/** Commit one unit of metadata work, always returning its connection to the pool. */
async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // An unusable connection must not re-enter the pool. Preserve the cause
      // of the operation rather than replacing it with a cleanup error.
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/**
 * Create a metadata store with bounded connections and database-clock leases.
 *
 * The caller owns the pool and must call close during controlled shutdown.
 * The caller must validate TLS policy in connectionString before construction;
 * this store passes that policy to pg without weakening certificate checks.
 * complete must be called only after the original SMTP transport is closed;
 * marking a request unknown while it can still send must retain its lease.
 * No operation creates or migrates database objects.
 */
export function createPostgresStore(
  connectionString: string,
  limits: AdmissionLimits,
): SendStore {
  const admission = limitsSchema.parse(limits);
  const pool = new Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    application_name: "encrypted-email-mcp",
  });
  // pg removes idle connections on background errors. A listener prevents a
  // disconnected idle socket from terminating the process; subsequent requests
  // obtain a new connection and still surface their own failures.
  pool.on("error", () => {
    console.warn(
      JSON.stringify({
        event: "database_idle_connection_error",
        code: "DATABASE_CONNECTION_LOST",
      }),
    );
  });

  return {
    async find(owner, requestId) {
      try {
        return await transaction(pool, async (client) => {
          await client.query(
            `UPDATE email_mcp.send_attempts
             SET status = 'unknown', error_code = 'ATTEMPT_EXPIRED',
                 updated_at = clock_timestamp()
             WHERE owner = $1 AND request_id = $2 AND status = 'in_progress'
               AND active_until <= clock_timestamp()`,
            [owner, requestId],
          );
          const result = await client.query<Record<string, unknown>>(
            `SELECT ${returningColumns} FROM email_mcp.send_attempts
             WHERE owner = $1 AND request_id = $2`,
            [owner, requestId],
          );
          return result.rows.length === 0 ? null : readAttempt(result.rows[0]);
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async reserve(input: NewAttempt) {
      try {
        return await transaction(pool, async (client) => {
          // The global lock protects total capacity and global SMTP slots;
          // the owner lock additionally defines the per-owner quota boundary.
          // All reservers acquire locks in this order to avoid deadlocks.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('email_mcp.admission', 0))",
          );
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
            input.owner,
          ]);
          await client.query(
            `UPDATE email_mcp.send_attempts
             SET status = 'unknown', error_code = 'ATTEMPT_EXPIRED',
                 updated_at = clock_timestamp()
             WHERE status = 'in_progress' AND active_until <= clock_timestamp()`,
          );
          const previous = await client.query<Record<string, unknown>>(
            `SELECT ${returningColumns} FROM email_mcp.send_attempts
             WHERE owner = $1 AND request_id = $2`,
            [input.owner, input.requestId],
          );
          if (previous.rows.length > 0) {
            return { created: false, attempt: readAttempt(previous.rows[0]) };
          }
          const counts = await client.query<Record<string, unknown>>(
            `WITH boundary AS (SELECT clock_timestamp() AS now)
             SELECT
               count(*)::text AS total,
               count(*) FILTER (WHERE status IN ('in_progress', 'unknown')
                 AND active_until > boundary.now)::text AS active,
               count(*) FILTER (WHERE owner = $1 AND
                 created_at > boundary.now - INTERVAL '1 minute')::text AS minute,
               count(*) FILTER (WHERE owner = $1 AND
                 created_at > boundary.now - INTERVAL '1 day')::text AS day
             FROM email_mcp.send_attempts CROSS JOIN boundary`,
            [input.owner],
          );
          const count = z
            .object({
              total: z.coerce.number().int().nonnegative(),
              active: z.coerce.number().int().nonnegative(),
              minute: z.coerce.number().int().nonnegative(),
              day: z.coerce.number().int().nonnegative(),
            })
            .parse(counts.rows[0]);
          if (count.total >= admission.capacity) {
            throw new MailError("CAPACITY_EXCEEDED");
          }
          if (count.active >= admission.concurrent) {
            throw new MailError("BUSY");
          }
          if (count.minute >= admission.perMinute || count.day >= admission.perDay) {
            throw new MailError("RATE_LIMITED");
          }
          const result = await client.query<Record<string, unknown>>(
            `INSERT INTO email_mcp.send_attempts
             (owner, request_id, digest_key_id, payload_digest, message_id,
              encryption_fingerprint, active_until)
             VALUES ($1, $2, $3, $4, $5, $6,
               clock_timestamp() + $7 * INTERVAL '1 millisecond')
             RETURNING ${returningColumns}`,
            [
              input.owner,
              input.requestId,
              input.digest.keyId,
              input.digest.value,
              input.messageId,
              input.fingerprint,
              admission.leaseMs,
            ],
          );
          return { created: true, attempt: readAttempt(result.rows[0]) };
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async complete(owner, requestId, result: Submission) {
      try {
        return await transaction(pool, async (client) => {
          const updated = await client.query<Record<string, unknown>>(
            `UPDATE email_mcp.send_attempts
             SET status = $3, error_code = $4, active_until = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE owner = $1 AND request_id = $2
               AND status IN ('in_progress', 'unknown')
             RETURNING ${returningColumns}`,
            [owner, requestId, result.status, result.errorCode ?? null],
          );
          if (updated.rows.length > 0) {
            return readAttempt(updated.rows[0]);
          }
          const existing = await client.query<Record<string, unknown>>(
            `SELECT ${returningColumns} FROM email_mcp.send_attempts
             WHERE owner = $1 AND request_id = $2`,
            [owner, requestId],
          );
          if (existing.rows.length === 0) {
            throw new MailError("ATTEMPT_NOT_FOUND");
          }
          // Accepted and rejected evidence is final. Duplicate or late writes
          // cannot replace it with a weaker or contradictory outcome.
          return readAttempt(existing.rows[0]);
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async close() {
      try {
        await pool.end();
      } catch (error) {
        throw databaseError(error);
      }
    },
  };
}
