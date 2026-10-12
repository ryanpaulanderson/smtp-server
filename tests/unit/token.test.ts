import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createTokenVerifier } from "../../src/auth/token.js";
import type { AuthConfig } from "../../src/config.js";

const config: AuthConfig = {
  resource: "https://emailmcp.example.com/mcp",
  issuer: "https://issuer.example.com/",
  jwksUrl: "https://issuer.example.com/jwks",
  owner: "owner",
  allowedOrigins: [],
};
let privateKey: CryptoKey;
let publicJwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
});

async function token(claims: Record<string, unknown> = {}, algorithm = "RS256") {
  return new SignJWT({
    scope: "email:send:self email:status:self",
    azp: "test-client",
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm, kid: "test" })
    .setSubject("owner")
    .setIssuer(config.issuer)
    .setAudience(config.resource)
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("OAuth access token verification", () => {
  it("verifies the signature and exact issuer, resource, owner, expiry and scopes", async () => {
    const verify = createTokenVerifier(config, createLocalJWKSet({ keys: [publicJwk] }));
    expect(await verify(await token())).toMatchObject({
      clientId: "test-client",
      scopes: ["email:send:self", "email:status:self"],
      extra: { subject: "owner" },
    });
    expect(
      await verify(await token({ azp: undefined, scope: "email:status:self" })),
    ).toMatchObject({ clientId: "authenticated-client", scopes: ["email:status:self"] });
  });

  it("rejects untrusted signature, wrong issuer or audience, expired and missing claims", async () => {
    const verify = createTokenVerifier(config, createLocalJWKSet({ keys: [publicJwk] }));
    for (const [name, value] of Object.entries({
      iss: "https://wrong.example/",
      aud: "other",
      exp: 1,
      scope: null,
      sub: null,
    })) {
      const invalid = await new SignJWT({
        iss: config.issuer,
        aud: config.resource,
        sub: "owner",
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: "email:send:self",
        [name]: value,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .sign(privateKey);
      await expect(verify(invalid)).rejects.toThrow("INVALID_TOKEN");
    }
    const other = await generateKeyPair("RS256");
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(other.privateKey);
    await expect(verify(bad)).rejects.toThrow("INVALID_TOKEN");
    await expect(verify("x".repeat(16_385))).rejects.toThrow("INVALID_TOKEN");
  });

  it("rejects another signed-in identity and oversized scope claims", async () => {
    const verify = createTokenVerifier(config, createLocalJWKSet({ keys: [publicJwk] }));
    const other = await new SignJWT({ scope: "email:send:self" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("other")
      .setIssuer(config.issuer)
      .setAudience(config.resource)
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verify(other)).rejects.toThrow("FORBIDDEN_OWNER");
    await expect(verify(await token({ scope: "x".repeat(4097) }))).rejects.toThrow(
      "INVALID_TOKEN",
    );
  });
});
