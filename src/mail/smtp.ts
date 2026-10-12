/** One-shot SMTP submission with mandatory TLS and an explicit uncertain outcome. */
import { isIP } from "node:net";
import { Readable } from "node:stream";
import SMTPConnection from "nodemailer/lib/smtp-connection";

import type { EncryptedMessage, SmtpConfig, Submission } from "./contracts";

/** Extract only a numeric SMTP response; upstream text can contain private data. */
function responseCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "responseCode" in error &&
    typeof error.responseCode === "number"
  ) {
    return error.responseCode;
  }
  return undefined;
}

/**
 * Submit an already encrypted message over one verified STARTTLS connection.
 *
 * The fixed envelope is independent of message headers. A whole-operation
 * deadline or cancellation destroys the connection, and no retry is attempted.
 * Once body transmission begins, a missing final acknowledgment is `unknown`;
 * only an explicit SMTP failure response proves rejection at that point.
 */
export function submitEncryptedMessage(
  message: EncryptedMessage,
  config: SmtpConfig,
  signal?: AbortSignal,
): Promise<Submission> {
  if (signal?.aborted) {
    return Promise.resolve({ status: "rejected", errorCode: "SMTP_CANCELLED" });
  }
  return new Promise((resolve) => {
    const connection = new SMTPConnection({
      host: config.host,
      port: config.port,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      opportunisticTLS: false,
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs,
      tls: {
        rejectUnauthorized: true,
        servername: isIP(config.host) ? undefined : config.host,
        ca: config.tlsCa,
      },
      logger: false,
      debug: false,
    });
    let settled = false;
    let bodyStarted = false;
    const source = new Readable({
      read() {
        // SMTPConnection reads this source only after the server accepts DATA.
        bodyStarted = true;
        this.push(message.raw);
        this.push(null);
      },
    });
    const finish = (result: Submission): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      source.destroy();
      connection.close();
      resolve(result);
    };
    const fail = (errorCode: string, error?: unknown): void => {
      const code = responseCode(error);
      const definitiveResponse = code !== undefined && code >= 400 && code < 600;
      const timedOut =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ETIMEDOUT";
      finish({
        status: bodyStarted && !definitiveResponse ? "unknown" : "rejected",
        errorCode: timedOut ? "SMTP_DEADLINE_EXCEEDED" : errorCode,
      });
    };
    const cancel = (): void => fail("SMTP_CANCELLED");
    const deadline = setTimeout(() => fail("SMTP_DEADLINE_EXCEEDED"), config.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    // An abort can arrive between the initial check and listener registration.
    if (signal?.aborted) {
      cancel();
      return;
    }
    connection.on("error", (error: Error) => fail("SMTP_CONNECTION_FAILED", error));
    connection.on("end", () => fail("SMTP_CONNECTION_CLOSED"));
    connection.connect((connectError) => {
      if (settled) return;
      if (connectError) {
        fail("SMTP_CONNECTION_FAILED", connectError);
        return;
      }
      connection.login({ user: config.username, pass: config.password }, (loginError) => {
        if (settled) return;
        if (loginError) {
          fail("SMTP_AUTH_FAILED", loginError);
          return;
        }
        connection.send({ from: config.from, to: [config.to] }, source, (sendError) => {
          if (settled) return;
          if (sendError) fail("SMTP_SUBMISSION_FAILED", sendError);
          else finish({ status: "accepted" });
        });
      });
    });
  });
}
