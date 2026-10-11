-- Complete the post-0066 privacy rollout and make owned-user-scope principal
-- locking consistent across coordination and offboarding.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

UPDATE coordination_principal_privacy_progress progress
   SET audit_cursor_id = 0,
       completed_at = NULL,
       updated_at = clock_timestamp()
  FROM principals principal
 WHERE principal.id = progress.principal_id
   AND (principal.disabled_at IS NOT NULL OR principal.offboarded_at IS NOT NULL)
   AND progress.privacy_version = 2
   AND progress.completed_at IS NOT NULL;

DO $actual_state$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_offboarding_actual_state_is_erased(uuid)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '    OR EXISTS (SELECT 1 FROM scope_memberships m WHERE m.scope_id = run.scope_id AND m.active)',
    '    OR EXISTS (SELECT 1 FROM coordination_principal_privacy_progress progress' || chr(10) ||
    '      WHERE progress.principal_id = run.principal_id' || chr(10) ||
    '        AND (progress.privacy_version < 2 OR progress.completed_at IS NULL))' || chr(10) ||
    '    OR EXISTS (SELECT 1 FROM scope_memberships m WHERE m.scope_id = run.scope_id AND m.active)');
  IF revised = definition
      OR position('progress.privacy_version < 2 OR progress.completed_at IS NULL' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to add coordination privacy to offboarding actual state';
  END IF;
  EXECUTE revised;
END;
$actual_state$;

DO $scope_access$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_operator_offboard_scope_access(uuid,uuid)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);' || chr(10) ||
    '  SELECT run.run_id, run.principal_id INTO bound_run_id, bound_principal_id',
    '  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);' || chr(10) ||
    '  PERFORM 1 FROM principals principal' || chr(10) ||
    '    JOIN scope_memberships membership ON membership.principal_id = principal.id' || chr(10) ||
    '   WHERE membership.scope_id = target_scope_id' || chr(10) ||
    '   ORDER BY principal.id FOR UPDATE OF principal;' || chr(10) ||
    '  SELECT run.run_id, run.principal_id INTO bound_run_id, bound_principal_id');
  IF revised = definition
      OR position('ORDER BY principal.id FOR UPDATE OF principal' IN revised) = 0 THEN
    RAISE EXCEPTION 'unable to repair offboarding member-principal lock order';
  END IF;
  EXECUTE revised;
END;
$scope_access$;
