-- Separate tenant discovery from explicit administrator-approved bindings.
-- The temporary nullable/default form keeps upgrades safe for installations
-- that briefly run the rejected pre-release migration during review.
ALTER TABLE entra_groups
  ADD COLUMN approved_by UUID REFERENCES principals(id) ON DELETE RESTRICT,
  ADD COLUMN approved_at TIMESTAMPTZ;

-- Pre-release rows are not trusted bindings. They remain recorded for audit,
-- but inactive until an administrator explicitly provisions them again.
UPDATE entra_groups
   SET active = FALSE,
       deactivated_at = COALESCE(deactivated_at, now())
 WHERE approved_by IS NULL;

-- Memberships written by the rejected pre-release name mapper are equally
-- untrusted. Deactivate them before installing the guard so an upgrade cannot
-- retain access that no immutable group-ID binding has approved.
UPDATE scope_memberships m
   SET active = FALSE,
       deactivated_at = COALESCE(m.deactivated_at, now()),
       synced_at = now()
 WHERE m.source_kind = 'entra'
   AND m.active
   AND NOT EXISTS (
     SELECT 1 FROM entra_groups g
      WHERE g.external_id = m.source_id AND g.approved_by IS NOT NULL
   );

ALTER TABLE entra_groups ALTER COLUMN last_seen_at DROP NOT NULL;

CREATE OR REPLACE FUNCTION continuum_require_approved_entra_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind = 'entra' AND NEW.active
     AND NOT EXISTS (
       SELECT 1 FROM entra_groups g
        WHERE g.external_id = NEW.source_id AND g.approved_by IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'active Entra membership requires an approved immutable group binding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scope_memberships_require_approved_entra_binding
BEFORE INSERT OR UPDATE OF source_kind, source_id, active
ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_require_approved_entra_binding();
