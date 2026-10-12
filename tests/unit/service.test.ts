import { describe, expect, it, vi } from "vitest";
import type {
  EncryptedMessage,
  NewAttempt,
  SendAttempt,
  SendStore,
  Submission,
} from "../../src/mail/contracts.js";
import {
  createMailService,
  type MailServiceDependencies,
} from "../../src/mail/service.js";
import { digestNote, parseNote } from "../../src/mail/note.js";

const note = parseNote({
  request_id: "168541d6-2124-4f1d-8db2-666728fd2d83",
  title: "Secret title",
  body: "Secret body",
});
const key = Buffer.alloc(32, 1);

/** In-memory test boundary exposes durable effects without mocking internal helpers. */
function fixture(overrides: Partial<MailServiceDependencies> = {}) {
  const records = new Map<string, SendAttempt>();
  const store: SendStore = {
    async find(_owner, id) {
      return records.get(id) ?? null;
    },
    async reserve(input: NewAttempt) {
      const existing = records.get(input.requestId);
      if (existing) return { created: false, attempt: existing };
      const attempt: SendAttempt = {
        ...input,
        status: "in_progress",
        createdAt: new Date(),
        activeUntil: new Date(Date.now() + 90_000),
      };
      records.set(input.requestId, attempt);
      return { created: true, attempt };
    },
    async complete(_owner, id, result) {
      const prior = records.get(id);
      if (!prior) throw new Error("Missing fixture record");
      const attempt = { ...prior, ...result };
      records.set(id, attempt);
      return attempt;
    },
    async close() {},
  };
  const encrypt = vi.fn(async (_note, messageId: string): Promise<EncryptedMessage> => ({
    raw: Buffer.from("ciphertext"),
    fingerprint: "a".repeat(40),
    messageId,
  }));
  const submit = vi.fn(async (): Promise<Submission> => ({ status: "accepted" }));
  const service = createMailService({
    owner: "owner",
    messageDomain: "localhost",
    store,
    hmacKeys: { v1: key },
    currentHmacKey: "v1",
    encrypt,
    submit,
    ...overrides,
  });
  return { service, store, records, encrypt, submit };
}

describe("mail operation lifecycle", () => {
  it("records one accepted submission and does not resend a duplicate", async () => {
    const { service, submit, records } = fixture();
    expect(await service.status(note.request_id)).toEqual({
      request_id: note.request_id,
      status: "not_found",
    });
    const first = await service.send(note);
    expect(first).toMatchObject({
      status: "accepted",
      message_id: `<${note.request_id}@localhost>`,
    });
    expect(await service.send(note)).toEqual(first);
    expect(await service.status(note.request_id)).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...records.values()])).not.toContain(note.body);
    expect(JSON.stringify([...records.values()])).not.toContain(note.title);
    await expect(service.send({ ...note, body: "changed" })).rejects.toThrow(
      "REQUEST_CONFLICT",
    );
  });

  it("uses the reservation winner across simultaneous calls", async () => {
    const { service, submit } = fixture();
    const results = await Promise.all([service.send(note), service.send(note)]);
    expect(results.map((result) => result.status)).toContain("accepted");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent request with conflicting content", async () => {
    const { service, submit } = fixture();
    const results = await Promise.allSettled([
      service.send(note),
      service.send({ ...note, body: "changed" }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "unknown"] as const)(
    "retains %s outcomes on retry",
    async (status) => {
      const submit = vi.fn(async (): Promise<Submission> => ({
        status,
        errorCode: "SMTP_FAILURE",
      }));
      const { service } = fixture({ submit });
      expect(await service.send(note)).toMatchObject({
        status,
        error_code: "SMTP_FAILURE",
      });
      expect(await service.send(note)).toMatchObject({ status });
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );

  it("retains an uncertain claim if an unexpected transport failure escapes", async () => {
    const submit = vi.fn(async (): Promise<Submission> => {
      throw new Error("secret upstream text");
    });
    const { service } = fixture({ submit });
    const result = await service.send(note);
    expect(result).toMatchObject({ status: "unknown", error_code: "TRANSPORT_FAILED" });
    expect(JSON.stringify(result)).not.toContain("secret");
    await service.send(note);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reports live submission evidence if the final database update fails", async () => {
    const { store, records } = fixture();
    store.complete = async () => {
      throw new Error("database secret");
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, submit } = fixture({ store });
      expect(await service.send(note)).toMatchObject({
        status: "accepted",
        warnings: ["STATUS_PERSISTENCE_FAILED"],
      });
      expect(records.get(note.request_id)?.status).toBe("in_progress");
      expect(await service.send(note)).toMatchObject({ status: "in_progress" });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).not.toContain("secret");
    } finally {
      warning.mockRestore();
    }
  });

  it("does not claim or submit when encryption or cancellation fails", async () => {
    const { service, records, submit } = fixture({
      encrypt: async () => {
        throw new Error("INVALID_KEY");
      },
    });
    await expect(service.send(note)).rejects.toThrow("INVALID_KEY");
    expect(records.size).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    await expect(service.send(note, AbortSignal.abort())).rejects.toThrow(
      "REQUEST_CANCELLED",
    );
    const controller = new AbortController();
    const second = fixture({
      encrypt: async (_note, messageId) => {
        controller.abort();
        return { raw: Buffer.from("encrypted"), messageId, fingerprint: "a".repeat(40) };
      },
    });
    await expect(second.service.send(note, controller.signal)).rejects.toThrow(
      "REQUEST_CANCELLED",
    );
    expect(second.records.size).toBe(0);
  });

  it("requires the current digest key before encryption", async () => {
    const { service, encrypt } = fixture({ currentHmacKey: "missing" });
    await expect(service.send(note)).rejects.toThrow("DIGEST_KEY_UNAVAILABLE");
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("retains compatibility with old digest keys", async () => {
    const { service, records, submit } = fixture();
    records.set(note.request_id, {
      requestId: note.request_id,
      owner: "owner",
      digest: digestNote(note, "v1", key),
      messageId: "stored-id",
      fingerprint: "a".repeat(40),
      status: "rejected",
      errorCode: "SMTP_REJECTED",
      createdAt: new Date(),
      activeUntil: new Date(),
    });
    expect(await service.send(note)).toMatchObject({
      status: "rejected",
      error_code: "SMTP_REJECTED",
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
