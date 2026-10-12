/** Public-key validation and in-memory PGP/MIME composition for one fixed recipient. */
import MimeNode from "nodemailer/lib/mime-node";
import * as openpgp from "openpgp";

import {
  MailError,
  type EncryptedMessage,
  type EncryptionConfig,
  type Note,
} from "./contracts";

/** Normalize a fingerprint without tolerating non-hexadecimal identifiers. */
function normalizeFingerprint(value: string): string {
  const fingerprint = value.replace(/\s/g, "").toUpperCase();
  if (!/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(fingerprint)) {
    throw new MailError("INVALID_KEY_FINGERPRINT");
  }
  return fingerprint;
}

/** Resolve exactly one public certificate and validate its current recipient binding. */
async function recipientKey(
  config: EncryptionConfig,
  now: Date,
): Promise<{ key: openpgp.PublicKey; fingerprint: string }> {
  const fingerprint = normalizeFingerprint(config.fingerprint);
  if (
    !/^\s*-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*-----END PGP PUBLIC KEY BLOCK-----\s*$/.test(
      config.publicKey,
    ) ||
    (config.publicKey.match(/-----BEGIN PGP /g)?.length ?? 0) !== 1
  ) {
    throw new MailError("INVALID_PUBLIC_KEY");
  }
  let keys: openpgp.Key[];
  try {
    keys = await openpgp.readKeys({
      armoredKeys: config.publicKey,
      config: { ignoreMalformedPackets: false, ignoreUnsupportedPackets: false },
    });
  } catch (cause) {
    throw new MailError("INVALID_PUBLIC_KEY", { cause });
  }
  const key = keys[0];
  if (
    keys.length !== 1 ||
    key === undefined ||
    key.isPrivate() ||
    key
      .toPacketList()
      .some(
        (packet) =>
          packet instanceof openpgp.SecretKeyPacket ||
          packet instanceof openpgp.SecretSubkeyPacket,
      )
  ) {
    throw new MailError("INVALID_PUBLIC_KEY");
  }
  if (normalizeFingerprint(key.getFingerprint()) !== fingerprint) {
    throw new MailError("KEY_FINGERPRINT_MISMATCH");
  }
  try {
    await key.verifyPrimaryKey(now);
  } catch (cause) {
    throw new MailError("KEY_UNUSABLE", { cause });
  }
  try {
    await key.getPrimaryUser(now, { email: config.to });
  } catch (cause) {
    throw new MailError("KEY_IDENTITY_MISMATCH", { cause });
  }
  try {
    await key.getEncryptionKey(undefined, now, { email: config.to });
  } catch (cause) {
    throw new MailError("KEY_UNUSABLE", { cause });
  }
  return { key, fingerprint };
}

/** Build a MIME node into a bounded in-memory buffer without file or URL access. */
function build(node: MimeNode): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    node.build((error, message) => {
      if (error) reject(error);
      else resolve(message);
    });
  });
}

/**
 * Encrypt the note before producing a complete RFC 3156 PGP/MIME message.
 *
 * The outer subject and envelope identities remain public. The encrypted MIME
 * body contains the exact title, two line feeds, and body as UTF-8 text. No
 * private key is accepted, no signature is added, and failures never return a
 * plaintext message. The optional clock is for deterministic time-bound checks.
 */
export async function encryptNote(
  note: Note,
  config: EncryptionConfig,
  messageId: string,
  now: Date = new Date(),
): Promise<EncryptedMessage> {
  const { key, fingerprint } = await recipientKey(config, now);
  try {
    const inner = new MimeNode("text/plain; charset=utf-8", {
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    inner.setHeader("Content-Transfer-Encoding", "base64");
    inner.setContent(Buffer.from(`${note.title}\n\n${note.body}`, "utf8"));
    const content = await build(inner);
    const ciphertext = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: content }),
      encryptionKeys: key,
      encryptionUserIDs: { email: config.to },
      date: now,
      format: "armored",
    });

    const outer = new MimeNode(
      'multipart/encrypted; protocol="application/pgp-encrypted"',
      {
        disableFileAccess: true,
        disableUrlAccess: true,
      },
    );
    outer.setHeader("From", config.from);
    outer.setHeader("To", config.to);
    outer.setHeader("Subject", note.subject);
    outer.setHeader("Message-ID", messageId);
    outer.setHeader("Date", now.toUTCString());
    const version = outer.createChild("application/pgp-encrypted");
    version.setHeader("Content-Transfer-Encoding", "7bit");
    version.setContent("Version: 1\r\n");
    const payload = outer.createChild('application/octet-stream; name="encrypted.asc"');
    payload.setHeader("Content-Transfer-Encoding", "7bit");
    payload.setHeader("Content-Disposition", 'inline; filename="encrypted.asc"');
    payload.setContent(ciphertext);
    return { raw: await build(outer), fingerprint, messageId };
  } catch (cause) {
    throw new MailError("ENCRYPTION_FAILED", { cause });
  }
}
