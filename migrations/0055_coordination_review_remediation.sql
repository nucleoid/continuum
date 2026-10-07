-- Forward-only remediation for the public coordination review.

ALTER TABLE coordination_scope_usage
  ADD COLUMN IF NOT EXISTS resource_limit INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE coordination_scope_usage
  DROP CONSTRAINT IF EXISTS coordination_scope_usage_resource_count_check,
  DROP CONSTRAINT IF EXISTS coordination_scope_usage_resource_limit_check;
ALTER TABLE coordination_scope_usage
  ADD CONSTRAINT coordination_scope_usage_resource_count_check
    CHECK (resource_count BETWEEN 0 AND 1000000),
  ADD CONSTRAINT coordination_scope_usage_resource_limit_check
    CHECK (resource_limit BETWEEN 1 AND 1000000);

ALTER TABLE coordination_principal_usage
  ADD COLUMN IF NOT EXISTS acquire_receipt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mutation_receipt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resource_window_started_at TIMESTAMPTZ
    NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS resource_window_count INTEGER NOT NULL DEFAULT 0;

UPDATE coordination_principal_usage usage
   SET acquire_receipt_count = counts.acquire_count,
       mutation_receipt_count = counts.mutation_count
  FROM (
    SELECT principal_id,
           count(*) FILTER (WHERE operation = 'acquire')::int AS acquire_count,
           count(*) FILTER (WHERE operation <> 'acquire')::int AS mutation_count
      FROM coordination_operation_receipts GROUP BY principal_id
  ) counts
 WHERE counts.principal_id = usage.principal_id;
ALTER TABLE coordination_principal_usage
  DROP COLUMN IF EXISTS receipt_count,
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_acquire_receipt_count_check,
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_mutation_receipt_count_check,
  DROP CONSTRAINT IF EXISTS coordination_principal_usage_resource_window_count_check,
  ADD CONSTRAINT coordination_principal_usage_acquire_receipt_count_check
    CHECK (acquire_receipt_count BETWEEN 0 AND 10000),
  ADD CONSTRAINT coordination_principal_usage_mutation_receipt_count_check
    CHECK (mutation_receipt_count BETWEEN 0 AND 10000),
  ADD CONSTRAINT coordination_principal_usage_resource_window_count_check
    CHECK (resource_window_count BETWEEN 0 AND 100);

CREATE TABLE coordination_fencing_floors (
  scope_id      UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  resource_hash BYTEA NOT NULL CHECK (octet_length(resource_hash) = 32),
  fencing_floor BIGINT NOT NULL CHECK (fencing_floor >= 0),
  reclaimed_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_id, resource_hash)
);
REVOKE ALL ON TABLE coordination_fencing_floors FROM PUBLIC;

CREATE INDEX IF NOT EXISTS coordination_resources_current_lease_idx
  ON coordination_resources (current_lease_id)
  WHERE current_lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coordination_leases_principal_terminal_idx
  ON coordination_leases
    (principal_id, (COALESCE(released_at, expires_at)), lease_id);

