\if :{?continuum_operator_role}
\else
  \echo 'continuum_operator_role must name a dedicated existing non-owner login role'
  \quit
\endif
\if :{?continuum_principal_id}
\else
  \echo 'continuum_principal_id must be the bound manual org-admin UUID'
  \quit
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- First apply grant-application-role.sql to this dedicated operator role, then
-- run this script as the migration owner. Never grant it to the shared app role.
SELECT :"continuum_schema".continuum_register_trusted_database_identity(
  :'continuum_operator_role'::name, :'continuum_principal_id'::uuid, TRUE, FALSE
);
GRANT UPDATE ON TABLE :"continuum_schema".entra_groups TO :"continuum_operator_role";
GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),
  :"continuum_schema".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),
  :"continuum_schema".continuum_takeover_manual_org_admin(UUID, UUID, UUID),
  :"continuum_schema".continuum_operator_complete_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_resume_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_restart_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_operator_start_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]),
  :"continuum_schema".continuum_operator_record_offboarding_event(UUID),
  :"continuum_schema".continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),
  :"continuum_schema".continuum_operator_reactivate_principal(UUID, UUID),
  :"continuum_schema".continuum_rotate_sync_database_identity(UUID, NAME, UUID),
  :"continuum_schema".continuum_cleanup_legacy_offboarding_audit_requests(INTEGER)
TO :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_trusted_database_identities
FROM :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_reapproval_requests
FROM :"continuum_operator_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),
  :"continuum_schema".continuum_activate_entra_memberships(UUID, TEXT, UUID[])
FROM :"continuum_operator_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_complete_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_resume_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_restart_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_start_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_redact_offboarding_audit(UUID, UUID, BIGINT[]),
  :"continuum_schema".continuum_record_offboarding_event(UUID),
  :"continuum_schema".continuum_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),
  :"continuum_schema".continuum_reactivate_principal(UUID, UUID)
FROM :"continuum_operator_role";
