ALTER TABLE principals
  ADD COLUMN disabled_at TIMESTAMPTZ;

CREATE INDEX principals_active_external_id_idx
  ON principals (external_id) WHERE disabled_at IS NULL;

CREATE OR REPLACE FUNCTION continuum_protect_last_manual_org_admin_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was_effective BOOLEAN;
  remains_effective BOOLEAN;
BEGIN
  was_effective := OLD.source_kind = 'manual'
    AND OLD.source_id = 'manual'
    AND OLD.active
    AND OLD.role = 'admin'
    AND EXISTS (
      SELECT 1 FROM scopes s
       WHERE s.id = OLD.scope_id AND s.kind = 'org' AND s.name = ''
    )
    AND EXISTS (
      SELECT 1 FROM principals p
       WHERE p.id = OLD.principal_id AND p.disabled_at IS NULL
    );
  remains_effective := TG_OP <> 'DELETE'
    AND NEW.source_kind = 'manual'
    AND NEW.source_id = 'manual'
    AND NEW.active
    AND NEW.role = 'admin'
    AND NEW.principal_id = OLD.principal_id
    AND NEW.scope_id = OLD.scope_id;

  IF was_effective AND NOT remains_effective THEN
    PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
    IF NOT EXISTS (
      SELECT 1
        FROM scope_memberships m
        JOIN scopes s ON s.id = m.scope_id
        JOIN principals p ON p.id = m.principal_id
       WHERE s.kind = 'org' AND s.name = ''
         AND m.source_kind = 'manual' AND m.source_id = 'manual'
         AND m.active AND m.role = 'admin' AND p.disabled_at IS NULL
         AND m.principal_id <> OLD.principal_id
    ) THEN
      RAISE EXCEPTION 'cannot remove the last effective manual org administrator';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER protect_last_manual_org_admin_membership
BEFORE DELETE OR UPDATE OF principal_id, scope_id, role, source_kind, source_id, active
ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_protect_last_manual_org_admin_membership();

CREATE OR REPLACE FUNCTION continuum_protect_last_manual_org_admin_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NULL
     AND (TG_OP = 'DELETE' OR NEW.disabled_at IS NOT NULL)
     AND EXISTS (
       SELECT 1
         FROM scope_memberships m JOIN scopes s ON s.id = m.scope_id
        WHERE m.principal_id = OLD.id
          AND s.kind = 'org' AND s.name = ''
          AND m.source_kind = 'manual' AND m.source_id = 'manual'
          AND m.active AND m.role = 'admin'
     ) THEN
    PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
    IF NOT EXISTS (
      SELECT 1
        FROM scope_memberships m
        JOIN scopes s ON s.id = m.scope_id
        JOIN principals p ON p.id = m.principal_id
       WHERE s.kind = 'org' AND s.name = ''
         AND m.source_kind = 'manual' AND m.source_id = 'manual'
         AND m.active AND m.role = 'admin' AND p.disabled_at IS NULL
         AND p.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'cannot remove the last effective manual org administrator';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER protect_last_manual_org_admin_principal
BEFORE DELETE OR UPDATE OF disabled_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_protect_last_manual_org_admin_principal();

CREATE OR REPLACE FUNCTION continuum_fail_closed_on_principal_disable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE service_api_keys
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE principal_id = NEW.id AND revoked_at IS NULL;
  UPDATE scope_memberships
     SET active = FALSE,
         deactivated_at = COALESCE(deactivated_at, now())
   WHERE principal_id = NEW.id AND active;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fail_closed_on_principal_disable
AFTER UPDATE OF disabled_at ON principals
FOR EACH ROW
WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
EXECUTE FUNCTION continuum_fail_closed_on_principal_disable();

CREATE OR REPLACE FUNCTION continuum_require_active_membership_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND NOT EXISTS (
    SELECT 1 FROM principals p
     WHERE p.id = NEW.principal_id AND p.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active membership requires an active principal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER require_active_membership_principal
BEFORE INSERT OR UPDATE OF principal_id, active ON scope_memberships
FOR EACH ROW EXECUTE FUNCTION continuum_require_active_membership_principal();

UPDATE scope_memberships m
   SET active = FALSE, deactivated_at = COALESCE(deactivated_at, now())
  FROM principals p
 WHERE p.id = m.principal_id AND p.disabled_at IS NOT NULL AND m.active;
