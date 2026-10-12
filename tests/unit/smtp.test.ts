import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EncryptedMessage, SmtpConfig } from "../../src/mail/contracts";
import { submitEncryptedMessage } from "../../src/mail/smtp";

const message: EncryptedMessage = {
  raw: Buffer.from(
    "From: sender@localhost\r\nTo: recipient@localhost\r\nSubject: Encrypted note\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n.leading dot\r\n-----END PGP MESSAGE-----\r\n",
  ),
  fingerprint: "0".repeat(40),
  messageId: "<smtp-test@localhost>",
};
let directory: string;
let certificate: string;
let privateKey: string;
const servers: SMTPServer[] = [];
const sockets = new Set<Socket>();

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "email-mcp-smtp-test-"));
  const keyFile = join(directory, "tls.key");
  const certificateFile = join(directory, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  privateKey = readFileSync(keyFile, "utf8");
  certificate = readFileSync(certificateFile, "utf8");
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(resolve))),
  );
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** Start an isolated real SMTP receiver with strict TLS and synthetic authentication. */
async function receiver(options: SMTPServerOptions = {}): Promise<{
  config: SmtpConfig;
  captured: Buffer[];
  secureSessions: boolean[];
  connections: () => number;
  closed: Promise<void>;
}> {
  const captured: Buffer[] = [];
  const secureSessions: boolean[] = [];
  let connectionCount = 0;
  let closed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = new SMTPServer({
    secure: false,
    key: privateKey,
    cert: certificate,
    logger: false,
    disableReverseLookup: true,
    authOptional: false,
    allowInsecureAuth: false,
    onConnect(_session, callback) {
      callback();
    },
    onClose() {
      closed();
    },
    onAuth(auth, session, callback) {
      secureSessions.push(session.secure);
      if (auth.username === "test-user" && auth.password === "test-only-password") {
        callback(null, { user: "test-user" });
      } else {
        callback(new Error("Invalid synthetic credentials"));
      }
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary SMTP data");
        chunks.push(chunk);
      });
      stream.once("end", () => {
        captured.push(Buffer.concat(chunks));
        callback(null, "Accepted test message");
      });
    },
    ...options,
  });
  // TLS rejection is expected in negative cases; the caller asserts the result.
  server.on("error", () => undefined);
  server.server.on("connection", (socket: Socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      closed();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing SMTP test port");
  return {
    config: {
      host: "localhost",
      port: address.port,
      username: "test-user",
      password: "test-only-password",
      from: "sender@localhost",
      to: "recipient@localhost",
      timeoutMs: 2000,
      tlsCa: certificate,
    },
    captured,
    secureSessions,
    connections: () => connectionCount,
    closed: closedPromise,
  };
}

describe("submitEncryptedMessage", () => {
  it("submits the exact raw message after verified STARTTLS using one connection", async () => {
    const smtp = await receiver();
    expect(await submitEncryptedMessage(message, smtp.config)).toEqual({
      status: "accepted",
    });
    expect(smtp.captured).toEqual([message.raw]);
    expect(smtp.secureSessions).toEqual([true]);
    expect(smtp.connections()).toBe(1);
    await smtp.closed;
  });

  it("rejects an explicit RCPT failure without transmitting the message", async () => {
    const smtp = await receiver({
      onRcptTo(_address, _session, callback) {
        callback(
          Object.assign(new Error("Test recipient denied"), { responseCode: 550 }),
        );
      },
    });
    expect(await submitEncryptedMessage(message, smtp.config)).toEqual({
      status: "rejected",
      errorCode: "SMTP_SUBMISSION_FAILED",
    });
    expect(smtp.captured).toHaveLength(0);
    expect(smtp.connections()).toBe(1);
  });

  it("rejects an explicit final DATA failure", async () => {
    const smtp = await receiver({
      onData(stream, _session, callback) {
        stream.resume();
        stream.once("end", () =>
          callback(
            Object.assign(new Error("Test content denied"), { responseCode: 554 }),
          ),
        );
      },
    });
    expect(await submitEncryptedMessage(message, smtp.config)).toEqual({
      status: "rejected",
      errorCode: "SMTP_SUBMISSION_FAILED",
    });
    expect(smtp.connections()).toBe(1);
  });

  it("does not authenticate or send when STARTTLS is unavailable", async () => {
    const smtp = await receiver({ disabledCommands: ["STARTTLS"] });
    expect(await submitEncryptedMessage(message, smtp.config)).toMatchObject({
      status: "rejected",
    });
    expect(smtp.secureSessions).toHaveLength(0);
    expect(smtp.captured).toHaveLength(0);
  });

  it("does not authenticate or send when the certificate is not trusted", async () => {
    const smtp = await receiver();
    const untrusted = { ...smtp.config, tlsCa: undefined };
    expect(await submitEncryptedMessage(message, untrusted)).toMatchObject({
      status: "rejected",
    });
    expect(smtp.secureSessions).toHaveLength(0);
    expect(smtp.captured).toHaveLength(0);
  });

  it("rejects a trusted certificate for the wrong SMTP hostname", async () => {
    const smtp = await receiver();
    expect(
      await submitEncryptedMessage(message, { ...smtp.config, host: "127.0.0.1" }),
    ).toMatchObject({ status: "rejected" });
    expect(smtp.secureSessions).toHaveLength(0);
    expect(smtp.captured).toHaveLength(0);
  });

  it("rejects invalid authentication without sending DATA", async () => {
    const smtp = await receiver();
    expect(
      await submitEncryptedMessage(message, {
        ...smtp.config,
        password: "wrong-password",
      }),
    ).toEqual({ status: "rejected", errorCode: "SMTP_AUTH_FAILED" });
    expect(smtp.captured).toHaveLength(0);
  });

  it("honors cancellation before connecting", async () => {
    const smtp = await receiver();
    const controller = new AbortController();
    controller.abort();
    expect(await submitEncryptedMessage(message, smtp.config, controller.signal)).toEqual(
      { status: "rejected", errorCode: "SMTP_CANCELLED" },
    );
    expect(smtp.connections()).toBe(0);
  });

  it("closes a timed-out greeting before any message can be accepted", async () => {
    const smtp = await receiver({
      onConnect() {
        /* Deliberately withhold the SMTP greeting. */
      },
    });
    expect(
      await submitEncryptedMessage(message, { ...smtp.config, timeoutMs: 100 }),
    ).toEqual({ status: "rejected", errorCode: "SMTP_DEADLINE_EXCEEDED" });
    expect(smtp.connections()).toBe(1);
    expect(smtp.secureSessions).toHaveLength(0);
    await smtp.closed;
  });

  it("reports unknown when final acknowledgment is lost and never resends", async () => {
    const smtp = await receiver({
      onData(stream) {
        stream.resume();
        stream.once("end", () => {
          for (const socket of sockets) socket.destroy();
        });
      },
    });
    expect(await submitEncryptedMessage(message, smtp.config)).toMatchObject({
      status: "unknown",
    });
    expect(smtp.connections()).toBe(1);
    await smtp.closed;
  });

  it("cancels after DATA with an unknown outcome and closes the connection", async () => {
    const controller = new AbortController();
    const smtp = await receiver({
      onData(stream) {
        stream.resume();
        stream.once("end", () => controller.abort());
      },
    });
    expect(await submitEncryptedMessage(message, smtp.config, controller.signal)).toEqual(
      { status: "unknown", errorCode: "SMTP_CANCELLED" },
    );
    expect(smtp.connections()).toBe(1);
    await smtp.closed;
  });

  it("enforces its deadline while waiting for final acknowledgment", async () => {
    const smtp = await receiver({
      onData(stream) {
        stream.resume();
      },
    });
    expect(
      await submitEncryptedMessage(message, { ...smtp.config, timeoutMs: 500 }),
    ).toEqual({ status: "unknown", errorCode: "SMTP_DEADLINE_EXCEEDED" });
    expect(smtp.connections()).toBe(1);
    await smtp.closed;
  });
});
