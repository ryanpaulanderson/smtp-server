import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importJWK, SignJWT } from "jose";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The full suite intentionally requires disposable Docker fixture configuration. */
function setting(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing integration fixture ${name}; run pnpm test:integration`);
  return value;
}

const endpoints = setting("TEST_MCP_URLS").split(",");
const primary = endpoints[0];
const secondary = endpoints[1];
if (!primary || !secondary) throw new Error("Two app replicas are required");
const mailpit = setting("TEST_MAILPIT_URL");
const keySchema = z
  .object({ kty: z.string(), kid: z.string(), alg: z.string() })
  .passthrough();
const keyData = keySchema.parse(
  JSON.parse(readFileSync(setting("TEST_JWT_PRIVATE_KEY_FILE"), "utf8")),
);
const signingKey = await importJWK(keyData, "RS256");
const resultSchema = z.object({
  request_id: z.uuid(),
  status: z.enum(["accepted", "rejected", "unknown", "in_progress", "not_found"]),
  message_id: z.string().optional(),
});
const messageList = z.object({
  messages: z.array(z.object({ ID: z.string(), MessageID: z.string() })),
});
const clients: Client[] = [];
let clientA: Client;
let clientB: Client;
let gpgHome: string;

/** Sign a real OAuth test token; only the HTTPS fixture publishes its public key. */
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: "test-owner",
    iss: "https://auth-fixture:8443",
    aud: primary,
    scope: "email:send:self email:status:self",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyData.kid })
    .sign(signingKey);
}

async function connect(endpoint: string, accessToken?: string): Promise<Client> {
  const client = new Client({ name: "integration-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken ?? (await token())}` },
    },
  });
  clients.push(client);
  await client.connect(transport);
  return client;
}

