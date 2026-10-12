/** Generate isolated, short-lived cryptographic fixtures into separate volumes. */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.FIXTURE_ROOT ?? "/fixtures";
const applicationUid = 65532;
const directories = ["app", "smtp", "auth", "postgres", "runner"];
for (const name of directories)
  mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "email-mcp-fixtures-"));

/** Write a fixture without exposing its contents in command output. */
function write(directory, name, contents) {
  const file = join(root, directory, name);
  writeFileSync(file, contents, { mode: 0o600 });
  if (directory === "app") chownSync(file, applicationUid, applicationUid);
}

/** Run a bounded crypto command, keeping private output out of the log. */
function command(program, args, input) {
  return execFileSync(program, args, {
    input,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

try {
  const caKey = join(scratch, "ca.key");
  const caCert = join(scratch, "ca.crt");
  command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "2",
    "-subj",
    "/CN=Disposable email MCP test CA",
  ]);
  for (const [directory, names] of [
    ["smtp", "DNS:mailpit,DNS:smtp-fault"],
    ["auth", "DNS:auth-fixture,DNS:localhost"],
  ]) {
    const key = join(root, directory, "server.key");
    const csr = join(scratch, `${directory}.csr`);
    const cert = join(root, directory, "server.crt");
    const extensions = join(scratch, `${directory}.ext`);
    writeFileSync(extensions, `subjectAltName=${names}\nextendedKeyUsage=serverAuth\n`);
    command("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${directory}`,
    ]);
    command("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "2",
      "-extfile",
      extensions,
    ]);
    chmodSync(key, 0o600);
  }
  for (const directory of ["app", "auth"]) {
    copyFileSync(caCert, join(root, directory, "ca.crt"));
  }

  const gpgHome = join(scratch, "gnupg");
  mkdirSync(gpgHome, { mode: 0o700 });
  const gpgArgs = [
    "--homedir",
    gpgHome,
    "--batch",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
  ];
  command("gpg", [
    ...gpgArgs,
    "--quick-generate-key",
    "Test Recipient <recipient@localhost>",
    "ed25519",
    "cert,sign",
    "1d",
  ]);
  const listing = command("gpg", [...gpgArgs, "--with-colons", "--list-keys"]).toString(
    "utf8",
  );
  const fingerprint = listing
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];
  if (!fingerprint)
    throw new Error("Fixture generation did not produce a PGP fingerprint");
  command("gpg", [
    ...gpgArgs,
    "--quick-add-key",
    fingerprint,
    "cv25519",
    "encrypt",
    "1d",
  ]);
  write(
    "app",
    "recipient-public.asc",
    command("gpg", [...gpgArgs, "--armor", "--export", fingerprint]),
  );
  write("app", "recipient-fingerprint", fingerprint);
  write(
    "runner",
    "recipient-private.asc",
    command("gpg", [...gpgArgs, "--armor", "--export-secret-keys", fingerprint]),
  );

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyMetadata = { kid: "disposable-test-key", alg: "RS256", use: "sig" };
  write(
    "runner",
    "jwt-private.jwk",
    JSON.stringify({ ...privateKey.export({ format: "jwk" }), ...keyMetadata }),
  );
  write(
    "auth",
    "jwks.json",
    JSON.stringify({
      keys: [{ ...publicKey.export({ format: "jwk" }), ...keyMetadata }],
    }),
  );

  const smtpPassword = randomBytes(24).toString("hex");
  const adminPassword = randomBytes(24).toString("hex");
  const runtimePassword = randomBytes(24).toString("hex");
  write("app", "smtp-password", smtpPassword);
  write(
    "smtp",
    "auth",
    `test-user:${command("openssl", ["passwd", "-6", "-stdin"], `${smtpPassword}\n`).toString("utf8").trim()}\n`,
  );
  write("postgres", "password", adminPassword);
  write(
    "app",
    "database-url",
    `postgresql://email_mcp_app:${runtimePassword}@postgres:5432/email_mcp`,
  );
  write(
    "runner",
    "database-admin-url",
    `postgresql://postgres:${adminPassword}@postgres:5432/email_mcp`,
  );
  write(
    "app",
    "hmac-keys.json",
    JSON.stringify({ v1: randomBytes(32).toString("base64url") }),
  );
  chownSync(join(root, "app"), applicationUid, applicationUid);
  chmodSync(join(root, "app"), 0o700);
  console.log(
    "Generated isolated test fixtures; private material is restricted to dedicated volumes.",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
