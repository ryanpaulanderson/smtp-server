/** Local HTTPS discovery/JWKS fixture; this does not implement Descope login. */
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const issuer = "https://auth-fixture:8443";
const server = createServer(
  {
    key: readFileSync("/fixtures/auth/server.key"),
    cert: readFileSync("/fixtures/auth/server.crt"),
  },
  (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const body =
      url.pathname === "/jwks.json"
        ? readFileSync("/fixtures/auth/jwks.json", "utf8")
        : url.pathname === "/.well-known/oauth-authorization-server"
          ? JSON.stringify({
              issuer,
              jwks_uri: `${issuer}/jwks.json`,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          : null;
    response.writeHead(body === null ? 404 : 200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(body ?? JSON.stringify({ error: "not_found" }));
  },
);
server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.listen(8443, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
