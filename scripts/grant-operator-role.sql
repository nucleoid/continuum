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
GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),
  :"continuum_schema".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),
  :"continuum_schema".continuum_takeover_manual_org_admin(UUID, UUID, UUID)
TO :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_trusted_database_identities
FROM :"continuum_operator_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),
  :"continuum_schema".continuum_activate_entra_memberships(UUID, TEXT, UUID[])
FROM :"continuum_operator_role";
