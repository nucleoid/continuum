-- Forward-only remediation for coordination privacy, role ACLs, and lock order.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- Lock audit rows retain operational evidence but no joinable identifiers.
DO $classifier$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '          ''operation'',''outcome'',''request_id'',''run_id'',''lease_id'',' || chr(10) ||
    '          ''fencing_token'',''resource_bytes'',''transport'',''own_lease''',
    '          ''operation'',''outcome'',''fencing_token'',''resource_bytes'',' || chr(10) ||
    '          ''transport'',''own_lease''');
  IF revised = definition OR position('''request_id'',''run_id'',''lease_id''' IN revised) <> 0 THEN
    RAISE EXCEPTION 'unable to narrow lock audit metadata classifier';
  END IF;
  EXECUTE revised;
END;
$classifier$;

-- Membership changes take principal locks, then ordered scope rows. The scope
-- advisory lock is needed only once privacy progress exists. The scope-row
-- gate serializes the no-progress check with progress creation.
CREATE OR REPLACE FUNCTION continuum_coordination_privacy_membership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE locked_principal UUID; locked_scope UUID; privacy_active BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.active IS NOT DISTINCT FROM OLD.active
      AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id THEN
    RETURN NEW;
  END IF;

  FOR locked_principal IN
    SELECT DISTINCT principal_id FROM (
      SELECT NEW.principal_id
      UNION ALL
      SELECT CASE WHEN TG_OP = 'UPDATE' THEN OLD.principal_id END
    ) candidate(principal_id)
    WHERE principal_id IS NOT NULL ORDER BY principal_id
  LOOP
    PERFORM 1 FROM principals WHERE id = locked_principal FOR KEY SHARE;
  END LOOP;

  FOR locked_scope IN
    SELECT DISTINCT scope_id FROM (
      SELECT NEW.scope_id
      UNION ALL
      SELECT CASE WHEN TG_OP = 'UPDATE' THEN OLD.scope_id END
    ) candidate(scope_id)
    WHERE scope_id IS NOT NULL ORDER BY scope_id
  LOOP
    PERFORM 1 FROM scopes WHERE id = locked_scope FOR KEY SHARE;
    SELECT EXISTS (
      SELECT 1 FROM coordination_scope_privacy_progress
       WHERE scope_id = locked_scope
    ) OR EXISTS (
      SELECT 1 FROM coordination_principal_privacy_progress
       WHERE principal_id IN (NEW.principal_id,
         CASE WHEN TG_OP = 'UPDATE' THEN OLD.principal_id END)
         AND completed_at IS NULL
    ) INTO privacy_active;
    IF privacy_active THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(locked_scope::text, 761));
    END IF;
  END LOOP;

  IF NOT NEW.active OR NOT EXISTS (
    SELECT 1 FROM coordination_scope_privacy_progress
     WHERE scope_id = NEW.scope_id
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM principal_user_scopes mapping
    JOIN principals principal ON principal.id = mapping.principal_id
     WHERE mapping.scope_id = NEW.scope_id
       AND mapping.principal_id = NEW.principal_id
       AND principal.disabled_at IS NULL
       AND principal.reactivated_at IS NOT NULL
  ) THEN
    DELETE FROM coordination_scope_privacy_progress WHERE scope_id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION
      'offboarded owned scope or coordination-private scope cannot gain active memberships';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_privacy_membership_guard() FROM PUBLIC;

