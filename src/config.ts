/** Validated operator configuration. Secret values are never included in errors. */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  MailError,
  type AdmissionLimits,
  type EncryptionConfig,
  type SmtpConfig,
} from "./mail/contracts";

const productionResource = "https://emailmcp.ryanpaulanderson.com/mcp";
const localHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "app-a",
  "app-b",
  "auth-fixture",
  "mailpit",
  "postgres",
  "smtp-fault",
]);

/** Explicit environment boundary, independent of framework-specific ambient types. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** Identity-provider settings shared by discovery and token verification. */
export interface AuthConfig {
  resource: string;
  issuer: string;
  jwksUrl: string;
  owner: string;
  allowedOrigins: readonly string[];
}

/** Complete settings required only when a send is requested. */
export interface MailConfig {
  encryption: EncryptionConfig;
  smtp: SmtpConfig;
  hmacKeys: Readonly<Record<string, Buffer>>;
  currentHmacKey: string;
}

/** Read an environment value or a mounted file, rejecting ambiguous sources. */
export function readSetting(
  name: string,
  env: Environment = process.env,
): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined)
    throw new MailError("AMBIGUOUS_CONFIGURATION");
  if (!file) return direct;
  try {
    return readFileSync(file, "utf8").trim();
  } catch (cause) {
    throw new MailError("CONFIGURATION_FILE_UNAVAILABLE", { cause });
  }
}

/** Test mode is permitted only outside Vercel and never disables authentication. */
export function isTestEnvironment(env: Environment = process.env): boolean {
  if (env.APP_ENV === "test" && env.VERCEL)
    throw new MailError("UNSAFE_TEST_CONFIGURATION");
  if (env.APP_ENV && !["test", "production"].includes(env.APP_ENV))
    throw new MailError("INVALID_CONFIGURATION");
  return env.APP_ENV === "test";
}

function endpoint(
  value: string | undefined,
  test: boolean,
  requiredHttps = false,
): string {
  if (!value) throw new MailError("CONFIGURATION_REQUIRED");
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new MailError("INVALID_CONFIGURATION", { cause });
  }
  if (url.username || url.password || url.hash || url.search)
    throw new MailError("INVALID_CONFIGURATION");
  if (
    url.protocol !== "https:" &&
    !(test && !requiredHttps && url.protocol === "http:" && localHosts.has(url.hostname))
  ) {
    throw new MailError("HTTPS_REQUIRED");
  }
  return value;
}

/** Load OAuth resource settings without requiring mail or database credentials. */
export function loadAuthConfig(env: Environment = process.env): AuthConfig {
  const test = isTestEnvironment(env);
  const resource = endpoint(env.MCP_RESOURCE_URL ?? productionResource, test);
  if (new URL(resource).pathname !== "/mcp") throw new MailError("INVALID_CONFIGURATION");
  const issuer = endpoint(env.OAUTH_ISSUER_URL, test, true);
  const jwksUrl = endpoint(env.OAUTH_JWKS_URL, test, true);
  const owner = env.OWNER_SUBJECT;
  if (!owner || owner.length > 512) throw new MailError("CONFIGURATION_REQUIRED");
  const allowedOrigins = [new URL(resource).origin, "https://chatgpt.com"];
  for (const raw of (env.MCP_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)) {
    const origin = endpoint(raw.trim(), test).replace(/\/$/, "");
    if (new URL(origin).origin !== origin) throw new MailError("INVALID_CONFIGURATION");
    allowedOrigins.push(origin);
  }
  return { resource, issuer, jwksUrl, owner, allowedOrigins };
}

/** Sending is opt-in; unconfigured deployments remain unable to submit mail. */
export function sendingEnabled(env: Environment = process.env): boolean {
  if (env.SEND_ENABLED === undefined || env.SEND_ENABLED === "false") return false;
  if (env.SEND_ENABLED !== "true") throw new MailError("INVALID_CONFIGURATION");
  isTestEnvironment(env);
  return true;
}

