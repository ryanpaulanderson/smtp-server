/** Run acceptance tests with fixture credentials confined to this process tree. */
import { spawn } from "node:child_process";

const child = spawn("pnpm", ["test:integration:run"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MCP_RESOURCE_URL: "http://app-a:3000/mcp",
    OAUTH_ISSUER_URL: "https://auth-fixture:8443",
    OWNER_SUBJECT: "test-owner",
  },
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