-- Move the principal eligibility lock ahead of every scope lock and write the
-- same canonical metadata shape expected by the immutable audit trigger.
DO $scrub$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '  -- Serialize privacy work for one principal without taking the principal row' || chr(10) ||
    '  -- ahead of scope locks used by membership insertion and activation.' || chr(10) ||
    '  PERFORM pg_advisory_xact_lock(hashtextextended(target_principal_id::text, 762));' || chr(10) ||
    '  INSERT INTO coordination_principal_privacy_progress',
    '  -- Principal lifecycle state always precedes privacy and scope locks.' || chr(10) ||
    '  PERFORM pg_advisory_xact_lock(hashtextextended(target_principal_id::text, 762));' || chr(10) ||
    '  PERFORM 1 FROM principals' || chr(10) ||
    '   WHERE id = target_principal_id' || chr(10) ||
    '     AND (disabled_at IS NOT NULL OR offboarded_at IS NOT NULL)' || chr(10) ||
    '   FOR UPDATE;' || chr(10) ||
    '  IF NOT FOUND THEN' || chr(10) ||
    '    RAISE EXCEPTION ''coordination scrub target must be disabled or offboarded'';' || chr(10) ||
    '  END IF;' || chr(10) ||
    '  INSERT INTO coordination_principal_privacy_progress');
  revised := replace(revised,
    '  -- Reactivation and candidate eligibility are rechecked only after the exact' || chr(10) ||
    '  -- advisory scope set has been acquired.' || chr(10) ||
    '  PERFORM 1 FROM principals' || chr(10) ||
    '   WHERE id = target_principal_id' || chr(10) ||
    '     AND (disabled_at IS NOT NULL OR offboarded_at IS NOT NULL)' || chr(10) ||
    '   FOR UPDATE;' || chr(10) ||
    '  IF NOT FOUND THEN' || chr(10) ||
    '    RAISE EXCEPTION ''coordination scrub target must be disabled or offboarded'';' || chr(10) ||
    '  END IF;' || chr(10),
    '  -- Eligibility remains protected by the principal lock acquired above.' || chr(10));
  revised := replace(revised,
    '    UPDATE audit_log audit SET metadata = audit.metadata' || chr(10) ||
    '      - ARRAY[''lease_id'',''request_id'',''run_id'',''resource'',''resource_sha256'']::text[]',
    '    UPDATE audit_log audit SET metadata =' || chr(10) ||
    '      continuum_offboarding_expected_audit_metadata(audit.metadata)');
  IF revised = definition
      OR position('without taking the principal row' IN revised) <> 0
      OR position('SET metadata = audit.metadata' IN revised) <> 0 THEN
    RAISE EXCEPTION 'unable to repair coordination scrub lock order and metadata';
  END IF;
  EXECUTE revised;
END;
$scrub$;

-- Runtime callers need only three booleans/versions, never progress-table ACLs.
CREATE OR REPLACE FUNCTION continuum_coordination_privacy_state(
  target_principal_id UUID, owned_scope_id UUID
) RETURNS TABLE (
  privacy_version INTEGER, principal_complete BOOLEAN, scope_complete BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(principal_progress.privacy_version, 0),
         COALESCE(principal_progress.privacy_version = 2
                  AND principal_progress.completed_at IS NOT NULL, FALSE),
         COALESCE(scope_progress.completed_at IS NOT NULL, FALSE)
    FROM principal_user_scopes mapping
    LEFT JOIN coordination_principal_privacy_progress principal_progress
      ON principal_progress.principal_id = mapping.principal_id
    LEFT JOIN coordination_scope_privacy_progress scope_progress
      ON scope_progress.scope_id = mapping.scope_id
   WHERE mapping.principal_id = target_principal_id
     AND mapping.scope_id = owned_scope_id;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_privacy_state(UUID, UUID) FROM PUBLIC;

-- The app role can execute this narrow fence without UPDATE on freshness state.
CREATE OR REPLACE FUNCTION continuum_coordination_lock_entra_freshness()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE current_freshness BOOLEAN := FALSE;
BEGIN
  SELECT clock_timestamp() < last_success_at + max_staleness
    INTO current_freshness
    FROM entra_sync_state WHERE singleton FOR SHARE;
  RETURN COALESCE(current_freshness, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_coordination_lock_entra_freshness() FROM PUBLIC;

-- Direct pseudonymization follows the same principal-before-scope order as
-- offboarding and membership lifecycle writes.
CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope_v2(
  authorization_principal_id UUID, target_scope_id UUID, pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET statement_timeout = '5s' AS $$
BEGIN
  PERFORM 1 FROM principals principal
  JOIN scope_memberships membership ON membership.principal_id = principal.id
   WHERE membership.scope_id = target_scope_id
   ORDER BY principal.id FOR UPDATE OF principal;
  PERFORM 1 FROM scopes WHERE id = target_scope_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_scope_id::text, 761));
  PERFORM continuum_operator_pseudonymize_scope_v2_legacy(
    authorization_principal_id, target_scope_id, pseudonym);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT)
  FROM PUBLIC;

-- Extend the exact app/operator function profiles; progress tables remain
-- absent from the table allow-list.
DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '        (''continuum_coordination_scope_fencing_floor(uuid)'')',
    '        (''continuum_coordination_scope_fencing_floor(uuid)''),' || chr(10) ||
    '        (''continuum_coordination_privacy_state(uuid,uuid)''),' || chr(10) ||
    '        (''continuum_coordination_lock_entra_freshness()'')');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to extend coordination application function allow-list';
  END IF;
  EXECUTE revised;
END;
$allowlist$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_coordination_privacy_membership_guard',
         'continuum_operator_scrub_coordination_principal',
         'continuum_coordination_privacy_state',
         'continuum_coordination_lock_entra_freshness',
         'continuum_operator_pseudonymize_scope_v2'
       ])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
END;
$harden$;
