# Vercel and account setup

The first implementation is ready for configuration and acceptance testing. This guide
describes the steps an account owner or administrator must complete; it does not record a
completed deployment. Keep `SEND_ENABLED=false` until the pre-send checks below pass and
the owner approves a harmless live test.

The exact mailbox, exported public key, approved fingerprint, Proton SMTP token, Descope
project configuration, and restricted PostgreSQL connection are still required. Enter
credentials directly into the provider's secret storage or a trusted local secret tool. Do
not paste passwords, tokens, connection strings, private keys, or complete JWTs into chat
or commit them to this repository.

## 1. Prepare the Vercel project and hostname

Use a dedicated Vercel project linked to this repository. Reuse an existing project for
this service if one has already been created; keep it separate from the wedding
application. No Vercel project, provider account, DNS record, or production database has
been provisioned by this implementation pass.

Publish the reviewed implementation to GitHub before importing or deploying it. Select the
revision containing the application; the earlier documentation-only revision cannot run
this service.

- Select the Next.js framework preset and the repository root.
- Use Node.js 24 and the pnpm version declared in `package.json`.
- Set the install command to `pnpm install --frozen-lockfile` and the build command to
  `pnpm build`. Keep Vercel's normal Next.js output handling; the standalone Docker output
  is for the local acceptance environment.
- Add only `emailmcp.ryanpaulanderson.com` to this project. Use the exact DNS record
  Vercel provides for this hostname and verify its HTTPS certificate. Preserve the apex
  website and Proton's MX, SPF, DKIM, and DMARC records.
- Keep production secrets scoped to Production. Preview deployments must have sending
  disabled and must not receive the production database, SMTP token, or encryption
  configuration. A preview requiring functional tests needs its own isolated accounts,
  data, and approved recipient.

The service URL and OAuth resource identifier are both:

```text
https://emailmcp.ryanpaulanderson.com/mcp
```

The `/mcp` route uses a Node.js runtime and a 60-second function limit. Builds do not open
SMTP connections or apply migrations. Review the installed Vercel plan, function settings,
region, and database connection limits before rollout.
[Vercel MCP hosting](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel),
[custom domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain)

## 2. Configure Descope MCP Auth

