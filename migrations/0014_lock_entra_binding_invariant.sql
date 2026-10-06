-- Lock the approved binding for the lifetime of an active membership write.
-- Without this row lock, a concurrent binding update or revocation can commit
-- after the trigger's EXISTS check and leave an active membership orphaned.

CREATE OR REPLACE FUNCTION continuum_require_approved_entra_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind = 'entra' AND NEW.active THEN
    PERFORM 1
      FROM entra_groups g
     WHERE g.external_id = NEW.source_id
       AND g.scope_id = NEW.scope_id
       AND g.role = NEW.role
       AND g.active
       AND g.approved_by IS NOT NULL
       AND g.approval_revoked_at IS NULL
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active Entra membership requires an approved immutable group binding';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
