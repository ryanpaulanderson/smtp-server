import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admissionLimits,
  isTestEnvironment,
  loadAuthConfig,
  loadDatabaseUrl,
  loadMailConfig,
  readSetting,
  sendingEnabled,
} from "../../src/config.js";

const production = {
  OAUTH_ISSUER_URL: "https://issuer.example.com/",
  OAUTH_JWKS_URL: "https://issuer.example.com/jwks",
  OWNER_SUBJECT: "owner",
  MAIL_FROM: "fixture@ryanpaulanderson.com",
  MAIL_TO: "fixture@ryanpaulanderson.com",
  PGP_PUBLIC_KEY: "public fixture".repeat(10),
  PGP_FINGERPRINT: "a".repeat(40),
  SMTP_PASSWORD: "fixture-password",
  REQUEST_HMAC_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 1).toString("base64url") }),
};

describe("operator configuration", () => {
  it("loads production defaults without changing issuer identity", () => {
    const auth = loadAuthConfig(production);
    expect(auth.resource).toBe("https://emailmcp.ryanpaulanderson.com/mcp");
    expect(auth.issuer).toBe("https://issuer.example.com/");
    expect(loadMailConfig(production).smtp).toMatchObject({
      host: "smtp.protonmail.ch",
      port: 587,
      username: production.MAIL_FROM,
      timeoutMs: 30_000,
    });
    expect(sendingEnabled(production)).toBe(false);
    expect(sendingEnabled({ SEND_ENABLED: "true" })).toBe(true);
    expect(admissionLimits()).toMatchObject({
      concurrent: 2,
      perMinute: 10,
      perDay: 100,
      leaseMs: 90_000,
    });
  });

  it("requires HTTPS and a configured owner for OAuth", () => {
    expect(() =>
      loadAuthConfig({ ...production, OAUTH_ISSUER_URL: "http://issuer.example.com" }),
    ).toThrow("HTTPS_REQUIRED");
    expect(() =>
      loadAuthConfig({
        ...production,
        MCP_RESOURCE_URL: "https://emailmcp.example.com/other",
      }),
    ).toThrow("INVALID_CONFIGURATION");
    expect(() => loadAuthConfig({ ...production, OWNER_SUBJECT: "" })).toThrow(
      "CONFIGURATION_REQUIRED",
    );
    expect(() =>
      loadAuthConfig({
        ...production,
        OAUTH_JWKS_URL: "https://secret@issuer.example.com/jwks",
      }),
    ).toThrow("INVALID_CONFIGURATION");
    expect(() =>
      loadAuthConfig({
        ...production,
        MCP_ALLOWED_ORIGINS: "https://client.example/path",
      }),
    ).toThrow("INVALID_CONFIGURATION");
  });

  it("confines test exceptions to local services outside Vercel", () => {
    expect(() => isTestEnvironment({ APP_ENV: "test", VERCEL: "1" })).toThrow(
      "UNSAFE_TEST_CONFIGURATION",
    );
    expect(() => isTestEnvironment({ APP_ENV: "staging" })).toThrow(
      "INVALID_CONFIGURATION",
    );
    expect(() => sendingEnabled({ SEND_ENABLED: "yes" })).toThrow(
      "INVALID_CONFIGURATION",
    );
    expect(
      loadAuthConfig({
        ...production,
        APP_ENV: "test",
        MCP_RESOURCE_URL: "http://app-a:3000/mcp",
      }).resource,
    ).toBe("http://app-a:3000/mcp");
    expect(() =>
      loadAuthConfig({
        ...production,
        APP_ENV: "test",
        MCP_RESOURCE_URL: "http://external.example/mcp",
      }),
    ).toThrow("HTTPS_REQUIRED");
    const testMail = {
      ...production,
      APP_ENV: "test",
      SMTP_HOST: "mailpit",
      MAIL_FROM: "sender@localhost",
      MAIL_TO: "recipient@localhost",
      SMTP_CA: "test-ca",
    };
    expect(loadMailConfig(testMail).smtp.tlsCa).toBe("test-ca");
    expect(() => loadMailConfig({ ...testMail, SMTP_HOST: "remote.example" })).toThrow(
      "UNSAFE_TEST_CONFIGURATION",
    );
  });

  it("requires production mailbox, provider and encryption configuration", () => {
    for (const change of [
      { MAIL_TO: "outsider@example.com" },
      { SMTP_HOST: "elsewhere.example" },
      { SMTP_PORT: "25" },
      { PGP_FINGERPRINT: "a".repeat(48) },
      { PGP_PUBLIC_KEY: "" },
      { SMTP_USERNAME: "other" },
      { SMTP_CA: "custom" },
    ]) {
      expect(() => loadMailConfig({ ...production, ...change })).toThrow();
    }
    for (const value of [
      "invalid json",
      "null",
      JSON.stringify({ v1: "tiny" }),
      JSON.stringify({ other: Buffer.alloc(32).toString("base64url") }),
    ]) {
      expect(() => loadMailConfig({ ...production, REQUEST_HMAC_KEYS: value })).toThrow(
        "INVALID_DIGEST_CONFIGURATION",
      );
    }
  });

  it("requires verified remote database TLS and local-only test databases", () => {
    expect(
      loadDatabaseUrl({
        DATABASE_URL:
          "postgresql://user:fixture@database.example/test?sslmode=verify-full",
      }),
    ).toContain("verify-full");
    expect(() =>
      loadDatabaseUrl({
        DATABASE_URL: "postgresql://database.example/test?sslmode=require",
      }),
    ).toThrow("DATABASE_TLS_REQUIRED");
    expect(() =>
      loadDatabaseUrl({
        APP_ENV: "test",
        DATABASE_URL: "postgresql://external.example/test",
      }),
    ).toThrow("UNSAFE_TEST_CONFIGURATION");
    expect(
      loadDatabaseUrl({ APP_ENV: "test", DATABASE_URL: "postgresql://postgres/test" }),
    ).toBe("postgresql://postgres/test");
    for (const url of [
      "postgresql://database.example/test?sslmode=verify-full&sslmode=disable",
      "postgresql://postgres/test?host=external.example",
      "postgresql://database.example/test?sslmode=verify-full&sslrootcert=/tmp/untrusted",
    ]) {
      expect(() => loadDatabaseUrl({ DATABASE_URL: url })).toThrow(
        "INVALID_CONFIGURATION",
      );
    }
  });

  it("does not accept inherited object properties as digest keys", () => {
    expect(() =>
      loadMailConfig({
        ...production,
        REQUEST_HMAC_KEYS: "{}",
        REQUEST_HMAC_CURRENT_KEY: "constructor",
      }),
    ).toThrow("INVALID_DIGEST_CONFIGURATION");
  });

  it("reads mounted values and never includes the path or content in public errors", () => {
    const folder = mkdtempSync(join(tmpdir(), "email-config-"));
    try {
      const file = join(folder, "value");
      writeFileSync(file, "fixture secret\n", { mode: 0o600 });
      expect(readSetting("VALUE", { VALUE_FILE: file })).toBe("fixture secret");
      expect(() => readSetting("VALUE", { VALUE: "value", VALUE_FILE: file })).toThrow(
        "AMBIGUOUS_CONFIGURATION",
      );
      expect(() => readSetting("VALUE", { VALUE_FILE: join(folder, "missing") })).toThrow(
        "CONFIGURATION_FILE_UNAVAILABLE",
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
