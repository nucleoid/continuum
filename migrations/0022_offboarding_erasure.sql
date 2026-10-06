-- Explicit user-scope ownership and fail-closed erasure lifecycle.

-- Fail quickly instead of queueing application traffic behind a long-held lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE principals
  ADD COLUMN offboarded_at TIMESTAMPTZ,
  ADD COLUMN reactivated_at TIMESTAMPTZ;

CREATE TABLE principal_user_scopes (
  principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL UNIQUE REFERENCES scopes(id) ON DELETE RESTRICT,
  mapped_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  allow_other_active_members BOOLEAN NOT NULL DEFAULT FALSE
);

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
-- row orders capture against offboarding and reactivation.
CREATE FUNCTION continuum_require_open_owned_user_scope() RETURNS trigger AS $$
DECLARE
  owner_offboarded_at TIMESTAMPTZ;
BEGIN
  IF NEW.state = 'live' THEN
    SELECT p.offboarded_at INTO owner_offboarded_at
      FROM principal_user_scopes pus
      JOIN principals p ON p.id = pus.principal_id
     WHERE pus.scope_id = NEW.scope_id
     FOR KEY SHARE OF p;
    IF FOUND AND owner_offboarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'live memory is forbidden for a scope owned by an offboarded principal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_open_owned_user_scope
BEFORE INSERT OR UPDATE OF scope_id, state ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_require_open_owned_user_scope();

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

-- Clean up derived rows that predate the archive trigger.
DELETE FROM memory_embeddings e USING memories m
 WHERE e.memory_id = m.id AND m.state = 'archived';

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
