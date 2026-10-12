/** Input and digest contracts for a note, including its unencrypted subject. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MailError, type Note, type RequestDigest } from "./contracts";

function boundedText(bytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= bytes,
      "Text exceeds its byte limit or is empty",
    );
}

/** Strict tool input. Addresses, keys, headers, and files cannot be supplied. */
export const noteSchema = z.strictObject({
  request_id: z.uuid(),
  title: boundedText(512),
  body: boundedText(64 * 1024),
  subject: boundedText(200)
    .refine(
      (value) => !/[\x00-\x1f\x7f]/.test(value),
      "Subject contains a control character",
    )
    .default("Encrypted note"),
});

/** Status lookup accepts only one operation identifier. */
export const statusSchema = z.strictObject({ request_id: z.uuid() });

/** Validate the input at the application boundary and emit safe error text. */
export function parseNote(input: unknown): Note {
  const result = noteSchema.safeParse(input);
  if (!result.success) throw new MailError("INVALID_INPUT");
  return result.data;
}

/** Hash ordered, versioned content without retaining it in the database. */
export function digestNote(note: Note, keyId: string, key: Buffer): RequestDigest {
  return {
    keyId,
    value: createHmac("sha256", key)
      .update(JSON.stringify([1, note.title, note.body, note.subject]))
      .digest("hex"),
  };
}

/** Compare a request using the historical key that created its stored digest. */
export function matchesDigest(
  note: Note,
  stored: RequestDigest,
  keys: Readonly<Record<string, Buffer>>,
): boolean {
  const key = Object.hasOwn(keys, stored.keyId) ? keys[stored.keyId] : undefined;
  if (!key) throw new MailError("DIGEST_KEY_UNAVAILABLE");
  if (!/^[a-f0-9]{64}$/.test(stored.value)) throw new MailError("INVALID_STORED_DIGEST");
  return timingSafeEqual(
    Buffer.from(digestNote(note, stored.keyId, key).value, "hex"),
    Buffer.from(stored.value, "hex"),
  );
}
