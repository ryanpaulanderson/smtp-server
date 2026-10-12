/** Check authored documentation and the validation workflow's static contracts. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { lint as lintMarkdown } from "markdownlint/sync";
import { parse } from "yaml";

/** Narrow untrusted YAML objects before inspecting their configuration. */
function mapping(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a configuration mapping");
  }
  return value as Record<string, unknown>;
}

/** Enumerate documentation files without traversing generated dependencies. */
function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(path)
      : extname(path) === ".md"
        ? [path]
        : [];
  });
}

/** Fail on a missing in-repository Markdown link target. */
function checkLinks(file: string, text: string): void {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim().replace(/^<|>$/g, "").split(/\s+"/)[0];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const pathname = decodeURIComponent(target.split("#")[0] ?? "");
    const destination = resolve(dirname(file), pathname);
    if (!destination.startsWith(`${process.cwd()}/`) || !existsSync(destination)) {
      throw new Error(`${file}: missing or out-of-repository link target ${target}`);
    }
  }
}

/** Check the supported simple flowcharts; rendering remains a manual visual check. */
function checkDiagrams(file: string, text: string): void {
  for (const block of text.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)) {
    const lines = (block[1] ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!/^flowchart (LR|RL|TB|TD|BT)$/.test(lines.shift() ?? "")) {
      throw new Error(`${file}: unsupported Mermaid diagram declaration`);
    }
    const declared = new Set<string>();
    let subgraphs = 0;
    for (const line of lines) {
      const declaration = /^([A-Za-z]\w*)\["[^"\n]+"\]$/.exec(line);
      if (declaration?.[1]) declared.add(declaration[1]);
      else if (/^subgraph [A-Za-z]\w*\["[^"\n]+"\]$/.test(line)) subgraphs += 1;
      else if (line === "end" && subgraphs > 0) subgraphs -= 1;
      else if (
        !/^[A-Za-z]\w*\s+(?:-->|<-->|---)(?:\|"[^"\n]+"\|)?\s+[A-Za-z]\w*$/.test(line)
      ) {
        throw new Error(`${file}: unsupported or malformed Mermaid flowchart line`);
      }
    }
    if (subgraphs !== 0) throw new Error(`${file}: unterminated Mermaid subgraph`);
    for (const line of lines.filter((line) => !line.includes("[") && line !== "end")) {
      const source = line.split(/\s+/)[0];
      const destination = line.split(/\s+/).at(-1);
      if (
        !source ||
        !destination ||
        !declared.has(source) ||
        !declared.has(destination)
      ) {
        throw new Error(`${file}: Mermaid edge references an undeclared node`);
      }
    }
  }
}

/** Run a documented validation command, preserving its failure status. */
function check(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} validation failed`);
}

const documentation = ["README.md", ...markdownFiles("docs")];
for (const file of documentation) {
  const text = readFileSync(file, "utf8");
  checkLinks(file, text);
  checkDiagrams(file, text);
}
const markdownResults = lintMarkdown({
  files: documentation,
  config: { MD013: false, MD060: false },
});
if (Object.values(markdownResults).some((errors) => errors.length > 0)) {
  throw new Error(markdownResults.toString());
}
const workflowText = readFileSync(".github/workflows/ci.yml", "utf8");
const workflow: unknown = parse(workflowText);
const jobs = mapping(mapping(workflow).jobs);
for (const job of Object.values(jobs)) {
  const steps: unknown = mapping(job).steps;
  if (!Array.isArray(steps)) throw new Error("A workflow job must declare its steps");
  for (const step of steps) {
    const uses = mapping(step).uses;
    if (typeof uses === "string" && !/^[-\w./]+@[a-f0-9]{40}$/.test(uses)) {
      throw new Error(`Workflow action must use a full commit pin: ${uses}`);
    }
  }
}
const required = mapping(jobs.required);
if (
  required.if !== "always()" ||
  JSON.stringify(required.needs) !==
    JSON.stringify(["quality", "unit", "integration", "dependency-audit"])
) {
  throw new Error("The required job must always aggregate all four validation jobs");
}
const compose: unknown = parse(readFileSync("compose.yaml", "utf8"), { merge: true });
const networks = mapping(mapping(compose).networks);
if (mapping(networks.test).internal !== true)
  throw new Error("Integration network must be internal");
for (const [name, service] of Object.entries(mapping(mapping(compose).services))) {
  const config = mapping(service);
  if (config.profiles === undefined && JSON.stringify(config.networks) !== '["test"]') {
    throw new Error(`Runtime service must use only the isolated test network: ${name}`);
  }
  if (config.ports !== undefined)
    throw new Error(`Base Compose service must not publish ports: ${name}`);
  if (
    typeof config.image === "string" &&
    !config.build &&
    !/@sha256:[a-f0-9]{64}$/.test(config.image)
  ) {
    throw new Error(`External service image must be digest-pinned: ${name}`);
  }
}
const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
const engines = mapping(mapping(manifest).engines);
const dockerfile = readFileSync("Dockerfile", "utf8");
const buildNodeMajor = dockerfile.match(/^FROM node:(\d+)\./m)?.[1];
const runtimeNodeMajor = dockerfile.match(
  /^FROM gcr\.io\/distroless\/nodejs(\d+)-debian\d+:nonroot@sha256:[a-f0-9]{64} AS production$/m,
)?.[1];
if (
  !buildNodeMajor ||
  runtimeNodeMajor !== buildNodeMajor ||
  engines.node !== `>=${buildNodeMajor} <${Number(buildNodeMajor) + 1}`
) {
  throw new Error(
    "Build and runtime Node majors must match the supported package engine",
  );
}
check("docker", [
  "compose",
  "--env-file",
  "/dev/null",
  "-f",
  "compose.yaml",
  "config",
  "--quiet",
]);
check("docker", [
  "compose",
  "--env-file",
  "/dev/null",
  "-f",
  "compose.yaml",
  "--profile",
  "tools",
  "run",
  "--rm",
  "--no-deps",
  "workflow-lint",
]);
console.log(
  "Documentation links, simple flowcharts, Compose contracts, and workflow syntax passed.",
);
