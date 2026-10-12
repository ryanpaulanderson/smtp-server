/** Orchestrate encryption, durable admission, one submission, and safe outcomes. */
import {
  MailError,
  type EncryptedMessage,
  type Note,
  type SendAttempt,
  type SendStore,
  type Submission,
} from "./contracts";
import { digestNote, matchesDigest, parseNote } from "./note";

/** Public result intentionally excludes all submitted content and credentials. */
export interface SendResult {
  request_id: string;
  status: SendAttempt["status"] | "not_found";
  message_id?: string;
  error_code?: string;
  warnings?: string[];
}

/** Side effects injected at the service boundary for clear resource ownership. */
export interface MailServiceDependencies {
  owner: string;
  messageDomain: string;
  store: SendStore;
  hmacKeys: Readonly<Record<string, Buffer>>;
  currentHmacKey: string;
  encrypt(note: Note, messageId: string): Promise<EncryptedMessage>;
  submit(message: EncryptedMessage, signal?: AbortSignal): Promise<Submission>;
}

function publicResult(attempt: SendAttempt): SendResult {
  return {
    request_id: attempt.requestId,
    status: attempt.status,
    message_id: attempt.messageId,
    ...(attempt.errorCode ? { error_code: attempt.errorCode } : {}),
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MailError("REQUEST_CANCELLED");
}

/** Create an owner-scoped service; its caller owns and closes the injected store. */
export function createMailService(deps: MailServiceDependencies) {
  return {
    /** Return saved submission evidence. This method never sends an email. */
    async status(requestId: string): Promise<SendResult> {
      const stored = await deps.store.find(deps.owner, requestId);
      return stored
        ? publicResult(stored)
        : { request_id: requestId, status: "not_found" };
    },
    /** Send once per request ID. Uncertain outcomes retain the original claim. */
    async send(input: unknown, signal?: AbortSignal): Promise<SendResult> {
      const note = parseNote(input);
      checkAbort(signal);
      const stored = await deps.store.find(deps.owner, note.request_id);
      if (stored) {
        if (!matchesDigest(note, stored.digest, deps.hmacKeys))
          throw new MailError("REQUEST_CONFLICT");
        return publicResult(stored);
      }
      const key = Object.hasOwn(deps.hmacKeys, deps.currentHmacKey)
        ? deps.hmacKeys[deps.currentHmacKey]
        : undefined;
      if (!key) throw new MailError("DIGEST_KEY_UNAVAILABLE");
      const messageId = `<${note.request_id}@${deps.messageDomain}>`;
      const message = await deps.encrypt(note, messageId);
      checkAbort(signal);
      const reserved = await deps.store.reserve({
        owner: deps.owner,
        requestId: note.request_id,
        digest: digestNote(note, deps.currentHmacKey, key),
        messageId,
        fingerprint: message.fingerprint,
      });
      if (!reserved.created) {
        if (!matchesDigest(note, reserved.attempt.digest, deps.hmacKeys))
          throw new MailError("REQUEST_CONFLICT");
        return publicResult(reserved.attempt);
      }
      let submission: Submission;
      try {
        submission = await deps.submit(message, signal);
      } catch {
        // A transport exception cannot establish that the server did not accept
        // the message. Retaining the reservation is safer than attempting again.
        submission = { status: "unknown", errorCode: "TRANSPORT_FAILED" };
      }
      try {
        return publicResult(
          await deps.store.complete(deps.owner, note.request_id, submission),
        );
      } catch {
        console.warn(
          JSON.stringify({
            event: "status_persistence_failed",
            request_id: note.request_id,
            status: submission.status,
          }),
        );
        return {
          request_id: note.request_id,
          status: submission.status,
          message_id: messageId,
          ...(submission.errorCode ? { error_code: submission.errorCode } : {}),
          warnings: ["STATUS_PERSISTENCE_FAILED"],
        };
      }
    },
  };
}
