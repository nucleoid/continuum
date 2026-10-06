-- Reinstall the complete binding invariant for databases that applied the
-- earlier review migrations before scope and role enforcement was added.

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

DROP TRIGGER IF EXISTS scope_memberships_require_approved_entra_binding
  ON scope_memberships;
CREATE TRIGGER scope_memberships_require_approved_entra_binding
BEFORE INSERT OR UPDATE OF source_kind, source_id, scope_id, role, active
ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_require_approved_entra_binding();
