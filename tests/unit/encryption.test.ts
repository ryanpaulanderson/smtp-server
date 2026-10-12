import { simpleParser } from "mailparser";
import * as openpgp from "openpgp";
import { beforeAll, describe, expect, it } from "vitest";

import type { EncryptionConfig, Note } from "../../src/mail/contracts";
import { encryptNote } from "../../src/mail/encryption";

const generatedAt = new Date("2026-01-01T00:00:00Z");
const sendAt = new Date("2026-01-02T00:00:00Z");
const note: Note = {
  request_id: "7432888c-6f19-44c2-bcdf-b7a5fe4a0f3e",
  title: "Private title 📨",
  body: "## Private Markdown\n\nA secret with Unicode: café.\n.leading dot\n",
  subject: "Encrypted note",
};
let config: EncryptionConfig;
let privateKey: openpgp.PrivateKey;

beforeAll(async () => {
  const keys = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ email: "recipient@localhost" }],
    date: generatedAt,
  });
  privateKey = await openpgp.readPrivateKey({ armoredKey: keys.privateKey });
  config = {
    from: "sender@localhost",
    to: "recipient@localhost",
    publicKey: keys.publicKey,
    fingerprint: privateKey.getFingerprint(),
  };
});

describe("encryptNote", () => {
  it("emits decryptable PGP/MIME without the private title or body on the wire", async () => {
    const result = await encryptNote(note, config, "<request-1@localhost>", sendAt);
    const wire = result.raw.toString("utf8");
    const outer = await simpleParser(result.raw);
    expect(wire).toMatch(/Content-Type: multipart\/encrypted;/i);
    expect(wire).toContain('protocol="application/pgp-encrypted"');
    expect(wire).not.toContain(note.title);
    expect(wire).not.toContain(note.body);
    expect(wire).not.toContain("Private Markdown");
    expect(outer.subject).toBe(note.subject);
    expect(outer.from?.value[0]?.address).toBe(config.from);
    expect(outer.messageId).toBe("<request-1@localhost>");
    expect(result.fingerprint).toBe(config.fingerprint.toUpperCase());
    const version = outer.attachments.find(
      (part) => part.contentType === "application/pgp-encrypted",
    );
    const encrypted = outer.attachments.find(
      (part) => part.contentType === "application/octet-stream",
    );
    expect(version?.content.toString("utf8").trim()).toBe("Version: 1");
    expect(encrypted).toBeDefined();
    if (!encrypted) throw new Error("Missing encrypted MIME payload");
    const clear = await openpgp.decrypt({
      message: await openpgp.readMessage({
        armoredMessage: encrypted.content.toString("utf8"),
      }),
      decryptionKeys: privateKey,
      format: "binary",
      date: sendAt,
    });
    const inner = await simpleParser(Buffer.from(clear.data));
    expect(inner.text).toBe(`${note.title}\n\n${note.body}`);
    expect(clear.signatures).toHaveLength(0);
  });

  it("accepts an explicitly formatted version of the pinned fingerprint", async () => {
    const grouped = config.fingerprint
      .toLowerCase()
      .match(/.{1,4}/g)
      ?.join(" ");
    if (!grouped) throw new Error("Missing test fingerprint");
    const result = await encryptNote(
      note,
      { ...config, fingerprint: grouped },
      "<2@localhost>",
      sendAt,
    );
    expect(result.fingerprint).toBe(config.fingerprint.toUpperCase());
  });

  it.each(["not a fingerprint", "A".repeat(41)])(
    "rejects invalid fingerprint %s",
    async (fingerprint) => {
      await expect(
        encryptNote(note, { ...config, fingerprint }, "<3@localhost>", sendAt),
      ).rejects.toMatchObject({
        code: "INVALID_KEY_FINGERPRINT",
      });
    },
  );

  it("rejects a substituted public key fingerprint", async () => {
    await expect(
      encryptNote(
        note,
        { ...config, fingerprint: "0".repeat(40) },
        "<4@localhost>",
        sendAt,
      ),
    ).rejects.toMatchObject({ code: "KEY_FINGERPRINT_MISMATCH" });
  });

  it("rejects a recipient not certified by the pinned public key", async () => {
    await expect(
      encryptNote(note, { ...config, to: "other@localhost" }, "<5@localhost>", sendAt),
    ).rejects.toMatchObject({ code: "KEY_IDENTITY_MISMATCH" });
  });

  it("never accepts private material or concatenated certificate blocks", async () => {
    for (const publicKey of [
      privateKey.armor(),
      config.publicKey + privateKey.armor(),
      config.publicKey + config.publicKey,
    ]) {
      await expect(
        encryptNote(note, { ...config, publicKey }, "<6@localhost>", sendAt),
      ).rejects.toMatchObject({
        code: "INVALID_PUBLIC_KEY",
      });
    }
  });

  it("rejects corrupt public certificate data", async () => {
    const publicKey =
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\ninvalid\n-----END PGP PUBLIC KEY BLOCK-----";
    await expect(
      encryptNote(note, { ...config, publicKey }, "<7@localhost>", sendAt),
    ).rejects.toMatchObject({
      code: "INVALID_PUBLIC_KEY",
    });
  });

  it("revalidates expiration at the time of every send", async () => {
    const keys = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ email: config.to }],
      keyExpirationTime: 60,
      date: generatedAt,
    });
    const key = await openpgp.readKey({ armoredKey: keys.publicKey });
    const expiring = {
      ...config,
      publicKey: keys.publicKey,
      fingerprint: key.getFingerprint(),
    };
    await expect(
      encryptNote(note, expiring, "<8@localhost>", generatedAt),
    ).resolves.toHaveProperty("raw");
    await expect(
      encryptNote(note, expiring, "<9@localhost>", sendAt),
    ).rejects.toMatchObject({ code: "KEY_UNUSABLE" });
  });

  it("rejects revoked certificates", async () => {
    const revoked = await openpgp.revokeKey({ key: privateKey, date: generatedAt });
    await expect(
      encryptNote(
        note,
        { ...config, publicKey: revoked.publicKey },
        "<10@localhost>",
        sendAt,
      ),
    ).rejects.toMatchObject({ code: "KEY_UNUSABLE" });
  });

  it("rejects a valid signing certificate without an encryption-capable key", async () => {
    const keys = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ email: config.to }],
      subkeys: [],
      date: generatedAt,
    });
    const key = await openpgp.readKey({ armoredKey: keys.publicKey });
    await expect(
      encryptNote(
        note,
        { ...config, publicKey: keys.publicKey, fingerprint: key.getFingerprint() },
        "<11@localhost>",
        sendAt,
      ),
    ).rejects.toMatchObject({ code: "KEY_UNUSABLE" });
  });
});
