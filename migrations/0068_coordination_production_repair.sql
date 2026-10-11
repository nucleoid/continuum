-- Add a bounded production repair surface for rollout privacy work and fence
-- pre-0067 restart behavior without changing published migrations.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION continuum_operator_list_coordination_privacy_repairs(
  authorization_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'coordination privacy repair list limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
  SELECT principal.id, mapping.scope_id,
         CASE WHEN principal.offboarded_at IS NOT NULL
              THEN 'offboarded'::text ELSE 'disabled_only'::text END
    FROM coordination_principal_privacy_progress progress
    JOIN principals principal ON principal.id = progress.principal_id
    JOIN principal_user_scopes mapping ON mapping.principal_id = principal.id
   WHERE (target_principal_id IS NULL OR principal.id = target_principal_id)
     AND principal.disabled_at IS NOT NULL
     AND (progress.privacy_version < 2 OR progress.completed_at IS NULL)
   ORDER BY principal.id
   LIMIT row_limit;
END;
$$;
REVOKE ALL ON FUNCTION
  continuum_operator_list_coordination_privacy_repairs(UUID, UUID, INTEGER)
FROM PUBLIC;

CREATE FUNCTION continuum_operator_offboarding_actual_state_is_erased(
  authorization_principal_id UUID, target_run_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  RETURN continuum_offboarding_actual_state_is_erased(target_run_id);
END;
$$;
REVOKE ALL ON FUNCTION
  continuum_operator_offboarding_actual_state_is_erased(UUID, UUID)
FROM PUBLIC;

-- Preserve the pre-0067 erasure predicate under a new private name. The
-- current predicate remains authoritative for completion; this copy is used
-- only to distinguish privacy-only dirt from real lifecycle drift.
DO $noncoordination_state$
DECLARE definition TEXT; revised TEXT; privacy_clause TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_offboarding_actual_state_is_erased(uuid)'::regprocedure)
    INTO definition;
  privacy_clause :=
    '    OR EXISTS (SELECT 1 FROM coordination_principal_privacy_progress progress' || chr(10) ||
    '      WHERE progress.principal_id = run.principal_id' || chr(10) ||
    '        AND (progress.privacy_version < 2 OR progress.completed_at IS NULL))' || chr(10);
  revised := replace(definition,
    'CREATE OR REPLACE FUNCTION ' || quote_ident(current_schema()) ||
      '.continuum_offboarding_actual_state_is_erased',
    'CREATE FUNCTION ' || quote_ident(current_schema()) ||
      '.continuum_offboarding_noncoordination_state_is_erased');
  revised := replace(revised, privacy_clause, '');
  IF revised = definition
      OR position('continuum_offboarding_noncoordination_state_is_erased' IN revised) = 0
      OR position('coordination_principal_privacy_progress' IN revised) > 0 THEN
    RAISE EXCEPTION 'unable to derive non-coordination offboarding state predicate';
  END IF;
  EXECUTE revised;
END;
$noncoordination_state$;
REVOKE ALL ON FUNCTION
  continuum_offboarding_noncoordination_state_is_erased(UUID)
FROM PUBLIC;

-- Old services call restart directly after observing a completed dirty run.
-- Refuse that exact call when coordination privacy is the only dirty state;
-- current services use the bounded privacy repair path instead.
DO $restart_fence$
DECLARE definition TEXT; revised TEXT; anchor TEXT; replacement TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_restart_offboarding_run(uuid,uuid,jsonb)'::regprocedure)
    INTO definition;
  anchor := '  SELECT run.* INTO current_run FROM principal_offboarding_runs run';
  replacement :=
    '  IF EXISTS (' || chr(10) ||
    '    SELECT 1 FROM principal_offboarding_runs run' || chr(10) ||
    '    JOIN principals principal ON principal.id = run.principal_id' || chr(10) ||
    '   WHERE run.principal_id = target_principal_id' || chr(10) ||
    '     AND run.completed_at IS NOT NULL' || chr(10) ||
    '     AND principal.offboarded_at IS NOT NULL' || chr(10) ||
    '     AND principal.disabled_at IS NOT NULL' || chr(10) ||
    '     AND principal.reactivated_at IS NULL' || chr(10) ||
    '     AND NOT continuum_offboarding_actual_state_is_erased(run.run_id)' || chr(10) ||
    '     AND continuum_offboarding_noncoordination_state_is_erased(run.run_id)' || chr(10) ||
    '  ) THEN' || chr(10) ||
    '    RAISE EXCEPTION ''coordination privacy repair is required; completed offboarding restart refused'';' || chr(10) ||
    '  END IF;' || chr(10) ||
    anchor;
  revised := replace(definition, anchor, replacement);
  IF revised = definition
      OR position('completed offboarding restart refused' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to fence privacy-only offboarding restart';
  END IF;
  EXECUTE revised;
END;
$restart_fence$;

-- Extend the exact operator function profile. Neither progress tables nor the
-- private non-coordination predicate are granted to runtime roles.
DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '        (''continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)''),',
    '        (''continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_offboarding_actual_state_is_erased(uuid,uuid)''),');
  IF revised = definition
      OR position('continuum_operator_list_coordination_privacy_repairs' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to extend coordination repair operator allow-list';
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
         'continuum_operator_list_coordination_privacy_repairs',
         'continuum_operator_offboarding_actual_state_is_erased',
         'continuum_offboarding_noncoordination_state_is_erased',
         'continuum_restart_offboarding_run'
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
