-- Close independent-review gaps in coordination privacy completion, rollout
-- discovery, lifecycle fencing, and lock ordering without changing any
-- ledgered issue-7 migration.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE coordination_principal_privacy_progress
  DROP CONSTRAINT coordination_principal_privacy_progress_privacy_version_check;
ALTER TABLE coordination_principal_privacy_progress
  ADD CONSTRAINT coordination_principal_privacy_progress_privacy_version_check
  CHECK (privacy_version BETWEEN 1 AND 3);

CREATE INDEX coordination_principal_privacy_repair_idx
  ON coordination_principal_privacy_progress (principal_id)
  WHERE privacy_version < 3 OR completed_at IS NULL;

-- A principal privacy receipt is evidence, not the state predicate. This
-- bounded predicate also catches pre-0065 lock metadata after an old cursor
-- and shared state that still identifies the principal.
CREATE FUNCTION continuum_coordination_privacy_actual_state_is_erased(
  target_principal_id UUID, owned_scope_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
      FROM principal_user_scopes mapping
      JOIN coordination_principal_privacy_progress progress
        ON progress.principal_id = mapping.principal_id
     WHERE mapping.principal_id = target_principal_id
       AND mapping.scope_id = owned_scope_id
       AND progress.privacy_version >= 3
       AND progress.completed_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log audit
     WHERE audit.principal_id = target_principal_id
       AND audit.metadata->>'operation' IN (
         'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect')
       AND audit.metadata ?| ARRAY[
         'request_id','run_id','lease_id','resource','resource_sha256'])
  AND NOT EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.principal_id = target_principal_id
       AND receipt.scope_id <> owned_scope_id)
  AND NOT EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.principal_id = target_principal_id
       AND lease.scope_id <> owned_scope_id);
$$;
REVOKE ALL ON FUNCTION
  continuum_coordination_privacy_actual_state_is_erased(UUID, UUID) FROM PUBLIC;

-- Keep the entire non-coordination predicate in one implementation. Both
-- public predicate variants become tiny wrappers over the same shared core,
-- so adding a lifecycle clause cannot silently drift one copy.
ALTER FUNCTION continuum_offboarding_noncoordination_state_is_erased(UUID)
  RENAME TO continuum_offboarding_lifecycle_state_is_erased;

