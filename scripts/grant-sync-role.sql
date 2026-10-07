\set ON_ERROR_STOP on
\if :{?continuum_sync_role}
\else
  \echo 'continuum_sync_role must name a dedicated existing non-owner login role'
\endif
\if :{?continuum_principal_id}
\else
  \echo 'continuum_principal_id must be a dedicated enabled service-principal UUID'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the migration owner. Never grant this role to the shared app role.
BEGIN;
SELECT :"continuum_schema".continuum_register_trusted_database_identity(
  :'continuum_sync_role'::name, :'continuum_principal_id'::uuid, FALSE, TRUE
);
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA :"continuum_schema"
FROM :"continuum_sync_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA :"continuum_schema"
FROM :"continuum_sync_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA :"continuum_schema"
FROM :"continuum_sync_role";
REVOKE ALL PRIVILEGES ON SCHEMA :"continuum_schema" FROM :"continuum_sync_role";
GRANT USAGE ON SCHEMA :"continuum_schema" TO :"continuum_sync_role";
GRANT SELECT ON TABLE
  :"continuum_schema".scopes,
  :"continuum_schema".principals,
  :"continuum_schema".entra_groups,
  :"continuum_schema".scope_memberships,
  :"continuum_schema".entra_sync_state
TO :"continuum_sync_role";
GRANT INSERT ON TABLE :"continuum_schema".principals, :"continuum_schema".audit_log
TO :"continuum_sync_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  :"continuum_schema".entra_groups,
  :"continuum_schema".scope_memberships
FROM :"continuum_sync_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".entra_sync_state
FROM :"continuum_sync_role";
GRANT USAGE, SELECT ON SEQUENCE :"continuum_schema".audit_log_id_seq
TO :"continuum_sync_role";
GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_activate_entra_memberships(UUID, TEXT, UUID[]),
  :"continuum_schema".continuum_require_sync_session(UUID),
  :"continuum_schema".continuum_record_entra_sync_success(UUID, INTEGER),
  :"continuum_schema".continuum_record_entra_sync_failure(UUID, TEXT, INTEGER),
  :"continuum_schema".continuum_sync_observe_entra_group(UUID, TEXT, TEXT),
  :"continuum_schema".continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]),
  :"continuum_schema".continuum_sync_deactivate_entra_groups(UUID, TEXT[]),
  :"continuum_schema".continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT),
  :"continuum_schema".continuum_verify_sync_database_identity(UUID)
TO :"continuum_sync_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_trusted_database_identities
FROM :"continuum_sync_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_reapproval_requests
FROM :"continuum_sync_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_guarded_mutations
FROM :"continuum_sync_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT)
FROM :"continuum_sync_role";
SELECT :"continuum_schema".continuum_verify_database_identity_configuration();
SELECT :"continuum_schema".continuum_verify_sync_retirement_authority_configuration();
COMMIT;
