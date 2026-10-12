/** Authenticated Streamable HTTP transport and narrowly scoped email tools. */
import { createMcpHandler } from "mcp-handler";
import type {
  AuthInfo,
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { loadAuthConfig, sendingEnabled, type AuthConfig } from "../config";
import { createTokenVerifier } from "../auth/token";
import { requirePermission, SEND_SCOPE, STATUS_SCOPE } from "../auth/policy";
import { MailError } from "../mail/contracts";
import { noteSchema, statusSchema } from "../mail/note";
import { createApplicationRuntime } from "../runtime";
import { readBoundedBody } from "./body";
import manifest from "../../package.json";

const instructions =
  "Send only when the owner authorizes the email. The subject is visible, unencrypted metadata: judge sensitivity and ask the owner when uncertain. Put the full title and sensitive information inside the encrypted body. Reuse the original request_id when checking or repeating an attempt; never create a new ID to bypass an unknown outcome.";

function metadataUrl(config: AuthConfig): string {
  return new URL("/.well-known/oauth-protected-resource", config.resource).href;
}

function challenge(config: AuthConfig, scope?: string): string {
  return `Bearer resource_metadata="${metadataUrl(config)}"${scope ? `, scope="${scope}"` : ""}`;
}

function authorize(context: ServerContext, config: AuthConfig, scope: string): AuthInfo {
  const auth = context.http?.authInfo;
  if (!auth || typeof auth.extra?.subject !== "string")
    throw new MailError("INVALID_TOKEN");
  requirePermission(
    { subject: auth.extra.subject, scopes: auth.scopes, clientId: auth.clientId },
    config.owner,
    scope,
  );
  return auth;
}

function toolError(error: unknown, config: AuthConfig, scope: string): CallToolResult {
  const code = error instanceof MailError ? error.code : "INTERNAL_ERROR";
  return {
    isError: true,
    content: [{ type: "text", text: code }],
    structuredContent: { error_code: code },
    ...(code === "INSUFFICIENT_SCOPE"
      ? {
          _meta: {
            "mcp/www_authenticate": [
              `${challenge(config, scope)}, error="insufficient_scope"`,
            ],
          },
        }
      : {}),
  };
}

/** Create one application handler with resource caches, never shared user state. */
export function createAuthenticatedHandler(config: AuthConfig) {
  const verify = createTokenVerifier(config);
  let runtime: ReturnType<typeof createApplicationRuntime> | undefined;
  const application = () => (runtime ??= createApplicationRuntime(config));
  const mcp = createMcpHandler(
    (server) => {
      server.registerTool(
        "send_encrypted_email",
        {
          title: "Email an encrypted note to myself",
          description: instructions,
          inputSchema: noteSchema,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
            idempotentHint: true,
          },
          _meta: { securitySchemes: [{ type: "oauth2", scopes: [SEND_SCOPE] }] },
        },
        async (note, context) => {
          try {
            authorize(context, config, SEND_SCOPE);
            if (!sendingEnabled()) throw new MailError("SEND_DISABLED");
            const result = await application().send(note, context.mcpReq.signal);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: { ...result },
            };
          } catch (error) {
            return toolError(error, config, SEND_SCOPE);
          }
        },
      );
      server.registerTool(
        "get_email_send_status",
        {
          title: "Check an email submission",
          description:
            "Return the saved submission result for an existing request_id. Never sends email. Accepted means Proton accepted submission, not proven inbox delivery; unknown must not be retried with a new ID without the owner's direction.",
          inputSchema: statusSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
            idempotentHint: true,
          },
          _meta: { securitySchemes: [{ type: "oauth2", scopes: [STATUS_SCOPE] }] },
        },
        async ({ request_id }, context) => {
          try {
            authorize(context, config, STATUS_SCOPE);
            const result = await application().status(request_id);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: { ...result },
            };
          } catch (error) {
            return toolError(error, config, STATUS_SCOPE);
          }
        },
      );
    },
    {
      serverInfo: { name: manifest.name, version: manifest.version },
      instructions,
      maxSubscriptions: 0,
      verboseLogs: false,
    },
  );

  return {
    /** Verify identity before reading bounded message content or invoking a tool. */
    async handle(request: Request): Promise<Response> {
      const origin = request.headers.get("origin");
      if (origin && !config.allowedOrigins.includes(origin))
        return Response.json({ error: "ORIGIN_NOT_ALLOWED" }, { status: 403 });
      const headers = new Headers({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
        headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
      }
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        headers.set(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
        );
        return new Response(null, { status: 204, headers });
      }
      const authorization = request.headers.get("authorization");
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      let auth: AuthInfo;
      try {
        if (!match?.[1]) throw new MailError("INVALID_TOKEN");
        auth = await verify(match[1]);
      } catch (error) {
        const forbidden = error instanceof MailError && error.code === "FORBIDDEN_OWNER";
        if (!forbidden) headers.set("WWW-Authenticate", challenge(config));
        return Response.json(
          { error: forbidden ? "FORBIDDEN_OWNER" : "INVALID_TOKEN" },
          { status: forbidden ? 403 : 401, headers },
        );
      }
      try {
        let authenticated = request;
        if (request.method === "POST") {
          if (!request.headers.get("content-type")?.includes("application/json"))
            return Response.json({ error: "JSON_REQUIRED" }, { status: 415, headers });
          const bytes = await readBoundedBody(request);
          authenticated = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: Buffer.from(bytes),
            signal: request.signal,
          });
        }
        authenticated.auth = auth;
        const result = await mcp(authenticated);
        for (const [name, value] of headers) result.headers.set(name, value);
        return result;
      } catch (error) {
        const code = error instanceof MailError ? error.code : "INTERNAL_ERROR";
        return Response.json(
          { error: code },
          {
            status:
              code === "REQUEST_TOO_LARGE" ? 413 : code === "REQUEST_TIMEOUT" ? 408 : 500,
            headers,
          },
        );
      }
    },
    /** Close resources during test teardown; no persistent messages are kept in process. */
    close: async () => {
      await runtime?.close();
    },
  };
}

let active: ReturnType<typeof createAuthenticatedHandler> | undefined;

/** Next.js entry point: initialize resources on demand and fail closed when unconfigured. */
export async function handleMcp(request: Request): Promise<Response> {
  try {
    return await (active ??= createAuthenticatedHandler(loadAuthConfig())).handle(
      request,
    );
  } catch {
    return Response.json(
      { error: "SERVICE_NOT_CONFIGURED" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** Public RFC 9728 discovery; metadata contains no credentials or mailbox identity. */
export function resourceMetadata(): Response {
  try {
    const config = loadAuthConfig();
    return Response.json(
      {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: [SEND_SCOPE, STATUS_SCOPE],
        bearer_methods_supported: ["header"],
      },
      {
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json({ error: "SERVICE_NOT_CONFIGURED" }, { status: 503 });
  }
}
