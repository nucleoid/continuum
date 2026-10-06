-- Explicit user-scope ownership and fail-closed erasure lifecycle.

-- Fail quickly instead of queueing application traffic or scanning without a
-- bounded operator-visible failure.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE principal_user_scopes (
  principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL UNIQUE REFERENCES scopes(id) ON DELETE RESTRICT,
  mapped_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_principal_ids UUID[] NOT NULL,
  acknowledged_evidence_hash TEXT NOT NULL
    CHECK (acknowledged_evidence_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE principal_user_scope_approvals (
  id BIGSERIAL PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  approved_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_principal_ids UUID[] NOT NULL,
  acknowledged_evidence_hash TEXT NOT NULL
    CHECK (acknowledged_evidence_hash ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION continuum_preserve_user_scope_approval() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'principal user-scope approval evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_user_scope_approval
BEFORE UPDATE OR DELETE ON principal_user_scope_approvals
FOR EACH ROW EXECUTE FUNCTION continuum_preserve_user_scope_approval();

CREATE TRIGGER preserve_user_scope_approval_truncate
BEFORE TRUNCATE ON principal_user_scope_approvals
FOR EACH STATEMENT EXECUTE FUNCTION continuum_preserve_user_scope_approval();

CREATE TABLE principal_offboarding_runs (
  principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  initiated_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  approval_id BIGINT NOT NULL REFERENCES principal_user_scope_approvals(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  initial_memories INTEGER NOT NULL CHECK (initial_memories >= 0),
  initial_embeddings INTEGER NOT NULL CHECK (initial_embeddings >= 0),
  initial_memberships INTEGER NOT NULL CHECK (initial_memberships >= 0),
  initial_aliases INTEGER NOT NULL CHECK (initial_aliases >= 0),
  initial_entra_bindings INTEGER NOT NULL CHECK (initial_entra_bindings >= 0),
  initial_audit_rows INTEGER NOT NULL CHECK (initial_audit_rows >= 0),
  initial_audit_queries INTEGER NOT NULL CHECK (initial_audit_queries >= 0),
  initial_audit_selection JSONB NOT NULL DEFAULT '{}'::jsonb,
  memories_processed INTEGER NOT NULL DEFAULT 0 CHECK (memories_processed >= 0),
  audit_rows_processed INTEGER NOT NULL DEFAULT 0 CHECK (audit_rows_processed >= 0),
  batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
  memory_cursor UUID,
  audit_principal_cursor BIGINT NOT NULL DEFAULT 0,
  audit_scope_cursor BIGINT NOT NULL DEFAULT 0,
  audit_memory_cursor BIGINT NOT NULL DEFAULT 0,
  audit_scope_ids_cursor BIGINT NOT NULL DEFAULT 0,
  audit_linked_cursor BIGINT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ
);

CREATE TABLE principal_offboarding_audit_requests (
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  PRIMARY KEY (principal_id, request_id)
);

-- This compact privacy-safe ledger is deliberately outside audit_log so the
-- original erasure receipt survives ordinary audit retention pruning.
CREATE TABLE principal_offboarding_events (
  id BIGSERIAL PRIMARY KEY,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  repair BOOLEAN NOT NULL DEFAULT FALSE,
  memories INTEGER NOT NULL CHECK (memories >= 0),
  embeddings INTEGER NOT NULL CHECK (embeddings >= 0),
  memberships INTEGER NOT NULL CHECK (memberships >= 0),
  aliases INTEGER NOT NULL CHECK (aliases >= 0),
  entra_bindings INTEGER NOT NULL CHECK (entra_bindings >= 0),
  audit_rows INTEGER NOT NULL CHECK (audit_rows >= 0),
  audit_queries INTEGER NOT NULL CHECK (audit_queries >= 0),
  approval_id BIGINT NOT NULL REFERENCES principal_user_scope_approvals(id) ON DELETE RESTRICT,
  batches INTEGER NOT NULL CHECK (batches > 0),
  evidence JSONB NOT NULL
);

CREATE INDEX principal_offboarding_events_principal_idx
  ON principal_offboarding_events (principal_id, id);

CREATE FUNCTION continuum_preserve_offboarding_event() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'principal offboarding event evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_offboarding_event
BEFORE UPDATE OR DELETE ON principal_offboarding_events
FOR EACH ROW EXECUTE FUNCTION continuum_preserve_offboarding_event();

CREATE TRIGGER preserve_offboarding_event_truncate
BEFORE TRUNCATE ON principal_offboarding_events
FOR EACH STATEMENT EXECUTE FUNCTION continuum_preserve_offboarding_event();

CREATE FUNCTION continuum_validate_principal_user_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = NEW.principal_id AND p.kind = 'user') THEN
    RAISE EXCEPTION 'owned user scope requires a user principal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = NEW.scope_id AND s.kind = 'user') THEN
    RAISE EXCEPTION 'owned user scope must have kind user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_principal_user_scope
BEFORE INSERT OR UPDATE ON principal_user_scopes
FOR EACH ROW EXECUTE FUNCTION continuum_validate_principal_user_scope();

-- Close an offboarded owned scope at the database boundary. Locking the owner
-- row orders capture against offboarding and reactivation. Only the canonical
-- tombstone is accepted for repair of a dirty archived row.
CREATE FUNCTION continuum_require_open_owned_user_scope() RETURNS trigger AS $$
DECLARE
  owner_offboarded_at TIMESTAMPTZ;
BEGIN
  SELECT p.offboarded_at INTO owner_offboarded_at
    FROM principal_user_scopes pus
    JOIN principals p ON p.id = pus.principal_id
   WHERE pus.scope_id = NEW.scope_id
   FOR KEY SHARE OF p;
  IF FOUND AND owner_offboarded_at IS NOT NULL
     AND (NEW.state <> 'archived' OR NEW.type <> 'context'
          OR NEW.title <> '[erased]' OR NEW.body <> '[erased]'
          OR NEW.metadata <> '{}'::jsonb OR NEW.tags <> '{}'::text[]
          OR NEW.source <> 'erased' OR NEW.source_ref IS NOT NULL
          OR NEW.supersedes_id IS NOT NULL OR NEW.promoted_to_id IS NOT NULL
          OR NEW.expires_at IS NOT NULL OR NEW.last_verified IS NOT NULL) THEN
    RAISE EXCEPTION 'live or non-tombstone memory is forbidden for an offboarded owned scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_open_owned_user_scope
BEFORE INSERT OR UPDATE OF scope_id, type, title, body, metadata, tags, source,
  source_ref, state, supersedes_id, promoted_to_id, expires_at, last_verified ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_require_open_owned_user_scope();

CREATE FUNCTION continuum_protect_offboarded_memory_tombstone() RETURNS trigger AS $$
DECLARE
  owner_offboarded_at TIMESTAMPTZ;
BEGIN
  SELECT p.offboarded_at INTO owner_offboarded_at
    FROM principal_user_scopes pus JOIN principals p ON p.id = pus.principal_id
   WHERE pus.scope_id = OLD.scope_id
   FOR KEY SHARE OF p;
  IF FOUND AND owner_offboarded_at IS NOT NULL
     AND (NEW.scope_id IS DISTINCT FROM OLD.scope_id
         OR NEW.author_id IS DISTINCT FROM OLD.author_id
         OR NEW.type IS DISTINCT FROM OLD.type OR NEW.title IS DISTINCT FROM OLD.title
         OR NEW.body IS DISTINCT FROM OLD.body OR NEW.metadata IS DISTINCT FROM OLD.metadata
         OR NEW.tags IS DISTINCT FROM OLD.tags OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.state IS DISTINCT FROM OLD.state
         OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
         OR NEW.promoted_to_id IS DISTINCT FROM OLD.promoted_to_id
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.last_verified IS DISTINCT FROM OLD.last_verified) THEN
    IF NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.state <> 'archived' OR NEW.type <> 'context'
       OR NEW.title <> '[erased]' OR NEW.body <> '[erased]'
       OR NEW.metadata <> '{}'::jsonb OR NEW.tags <> '{}'::text[]
       OR NEW.source <> 'erased' OR NEW.source_ref IS NOT NULL
       OR NEW.supersedes_id IS NOT NULL OR NEW.promoted_to_id IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.last_verified IS NOT NULL THEN
      RAISE EXCEPTION 'archived memory content is immutable in an offboarded owned scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_offboarded_memory_tombstone
BEFORE UPDATE OF scope_id, type, title, body, metadata, tags, author_id, source,
  source_ref, state, supersedes_id, promoted_to_id, expires_at, last_verified ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_protect_offboarded_memory_tombstone();

-- No active direct or source-managed access can target a closed owned scope.
CREATE OR REPLACE FUNCTION continuum_require_active_membership_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_offboarded_at TIMESTAMPTZ;
BEGIN
  IF NEW.active AND NOT EXISTS (
    SELECT 1 FROM principals p WHERE p.id = NEW.principal_id AND p.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active membership requires an active principal';
  END IF;
  IF NEW.active THEN
    SELECT p.offboarded_at INTO owner_offboarded_at
      FROM principal_user_scopes pus JOIN principals p ON p.id = pus.principal_id
     WHERE pus.scope_id = NEW.scope_id
     FOR KEY SHARE OF p;
    IF FOUND AND owner_offboarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'active membership is forbidden for an offboarded owned scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER require_active_membership_principal ON scope_memberships;
CREATE TRIGGER require_active_membership_principal
BEFORE INSERT OR UPDATE OF principal_id, scope_id, active ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_require_active_membership_principal();

CREATE FUNCTION continuum_require_open_entra_binding_scope() RETURNS trigger AS $$
DECLARE
  owner_offboarded_at TIMESTAMPTZ;
BEGIN
  IF NEW.active THEN
    SELECT p.offboarded_at INTO owner_offboarded_at
      FROM principal_user_scopes pus JOIN principals p ON p.id = pus.principal_id
     WHERE pus.scope_id = NEW.scope_id
     FOR KEY SHARE OF p;
    IF FOUND AND owner_offboarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'active Entra binding is forbidden for an offboarded owned scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_open_entra_binding_scope
BEFORE INSERT OR UPDATE OF scope_id, active ON entra_groups
FOR EACH ROW EXECUTE FUNCTION continuum_require_open_entra_binding_scope();

-- Parent locking orders embedding writes against every archive path.
CREATE FUNCTION continuum_require_embeddable_memory() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memories m
     WHERE m.id = NEW.memory_id AND m.state = 'live'
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'embedding requires a live memory';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_embeddable_memory
BEFORE INSERT OR UPDATE ON memory_embeddings
FOR EACH ROW EXECUTE FUNCTION continuum_require_embeddable_memory();

CREATE FUNCTION continuum_remove_archived_memory_embedding() RETURNS trigger AS $$
BEGIN
  IF NEW.state = 'archived' AND OLD.state IS DISTINCT FROM NEW.state THEN
    DELETE FROM memory_embeddings WHERE memory_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER remove_archived_memory_embedding
AFTER UPDATE OF state ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_remove_archived_memory_embedding();

-- Order every audit write against offboarding through both the acting principal
-- and every exact scope UUID carried by the row. A late delegate/admin summary
-- therefore fails before unsanitized recall results can be returned.
CREATE FUNCTION continuum_reject_offboarded_principal_audit() RETURNS trigger AS $$
DECLARE
  principal_offboarded_at TIMESTAMPTZ;
  owner_principal_id UUID;
BEGIN
  SELECT p.offboarded_at INTO principal_offboarded_at
    FROM principals p
   WHERE p.id = NEW.principal_id
   FOR KEY SHARE;
  IF principal_offboarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'audit insert forbidden for offboarded principal';
  END IF;
  SELECT p.id, p.offboarded_at INTO owner_principal_id, principal_offboarded_at
    FROM principal_user_scopes pus
    JOIN principals p ON p.id = pus.principal_id
   WHERE pus.scope_id = NEW.scope_id
   FOR KEY SHARE OF p;
  IF FOUND AND principal_offboarded_at IS NOT NULL THEN
    IF NOT (NEW.action = 'archive' AND NEW.query IS NULL
      AND NEW.metadata->>'principal_id' = owner_principal_id::text
      AND (
        (NEW.memory_id IS NOT NULL AND NEW.metadata = jsonb_build_object(
          'operation', 'principal_memory_erased', 'principal_id', owner_principal_id::text
        ))
        OR (NEW.memory_id IS NULL AND NEW.metadata->>'operation' IN
          ('principal_offboarded', 'principal_offboarding_repaired')
          AND NEW.metadata - ARRAY[
            'operation', 'principal_id', 'approval_id', 'acknowledged_evidence_hash',
            'memories', 'audit_rows', 'batches'
          ]::text[] = '{}'::jsonb)
      )) THEN
      RAISE EXCEPTION 'audit insert forbidden for an offboarded owned scope';
    END IF;
  END IF;

  FOR principal_offboarded_at IN
    SELECT p.offboarded_at
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(NEW.metadata->'scope_ids') = 'array'
             THEN NEW.metadata->'scope_ids' ELSE '[]'::jsonb END
      ) AS carried(value)
      JOIN principal_user_scopes pus
        ON pus.scope_id = CASE
          WHEN carried.value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          THEN carried.value::uuid ELSE NULL END
      JOIN principals p ON p.id = pus.principal_id
     FOR KEY SHARE OF p
  LOOP
    IF principal_offboarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'audit insert forbidden for an offboarded owned scope';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_offboarded_principal_audit
BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_reject_offboarded_principal_audit();
