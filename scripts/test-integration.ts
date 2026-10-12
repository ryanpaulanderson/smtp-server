/** Build and run the disposable Docker acceptance topology, always cleaning up. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const mode = process.argv[2] ?? "all";
if (!["all", "prepare", "run"].includes(mode))
  throw new Error("Unknown integration mode");
if (mode !== "all" && !process.env.TEST_COMPOSE_PROJECT) {
  throw new Error("Split prepare/run invocations require TEST_COMPOSE_PROJECT");
}
const project =
  process.env.TEST_COMPOSE_PROJECT ??
  `email-mcp-${process.pid}-${randomBytes(4).toString("hex")}`;
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))
  throw new Error("Invalid integration project name");
const compose = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "/dev/null",
  "-f",
  "compose.yaml",
];
let active: ReturnType<typeof spawn> | undefined;
let cancelled = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cancelled = true;
    active?.kill(signal);
  });
}

/** Run one Docker command with a deadline and inherited, secret-free output. */
async function run(args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [...compose, ...args], { stdio: "inherit" });
    active = child;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      active = undefined;
      if (code === 0) resolve();
      else reject(new Error(`Docker ${args[0]} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

console.log(`Disposable Compose project: ${project}`);
console.log(
  `Interrupted-run cleanup: docker ${compose.join(" ")} down --volumes --remove-orphans`,
);
try {
  await run(["config", "--quiet"], 10_000);
  if (mode !== "run") {
    await run(["pull", "postgres", "mailpit"], 180_000);
    if (cancelled) throw new Error("Integration run cancelled");
    // The two replicas and all fixture services share these two image tags.
    await run(["build", "app-a", "fixture-init"], 600_000);
    if (cancelled) throw new Error("Integration run cancelled");
  }
  if (mode !== "prepare") {
    const deadline = Date.now() + 600_000;
    await run(
      [
        "up",
        "--pull",
        "never",
        "--no-build",
        "--detach",
        "--wait",
        "--wait-timeout",
        "120",
        "app-a",
        "app-b",
      ],
      150_000,
    );
    if (cancelled) throw new Error("Integration run cancelled");
    await run(
      ["run", "--pull", "never", "--rm", "--no-deps", "test-runner"],
      Math.max(1, deadline - Date.now()),
    );
  }
} finally {
  await run(["down", "--volumes", "--remove-orphans", "--timeout", "5"], 60_000);
}
