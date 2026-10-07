\set ON_ERROR_STOP on
\if :{?continuum_app_role}
\else
  \echo 'continuum_app_role must name an existing non-owner role'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the migration owner after continuum-migrate. The role is deliberately
-- not granted CREATE on the schema or any privilege on capability tables.
-- The transaction makes re-profiling an existing operator fail atomically.
BEGIN;
GRANT USAGE ON SCHEMA :"continuum_schema" TO :"continuum_app_role";

GRANT SELECT, INSERT, UPDATE ON TABLE
  :"continuum_schema".principals,
  :"continuum_schema".memories
TO :"continuum_app_role";
GRANT SELECT, INSERT ON TABLE :"continuum_schema".scopes
TO :"continuum_app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".scopes
FROM :"continuum_app_role";
GRANT SELECT ON TABLE :"continuum_schema".entra_groups TO :"continuum_app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".entra_groups
FROM :"continuum_app_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  :"continuum_schema".scope_memberships,
  :"continuum_schema".memory_embeddings
TO :"continuum_app_role";

GRANT SELECT, INSERT, UPDATE ON TABLE
  :"continuum_schema".service_api_keys,
  :"continuum_schema".ingest_deliveries
TO :"continuum_app_role";
GRANT SELECT ON TABLE :"continuum_schema".entra_sync_state TO :"continuum_app_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".entra_sync_state
FROM :"continuum_app_role";

GRANT SELECT, INSERT, UPDATE ON TABLE
  :"continuum_schema".principal_user_scopes
TO :"continuum_app_role";
GRANT SELECT ON TABLE :"continuum_schema".principal_offboarding_runs
TO :"continuum_app_role";

GRANT SELECT, INSERT ON TABLE :"continuum_schema".audit_log
TO :"continuum_app_role";
GRANT SELECT, DELETE ON TABLE :"continuum_schema".principal_aliases
TO :"continuum_app_role";
GRANT SELECT ON TABLE
  :"continuum_schema".audit_log_offboarding_scopes,
  :"continuum_schema".audit_log_offboarding_backfill_state
TO :"continuum_app_role";
GRANT SELECT ON TABLE
  :"continuum_schema".principal_user_scope_approvals
TO :"continuum_app_role";
GRANT SELECT ON TABLE
  :"continuum_schema".principal_offboarding_events,
  :"continuum_schema".principal_offboarding_run_events,
  :"continuum_schema".principal_offboarding_takeover_events
TO :"continuum_app_role";

-- Upgrade rehearsals may profile a role before 0054 exists. Defer these exact
-- grants until the coordination schema is present; the final allow-list call
-- still rejects missing or broader privileges after 0055.
SELECT set_config('continuum.application_grant_target', :'continuum_app_role', TRUE);
SELECT set_config('continuum.application_grant_schema', namespace.nspname, TRUE)
FROM :"continuum_schema".scopes scope
JOIN pg_catalog.pg_class relation ON relation.oid = scope.tableoid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
LIMIT 1;
DO $coordination_grants$
DECLARE schema_name TEXT := current_setting('continuum.application_grant_schema');
        target_role NAME := current_setting('continuum.application_grant_target')::name;
BEGIN
  IF to_regclass(format('%I.coordination_resources', schema_name)) IS NOT NULL THEN
    -- A 0060-era profile granted table-wide UPDATE. PostgreSQL table grants
    -- subsume column grants, so remove the old capability before regranting
    -- the exact lifecycle columns.
    EXECUTE format('REVOKE UPDATE ON TABLE %I.coordination_resources FROM %I',
      schema_name, target_role);
    EXECUTE format('REVOKE UPDATE ON TABLE %I.coordination_leases FROM %I',
      schema_name, target_role);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.coordination_resources TO %I',
      schema_name, target_role);
    EXECUTE format('GRANT UPDATE (fencing_token, current_lease_id, updated_at) ON TABLE %I.coordination_resources TO %I',
      schema_name, target_role);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I.coordination_leases TO %I',
      schema_name, target_role);
    EXECUTE format('GRANT UPDATE (expires_at, released_at) ON TABLE %I.coordination_leases TO %I',
      schema_name, target_role);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I.coordination_operation_receipts TO %I',
      schema_name, target_role);
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON TABLE %I.coordination_operation_receipts FROM %I',
      schema_name, target_role);
    EXECUTE format('GRANT SELECT ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage TO %I',
      schema_name, schema_name, target_role);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage, %I.coordination_scope_fencing_floors FROM %I',
      schema_name, schema_name, schema_name, target_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_coordination_reserve_resource_creation(UUID), %I.continuum_coordination_scope_fencing_floor(UUID) TO %I',
      schema_name, schema_name, target_role);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.continuum_operator_reclaim_coordination_resource(UUID, UUID, TEXT), %I.continuum_operator_set_coordination_scope_quota(UUID, UUID, INTEGER), %I.continuum_operator_sweep_coordination_state(UUID, INTEGER) FROM %I',
      schema_name, schema_name, schema_name, target_role);
    IF to_regprocedure(format(
      '%I.continuum_operator_pseudonymize_scope_v2(uuid,uuid,text)', schema_name
    )) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %I.continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT) FROM %I',
        schema_name, target_role);
    END IF;
    IF to_regprocedure(format(
      '%I.continuum_operator_set_coordination_principal_quota(uuid,uuid,integer,integer)',
      schema_name
    )) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %I.continuum_operator_set_coordination_principal_quota(UUID, UUID, INTEGER, INTEGER) FROM %I',
        schema_name, target_role);
    END IF;
  END IF;
