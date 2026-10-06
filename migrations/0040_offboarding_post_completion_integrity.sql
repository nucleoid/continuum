-- Upgrade-safe follow-up for installations that already ledgered 0039.
-- Keep completion verification index-driven and preserve the proved erasure
-- state against post-completion mutation races.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_offboarding_actual_state_is_erased(target_run_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH target_run AS NOT MATERIALIZED (
    SELECT run.* FROM principal_offboarding_runs run
     WHERE run.run_id = target_run_id
  ), direct_audit AS (
    -- OFFSET 0 preserves each parameterized, ordered selector as its own
    -- planner path instead of allowing a fence-wide audit_log join.
    SELECT audit.id, audit.request_id
      FROM target_run run
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.metadata->>'request_id' AS request_id
          FROM audit_log candidate
         WHERE candidate.principal_id = run.principal_id
           AND candidate.id <= run.audit_fence_id
         ORDER BY candidate.principal_id, candidate.id OFFSET 0
      ) audit
    UNION
    SELECT audit.id, audit.request_id
      FROM target_run run
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.metadata->>'request_id' AS request_id
          FROM audit_log candidate
         WHERE candidate.scope_id = run.scope_id
           AND candidate.id <= run.audit_fence_id
         ORDER BY candidate.scope_id, candidate.id OFFSET 0
      ) audit
    UNION
    SELECT audit.id, audit.request_id
      FROM target_run run
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.metadata->>'request_id' AS request_id
          FROM audit_log_offboarding_scopes selector
          JOIN audit_log candidate ON candidate.id = selector.audit_id
                                  AND candidate.id <= run.audit_fence_id
         WHERE selector.scope_id = run.scope_id AND selector.selector_kind = 'memory'
         ORDER BY selector.audit_id OFFSET 0
      ) audit
    UNION
    SELECT audit.id, audit.request_id
      FROM target_run run
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.metadata->>'request_id' AS request_id
          FROM audit_log_offboarding_scopes selector
          JOIN audit_log candidate ON candidate.id = selector.audit_id
                                  AND candidate.id <= run.audit_fence_id
         WHERE selector.scope_id = run.scope_id AND selector.selector_kind = 'scope_ids'
         ORDER BY selector.audit_id OFFSET 0
      ) audit
  ), linked_request AS (
    SELECT request.request_id FROM target_run run
      CROSS JOIN LATERAL (
        SELECT candidate.request_id FROM principal_offboarding_audit_requests candidate
         WHERE candidate.principal_id = run.principal_id
         ORDER BY candidate.request_id OFFSET 0
      ) request
    UNION
    SELECT request_id FROM direct_audit WHERE request_id IS NOT NULL
  ), target_audit AS (
    SELECT id FROM direct_audit
    UNION
    SELECT audit.id FROM linked_request request
      CROSS JOIN LATERAL (
        SELECT linked.id FROM target_run run
          JOIN audit_log linked ON linked.metadata ? 'request_id'
                               AND linked.metadata->>'request_id' = request.request_id
                               AND linked.id <= run.audit_fence_id
         ORDER BY linked.id OFFSET 0
      ) audit
  )
  SELECT COALESCE((
    SELECT NOT (
      NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = run.principal_id
                   AND p.disabled_at IS NOT NULL AND p.offboarded_at IS NOT NULL
                   AND p.reactivated_at IS NULL
                   AND p.display_name = 'erased-' ||
                     left(replace(run.principal_id::text, '-', ''), 12))
      OR NOT EXISTS (SELECT 1 FROM scopes s WHERE s.id = run.scope_id
                      AND s.kind = 'user'
                      AND s.name = 'erased-user-' || run.scope_id::text)
      OR NOT EXISTS (SELECT 1 FROM principal_user_scopes mapping
                      WHERE mapping.principal_id = run.principal_id
                        AND mapping.scope_id = run.scope_id)
      OR NOT EXISTS (SELECT 1 FROM principal_user_scope_approvals approval
                      WHERE approval.id = run.approval_id
                        AND approval.principal_id = run.principal_id
                        AND approval.scope_id = run.scope_id
                        AND approval.acknowledged_evidence_hash =
                          run.approval_evidence_hash)
      OR EXISTS (SELECT 1 FROM memories m WHERE m.scope_id = run.scope_id AND (
        m.type IS DISTINCT FROM 'context' OR m.title IS DISTINCT FROM '[erased]'
        OR m.body IS DISTINCT FROM '[erased]'
        OR m.metadata IS DISTINCT FROM '{}'::jsonb
        OR m.tags IS DISTINCT FROM '{}'::text[]
        OR m.source IS DISTINCT FROM 'erased'
        OR m.source_ref IS NOT NULL OR m.state IS DISTINCT FROM 'archived'
        OR m.supersedes_id IS NOT NULL OR m.promoted_to_id IS NOT NULL
        OR m.expires_at IS NOT NULL OR m.last_verified IS NOT NULL))
      OR EXISTS (SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
                  WHERE m.scope_id = run.scope_id)
      OR EXISTS (SELECT 1 FROM scope_memberships m
                  WHERE m.scope_id = run.scope_id AND m.active)
      OR EXISTS (SELECT 1 FROM principal_aliases a WHERE a.principal_id = run.principal_id)
      OR EXISTS (SELECT 1 FROM entra_groups g WHERE g.scope_id = run.scope_id
                  AND (g.active OR g.approval_revoked_at IS NULL))
      OR EXISTS (
        SELECT 1 FROM target_audit target JOIN audit_log audit ON audit.id = target.id
         WHERE audit.query IS NOT NULL OR audit.metadata IS DISTINCT FROM
             continuum_offboarding_expected_audit_metadata(audit.metadata))
    ) FROM target_run run
  ), FALSE)
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_actual_state_is_erased(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_protect_offboarded_scope_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  owner_offboarded BOOLEAN;
BEGIN
  SELECT TRUE INTO owner_offboarded
    FROM principal_user_scopes mapping
    JOIN principals principal ON principal.id = mapping.principal_id
   WHERE mapping.scope_id = OLD.id AND principal.offboarded_at IS NOT NULL
   FOR KEY SHARE OF principal NOWAIT;
  IF FOUND AND (NEW.kind IS DISTINCT FROM 'user'
                OR NEW.name IS DISTINCT FROM 'erased-user-' || NEW.id::text) THEN
    RAISE EXCEPTION 'offboarded owned-scope identity is immutable until guarded reactivation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_offboarded_scope_identity() FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_protect_offboarded_audit_tombstone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  linked_to_offboarded BOOLEAN := FALSE;
BEGIN
  -- The normal bounded scrub writes only the canonical state. Keep that
  -- production-shaped batch O(rows), without per-row linkage lookups/locks.
  IF NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
     AND NEW.scope_id IS NOT DISTINCT FROM OLD.scope_id
     AND NEW.memory_id IS NOT DISTINCT FROM OLD.memory_id
     AND COALESCE(OLD.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped',
       'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased',
       'principal_offboarded',
       'principal_offboarding_repaired'
     ]::text[])
     AND NEW.query IS NULL AND NEW.metadata IS NOT DISTINCT FROM
       continuum_offboarding_expected_audit_metadata(OLD.metadata) THEN
    RETURN NEW;
  END IF;

  SELECT TRUE INTO linked_to_offboarded FROM principals principal
   WHERE principal.id IN (OLD.principal_id, NEW.principal_id)
     AND principal.offboarded_at IS NOT NULL
   FOR KEY SHARE OF principal NOWAIT;
  IF NOT FOUND THEN
    SELECT TRUE INTO linked_to_offboarded
      FROM principal_user_scopes mapping
      JOIN principals principal ON principal.id = mapping.principal_id
     WHERE principal.offboarded_at IS NOT NULL AND (
       mapping.scope_id = OLD.scope_id OR mapping.scope_id = NEW.scope_id
       OR EXISTS (SELECT 1 FROM memories memory
                   WHERE memory.id IN (OLD.memory_id, NEW.memory_id)
                     AND memory.scope_id = mapping.scope_id)
       OR EXISTS (SELECT 1 FROM audit_log_offboarding_scopes selector
                   WHERE selector.audit_id = NEW.id
                     AND selector.scope_id = mapping.scope_id)
       OR EXISTS (SELECT 1 FROM principal_offboarding_audit_requests request
                   WHERE request.principal_id = mapping.principal_id
                     AND request.request_id = COALESCE(
                       NEW.metadata->>'request_id', OLD.metadata->>'request_id'))
     )
     FOR KEY SHARE OF principal NOWAIT;
  END IF;
  IF FOUND OR linked_to_offboarded THEN
    IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.memory_id IS DISTINCT FROM OLD.memory_id THEN
      RAISE EXCEPTION 'offboarded audit linkage is immutable';
    END IF;
    IF COALESCE(OLD.metadata->>'operation', '') = ANY(ARRAY[
         'principal_user_scope_mapped',
         'principal_user_scope_acknowledgement_replaced',
         'principal_memory_erased',
         'principal_offboarded',
         'principal_offboarding_repaired'
       ]::text[]) THEN
      IF NEW.query IS DISTINCT FROM OLD.query OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'preserved offboarding audit evidence is immutable';
      END IF;
    ELSIF NEW.query IS NOT NULL OR NEW.metadata IS DISTINCT FROM
          continuum_offboarding_expected_audit_metadata(OLD.metadata) THEN
      RAISE EXCEPTION 'offboarded audit tombstone is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_protect_offboarded_audit_tombstone() FROM PUBLIC;

DO $migration$
DECLARE
  schema_name TEXT := current_schema();
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT procedure.proname,
           pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
            OR procedure.proname = 'reject_lifecycle_principal_membership')
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name
    );
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_proc procedure
     WHERE procedure.pronamespace = current_schema()::regnamespace
       AND (procedure.proname LIKE 'continuum\_%' ESCAPE '\'
            OR procedure.proname = 'reject_lifecycle_principal_membership')
       AND procedure.proowner = current_user::regrole
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
          WHERE dependency.classid = 'pg_proc'::regclass
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
       AND NOT COALESCE(procedure.proconfig @> ARRAY[
         format('search_path=pg_catalog, %s, pg_temp', schema_name)
       ], FALSE)
  ) THEN
    RAISE EXCEPTION 'Continuum function search_path hardening is incomplete';
  END IF;
END;
$migration$;
