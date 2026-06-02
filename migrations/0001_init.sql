-- Continuum v0 initial schema.
-- See ARCHITECTURE.md for the design rationale and scope/taxonomy model.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE principals (
  id            UUID PRIMARY KEY,
  external_id   TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('user', 'service')),
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scopes (
  id          UUID PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('org', 'team', 'project', 'user', 'role')),
  name        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE TABLE scope_memberships (
  principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  scope_id      UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'admin')),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, scope_id)
);

CREATE INDEX scope_memberships_scope_idx ON scope_memberships (scope_id);

CREATE TABLE memories (
  id              UUID PRIMARY KEY,
  scope_id        UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  type            TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'context', 'playbook', 'relationship')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  author_id       UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  source          TEXT NOT NULL,
  source_ref      TEXT,
  state           TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'stale', 'archived', 'promoted')),
  supersedes_id   UUID REFERENCES memories(id) ON DELETE SET NULL,
  promoted_to_id  UUID REFERENCES memories(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  last_verified   TIMESTAMPTZ
);

CREATE INDEX memories_scope_state_idx ON memories (scope_id, state);
CREATE INDEX memories_type_idx        ON memories (type);
CREATE INDEX memories_tags_gin        ON memories USING gin (tags);
CREATE INDEX memories_metadata_gin    ON memories USING gin (metadata);
CREATE INDEX memories_fts_idx         ON memories USING gin (to_tsvector('english', title || ' ' || body));

CREATE TABLE memory_embeddings (
  memory_id   UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  dim         INT  NOT NULL,
  embedding   vector(768),
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_embeddings_ivf ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('read', 'write', 'promote', 'archive', 'verify')),
  memory_id     UUID,
  scope_id      UUID,
  query         TEXT,
  metadata      JSONB
);

CREATE INDEX audit_log_principal_idx ON audit_log (principal_id, at DESC);
CREATE INDEX audit_log_memory_idx    ON audit_log (memory_id);
CREATE INDEX audit_log_at_idx        ON audit_log (at DESC);

-- Seed the singleton org scope.
INSERT INTO scopes (id, kind, name) VALUES (gen_random_uuid(), 'org', '');
