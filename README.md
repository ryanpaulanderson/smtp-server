# smtp-server

Private MCP service for sending PGP-encrypted notes to one configured Proton mailbox.
ChatGPT or Codex supplies the note; the service verifies the owner's OAuth token, encrypts
the content in memory, and submits it over authenticated SMTP with mandatory STARTTLS.

This is the first implementation pass. Live Descope sign-in, Vercel hosting, Proton
delivery, and compatibility with the owner's actual PGP key still need acceptance testing.
Sending is disabled unless `SEND_ENABLED=true` is explicitly configured. No private PGP
key belongs in the application.

## Local verification

Use Node.js 24, the pnpm version pinned in [package.json](package.json), and Docker with
the Compose plugin. Install dependencies and run the shared checks:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` includes the real production build and an isolated Docker suite. It generates
fresh credentials and test keys, runs two application instances against disposable
PostgreSQL, and sends only from `sender@localhost` to `recipient@localhost` through
Mailpit. SMTP still requires authentication, STARTTLS, and certificate verification. The
suite neither needs nor uses production environment files, Proton credentials, or the
owner's key.

| Command                   | Purpose                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`       | Check formatting without changing files.                                                                                                     |
| `pnpm lint`               | Check TypeScript, documentation links and structure, workflow syntax, and Compose configuration. Docker is required for workflow validation. |
| `pnpm typecheck`          | Generate Next.js route types and check TypeScript.                                                                                           |
| `pnpm test:unit`          | Run deterministic unit tests with the configured coverage thresholds.                                                                        |
| `pnpm build`              | Build Next.js without connecting to mail or production databases.                                                                            |
| `pnpm test:integration`   | Build and run the disposable Docker acceptance suite, then remove its containers and volumes.                                                |
| `pnpm audit:dependencies` | Check the resolved dependency tree; this requires network access and fails on high/critical advisories.                                      |
| `pnpm db:migrate`         | Explicitly apply immutable SQL migrations using separately supplied administrative credentials.                                              |

To inspect the local application and captured mail, start the same topology with
loopback-only UI ports:

```sh
docker compose --project-name email-mcp-local --env-file /dev/null -f compose.yaml -f compose.local.yaml up --build --wait app-a app-b
```

The application is at `http://127.0.0.1:3000` and Mailpit at `http://127.0.0.1:8025`. The
MCP endpoint still requires a generated fixture token; opening the UI does not bypass
authentication. Run the fixture client to exercise both application instances:

```sh
docker compose --project-name email-mcp-local --env-file /dev/null -f compose.yaml -f compose.local.yaml run --rm --no-deps test-runner
docker compose --project-name email-mcp-local --env-file /dev/null -f compose.yaml -f compose.local.yaml down --volumes --remove-orphans
```

The base topology exposes no host ports and uses an internal network. Automated runs print
their unique project name and cleanup command if a run is interrupted. Never add
production credentials to these fixtures.

The disposable database uses PostgreSQL 18 with its named data volume mounted at
`/var/lib/postgresql`. Existing PostgreSQL 17 fixture volumes cannot be reused directly.
If you previously started `email-mcp-local`, run the cleanup command above before starting
the updated topology. This deletes only that project's disposable test data and captured
mail; never use it against a database containing data you need to retain.

Docker Node major updates are excluded from Dependabot because the build image, production
image, package engine, and hosting configuration must agree on Node.js 24. Review a
runtime migration as one coordinated change; minor and patch updates remain enabled.

## Operation and configuration

The service exposes `send_encrypted_email` and `get_email_send_status` at `/mcp`. Each
intended email has an owner-scoped UUID. Reusing it returns the saved result; changing its
content produces a conflict. `accepted` means the SMTP server acknowledged submission, not
that the message reached the Inbox. `unknown` must not trigger an automatic retry or a
replacement UUID.

The subject remains visible metadata. The full title and body are encrypted. Sender,
recipient, SMTP settings, and encryption keys are operator configuration, never tool
arguments. PostgreSQL retains only submission metadata and a keyed digest; it stores no
titles, bodies, subjects, or ciphertext.

Follow the [Vercel and account setup guide](docs/setup/vercel.md) before deploying. Use
[.env.example](.env.example) as the configuration inventory, not as a working credential
file. Builds never apply database migrations. The `CI` workflow's `required` job
aggregates quality, unit, integration, and dependency-audit jobs; configure repository
protection to require it. Dependabot covers npm, GitHub Actions, Dockerfile images, and
Compose images.

## Documentation

- [Encrypted self-email MCP architecture](docs/architecture/encrypted-email-mcp.md) —
  requirements, architectural decisions, acceptance criteria, and decision history.
- [Vercel and account setup](docs/setup/vercel.md) — production configuration, PostgreSQL
  ownership, Descope sign-in, and the remaining live acceptance steps.
