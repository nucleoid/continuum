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

CREATE INDEX memories_standup_actor_created_idx
  ON memories ((metadata->>'actor_principal_id'), created_at DESC, id)
  WHERE metadata ? 'actor_principal_id';

CREATE INDEX memories_standup_thread_idx
  ON memories ((metadata->>'thread_key'), created_at DESC, id)
  WHERE metadata ? 'thread_key';

CREATE INDEX memories_standup_closures_gin
  ON memories USING gin ((metadata->'closes_thread_keys'))
  WHERE metadata ? 'closes_thread_keys';
