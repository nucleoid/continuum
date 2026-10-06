-- Explicit, audited application-level revocation state for Entra bindings.
-- This migration also repairs installations that had already applied 0006
-- before its legacy-membership deactivation was added.

ALTER TABLE entra_groups
  ADD COLUMN approval_revoked_by UUID REFERENCES principals(id) ON DELETE RESTRICT,
  ADD COLUMN approval_revoked_at TIMESTAMPTZ;

ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_revocation_pair
  CHECK ((approval_revoked_by IS NULL) = (approval_revoked_at IS NULL));

UPDATE scope_memberships m
   SET active = FALSE,
       deactivated_at = COALESCE(m.deactivated_at, now()),
       synced_at = now()
 WHERE m.source_kind = 'entra'
   AND m.active
   AND NOT EXISTS (
     SELECT 1 FROM entra_groups g
      WHERE g.external_id = m.source_id
        AND g.approved_by IS NOT NULL
        AND g.approval_revoked_at IS NULL
   );

CREATE OR REPLACE FUNCTION continuum_require_approved_entra_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind = 'entra' AND NEW.active
     AND NOT EXISTS (
       SELECT 1 FROM entra_groups g
        WHERE g.external_id = NEW.source_id
          AND g.scope_id = NEW.scope_id
          AND g.role = NEW.role
          AND g.approved_by IS NOT NULL
          AND g.approval_revoked_at IS NULL
     ) THEN
    RAISE EXCEPTION 'active Entra membership requires an approved immutable group binding';
  END IF;
  RETURN NEW;
END;
$$;

-- Some pre-release installations recorded 0006 before its trigger was added.
-- Recreate it here so the repair is effective regardless of that history.
DROP TRIGGER IF EXISTS scope_memberships_require_approved_entra_binding
  ON scope_memberships;
CREATE TRIGGER scope_memberships_require_approved_entra_binding
BEFORE INSERT OR UPDATE OF source_kind, source_id, scope_id, role, active
ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_require_approved_entra_binding();
