/** Apply real migrations, then grant the fixture runtime role only required access. */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import pg from "pg";

const adminUrl = (await readFile("/fixtures/runner/database-admin-url", "utf8")).trim();
const runtimeUrl = new URL((await readFile("/fixtures/app/database-url", "utf8")).trim());
const result = spawnSync("pnpm", ["db:migrate"], {
  stdio: "inherit",
  timeout: 60_000,
  env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Database migration failed");
if (
  runtimeUrl.username !== "email_mcp_app" ||
  !/^[a-f0-9]{48}$/.test(runtimeUrl.password)
) {
  throw new Error("Unexpected fixture runtime credentials");
}
const client = new pg.Client({
  connectionString: adminUrl,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
});
try {
  await client.connect();
  await client.query(`CREATE ROLE email_mcp_app LOGIN PASSWORD '${runtimeUrl.password}'`);
  await client.query("GRANT CONNECT ON DATABASE email_mcp TO email_mcp_app");
  await client.query("GRANT USAGE ON SCHEMA email_mcp TO email_mcp_app");
  await client.query(
    "GRANT SELECT, INSERT, UPDATE ON email_mcp.send_attempts TO email_mcp_app",
  );
} finally {
  await client.end();
}
