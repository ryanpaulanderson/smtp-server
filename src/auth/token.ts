/** Signature and claim validation for the configured OAuth authorization server. */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { AuthConfig } from "../config";
import { MailError } from "../mail/contracts";

/** Create a bounded verifier. The optional key resolver is an injectable I/O boundary. */
export function createTokenVerifier(config: AuthConfig, resolver?: JWTVerifyGetKey) {
  const keys =
    resolver ??
    createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  return async (token: string): Promise<AuthInfo> => {
    if (token.length > 16_384) throw new MailError("INVALID_TOKEN");
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "iss", "sub", "aud"],
      });
      if (typeof payload.sub !== "string") throw new MailError("INVALID_TOKEN");
      if (payload.sub !== config.owner) throw new MailError("FORBIDDEN_OWNER");
      if (
        typeof payload.scope !== "string" ||
        payload.scope.length > 4096 ||
        typeof payload.exp !== "number"
      ) {
        throw new MailError("INVALID_TOKEN");
      }
      return {
        token,
        clientId: typeof payload.azp === "string" ? payload.azp : "authenticated-client",
        scopes: payload.scope.split(/\s+/).filter(Boolean),
        expiresAt: payload.exp,
        resource: new URL(config.resource),
        extra: { subject: payload.sub },
      };
    } catch (cause) {
      if (cause instanceof MailError) throw cause;
      throw new MailError("INVALID_TOKEN", { cause });
    }
  };
}
