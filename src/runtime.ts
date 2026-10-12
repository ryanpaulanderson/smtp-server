/** Process-local resource ownership; all authoritative send state lives in PostgreSQL. */
import {
  admissionLimits,
  loadDatabaseUrl,
  loadMailConfig,
  type AuthConfig,
} from "./config";
import { createMailService } from "./mail/service";
import { encryptNote } from "./mail/encryption";
import { submitEncryptedMessage } from "./mail/smtp";
import { createPostgresStore } from "./persistence/postgres-store";

/** Create a lazy application owner; importing this module opens no connections. */
export function createApplicationRuntime(auth: AuthConfig) {
  const store = createPostgresStore(loadDatabaseUrl(), admissionLimits());
  let mail: ReturnType<typeof createMailService> | undefined;
  return {
    /** Read stored state without requiring the SMTP token or encryption key. */
    async status(requestId: string) {
      const attempt = await store.find(auth.owner, requestId);
      return attempt
        ? {
            request_id: requestId,
            status: attempt.status,
            message_id: attempt.messageId,
            ...(attempt.errorCode ? { error_code: attempt.errorCode } : {}),
          }
        : { request_id: requestId, status: "not_found" };
    },
    /** Resolve sending configuration only when a send has been enabled. */
    async send(input: unknown, signal?: AbortSignal) {
      if (!mail) {
        const config = loadMailConfig();
        mail = createMailService({
          owner: auth.owner,
          messageDomain: new URL(auth.resource).hostname,
          store,
          hmacKeys: config.hmacKeys,
          currentHmacKey: config.currentHmacKey,
          encrypt: (note, messageId) => encryptNote(note, config.encryption, messageId),
          submit: (message, abort) => submitEncryptedMessage(message, config.smtp, abort),
        });
      }
      return mail.send(input, signal);
    },
    /** Release database connections during controlled shutdown or tests. */
    close: () => store.close(),
  };
}