/** Load a bounded PostgreSQL connection; remote production connections verify TLS. */
export function loadDatabaseUrl(env: Environment = process.env): string {
  const value = readSetting("DATABASE_URL", env);
  if (!value) throw new MailError("CONFIGURATION_REQUIRED");
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new MailError("INVALID_CONFIGURATION", { cause });
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new MailError("INVALID_CONFIGURATION");
  // Driver query parameters may override URL authority and TLS settings. Keep
  // the supported connection-string surface explicit and reject duplicates.
  const allowed = new Set(["sslmode", "channel_binding", "application_name"]);
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1)
      throw new MailError("INVALID_CONFIGURATION");
  }
  if (!url.hostname || url.hash) throw new MailError("INVALID_CONFIGURATION");
  if (isTestEnvironment(env)) {
    if (!localHosts.has(url.hostname)) throw new MailError("UNSAFE_TEST_CONFIGURATION");
  } else if (url.searchParams.get("sslmode") !== "verify-full") {
    throw new MailError("DATABASE_TLS_REQUIRED");
  }
  return value;
}

/** Resource bounds shared by every server instance. Leases outlive the function. */
export function admissionLimits(): AdmissionLimits {
  return {
    concurrent: 2,
    perMinute: 10,
    perDay: 100,
    capacity: 100_000,
    leaseMs: 90_000,
  };
}

/** Load email and keyed-digest settings, validating before any external submission. */
export function loadMailConfig(env: Environment = process.env): MailConfig {
  const test = isTestEnvironment(env);
  const mailbox = z
    .string()
    .regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/)
    .max(254);
  const parsed = z
    .object({
      from: mailbox,
      to: mailbox,
      publicKey: z.string().min(64),
      fingerprint: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
      host: z.string().min(1),
      port: z.coerce.number().int().min(1).max(65535),
      username: z.string().min(1).max(254),
      password: z.string().min(1),
      currentKey: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    })
    .safeParse({
      from: env.MAIL_FROM,
      to: env.MAIL_TO,
      publicKey: readSetting("PGP_PUBLIC_KEY", env),
      fingerprint: readSetting("PGP_FINGERPRINT", env),
      host: env.SMTP_HOST ?? "smtp.protonmail.ch",
      port: env.SMTP_PORT ?? "587",
      username: env.SMTP_USERNAME ?? env.MAIL_FROM,
      password: readSetting("SMTP_PASSWORD", env),
      currentKey: env.REQUEST_HMAC_CURRENT_KEY ?? "v1",
    });
  if (!parsed.success) throw new MailError("INVALID_MAIL_CONFIGURATION");
  const p = parsed.data;
  if (test) {
    if (
      !localHosts.has(p.host) ||
      !p.from.endsWith("@localhost") ||
      !p.to.endsWith("@localhost")
    )
      throw new MailError("UNSAFE_TEST_CONFIGURATION");
  } else if (
    p.host !== "smtp.protonmail.ch" ||
    p.port !== 587 ||
    p.username !== p.from ||
    p.from !== p.to ||
    !p.to.endsWith("@ryanpaulanderson.com")
  ) {
    throw new MailError("INVALID_MAIL_CONFIGURATION");
  }
  let rawKeys: unknown;
  try {
    rawKeys = JSON.parse(readSetting("REQUEST_HMAC_KEYS", env) ?? "null");
  } catch (cause) {
    throw new MailError("INVALID_DIGEST_CONFIGURATION", { cause });
  }
  const keys = z
    .record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
      z.string().regex(/^[A-Za-z0-9_-]+$/),
    )
    .safeParse(rawKeys);
  if (!keys.success) throw new MailError("INVALID_DIGEST_CONFIGURATION");
  const keyEntries: Array<[string, Buffer]> = [];
  for (const [name, encoded] of Object.entries(keys.data)) {
    const key = Buffer.from(encoded, "base64url");
    if (key.length < 32) throw new MailError("INVALID_DIGEST_CONFIGURATION");
    keyEntries.push([name, key]);
  }
  const hmacKeys: Record<string, Buffer> = Object.fromEntries(keyEntries);
  if (!Object.hasOwn(hmacKeys, p.currentKey))
    throw new MailError("INVALID_DIGEST_CONFIGURATION");
  const tlsCa = readSetting("SMTP_CA", env);
  if (tlsCa && !test) throw new MailError("INVALID_MAIL_CONFIGURATION");
  return {
    encryption: {
      from: p.from,
      to: p.to,
      publicKey: p.publicKey,
      fingerprint: p.fingerprint.toLowerCase(),
    },
    smtp: {
      from: p.from,
      to: p.to,
      host: p.host,
      port: p.port,
      username: p.username,
      password: p.password,
      timeoutMs: 30_000,
      ...(tlsCa ? { tlsCa } : {}),
    },
    currentHmacKey: p.currentKey,
    hmacKeys,
  };
}
