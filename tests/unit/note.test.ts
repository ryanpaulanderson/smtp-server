import { describe, expect, it } from "vitest";
import {
  digestNote,
  matchesDigest,
  parseNote,
  statusSchema,
} from "../../src/mail/note.js";

const input = {
  request_id: "168541d6-2124-4f1d-8db2-666728fd2d83",
  title: "Private title",
  body: "# A note\n\nHello 🌎",
};
const key = Buffer.alloc(32, 1);

describe("note contract", () => {
  it("defaults to a neutral subject and preserves Markdown", () => {
    expect(parseNote(input)).toEqual({ ...input, subject: "Encrypted note" });
    expect(statusSchema.safeParse({ request_id: input.request_id }).success).toBe(true);
    expect(
      statusSchema.safeParse({ request_id: input.request_id, body: "extra" }).success,
    ).toBe(false);
  });

  it.each([
    { ...input, to: "outsider@example.com" },
    { ...input, request_id: "invalid" },
    { ...input, title: " " },
    { ...input, body: "" },
    { ...input, title: "é".repeat(257) },
    { ...input, body: "é".repeat(32769) },
    { ...input, subject: "é".repeat(101) },
    { ...input, subject: "private\r\nBcc: outsider@example.com" },
  ])("rejects invalid or excessive input", (value) => {
    expect(() => parseNote(value)).toThrow("INVALID_INPUT");
  });

  it("accepts exact UTF-8 boundaries", () => {
    expect(
      parseNote({
        ...input,
        title: "é".repeat(256),
        body: "é".repeat(32768),
        subject: "é".repeat(100),
      }).title,
    ).toHaveLength(256);
  });

  it("compares historical keys and every content field without storing plaintext", () => {
    const note = parseNote(input);
    const digest = digestNote(note, "old", key);
    expect(digest.value).toMatch(/^[a-f0-9]{64}$/);
    expect(matchesDigest(note, digest, { old: key, new: Buffer.alloc(32, 2) })).toBe(
      true,
    );
    for (const field of ["body", "title", "subject"] as const) {
      expect(matchesDigest({ ...note, [field]: "changed" }, digest, { old: key })).toBe(
        false,
      );
    }
    expect(() => matchesDigest(note, digest, {})).toThrow("DIGEST_KEY_UNAVAILABLE");
    expect(() =>
      matchesDigest(note, { ...digest, value: "broken" }, { old: key }),
    ).toThrow("INVALID_STORED_DIGEST");
  });
});
