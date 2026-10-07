\if :{?continuum_app_role}
\else
  \echo 'continuum_app_role must name an existing non-owner role'
  \quit
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
  :"continuum_schema".continuum_entra_reapproval_requests,
  :"continuum_schema".principal_offboarding_audit_requests,
  :"continuum_schema".continuum_offboarding_restart_requests
FROM :"continuum_app_role";

SELECT :"continuum_schema".continuum_assert_application_role_allowlist(
  :'continuum_app_role'::name
);
COMMIT;