/** Query Mailpit's public API without using any server-internal implementation. */
async function messages() {
  const response = await fetch(`${mailpit}/api/v1/messages`, {
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.ok).toBe(true);
  return messageList.parse(await response.json()).messages;
}

beforeAll(async () => {
  clientA = await connect(primary);
  clientB = await connect(secondary);
  gpgHome = mkdtempSync(join(tmpdir(), "mcp-gpg-"));
  execFileSync("gpg", ["--homedir", gpgHome, "--batch", "--import"], {
    input: readFileSync(setting("TEST_PGP_PRIVATE_KEY_FILE")),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  if (gpgHome) rmSync(gpgHome, { recursive: true, force: true });
});

describe("built MCP service over HTTP and SMTP", () => {
  it("publishes discovery metadata, challenges unauthenticated callers, and rejects invalid tokens", async () => {
    const origin = new URL(primary).origin;
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({
        resource: primary,
        authorization_servers: ["https://auth-fixture:8443"],
        scopes_supported: ["email:send:self", "email:status:self"],
      });
    }
    const response = await fetch(primary);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `${origin}/.well-known/oauth-protected-resource`,
    );
    for (const claims of [
      { aud: "https://different.example/mcp" },
      { iss: "https://different.example" },
      { exp: 1 },
    ]) {
      const invalid = await fetch(primary, {
        headers: { Authorization: `Bearer ${await token(claims)}` },
      });
      expect(invalid.status).toBe(401);
    }
    const other = await fetch(primary, {
      headers: { Authorization: `Bearer ${await token({ sub: "other-owner" })}` },
    });
    expect(other.status).toBe(403);
  });

  it("enforces origin and request bounds without sending", async () => {
    const before = (await messages()).length;
    const headers = {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
    };
    const origin = await fetch(primary, {
      method: "POST",
      headers: { ...headers, Origin: "https://untrusted.example" },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    const oversized = await fetch(primary, {
      method: "POST",
      headers,
      body: "x".repeat(128 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect((await messages()).length).toBe(before);
  });

  it("exposes the two constrained tools and enforces scopes and fixed recipients", async () => {
    const { tools } = await clientA.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_email_send_status",
      "send_encrypted_email",
    ]);
    const request_id = randomUUID();
    expect(
      resultSchema.parse(
        (
          await clientA.callTool({
            name: "get_email_send_status",
            arguments: { request_id },
          })
        ).structuredContent,
      ).status,
    ).toBe("not_found");
    const statusOnly = await connect(
      primary,
      await token({ scope: "email:status:self" }),
    );
    const denied = await statusOnly.callTool({
      name: "send_encrypted_email",
      arguments: { request_id, title: "Title", body: "Body" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("INSUFFICIENT_SCOPE");
    const before = (await messages()).length;
    const invalid = await clientA.callTool({
      name: "send_encrypted_email",
      arguments: { request_id, title: "Title", body: "Body", to: "outsider@example.com" },
    });
    expect(invalid.isError).toBe(true);
    expect((await messages()).length).toBe(before);
  });

  it("sends encrypted Markdown, decrypts with GnuPG, and deduplicates across replicas", async () => {
    const before = await messages();
    const note = {
      request_id: randomUUID(),
      title: "Private integration title Ω",
      body: "# Private Markdown\n\nUnicode 🌎 and [a link](https://example.com).",
    };
    const sent = resultSchema.parse(
      (await clientA.callTool({ name: "send_encrypted_email", arguments: note }))
        .structuredContent,
    );
    expect(sent.status).toBe("accepted");
    const repeated = resultSchema.parse(
      (await clientB.callTool({ name: "send_encrypted_email", arguments: note }))
        .structuredContent,
    );
    expect(repeated).toEqual(sent);
    const status = resultSchema.parse(
      (
        await clientB.callTool({
          name: "get_email_send_status",
          arguments: { request_id: note.request_id },
        })
      ).structuredContent,
    );
    expect(status).toEqual(sent);
    const after = await messages();
    const fresh = after.filter(
      (message) => !before.some((prior) => prior.ID === message.ID),
    );
    expect(fresh).toHaveLength(1);
    const message = fresh[0];
    if (!message) throw new Error("Expected captured encrypted message");
    const response = await fetch(
      `${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}/raw`,
    );
    expect(response.ok).toBe(true);
    const raw = Buffer.from(await response.arrayBuffer());
    expect(raw.toString("utf8")).not.toContain(note.title);
    expect(raw.toString("utf8")).not.toContain(note.body);
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Encrypted note");
    expect(parsed.from?.value[0]?.address).toBe("sender@localhost");
    expect(parsed.messageId).toBe(sent.message_id);
    expect(parsed.headers.get("content-type")).toMatchObject({
      value: "multipart/encrypted",
    });
    const ciphertext = parsed.attachments.find((attachment) =>
      attachment.content.toString("utf8").includes("BEGIN PGP MESSAGE"),
    );
    if (!ciphertext) throw new Error("Expected an OpenPGP encrypted MIME attachment");
    const decrypted = execFileSync(
      "gpg",
      [
        "--homedir",
        gpgHome,
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--decrypt",
      ],
      { input: ciphertext.content, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 },
    );
    const inner = await simpleParser(decrypted);
    expect(inner.text?.replace(/\r\n/g, "\n").trimEnd()).toBe(
      `${note.title}\n\n${note.body}`,
    );
    const conflict = await clientB.callTool({
      name: "send_encrypted_email",
      arguments: { ...note, body: "changed content" },
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("REQUEST_CONFLICT");
    expect((await messages()).length).toBe(after.length);
  });

  it("reserves one submission for concurrent retries through different instances", async () => {
    const before = (await messages()).length;
    const note = {
      request_id: randomUUID(),
      title: "Concurrent encrypted title",
      body: "Concurrent duplicate content",
    };
    const results = await Promise.all(
      [clientA, clientB].map(async (client) =>
        resultSchema.parse(
          (await client.callTool({ name: "send_encrypted_email", arguments: note }))
            .structuredContent,
        ),
      ),
    );
    expect(results.some((result) => result.status === "accepted")).toBe(true);
    expect(
      results.every((result) => ["accepted", "in_progress"].includes(result.status)),
    ).toBe(true);
    expect((await messages()).length).toBe(before + 1);
    expect(
      resultSchema.parse(
        (
          await clientA.callTool({
            name: "get_email_send_status",
            arguments: { request_id: note.request_id },
          })
        ).structuredContent,
      ).status,
    ).toBe("accepted");
  });
});