CREATE FUNCTION continuum_offboarding_state_is_erased(
  target_run_id UUID, include_coordination BOOLEAN
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased(target_run_id)
    AND (NOT include_coordination OR COALESCE((
      SELECT continuum_coordination_privacy_actual_state_is_erased(
               run.principal_id, run.scope_id)
             AND NOT EXISTS (
               SELECT 1 FROM coordination_operation_receipts receipt
                WHERE receipt.principal_id = run.principal_id)
             AND NOT EXISTS (
               SELECT 1 FROM coordination_leases lease
                WHERE lease.principal_id = run.principal_id)
        FROM principal_offboarding_runs run
       WHERE run.run_id = target_run_id
    ), FALSE));
$$;

CREATE OR REPLACE FUNCTION continuum_offboarding_actual_state_is_erased(
  target_run_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_state_is_erased(target_run_id, TRUE);
$$;

CREATE FUNCTION continuum_offboarding_noncoordination_state_is_erased(
  target_run_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_state_is_erased(target_run_id, FALSE);
$$;

REVOKE ALL ON FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_offboarding_state_is_erased(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_offboarding_actual_state_is_erased(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_offboarding_noncoordination_state_is_erased(UUID) FROM PUBLIC;

-- Version 3 replays the audit keyset from zero, including owned-scope rows.
UPDATE coordination_principal_privacy_progress progress
   SET audit_cursor_id = 0,
       completed_at = NULL,
       updated_at = clock_timestamp()
  FROM principals principal
 WHERE principal.id = progress.principal_id
   AND (principal.disabled_at IS NOT NULL OR principal.offboarded_at IS NOT NULL)
   AND (progress.privacy_version < 3 OR progress.completed_at IS NOT NULL);

DO $scrub_v3$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '       AND audit.scope_id IS DISTINCT FROM owned_scope_id' || chr(10), '');
  revised := replace(revised,
    'DECLARE detached_id CONSTANT UUID',
    'DECLARE blocked_until TIMESTAMPTZ;' || chr(10) ||
    'DECLARE detached_id CONSTANT UUID');
  revised := replace(revised,
    'privacy_version = CASE WHEN complete THEN 2 ELSE privacy_version END',
    'privacy_version = CASE WHEN complete THEN 3 ELSE privacy_version END');
  revised := replace(revised, '''privacy_version'', 2', '''privacy_version'', 3');
  revised := replace(revised,
    'metadata->>''privacy_version'' = ''2''',
    'metadata->>''privacy_version'' = ''3''');
  revised := replace(revised,
    '  INSERT INTO coordination_operator_events' || chr(10) ||
    '    (principal_id, scope_id, operation, metadata)' || chr(10) ||
    '  VALUES (authorization_principal_id, owned_scope_id,' || chr(10) ||
    '    ''coordination_principal_scrub'', jsonb_build_object(' || chr(10) ||
    '      ''phase'', ''batch'', ''audit_rows_scrubbed'', audit_count,',
    '  IF audit_count + receipt_count + lease_count > 0 THEN' || chr(10) ||
    '    INSERT INTO coordination_operator_events' || chr(10) ||
    '      (principal_id, scope_id, operation, metadata)' || chr(10) ||
    '    VALUES (authorization_principal_id, owned_scope_id,' || chr(10) ||
    '      ''coordination_principal_scrub'', jsonb_build_object(' || chr(10) ||
    '        ''phase'', ''batch'', ''audit_rows_scrubbed'', audit_count,');
  revised := replace(revised,
    '      ''privacy_version'', 3, ''complete'', complete));' || chr(10) ||
    '  IF complete AND NOT EXISTS (',
    '        ''privacy_version'', 3, ''complete'', complete));' || chr(10) ||
    '  END IF;' || chr(10) ||
    '  IF audit_count + receipt_count + lease_count = 0 THEN' || chr(10) ||
    '    SELECT min(lease.expires_at) INTO blocked_until' || chr(10) ||
    '    FROM coordination_leases lease' || chr(10) ||
    '   WHERE lease.principal_id = target_principal_id' || chr(10) ||
    '     AND lease.scope_id <> owned_scope_id' || chr(10) ||
    '     AND lease.released_at IS NULL' || chr(10) ||
    '     AND lease.expires_at > clock_timestamp();' || chr(10) ||
    '  END IF;' || chr(10) ||
    '  IF complete AND NOT EXISTS (');
  revised := replace(revised,
    '''leases_scrubbed'', lease_count, ''privacy_version'', 3, ''complete'', complete);',
    '''leases_scrubbed'', lease_count, ''privacy_version'', 3, ''complete'', complete,' ||
    ' ''progressed'', audit_count + receipt_count + lease_count > 0,' ||
    ' ''blocked_until'', blocked_until);');
  IF revised = definition
      OR position('audit.scope_id IS DISTINCT FROM owned_scope_id' IN revised) > 0
      OR position('''progressed''' IN revised) = 0
      OR position('IF audit_count + receipt_count + lease_count > 0' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to install coordination privacy scrub v3';
  END IF;
  EXECUTE revised;
END;
$scrub_v3$;

CREATE OR REPLACE FUNCTION continuum_coordination_privacy_state(
  target_principal_id UUID, owned_scope_id UUID
) RETURNS TABLE (
  privacy_version INTEGER, principal_complete BOOLEAN, scope_complete BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(principal_progress.privacy_version, 0),
         continuum_coordination_privacy_actual_state_is_erased(
           mapping.principal_id, mapping.scope_id),
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

-- Cursor-based repair discovery uses the partial progress index. The legacy
-- three-argument signature remains a first-page compatibility wrapper.
CREATE FUNCTION continuum_operator_list_coordination_privacy_repairs(
  authorization_principal_id UUID, after_principal_id UUID,
  target_principal_id UUID, row_limit INTEGER
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
     AND (after_principal_id IS NULL OR principal.id > after_principal_id)
     AND principal.disabled_at IS NOT NULL
     AND (progress.privacy_version < 3 OR progress.completed_at IS NULL
          OR NOT continuum_coordination_privacy_actual_state_is_erased(
            principal.id, mapping.scope_id))
   ORDER BY principal.id
   LIMIT row_limit;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_operator_list_coordination_privacy_repairs(
  authorization_principal_id UUID, target_principal_id UUID, row_limit INTEGER
) RETURNS TABLE(principal_id UUID, scope_id UUID, repair_state TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT * FROM continuum_operator_list_coordination_privacy_repairs(
    authorization_principal_id, NULL, target_principal_id, row_limit);
$$;
REVOKE ALL ON FUNCTION
  continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER)
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  continuum_operator_list_coordination_privacy_repairs(UUID, UUID, INTEGER)
FROM PUBLIC;

-- Database-level fail-closed checks protect old binaries and direct SQL from
-- using offboarding create/start to turn a pending disabled-only privacy
-- repair into irreversible lifecycle erasure.
CREATE FUNCTION continuum_guard_disabled_only_privacy_offboarding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_principal UUID;
BEGIN
  target_principal := CASE WHEN TG_TABLE_NAME = 'principal_offboarding_runs'
    THEN NEW.principal_id ELSE (
      SELECT run.principal_id FROM principal_offboarding_runs run
       WHERE run.run_id = NEW.run_id) END;
  IF EXISTS (
    SELECT 1 FROM principals principal
    JOIN principal_user_scopes mapping ON mapping.principal_id = principal.id
    JOIN coordination_principal_privacy_progress progress
      ON progress.principal_id = principal.id
   WHERE principal.id = target_principal
     AND principal.disabled_at IS NOT NULL
     AND principal.offboarded_at IS NULL
     AND (progress.privacy_version < 3 OR progress.completed_at IS NULL
          OR NOT continuum_coordination_privacy_actual_state_is_erased(
            principal.id, mapping.scope_id))
  ) THEN
    RAISE EXCEPTION
      'pending disabled-only privacy repair blocks offboarding create/start';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_disabled_only_privacy_offboarding() FROM PUBLIC;
CREATE TRIGGER guard_disabled_only_privacy_offboarding_create
BEFORE INSERT ON principal_offboarding_runs
FOR EACH ROW EXECUTE FUNCTION continuum_guard_disabled_only_privacy_offboarding();
CREATE TRIGGER guard_disabled_only_privacy_offboarding_start
BEFORE INSERT ON principal_offboarding_run_events
FOR EACH ROW WHEN (NEW.phase = 'started')
EXECUTE FUNCTION continuum_guard_disabled_only_privacy_offboarding();

-- Reactivation participates in the same advisory-before-principal order as
-- direct scrub, repair, and offboarding.
CREATE OR REPLACE FUNCTION continuum_operator_reactivate_principal(
  target_principal_id UUID, authorization_principal_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(authorization_principal_id, 'approve');
  PERFORM pg_advisory_xact_lock(hashtextextended(target_principal_id::text, 762));
  RETURN continuum_reactivate_principal(target_principal_id, authorization_principal_id);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_reactivate_principal(UUID, UUID) FROM PUBLIC;

DO $allowlist$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,integer)''),',
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,integer)''),' || chr(10) ||
    '        (''continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)''),');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to extend coordination repair cursor allow-list';
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
         'continuum_coordination_privacy_actual_state_is_erased',
         'continuum_offboarding_lifecycle_state_is_erased',
         'continuum_offboarding_state_is_erased',
         'continuum_offboarding_actual_state_is_erased',
         'continuum_offboarding_noncoordination_state_is_erased',
         'continuum_operator_scrub_coordination_principal',
         'continuum_coordination_privacy_state',
         'continuum_operator_list_coordination_privacy_repairs',
         'continuum_guard_disabled_only_privacy_offboarding',
         'continuum_operator_reactivate_principal'
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
