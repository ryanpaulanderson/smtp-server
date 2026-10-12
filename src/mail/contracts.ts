/** The validated content of one intended email; the subject is public metadata. */
export interface Note {
  request_id: string;
  title: string;
  body: string;
  subject: string;
}

/** Envelope and encryption identity controlled by the operator, never the caller. */
export interface EncryptionConfig {
  from: string;
  to: string;
  publicKey: string;
  fingerprint: string;
}

/** A fully encrypted RFC 5322 message, ready for the fixed SMTP envelope. */
export interface EncryptedMessage {
  raw: Buffer;
  fingerprint: string;
  messageId: string;
}

/** Bounded SMTP connection settings; certificate verification is always required. */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  to: string;
  timeoutMs: number;
  /** Additional trusted PEM certificate authority; never disables certificate checks. */
  tlsCa?: string;
}

/** Submission evidence; accepted does not imply inbox delivery. */
export type Submission = {
  status: "accepted" | "rejected" | "unknown";
  errorCode?: string;
};

/** Key identifier and keyed digest used to detect conflicting request reuse. */
export interface RequestDigest {
  keyId: string;
  value: string;
}

/** Minimal permanent record of a reserved submission; contains no message content. */
export interface SendAttempt {
  requestId: string;
  owner: string;
  digest: RequestDigest;
  messageId: string;
  fingerprint: string;
  status: "in_progress" | Submission["status"];
  createdAt: Date;
  activeUntil: Date;
  errorCode?: string;
}

/** Admission limits enforced atomically across application instances. */
export interface AdmissionLimits {
  concurrent: number;
  perMinute: number;
  perDay: number;
  capacity: number;
  leaseMs: number;
}

/** New reservation data; the store owns timestamps and enforces uniqueness. */
export type NewAttempt = Pick<
  SendAttempt,
  "owner" | "requestId" | "digest" | "messageId" | "fingerprint"
>;

/** Persisted claim; only a newly created reservation may submit to SMTP. */
export interface Reservation {
  created: boolean;
  attempt: SendAttempt;
}

/** Authoritative state boundary, implemented by PostgreSQL in production. */
export interface SendStore {
  find(owner: string, requestId: string): Promise<SendAttempt | null>;
  reserve(input: NewAttempt): Promise<Reservation>;
  complete(owner: string, requestId: string, result: Submission): Promise<SendAttempt>;
  close(): Promise<void>;
}

/** A safe, intentionally public error code without upstream messages or secrets. */
export class MailError extends Error {
  constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "MailError";
  }
}
