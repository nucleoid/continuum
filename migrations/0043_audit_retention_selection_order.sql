-- Upgrade-safe correction for retention batches whose stable (at,id) order is
-- not the same as ID order. Compare sets by ID while preserving time endpoints.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_apply_audit_retention(
  authorization_principal_id UUID,
  cutoff TIMESTAMPTZ,
  retention_days INTEGER,
  retention_run_id UUID,
  batch_number INTEGER,
  expected_rows JSONB,
  export_mode TEXT,
  export_sha256 TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  actual_rows JSONB;
  expected_rows_by_id JSONB;
  deleted_count INTEGER;
  first_row JSONB;
  last_row JSONB;
BEGIN
  IF retention_days < 1 OR batch_number < 1
     OR jsonb_typeof(expected_rows) <> 'array'
     OR jsonb_array_length(expected_rows) NOT BETWEEN 1 AND 1000
     OR export_mode NOT IN ('none', 'jsonl')
     OR (export_mode = 'jsonl' AND export_sha256 !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid audit retention batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals principal
    JOIN scope_memberships membership ON membership.principal_id = principal.id
    JOIN scopes scope ON scope.id = membership.scope_id
    WHERE principal.id = authorization_principal_id
      AND principal.disabled_at IS NULL
      AND scope.kind = 'org' AND scope.name = ''
      AND membership.active AND membership.role = 'admin'
      AND continuum_membership_is_effective(membership.active, membership.source_kind)
  ) THEN
    RAISE EXCEPTION 'audit retention requires a current org admin';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(expected_rows)) <>
     (SELECT count(DISTINCT (row->>'id')::bigint) FROM jsonb_array_elements(expected_rows) row) THEN
    RAISE EXCEPTION 'audit retention batch contains duplicate IDs';
  END IF;
  SELECT jsonb_agg(row ORDER BY (row->>'id')::bigint)
    INTO expected_rows_by_id FROM jsonb_array_elements(expected_rows) row;

  SELECT jsonb_agg(jsonb_build_object(
           'id', audit.id::text,
           'at', CASE
             WHEN audit.at = '-infinity'::timestamptz THEN '-infinity'
             WHEN audit.at = 'infinity'::timestamptz THEN 'infinity'
             WHEN extract(year FROM audit.at AT TIME ZONE 'UTC') < 1
               THEN to_char(audit.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z" BC')
             ELSE to_char(audit.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           END,
           'principal_id', audit.principal_id,
           'action', audit.action,
           'memory_id', audit.memory_id,
           'scope_id', audit.scope_id,
           'query', audit.query,
           'metadata_json', audit.metadata::text
         ) ORDER BY audit.id)
    INTO actual_rows
    FROM audit_log audit
   WHERE audit.id = ANY(ARRAY(
           SELECT (row->>'id')::bigint FROM jsonb_array_elements(expected_rows) row
         ))
     AND audit.at < cutoff
     AND COALESCE(audit.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
     ]::text[])
     AND COALESCE(audit.metadata->>'source', '') <> 'audit-retention';
  IF actual_rows IS DISTINCT FROM expected_rows_by_id THEN
    RAISE EXCEPTION 'audit retention row changed after export or is not deletable';
  END IF;

  first_row := expected_rows->0;
  last_row := expected_rows->(jsonb_array_length(expected_rows) - 1);
  DELETE FROM audit_log audit
   WHERE audit.id = ANY(ARRAY(
           SELECT (row->>'id')::bigint FROM jsonb_array_elements(expected_rows) row
         ))
     AND audit.at < cutoff
     AND COALESCE(audit.metadata->>'operation', '') <> ALL(ARRAY[
       'principal_user_scope_mapped', 'principal_user_scope_acknowledgement_replaced',
       'principal_memory_erased', 'principal_offboarded', 'principal_offboarding_repaired'
     ]::text[])
     AND COALESCE(audit.metadata->>'source', '') <> 'audit-retention';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> jsonb_array_length(expected_rows) THEN
    RAISE EXCEPTION 'audit retention delete count did not match the selected batch';
  END IF;
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (authorization_principal_id, 'archive', jsonb_build_object(
    'source', 'audit-retention',
    'cutoff', to_char(cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'retention_days', retention_days,
    'first_id', first_row->>'id',
    'last_id', last_row->>'id',
    'first_at', first_row->>'at',
    'last_at', last_row->>'at',
    'deleted_count', deleted_count,
    'export_mode', export_mode,
    'export_sha256', export_sha256,
    'run_id', retention_run_id,
    'batch_number', batch_number
  ));
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION continuum_apply_audit_retention(
  UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT
) FROM PUBLIC;

DO $migration$
DECLARE
  schema_name TEXT := current_schema();
  owner_name TEXT;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO owner_name
    FROM pg_proc
   WHERE oid = 'continuum_apply_audit_retention(uuid,timestamptz,integer,uuid,integer,jsonb,text,text)'::regprocedure;
  IF owner_name <> current_user THEN
    RAISE EXCEPTION 'foreign-owned Continuum SECURITY DEFINER retention function is unsafe';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$migration$;
