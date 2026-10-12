\set ON_ERROR_STOP on
\if :{?continuum_operator_role}
\else
  \echo 'continuum_operator_role must name a dedicated existing non-owner login role'
\endif
\if :{?continuum_principal_id}
\else
  \echo 'continuum_principal_id must be the bound manual org-admin UUID'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- First apply grant-application-role.sql to this dedicated operator role, then
-- run this script as the migration owner. Never grant it to the shared app role.
BEGIN;
SELECT :"continuum_schema".continuum_register_trusted_database_identity(
  :'continuum_operator_role'::name, :'continuum_principal_id'::uuid, TRUE, FALSE
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :"continuum_schema".entra_groups
FROM :"continuum_operator_role";
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_operator_pseudonymize_scope_v2_legacy(UUID, UUID, TEXT)
FROM :"continuum_operator_role";
GRANT EXECUTE ON FUNCTION
  :"continuum_schema".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),
  :"continuum_schema".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),
  :"continuum_schema".continuum_operator_revoke_entra_group_binding(UUID, TEXT),
  :"continuum_schema".continuum_operator_offboard_scope_access(UUID, UUID),
  :"continuum_schema".continuum_operator_pseudonymize_scope(UUID, UUID, TEXT),
  :"continuum_schema".continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT),
  :"continuum_schema".continuum_operator_reclaim_coordination_resource(UUID, UUID, TEXT),
  :"continuum_schema".continuum_operator_set_coordination_scope_quota(UUID, UUID, INTEGER),
  :"continuum_schema".continuum_operator_sweep_coordination_state(UUID, INTEGER),
  :"continuum_schema".continuum_operator_scrub_coordination_principal(UUID, UUID, UUID, INTEGER),
  :"continuum_schema".continuum_operator_list_coordination_privacy_repairs(UUID, UUID, INTEGER),
  :"continuum_schema".continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER),
  :"continuum_schema".continuum_operator_offboarding_actual_state_is_erased(UUID, UUID),
  :"continuum_schema".continuum_operator_set_coordination_principal_quota(UUID, UUID, INTEGER, INTEGER),
  :"continuum_schema".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),
  :"continuum_schema".continuum_takeover_manual_org_admin(UUID, UUID, UUID),
  :"continuum_schema".continuum_operator_complete_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_get_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_authorize_audit_retention(UUID),
  :"continuum_schema".continuum_operator_resume_offboarding_run(UUID, UUID),
  :"continuum_schema".continuum_operator_restart_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB),
  :"continuum_schema".continuum_operator_start_offboarding_run(UUID, UUID, JSONB),
  :"continuum_schema".continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]),
  :"continuum_schema".continuum_operator_record_offboarding_event(UUID),
  :"continuum_schema".continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),
  :"continuum_schema".continuum_operator_reactivate_principal(UUID, UUID),
  :"continuum_schema".continuum_operator_remove_entra_membership(UUID, UUID, UUID, TEXT),
  :"continuum_schema".continuum_rotate_sync_database_identity(UUID, NAME, UUID),
  :"continuum_schema".continuum_cleanup_legacy_offboarding_audit_requests(INTEGER)
TO :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_trusted_database_identities
FROM :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_retired_sync_database_identities
FROM :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_reapproval_requests
FROM :"continuum_operator_role";
REVOKE ALL ON TABLE :"continuum_schema".continuum_entra_guarded_mutations
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
REVOKE ALL ON FUNCTION
  :"continuum_schema".continuum_get_offboarding_run(UUID, UUID)
FROM :"continuum_operator_role";
SELECT set_config('continuum.operator_grant_schema', :'continuum_schema', TRUE);
SELECT set_config('continuum.operator_grant_target', :'continuum_operator_role', TRUE);
DO $provider_profile$
DECLARE schema_name TEXT := current_setting('continuum.operator_grant_schema');
        target_role NAME := current_setting('continuum.operator_grant_target')::name;
BEGIN
  IF to_regprocedure(format('%I.continuum_operator_list_coordination_privacy_repair_page(uuid,uuid,integer)', schema_name)) IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_list_coordination_privacy_repair_page(UUID,UUID,INTEGER) TO %I',schema_name,target_role);
  END IF;
  IF to_regprocedure(format('%I.continuum_operator_coordination_scope_privacy_state(uuid,uuid)', schema_name)) IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_coordination_scope_privacy_state(UUID,UUID) TO %I',schema_name,target_role);
  END IF;
  IF to_regprocedure(format('%I.continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)', schema_name)) IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_promotion_scope(UUID,UUID,UUID,INTEGER) TO %I',schema_name,target_role);
  END IF;
  IF to_regprocedure(format('%I.continuum_operator_bind_standup_producer(uuid,name,uuid,text,text)',schema_name)) IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_bind_standup_producer(UUID,NAME,UUID,TEXT,TEXT),%I.continuum_operator_map_standup_actor(UUID,TEXT,TEXT,UUID,TEXT) TO %I',schema_name,schema_name,target_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_standup_scope(UUID,UUID,UUID,INTEGER) TO %I',schema_name,target_role);
  END IF;
  IF to_regprocedure(format('%I.continuum_operator_set_promotion_webhook_ids(uuid,text[])',schema_name)) IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_set_promotion_webhook_ids(UUID,TEXT[]) TO %I',schema_name,target_role);
  END IF;
  IF to_regclass(format('%I.continuum_pgvector_role_profiles', schema_name)) IS NOT NULL THEN
    EXECUTE format(
      'SELECT %I.continuum_grant_application_vector_functions($1::name)', schema_name
    ) USING target_role;
    EXECUTE format('SELECT %I.continuum_assert_application_vector_profile($1::name)',schema_name) USING target_role;
  END IF;
END;
$provider_profile$;
SELECT :"continuum_schema".continuum_assert_operator_role_allowlist(
  :'continuum_operator_role'::name
);
COMMIT;
