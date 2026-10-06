-- Distinguish fail-closed invalid-input quarantine from an ordinary Graph 404.
-- Existing inactive approved bindings cannot be classified reliably after the
-- fact, so quarantine them for explicit operator review during this upgrade.

ALTER TABLE entra_groups
  ADD COLUMN quarantined_at TIMESTAMPTZ,
  ADD COLUMN quarantine_reason TEXT;

UPDATE entra_groups
   SET quarantined_at = COALESCE(deactivated_at, now()),
       quarantine_reason = 'LEGACY_INACTIVE_REVIEW'
 WHERE NOT active
   AND approved_by IS NOT NULL
   AND approval_revoked_at IS NULL;

ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_quarantine_pair
  CHECK ((quarantined_at IS NULL) = (quarantine_reason IS NULL));
ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_quarantine_inactive
  CHECK (quarantined_at IS NULL OR NOT active);

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
       AND g.quarantined_at IS NULL
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active Entra membership requires an approved immutable group binding';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