END;
$coordination_grants$;

GRANT USAGE, SELECT ON SEQUENCE
  :"continuum_schema".audit_log_id_seq,
  :"continuum_schema".principal_user_scope_approvals_id_seq,
  :"continuum_schema".principal_offboarding_run_events_id_seq
TO :"continuum_app_role";

GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_org_scope_id(),
  :"continuum_schema".continuum_audit_retention_minimum_days(),
  :"continuum_schema".continuum_offboarding_expected_audit_metadata(JSONB),
  :"continuum_schema".continuum_membership_is_effective(BOOLEAN, TEXT),
  :"continuum_schema".continuum_disable_principal(UUID, UUID)
TO :"continuum_app_role";

-- PUBLIC function execution is closed across the application schema. Restore
-- only pgvector extension routines directly to roles with the application
-- profile; the owner-only helper discovers this role from its memories grant.
SELECT :"continuum_schema".continuum_grant_application_vector_functions();

REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),
  :"continuum_schema".continuum_activate_entra_memberships(UUID, TEXT, UUID[]),
  :"continuum_schema".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),
  :"continuum_schema".continuum_takeover_manual_org_admin(UUID, UUID, UUID),
  :"continuum_schema".continuum_complete_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_resume_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_restart_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_start_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_redact_offboarding_audit(UUID, UUID, BIGINT[]),
  :"continuum_schema".continuum_record_offboarding_event(UUID),
  :"continuum_schema".continuum_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),
  :"continuum_schema".continuum_reactivate_principal(UUID, UUID),
  :"continuum_schema".continuum_rotate_sync_database_identity(UUID, NAME, UUID),
  :"continuum_schema".continuum_record_entra_sync_success(UUID, INTEGER),
  :"continuum_schema".continuum_record_entra_sync_failure(UUID, TEXT, INTEGER),
  :"continuum_schema".continuum_require_sync_session(UUID),
  :"continuum_schema".continuum_cleanup_legacy_offboarding_audit_requests(INTEGER),
  :"continuum_schema".continuum_get_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_get_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_authorize_audit_retention(UUID),
  :"continuum_schema".continuum_sync_observe_entra_group(UUID, TEXT, TEXT),
  :"continuum_schema".continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]),
  :"continuum_schema".continuum_sync_deactivate_entra_groups(UUID, TEXT[]),
  :"continuum_schema".continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT),
  :"continuum_schema".continuum_operator_complete_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_resume_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_restart_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_operator_start_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]),
  :"continuum_schema".continuum_operator_record_offboarding_event(UUID),
  :"continuum_schema".continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),
  :"continuum_schema".continuum_operator_reactivate_principal(UUID, UUID),
  :"continuum_schema".continuum_operator_pseudonymize_scope(UUID, UUID, TEXT),
  :"continuum_schema".continuum_operator_revoke_entra_group_binding(UUID, TEXT),
  :"continuum_schema".continuum_operator_offboard_scope_access(UUID, UUID),
  :"continuum_schema".continuum_operator_remove_entra_membership(UUID, UUID, UUID, TEXT),
  :"continuum_schema".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN)
FROM :"continuum_app_role";

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  :"continuum_schema".principal_offboarding_runs,
  :"continuum_schema".principal_offboarding_run_events,
  :"continuum_schema".principal_offboarding_events
FROM :"continuum_app_role";
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".audit_log
FROM :"continuum_app_role";
REVOKE USAGE, SELECT ON SEQUENCE
  :"continuum_schema".principal_offboarding_events_id_seq
FROM :"continuum_app_role";
REVOKE USAGE, SELECT ON SEQUENCE
  :"continuum_schema".principal_offboarding_takeover_events_id_seq
FROM :"continuum_app_role";

REVOKE ALL ON TABLE :"continuum_schema".continuum_offboarding_completion_requests
FROM :"continuum_app_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_principal_reactivation_requests
FROM :"continuum_app_role";
REVOKE ALL ON TABLE
  :"continuum_schema".continuum_entra_guarded_mutations,
  :"continuum_schema".continuum_principal_disable_requests,
  :"continuum_schema".continuum_canonical_org_scope
FROM :"continuum_app_role";
REVOKE EXECUTE ON FUNCTION
  :"continuum_schema".continuum_backfill_audit_offboarding_scopes(INTEGER)
FROM :"continuum_app_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_write_offboarding_run_internal(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_apply_audit_retention_internal_v44(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT)
FROM :"continuum_app_role";
REVOKE ALL ON TABLE
  :"continuum_schema".continuum_audit_retention_policy,
  :"continuum_schema".continuum_trusted_database_identities,
  :"continuum_schema".continuum_retired_sync_database_identities,
  :"continuum_schema".continuum_entra_reapproval_requests,
  :"continuum_schema".principal_offboarding_audit_requests,
  :"continuum_schema".continuum_offboarding_restart_requests
FROM :"continuum_app_role";

SELECT :"continuum_schema".continuum_assert_application_role_allowlist(
  :'continuum_app_role'::name
);
COMMIT;