-- Resource pseudonymization updates every referring row atomically.
ALTER TABLE coordination_leases
  DROP CONSTRAINT IF EXISTS coordination_leases_scope_id_resource_fkey,
  ADD CONSTRAINT coordination_leases_scope_id_resource_fkey
    FOREIGN KEY (scope_id, resource)
    REFERENCES coordination_resources(scope_id, resource)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE coordination_operation_receipts
  DROP CONSTRAINT IF EXISTS coordination_operation_receipts_scope_id_resource_fkey,
  DROP CONSTRAINT IF EXISTS coordination_operation_receipts_lease_id_fkey,
  ADD CONSTRAINT coordination_operation_receipts_scope_id_resource_fkey
    FOREIGN KEY (scope_id, resource)
    REFERENCES coordination_resources(scope_id, resource)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT coordination_operation_receipts_lease_id_fkey
    FOREIGN KEY (lease_id) REFERENCES coordination_leases(lease_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION continuum_operator_reclaim_coordination_resource(
  authorization_principal_id UUID,
  target_scope_id UUID,
  target_resource TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE state RECORD;
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  SELECT fencing_token, current_lease_id INTO state
    FROM coordination_resources
   WHERE scope_id = target_scope_id AND resource = target_resource
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coordination resource is not reclaimable'; END IF;
  IF EXISTS (
    SELECT 1 FROM coordination_leases lease
     WHERE lease.lease_id = state.current_lease_id
       AND lease.released_at IS NULL AND lease.expires_at > clock_timestamp()
  ) OR EXISTS (
    SELECT 1 FROM coordination_operation_receipts receipt
     WHERE receipt.scope_id = target_scope_id AND receipt.resource = target_resource
  ) THEN RAISE EXCEPTION 'coordination resource is not reclaimable'; END IF;

  UPDATE coordination_resources SET current_lease_id = NULL
   WHERE scope_id = target_scope_id AND resource = target_resource;
  INSERT INTO coordination_fencing_floors
    (scope_id, resource_hash, fencing_floor)
  VALUES (
    target_scope_id, sha256(convert_to(target_resource, 'UTF8')),
    state.fencing_token
  )
  ON CONFLICT (scope_id, resource_hash) DO UPDATE SET
    fencing_floor = GREATEST(
      coordination_fencing_floors.fencing_floor, EXCLUDED.fencing_floor),
    reclaimed_at = clock_timestamp();
  DELETE FROM coordination_leases
   WHERE scope_id = target_scope_id AND resource = target_resource;
  DELETE FROM coordination_resources
   WHERE scope_id = target_scope_id AND resource = target_resource;
  UPDATE coordination_scope_usage
     SET resource_count = resource_count - 1, updated_at = clock_timestamp()
   WHERE scope_id = target_scope_id AND resource_count > 0;
  RETURN state.fencing_token;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_reclaim_coordination_resource(
  UUID, UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_operator_set_coordination_scope_quota(
  authorization_principal_id UUID,
  target_scope_id UUID,
  new_resource_limit INTEGER
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF new_resource_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'coordination resource limit is outside the supported range';
  END IF;
  INSERT INTO coordination_scope_usage (scope_id, resource_limit)
  VALUES (target_scope_id, new_resource_limit)
  ON CONFLICT (scope_id) DO UPDATE SET
    resource_limit = EXCLUDED.resource_limit,
    updated_at = clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_set_coordination_scope_quota(
  UUID, UUID, INTEGER) FROM PUBLIC;

-- Preserve useful lock evidence without retaining a dictionary-attackable
-- resource digest. Resource bytes and opaque operation identifiers are safe.
DO $migration$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '    WHEN audit_metadata->>''source'' = ''audit-retention'' THEN',
    '    WHEN audit_metadata->>''operation'' IN (' || chr(10) ||
    '      ''lock_acquire'', ''lock_inspect'', ''lock_release'', ''lock_renew''' || chr(10) ||
    '    ) THEN' || chr(10) ||
    '      (SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), ''{}''::jsonb)' || chr(10) ||
    '         FROM jsonb_each(audit_metadata) entry' || chr(10) ||
    '        WHERE entry.key = ANY(ARRAY[' || chr(10) ||
    '          ''operation'',''outcome'',''request_id'',''run_id'',''lease_id'',' || chr(10) ||
    '          ''fencing_token'',''resource_bytes'',''transport'',''own_lease''' || chr(10) ||
    '        ]::text[]))' || chr(10) ||
    '    WHEN audit_metadata->>''source'' = ''audit-retention'' THEN');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to extend offboarding audit metadata classifier';
  END IF;
  EXECUTE revised;
END;
$migration$;

CREATE OR REPLACE FUNCTION continuum_operator_pseudonymize_scope(
  authorization_principal_id UUID,
  target_scope_id UUID,
  pseudonym TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(
    authorization_principal_id, 'approve');
  IF pseudonym IS NULL OR btrim(pseudonym) = '' THEN
    RAISE EXCEPTION 'scope pseudonym must not be empty';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scopes WHERE id = target_scope_id AND kind = 'user'
      AND id <> continuum_org_scope_id() FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'only an existing non-organization user scope may be pseudonymized';
  END IF;
  UPDATE coordination_resources
     SET resource = 'offboarded:' || gen_random_uuid()::text,
         updated_at = clock_timestamp()
   WHERE scope_id = target_scope_id;
  UPDATE scopes SET name = pseudonym WHERE id = target_scope_id;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_pseudonymize_scope(UUID, UUID, TEXT)
  FROM PUBLIC;

-- Extend the exact application and operator profiles without editing the
-- checksum-pinned migration that originally defined them.
DO $migration$
DECLARE definition TEXT; revised TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'continuum_assert_application_role_allowlist(name,boolean)'::regprocedure)
    INTO definition;
  revised := replace(definition,
    '      (''principal_offboarding_takeover_events'',''SELECT'')',
    '      (''principal_offboarding_takeover_events'',''SELECT''),' || chr(10) ||
    '      (''coordination_resources'',''SELECT''),(''coordination_resources'',''INSERT''),' || chr(10) ||
    '      (''coordination_resources'',''UPDATE''),' || chr(10) ||
    '      (''coordination_leases'',''SELECT''),(''coordination_leases'',''INSERT''),' || chr(10) ||
    '      (''coordination_leases'',''UPDATE''),(''coordination_leases'',''DELETE''),' || chr(10) ||
    '      (''coordination_operation_receipts'',''SELECT''),' || chr(10) ||
    '      (''coordination_operation_receipts'',''INSERT''),' || chr(10) ||
    '      (''coordination_operation_receipts'',''UPDATE''),' || chr(10) ||
    '      (''coordination_operation_receipts'',''DELETE''),' || chr(10) ||
    '      (''coordination_scope_usage'',''SELECT''),(''coordination_scope_usage'',''INSERT''),' || chr(10) ||
    '      (''coordination_scope_usage'',''UPDATE''),' || chr(10) ||
    '      (''coordination_principal_usage'',''SELECT''),(''coordination_principal_usage'',''INSERT''),' || chr(10) ||
    '      (''coordination_principal_usage'',''UPDATE''),' || chr(10) ||
    '      (''coordination_fencing_floors'',''SELECT'')');
  revised := replace(revised,
    '        (''continuum_operator_pseudonymize_scope(uuid,uuid,text)''),',
    '        (''continuum_operator_pseudonymize_scope(uuid,uuid,text)''),' || chr(10) ||
    '        (''continuum_operator_reclaim_coordination_resource(uuid,uuid,text)''),' || chr(10) ||
    '        (''continuum_operator_set_coordination_scope_quota(uuid,uuid,integer)''),');
  IF revised = definition THEN
    RAISE EXCEPTION 'unable to extend application role allow-list';
  END IF;
  EXECUTE revised;
END;
$migration$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT function.proname,
           pg_get_function_identity_arguments(function.oid) AS arguments
      FROM pg_proc function
     WHERE function.pronamespace = quote_ident(current_schema())::regnamespace
       AND function.proname = ANY(ARRAY[
         'continuum_operator_pseudonymize_scope',
         'continuum_operator_reclaim_coordination_resource',
         'continuum_operator_set_coordination_scope_quota'
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
