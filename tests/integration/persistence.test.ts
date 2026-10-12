/** Exercise production metadata persistence against an isolated PostgreSQL DB. */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AdmissionLimits, NewAttempt, SendStore } from "../../src/mail/contracts.js";
import { createPostgresStore } from "../../src/persistence/postgres-store.js";

const execute = promisify(execFile);
const limits: AdmissionLimits = {
  concurrent: 2,
  perMinute: 10,
  perDay: 100,
  capacity: 1000,
  leaseMs: 90_000,
};

/** New metadata-only request; payloads never enter this persistence boundary. */
function attempt(owner = "integration-owner"): NewAttempt {
  const requestId = randomUUID();
  return {
    owner,
    requestId,
    digest: { keyId: "v1:test", value: randomBytes(32).toString("hex") },
    messageId: `<${requestId}@localhost>`,
    fingerprint: "A".repeat(40),
  };
}

// Integration selection must explicitly supply a disposable administrative
// database. Missing configuration fails setup instead of quietly skipping tests.
describe("PostgreSQL send store", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `email_mcp_test_${suffix}`;
  const runtimeRole = `email_mcp_role_${suffix}`;
  const runtimePassword = randomBytes(24).toString("hex");
  let databaseUrl: string;
  let runtimeUrl: string;
  let admin: Client;
  let cluster: Client;
  const stores: SendStore[] = [];

  /** Create independent bounded pools while sharing the isolated database. */
  function store(overrides: Partial<AdmissionLimits> = {}): SendStore {
    const created = createPostgresStore(runtimeUrl, { ...limits, ...overrides });
    stores.push(created);
    return created;
  }

  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL_FILE
      ? (await readFile(process.env.TEST_DATABASE_URL_FILE, "utf8")).trim()
      : process.env.TEST_DATABASE_URL;
    if (!adminUrl) {
      throw new Error("TEST_DATABASE_URL must point to disposable PostgreSQL");
    }
    cluster = new Client({ connectionString: adminUrl });
    await cluster.connect();
    // Identifiers contain only a fixed prefix and generated hexadecimal text.
    await cluster.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: databaseUrl,
        DATABASE_ADMIN_URL_FILE: "",
      },
      timeout: 40_000,
    });
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA email_mcp TO ${runtimeRole}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON email_mcp.send_attempts TO ${runtimeRole}`,
    );
    await admin.query("CREATE SCHEMA wedding_private");
    await admin.query("CREATE TABLE wedding_private.guests (name text NOT NULL)");
    url.username = runtimeRole;
    url.password = runtimePassword;
    runtimeUrl = url.toString();
  }, 50_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE email_mcp.send_attempts");
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((entry) => entry.close()));
  });

  afterAll(async () => {
    await admin?.end();
    if (cluster) {
      await cluster.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await cluster.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await cluster.end();
    }
  });

  it("reserves metadata using database time and returns the same attempt on reuse", async () => {
    const requests = store();
    const input = attempt();
    const first = await requests.reserve(input);
    const reused = await requests.reserve({
      ...input,
      digest: { keyId: "different", value: "different" },
    });
    expect(first.created).toBe(true);
    expect(first.attempt.status).toBe("in_progress");
    expect(
      first.attempt.activeUntil.getTime() - first.attempt.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(89_999);
    expect(reused).toEqual({ created: false, attempt: first.attempt });
    expect(await requests.find(input.owner, input.requestId)).toEqual(first.attempt);
    expect(await requests.find("another-owner", input.requestId)).toBeNull();
  });

  it("allows only one reservation for concurrent repeated requests across pools", async () => {
    const firstStore = store();
    const secondStore = store();
    const input = attempt();
    const results = await Promise.all([
      firstStore.reserve(input),
      secondStore.reserve(input),
      firstStore.reserve(input),
      secondStore.reserve(input),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.attempt.messageId)).size).toBe(1);
  });

  it("enforces admission atomically for distinct simultaneous requests", async () => {
    const firstStore = store({ concurrent: 1 });
    const secondStore = store({ concurrent: 1 });
    const results = await Promise.allSettled([
      firstStore.reserve(attempt("one")),
      secondStore.reserve(attempt("two")),
      firstStore.reserve(attempt("three")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "BUSY" });
      }
    }
  });

  it("scopes the same request ID independently to its authenticated owner", async () => {
    const requests = store();
    const input = attempt("one");
    const first = await requests.reserve(input);
    const second = await requests.reserve({ ...input, owner: "two" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.attempt.owner).toBe("two");
  });

  it("enforces global concurrency across owners and releases only completed slots", async () => {
    const firstStore = store();
    const secondStore = store();
    const first = attempt("one");
    const second = attempt("two");
    await firstStore.reserve(first);
    await secondStore.reserve(second);
    await expect(firstStore.reserve(attempt("three"))).rejects.toMatchObject({
      code: "BUSY",
    });
    await firstStore.complete(first.owner, first.requestId, { status: "accepted" });
    expect((await secondStore.reserve(attempt("three"))).created).toBe(true);
  });

  it("counts claims toward rolling quotas and does not charge repeated request IDs", async () => {
    const requests = store({ perMinute: 1 });
    const input = attempt();
    await requests.reserve(input);
    await requests.complete(input.owner, input.requestId, {
      status: "rejected",
      errorCode: "SMTP_REJECTED",
    });
    expect((await requests.reserve(input)).created).toBe(false);
    await expect(requests.reserve(attempt())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await admin.query(
      "UPDATE email_mcp.send_attempts SET created_at = clock_timestamp() - INTERVAL '61 seconds'",
    );
    expect((await requests.reserve(attempt())).created).toBe(true);
  });

  it("enforces the rolling day quota after the minute window has passed", async () => {
    const requests = store({ perDay: 1 });
    const input = attempt();
    await requests.reserve(input);
    await requests.complete(input.owner, input.requestId, { status: "unknown" });
    await admin.query(
      "UPDATE email_mcp.send_attempts SET created_at = clock_timestamp() - INTERVAL '1 hour'",
    );
    await expect(requests.reserve(attempt())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await admin.query(
      "UPDATE email_mcp.send_attempts SET created_at = clock_timestamp() - INTERVAL '25 hours'",
    );
    expect((await requests.reserve(attempt())).created).toBe(true);
  });

  it("retains duplicate history and rejects capacity overflow instead of deleting records", async () => {
    const requests = store({ capacity: 1 });
    const input = attempt();
    await requests.reserve(input);
    await requests.complete(input.owner, input.requestId, { status: "accepted" });
    await expect(requests.reserve(attempt())).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
    expect((await requests.reserve(input)).created).toBe(false);
  });

  it("expires abandoned work to unknown without retrying and permits a late original result", async () => {
    const requests = store();
    const input = attempt();
    await requests.reserve(input);
    await admin.query(
      "UPDATE email_mcp.send_attempts SET active_until = clock_timestamp() - INTERVAL '1 second'",
    );
    expect(await requests.find(input.owner, input.requestId)).toMatchObject({
      status: "unknown",
      errorCode: "ATTEMPT_EXPIRED",
    });
    expect((await requests.reserve(input)).created).toBe(false);
    expect(
      await requests.complete(input.owner, input.requestId, { status: "accepted" }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await requests.complete(input.owner, input.requestId, { status: "unknown" }),
    ).toMatchObject({ status: "accepted" });
  });

  it("never replaces terminal evidence or completes another owner's request", async () => {
    const requests = store();
    const input = attempt();
    await requests.reserve(input);
    await requests.complete(input.owner, input.requestId, {
      status: "rejected",
      errorCode: "SMTP_REJECTED",
    });
    expect(
      await requests.complete(input.owner, input.requestId, { status: "accepted" }),
    ).toMatchObject({
      status: "rejected",
      errorCode: "SMTP_REJECTED",
    });
    await expect(
      requests.complete("someone-else", input.requestId, { status: "accepted" }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
  });

  it("limits runtime privileges to metadata and excludes content fields", async () => {
    const runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    try {
      await expect(
        runtime.query("SELECT * FROM wedding_private.guests"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("SELECT * FROM email_mcp.schema_migrations"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("DROP TABLE email_mcp.send_attempts"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("DELETE FROM email_mcp.send_attempts"),
      ).rejects.toMatchObject({ code: "42501" });
      const result = await runtime.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'email_mcp' AND table_name = 'send_attempts'",
      );
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).not.toEqual(expect.arrayContaining(["body"]));
      expect(columns).not.toEqual(expect.arrayContaining(["title"]));
      expect(columns).not.toEqual(expect.arrayContaining(["subject"]));
      expect(columns).not.toEqual(expect.arrayContaining(["ciphertext"]));
    } finally {
      await runtime.end();
    }
  });

  it("runs committed migrations idempotently and requires an explicit admin URL", async () => {
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: databaseUrl,
        DATABASE_ADMIN_URL_FILE: "",
      },
      timeout: 40_000,
    });
    const history = await admin.query("SELECT filename FROM email_mcp.schema_migrations");
    expect(history.rows).toHaveLength(1);
    await expect(
      execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_ADMIN_URL: "", DATABASE_ADMIN_URL_FILE: "" },
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("rejects edited migration history without applying further changes", async () => {
    const sql = await readFile("migrations/001_send_attempts.sql", "utf8");
    const originalChecksum = createHash("sha256").update(sql).digest("hex");
    await admin.query("UPDATE email_mcp.schema_migrations SET sha256 = $1", [
      "0".repeat(64),
    ]);
    try {
      await expect(
        execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
          env: {
            ...process.env,
            DATABASE_ADMIN_URL: databaseUrl,
            DATABASE_ADMIN_URL_FILE: "",
          },
          timeout: 40_000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("MIGRATION_CHECKSUM_MISMATCH"),
      });
    } finally {
      await admin.query("UPDATE email_mcp.schema_migrations SET sha256 = $1", [
        originalChecksum,
      ]);
    }
  });

  it("returns safe database errors while preserving their diagnostic cause", async () => {
    const requests = store();
    await admin.query(`REVOKE SELECT ON email_mcp.send_attempts FROM ${runtimeRole}`);
    try {
      await expect(requests.find("owner", randomUUID())).rejects.toMatchObject({
        message: "DATABASE_UNAVAILABLE",
        code: "DATABASE_UNAVAILABLE",
        cause: expect.any(Error),
      });
    } finally {
      await admin.query(`GRANT SELECT ON email_mcp.send_attempts TO ${runtimeRole}`);
    }
  });
});
