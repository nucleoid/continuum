-- Identity proofing, service credentials, and source-owned Entra memberships.

ALTER TABLE scope_memberships DROP CONSTRAINT scope_memberships_pkey;
ALTER TABLE scope_memberships
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual', 'entra')),
  ADD COLUMN source_id TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN deactivated_at TIMESTAMPTZ,
  ADD COLUMN synced_at TIMESTAMPTZ;
ALTER TABLE scope_memberships
  ADD PRIMARY KEY (principal_id, scope_id, source_kind, source_id);
CREATE UNIQUE INDEX scope_memberships_manual_unique
  ON scope_memberships (principal_id, scope_id)
  WHERE source_kind = 'manual';
CREATE INDEX scope_memberships_active_principal_idx
  ON scope_memberships (principal_id, scope_id) WHERE active;

CREATE TABLE entra_groups (
  external_id   TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  scope_id      UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  role          TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'admin')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

CREATE TABLE service_api_keys (
  id             UUID PRIMARY KEY,
  principal_id   UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key_hash       BYTEA NOT NULL UNIQUE,
  prefix         TEXT NOT NULL,
  last_four      TEXT NOT NULL,
  allowed_source TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  CHECK (char_length(prefix) BETWEEN 4 AND 16),
  CHECK (char_length(last_four) = 4),
  CHECK (allowed_source IS NULL OR char_length(allowed_source) BETWEEN 1 AND 128)
);
CREATE INDEX service_api_keys_principal_idx ON service_api_keys (principal_id);
