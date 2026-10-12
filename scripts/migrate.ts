/** Explicit administrative migration entry point; never imported by the app. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { z } from "zod";

/** An operator-safe diagnostic whose cause may contain private connection data. */
class MigrationError extends Error {
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "MigrationError";
  }
}

/** Read only explicitly supplied administrative configuration, never app credentials. */
async function administrativeUrl(): Promise<string> {
  const direct = process.env.DATABASE_ADMIN_URL;
  const file = process.env.DATABASE_ADMIN_URL_FILE;
  if (direct && file) {
    throw new MigrationError("DATABASE_ADMIN_CONFIGURATION_AMBIGUOUS");
  }
  const value = file ? (await readFile(file, "utf8")).trim() : direct;
  if (!value) {
    throw new MigrationError("DATABASE_ADMIN_CONFIGURATION_REQUIRED");
  }
  return value;
}

/** Apply immutable SQL files atomically using a dedicated admin connection. */
async function migrate(): Promise<void> {
  const connectionString = await administrativeUrl();
  const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  if (filenames.length === 0) {
    throw new MigrationError("MIGRATION_FILES_REQUIRED");
  }
  if (filenames.some((filename) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(filename))) {
    throw new MigrationError("MIGRATION_FILENAME_INVALID");
  }
  const sequenceIds = filenames.map((filename) => filename.slice(0, 3));
  if (new Set(sequenceIds).size !== sequenceIds.length) {
    throw new MigrationError("MIGRATION_SEQUENCE_DUPLICATED");
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 31_000,
    application_name: "encrypted-email-mcp-migrations",
  });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('email_mcp.migrations', 0))",
    );
    await client.query("CREATE SCHEMA IF NOT EXISTS email_mcp");
    await client.query(`CREATE TABLE IF NOT EXISTS email_mcp.schema_migrations (
      filename text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await client.query("REVOKE ALL ON email_mcp.schema_migrations FROM PUBLIC");
    const applied = await client.query<Record<string, unknown>>(
      "SELECT filename, sha256 FROM email_mcp.schema_migrations ORDER BY filename",
    );
    const appliedSchema = z.object({ filename: z.string(), sha256: z.string() });
    const history = new Map(
      applied.rows.map((row) => {
        const entry = appliedSchema.parse(row);
        return [entry.filename, entry.sha256];
      }),
    );
    if ([...history.keys()].some((filename) => !filenames.includes(filename))) {
      throw new MigrationError("MIGRATION_HISTORY_FILE_MISSING");
    }
    const appliedFilenames: string[] = [];
    for (const filename of filenames) {
      const sql = await readFile(
        new URL(`../migrations/${filename}`, import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previousChecksum = history.get(filename);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) {
          throw new MigrationError("MIGRATION_CHECKSUM_MISMATCH");
        }
        continue;
      }
      if ([...history.keys()].some((appliedFile) => appliedFile > filename)) {
        throw new MigrationError("MIGRATION_HISTORY_REORDERED");
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO email_mcp.schema_migrations (filename, sha256) VALUES ($1, $2)",
        [filename, checksum],
      );
      appliedFilenames.push(filename);
    }
    await client.query("COMMIT");
    for (const filename of appliedFilenames) {
      process.stdout.write(`Applied ${filename}\n`);
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The client is closed below even if the connection failed or was lost.
    }
    throw error instanceof MigrationError
      ? error
      : new MigrationError("DATABASE_MIGRATION_FAILED", { cause: error });
  } finally {
    await client.end();
  }
}

try {
  await migrate();
} catch (error) {
  // Upstream database errors may contain connection details. Keep this CLI's
  // failure safe even when CI captures all output.
  const code =
    error instanceof MigrationError ? error.message : "DATABASE_MIGRATION_FAILED";
  process.stderr.write(
    `${code}: check administrative configuration and immutable migration history.\n`,
  );
  process.exitCode = 1;
}
