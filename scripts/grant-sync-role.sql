\if :{?continuum_sync_role}
\else
  \echo 'continuum_sync_role must name a dedicated existing non-owner login role'
  \quit
\endif
\if :{?continuum_principal_id}
\else
  \echo 'continuum_principal_id must be a dedicated enabled service-principal UUID'
  \quit
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the migration owner. Never grant this role to the shared app role.
SELECT :"continuum_schema".continuum_register_trusted_database_identity(
  :'continuum_sync_role'::name, :'continuum_principal_id'::uuid, FALSE, TRUE
);
GRANT USAGE ON SCHEMA :"continuum_schema" TO :"continuum_sync_role";
GRANT SELECT ON TABLE
  :"continuum_schema".scopes,
  :"continuum_schema".principals,
  :"continuum_schema".entra_groups,
  :"continuum_schema".scope_memberships,
  :"continuum_schema".entra_sync_state,
  :"continuum_schema".principal_user_scopes,
  :"continuum_schema".memories,
  :"continuum_schema".audit_log_offboarding_scopes
TO :"continuum_sync_role";
GRANT INSERT ON TABLE :"continuum_schema".principals, :"continuum_schema".audit_log
TO :"continuum_sync_role";
GRANT UPDATE ON TABLE
  :"continuum_schema".entra_groups,
  :"continuum_schema".scope_memberships
TO :"continuum_sync_role";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".entra_sync_state
FROM :"continuum_sync_role";
GRANT USAGE, SELECT ON SEQUENCE :"continuum_schema".audit_log_id_seq
TO :"continuum_sync_role";
GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_activate_entra_memberships(UUID, TEXT, UUID[]),
  :"continuum_schema".continuum_require_sync_session(UUID),
  :"continuum_schema".continuum_record_entra_sync_success(UUID, INTEGER),
  :"continuum_schema".continuum_record_entra_sync_failure(UUID, TEXT, INTEGER)
TO :"continuum_sync_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_trusted_database_identities
FROM :"continuum_sync_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_reapproval_requests
FROM :"continuum_sync_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT)
FROM :"continuum_sync_role";
