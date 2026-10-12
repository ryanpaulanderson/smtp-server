-- Metadata is retained permanently to prevent duplicate submissions.
-- The restricted runtime role requires USAGE on email_mcp and SELECT, INSERT,
-- UPDATE on send_attempts only. It must not own the schema or migration table.
CREATE SCHEMA IF NOT EXISTS email_mcp;
REVOKE ALL ON SCHEMA email_mcp FROM PUBLIC;

CREATE TABLE email_mcp.send_attempts (
    owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 512),
    request_id uuid NOT NULL,
    digest_key_id text NOT NULL CHECK (length(digest_key_id) BETWEEN 1 AND 128),
    payload_digest text NOT NULL CHECK (length(payload_digest) BETWEEN 1 AND 512),
    message_id text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 998),
    encryption_fingerprint text NOT NULL CHECK (length(encryption_fingerprint) BETWEEN 1 AND 128),
    status text NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'accepted', 'rejected', 'unknown')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    active_until timestamptz NOT NULL,
    error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,64}$'),
    PRIMARY KEY (owner, request_id)
);

CREATE INDEX send_attempts_owner_created_at
    ON email_mcp.send_attempts (owner, created_at);

CREATE INDEX send_attempts_active_until
    ON email_mcp.send_attempts (active_until)
    WHERE status IN ('in_progress', 'unknown');

REVOKE ALL ON email_mcp.send_attempts FROM PUBLIC;

COMMENT ON TABLE email_mcp.send_attempts IS
    'Permanent owner-scoped submission evidence; never store note content or credentials.';
COMMENT ON COLUMN email_mcp.send_attempts.active_until IS
    'SMTP capacity lease: retain until socket cleanup or process lifetime is certainly over.';
