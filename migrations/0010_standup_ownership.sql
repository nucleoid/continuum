-- Explicit ownership for personal scopes. Existing user scopes remain unowned
-- until an administrator reviews and backfills them; standup reads fail closed
-- for those rows rather than guessing from names or memberships.
ALTER TABLE scopes ADD COLUMN owner_principal_id UUID
  REFERENCES principals(id) ON DELETE RESTRICT;

ALTER TABLE scopes ADD CONSTRAINT scopes_owner_kind_check CHECK (
  (kind = 'user') OR owner_principal_id IS NULL
);

CREATE UNIQUE INDEX scopes_owner_principal_unique
  ON scopes (owner_principal_id)
  WHERE owner_principal_id IS NOT NULL;

CREATE FUNCTION validate_user_scope_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_principal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM principals
     WHERE id = NEW.owner_principal_id AND kind = 'user'
  ) THEN
    RAISE EXCEPTION 'user scope owner must be a user principal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_user_scope_owner_trigger
  BEFORE INSERT OR UPDATE OF owner_principal_id, kind ON scopes
  FOR EACH ROW EXECUTE FUNCTION validate_user_scope_owner();

CREATE FUNCTION reject_owned_principal_kind_change() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'user' AND NEW.kind <> 'user' AND EXISTS (
    SELECT 1 FROM scopes WHERE owner_principal_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'owned user-scope principal must remain a user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_owned_principal_kind_change_trigger
  BEFORE UPDATE OF kind ON principals
  FOR EACH ROW EXECUTE FUNCTION reject_owned_principal_kind_change();

-- Source identities are mapped by an org administrator. Provider/user IDs are
-- authoritative opaque identifiers; display names are never consulted.
CREATE TABLE actor_principal_mappings (
  authority TEXT NOT NULL CHECK (
    length(authority) BETWEEN 1 AND 100
    AND authority ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  external_actor_id TEXT NOT NULL CHECK (length(external_actor_id) BETWEEN 1 AND 500),
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapped_by_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (authority, external_actor_id)
);

CREATE FUNCTION validate_actor_principal_mapping() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM principals WHERE id = NEW.principal_id AND kind = 'user'
  ) THEN
    RAISE EXCEPTION 'actor identity must map to a user principal';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM scope_memberships sm
      JOIN scopes s ON s.id = sm.scope_id
     WHERE sm.principal_id = NEW.mapped_by_principal_id
       AND sm.role = 'admin' AND s.kind = 'org'
  ) THEN
    RAISE EXCEPTION 'actor identity mapper must be an org admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_actor_principal_mapping_trigger
  BEFORE INSERT OR UPDATE ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_actor_principal_mapping();

CREATE FUNCTION reject_mapped_principal_kind_change() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'user' AND NEW.kind <> 'user' AND EXISTS (
    SELECT 1 FROM actor_principal_mappings WHERE principal_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'mapped actor principal must remain a user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_mapped_principal_kind_change_trigger
  BEFORE UPDATE OF kind ON principals
  FOR EACH ROW EXECUTE FUNCTION reject_mapped_principal_kind_change();

CREATE INDEX actor_principal_mappings_principal_idx
  ON actor_principal_mappings (principal_id);
