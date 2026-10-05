-- Make the approved Entra binding relation authoritative in both directions.
-- Repair any orphaned active access left by an older binary before installing
-- constraints which reject future invalid binding state.

UPDATE scope_memberships m
   SET active = FALSE,
       deactivated_at = COALESCE(m.deactivated_at, now()),
       synced_at = now()
 WHERE m.source_kind = 'entra'
   AND m.active
   AND NOT EXISTS (
     SELECT 1
       FROM entra_groups g
      WHERE g.external_id = m.source_id
        AND g.scope_id = m.scope_id
        AND g.role = m.role
        AND g.active
        AND g.approved_by IS NOT NULL
        AND g.approved_at IS NOT NULL
        AND g.approval_revoked_at IS NULL
   );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entra_groups
     WHERE external_id !~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        OR (approved_by IS NULL) <> (approved_at IS NULL)
        OR (active AND (approved_by IS NULL OR approval_revoked_at IS NOT NULL
                        OR deactivated_at IS NOT NULL))
        OR (NOT active AND deactivated_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid Entra binding state; repair or revoke malformed bindings before retrying migration';
  END IF;
  IF (SELECT count(*) FROM entra_groups
       WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL) > 500 THEN
    RAISE EXCEPTION 'more than 500 approved Entra bindings; revoke excess bindings before retrying migration';
  END IF;
END;
$$;

ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_external_id_uuid
  CHECK (external_id ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$');
ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_approval_pair
  CHECK ((approved_by IS NULL) = (approved_at IS NULL));
ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_active_state
  CHECK (
    (active AND approved_by IS NOT NULL AND approval_revoked_at IS NULL
            AND deactivated_at IS NULL)
    OR
    (NOT active AND deactivated_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION continuum_limit_entra_bindings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL AND NEW.approval_revoked_at IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.approved_by IS NULL OR OLD.approval_revoked_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
    IF (SELECT count(*) FROM entra_groups
         WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL) >= 500 THEN
      RAISE EXCEPTION 'cannot approve more than 500 Entra group bindings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entra_groups_limit_approved_bindings
BEFORE INSERT OR UPDATE OF approved_by, approval_revoked_at
ON entra_groups
FOR EACH ROW EXECUTE FUNCTION continuum_limit_entra_bindings();

CREATE OR REPLACE FUNCTION continuum_protect_entra_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM scope_memberships m
       WHERE m.source_kind = 'entra' AND m.source_id = OLD.external_id AND m.active
    ) THEN
      RAISE EXCEPTION 'active Entra memberships must match an approved binding';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM scope_memberships m
     WHERE m.source_kind = 'entra' AND m.source_id = OLD.external_id AND m.active
       AND (NEW.external_id <> OLD.external_id
            OR NEW.external_id <> m.source_id
            OR NEW.scope_id <> m.scope_id
            OR NEW.role <> m.role
            OR NOT NEW.active
            OR NEW.approved_by IS NULL
            OR NEW.approval_revoked_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'active Entra memberships must match an approved binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entra_groups_protect_active_memberships
BEFORE UPDATE OR DELETE ON entra_groups
FOR EACH ROW EXECUTE FUNCTION continuum_protect_entra_binding();