Install the **Descope MCP Auth** product from the
[Vercel Marketplace](https://vercel.com/marketplace/descope), and associate it with this
service's Vercel project. Review the offer and account limits before accepting provider
terms. The integration can create or associate a Descope project and set up dynamic client
registration. This repository uses Descope as the OAuth authorization server; it does not
host a sign-in form or an authorization server itself.

In Descope's MCP server resource configuration:

1. Set the server URL/resource to the exact `/mcp` URL above. Access tokens must include
   that URL in `aud`; a Descope project ID is not a substitute.
2. Define `email:send:self` for submitting one encrypted email and `email:status:self` for
   reading submission metadata. Configure consent and user authentication for the intended
   owner.
3. Enable the supported registration path for the intended ChatGPT and Codex clients. Use
   their actual registration metadata and callback addresses; require authorization-code
   flow with PKCE S256. Review and restrict registered clients according to the account's
   supported controls. If using pre-registered clients, grant access through the
   resource's access policy. Enable client metadata discovery only for a supported client
   flow, and do not substitute broad callback wildcards for the client's actual registered
   addresses.
4. Find the issuer and authorization-server discovery URL in the resource's **Usage
   Samples**. Read the discovery document and copy its exact `issuer` and `jwks_uri`
   values into `OAUTH_ISSUER_URL` and `OAUTH_JWKS_URL`.
5. Sign in as the owner and obtain that user's immutable subject identifier for
   `OWNER_SUBJECT`. Use the identifier matching the token's `sub`, not an email address,
   client ID, or project ID. Inspect claims locally or in trusted provider tooling without
   uploading the token to a third-party decoder.

Marketplace variables are not automatically equivalent to the names this application
consumes. Map the provider's actual values to the configuration table below. No Descope
management key is required by the request handler.
[Descope MCP server configuration](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers),
[discovery fields](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/discovery-url),
[client registration](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/registration-methods)

The application publishes protected-resource metadata at
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
An unauthenticated `/mcp` request must receive an OAuth challenge. Valid tokens still need
the exact owner and the relevant tool scope. Vercel deployment protection must not replace
this authorization or prevent the intended clients from reaching OAuth discovery and the
MCP endpoint.

## 3. Isolate PostgreSQL access and apply migrations

Reuse the existing PostgreSQL service only after its operator has verified safe isolation.
The application owns the `email_mcp` schema; it does not need access to wedding tables,
credentials, or migrations. A schema name alone is not a permission boundary. If inherited
or public grants make isolation impossible, review a separate logical database on the same
service before proceeding.

Use distinct credentials for schema administration and runtime access. Have the database
operator create the runtime role with login and no broad administrative or inherited
application permissions. Apply migrations from a trusted administrative session:

```sh
DATABASE_ADMIN_URL_FILE=/absolute/path/to/admin-database-url pnpm db:migrate
```

The path is an operator-supplied secret file outside the repository. Alternatively provide
`DATABASE_ADMIN_URL` through the process environment, but never both. The script does not
load `.env.local`, fall back to `DATABASE_URL`, or run during application startup/build.
It applies SQL files atomically under an advisory lock, stores their checksums, and
rejects edited or missing migration history. Keep applied migration files immutable.

After migration, grant the runtime role only schema usage and the three required table
operations. For an operator-created role named `email_mcp_app`, the grants are:

```sql
GRANT USAGE ON SCHEMA email_mcp TO email_mcp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE email_mcp.send_attempts TO email_mcp_app;
```

Grant connection to the selected database if required by the provider's policy. Do not
grant schema ownership, `CREATE`, `DELETE`, migration-history access, or wedding-table
access. Verify effective permissions, including role memberships and public grants, using
the runtime identity before enabling the service.

Put only the runtime connection in Vercel's `DATABASE_URL`. It must use
`sslmode=verify-full`. The supported URL query keys are `sslmode`, `channel_binding`, and
`application_name`; duplicate keys and query-string host/user/port overrides are rejected.
Use the provider's supported endpoint with a valid certificate. Confirm that its
connection mode supports transactions and PostgreSQL advisory transaction locks.

Records contain request IDs, keyed digests, outcome metadata, and timestamps. They are
retained to prevent duplicates; the application rejects new sends when its configured
capacity is reached. Do not delete history to clear an error. Coordinate backups and
recovery with the existing database owner. Following a restore, keep sending disabled
until missing submission history is reconciled.

## 4. Prepare the mailbox, key, and server configuration

Confirm that the selected custom-domain address can generate an SMTP token in Proton.
Create a dedicated token for this service at **Settings → All settings → IMAP/SMTP → SMTP
tokens**, selecting that address. The token is the SMTP password; the normal Proton
account and mailbox passwords are not used. This service requires `smtp.protonmail.ch:587`
with STARTTLS and certificate verification. The account's entitlement remains a live
prerequisite. [Proton SMTP setup](https://proton.me/support/smtp-submission)

Export the **public** key for the same receiving address from Proton and verify its
fingerprint through a trusted account view. Preserve the armored key's real line breaks.
Do not export or provide a private key to Vercel. The implementation requires one
unrevoked, unexpired public certificate, an encryption-capable key, a matching address
identity, and the approved fingerprint. Compatibility with the owner's actual key still
needs testing, including any newer key algorithm.
[Exporting Proton keys](https://proton.me/support/download-public-private-key)

Use [.env.example](../../.env.example) as the complete configuration inventory. Set the
following values directly in this project's **Production** environment:

| Setting                                 | Required value or source                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                               | `production`; never use `test` on Vercel.                                                                                                                |
| `MCP_RESOURCE_URL`                      | `https://emailmcp.ryanpaulanderson.com/mcp`.                                                                                                             |
| `OAUTH_ISSUER_URL`                      | Exact issuer from the selected Descope resource's discovery document.                                                                                    |
| `OAUTH_JWKS_URL`                        | Exact HTTPS `jwks_uri` from that document.                                                                                                               |
| `OWNER_SUBJECT`                         | The intended owner's immutable Descope `sub`.                                                                                                            |
| `SEND_ENABLED`                          | `false` during setup; change only for authorized live acceptance and operation.                                                                          |
| `DATABASE_URL`                          | Restricted runtime PostgreSQL connection with `sslmode=verify-full`.                                                                                     |
| `MAIL_FROM`, `MAIL_TO`, `SMTP_USERNAME` | The same verified `@ryanpaulanderson.com` mailbox; the username must match the SMTP token.                                                               |
| `SMTP_HOST`, `SMTP_PORT`                | `smtp.protonmail.ch`, `587`; these are also the defaults.                                                                                                |
| `SMTP_PASSWORD`                         | Dedicated Proton SMTP token.                                                                                                                             |
| `PGP_PUBLIC_KEY`                        | Armored public key for the receiving address.                                                                                                            |
| `PGP_FINGERPRINT`                       | Approved 40- or 64-character hexadecimal fingerprint.                                                                                                    |
| `REQUEST_HMAC_KEYS`                     | JSON mapping of key identifiers to base64url-encoded random keys of at least 32 bytes each.                                                              |
| `REQUEST_HMAC_CURRENT_KEY`              | Identifier of the active digest key, initially `v1`.                                                                                                     |
| `MCP_ALLOWED_ORIGINS`                   | Optional comma-separated HTTPS origins for an additional trusted browser client; the service's origin and `https://chatgpt.com` are included by default. |

Treat the database URL, SMTP token, and HMAC keys as server-side Secrets. Nothing here
needs a `NEXT_PUBLIC_` prefix. Retain old HMAC keys when rotating the active key so
existing request IDs can still be checked. Public-key rotation does not justify deleting
submission history.

Generate the HMAC key with a trusted local cryptographic tool or password manager. It is a
separate random key, not the SMTP token or PGP key. `REQUEST_HMAC_KEYS` has the shape
`{"v1":"<base64url-encoded random key>"}`; replace the placeholder with at least 32 random
bytes encoded as base64url, and keep that value out of source control.

Mounted `_FILE` alternatives are available for selected settings in local environments.
The Docker suite uses them for generated fixture material. Do not copy fixture paths,
`TEST_*` values, custom test certificate authorities, or `DATABASE_ADMIN_URL` into the
Vercel request handler. Apply environment changes through a new deployment.
[Vercel environment variables](https://vercel.com/docs/environment-variables)

## 5. Complete live acceptance deliberately

Before any real email, verify HTTPS and public discovery, unauthenticated rejection,
Descope login from both ChatGPT and Codex, wrong-owner and missing-scope denials, and a
harmless status lookup against the isolated runtime database. Keep sending disabled
throughout these checks. A successful deployment or status lookup does not validate the
actual PGP key or SMTP credentials.

Once those checks pass and the owner approves the test, set `SEND_ENABLED=true` and deploy
that configuration. Send one harmless note with a new UUID through the intended client.
Verify its visible subject, successful automatic decryption in Proton, exact title/body,
and Inbox/Sent behavior. Repeat the client-specific acceptance for the other client with
deliberate authorization. Reuse the same UUID to verify duplicate suppression; changing
content under that UUID must return a conflict. An `accepted` response proves submission
only.

If an outcome is `unknown`, look up the original UUID and inspect the mailbox. Do not
automatically send again or generate another UUID. If any acceptance check fails, disable
sending before further work.

The current stop control is `SEND_ENABLED=false` followed by redeployment. For an
immediate SMTP stop, revoke this service's token in Proton. The first pass does not
provide a separate remote feature flag. Status lookup can remain available without loading
SMTP or encryption credentials.

Provider sign-in, account terms, mailbox/key selection, secret entry, and final live-send
approval require the owner's involvement. None of the local generated fixtures establish
that those account-specific steps have succeeded.
