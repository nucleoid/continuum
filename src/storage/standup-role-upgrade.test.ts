import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { reconcilePgvectorProviderGrants, requireCoordinationContractReady,
  requirePromotionOutboxReady, requireStandupReady } from './provider-lifecycle.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
// Immutable public e3b0 prior89 grants, embedded verbatim so CI needs no Git checkout/history.
// Only documented psql variable substitution is applied at execution. No registry bypass.
const PRIOR_GRANTS = {
  "grant-application-role.sql": {
    "sql": "\\set ON_ERROR_STOP on\n\\if :{?continuum_app_role}\n\\else\n  \\echo 'continuum_app_role must name an existing non-owner role'\n\\endif\n\\if :{?continuum_schema}\n\\else\n  \\set continuum_schema public\n\\endif\n\n-- Run as the migration owner after continuum-migrate. The role is deliberately\n-- not granted CREATE on the schema or any privilege on capability tables.\n-- The transaction removes operator-only capabilities before checking the application profile.\nBEGIN;\nGRANT USAGE ON SCHEMA :\"continuum_schema\" TO :\"continuum_app_role\";\n\nGRANT SELECT, INSERT, UPDATE ON TABLE\n  :\"continuum_schema\".principals,\n  :\"continuum_schema\".memories\nTO :\"continuum_app_role\";\nGRANT SELECT, INSERT ON TABLE :\"continuum_schema\".scopes\nTO :\"continuum_app_role\";\nREVOKE UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".scopes\nFROM :\"continuum_app_role\";\nGRANT SELECT ON TABLE :\"continuum_schema\".entra_groups TO :\"continuum_app_role\";\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".entra_groups\nFROM :\"continuum_app_role\";\n\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n  :\"continuum_schema\".scope_memberships,\n  :\"continuum_schema\".memory_embeddings\nTO :\"continuum_app_role\";\n\nGRANT SELECT, INSERT, UPDATE ON TABLE\n  :\"continuum_schema\".service_api_keys,\n  :\"continuum_schema\".ingest_deliveries\nTO :\"continuum_app_role\";\nGRANT SELECT ON TABLE :\"continuum_schema\".entra_sync_state TO :\"continuum_app_role\";\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".entra_sync_state\nFROM :\"continuum_app_role\";\n\nGRANT SELECT, INSERT, UPDATE ON TABLE\n  :\"continuum_schema\".principal_user_scopes\nTO :\"continuum_app_role\";\nGRANT SELECT ON TABLE :\"continuum_schema\".principal_offboarding_runs\nTO :\"continuum_app_role\";\n\nGRANT SELECT, INSERT ON TABLE :\"continuum_schema\".audit_log\nTO :\"continuum_app_role\";\nGRANT SELECT, DELETE ON TABLE :\"continuum_schema\".principal_aliases\nTO :\"continuum_app_role\";\nGRANT SELECT ON TABLE\n  :\"continuum_schema\".audit_log_offboarding_scopes,\n  :\"continuum_schema\".audit_log_offboarding_backfill_state\nTO :\"continuum_app_role\";\nGRANT SELECT ON TABLE\n  :\"continuum_schema\".principal_user_scope_approvals\nTO :\"continuum_app_role\";\nGRANT SELECT ON TABLE\n  :\"continuum_schema\".principal_offboarding_events,\n  :\"continuum_schema\".principal_offboarding_run_events,\n  :\"continuum_schema\".principal_offboarding_takeover_events\nTO :\"continuum_app_role\";\n\n-- Upgrade rehearsals may profile a role before 0054 exists. Defer these exact\n-- grants until the coordination schema is present; the final allow-list call\n-- still rejects missing or broader privileges after 0055.\nSELECT set_config('continuum.application_grant_target', :'continuum_app_role', TRUE);\nSELECT set_config('continuum.application_grant_schema', namespace.nspname, TRUE)\nFROM :\"continuum_schema\".scopes scope\nJOIN pg_catalog.pg_class relation ON relation.oid = scope.tableoid\nJOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace\nLIMIT 1;\nDO $coordination_grants$\nDECLARE schema_name TEXT := current_setting('continuum.application_grant_schema');\n        target_role NAME := current_setting('continuum.application_grant_target')::name;\n        function_signature TEXT;\nBEGIN\n  IF to_regclass(format('%I.coordination_resources', schema_name)) IS NOT NULL\n      AND to_regprocedure(format(\n        '%I.continuum_operator_set_coordination_principal_quota(uuid,uuid,integer,integer)',\n        schema_name\n      )) IS NOT NULL THEN\n    -- A 0060-era profile granted table-wide UPDATE. PostgreSQL table grants\n    -- subsume column grants, so remove the old capability before regranting\n    -- the exact lifecycle columns.\n    EXECUTE format('REVOKE UPDATE ON TABLE %I.coordination_resources FROM %I',\n      schema_name, target_role);\n    EXECUTE format('REVOKE UPDATE ON TABLE %I.coordination_leases FROM %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.coordination_resources TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT UPDATE (fencing_token, current_lease_id, updated_at) ON TABLE %I.coordination_resources TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I.coordination_leases TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT UPDATE (expires_at, released_at) ON TABLE %I.coordination_leases TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I.coordination_operation_receipts TO %I',\n      schema_name, target_role);\n    EXECUTE format('REVOKE UPDATE, TRUNCATE ON TABLE %I.coordination_operation_receipts FROM %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage TO %I',\n      schema_name, schema_name, target_role);\n    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage FROM %I',\n      schema_name, schema_name, target_role);\n    IF to_regclass(format('%I.coordination_scope_fencing_floors', schema_name)) IS NOT NULL THEN\n      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.coordination_scope_fencing_floors FROM %I',\n        schema_name, target_role);\n    END IF;\n    FOREACH function_signature IN ARRAY ARRAY[\n      'continuum_coordination_reserve_resource_creation(uuid)',\n      'continuum_coordination_scope_fencing_floor(uuid)',\n      'continuum_coordination_privacy_state(uuid,uuid)',\n      'continuum_coordination_lock_entra_freshness()',\n      'continuum_coordination_lock_principal_usage(uuid)',\n      'continuum_coordination_cleanup_expired_receipts(uuid)',\n      'continuum_coordination_contract_is_ready()'\n    ] LOOP\n      IF to_regprocedure(format('%I.%s', schema_name, function_signature)) IS NOT NULL THEN\n        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',\n          schema_name, function_signature, target_role);\n      END IF;\n    END LOOP;\n    FOREACH function_signature IN ARRAY ARRAY[\n      'continuum_operator_reclaim_coordination_resource(uuid,uuid,text)',\n      'continuum_operator_set_coordination_scope_quota(uuid,uuid,integer)',\n      'continuum_operator_sweep_coordination_state(uuid,integer)',\n      'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'\n    ] LOOP\n      IF to_regprocedure(format('%I.%s', schema_name, function_signature)) IS NOT NULL THEN\n        EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',\n          schema_name, function_signature, target_role);\n      END IF;\n    END LOOP;\n    IF to_regprocedure(format(\n      '%I.continuum_operator_pseudonymize_scope_v2_legacy(uuid,uuid,text)', schema_name\n    )) IS NOT NULL THEN\n      EXECUTE format(\n        'REVOKE ALL ON FUNCTION %I.continuum_operator_pseudonymize_scope_v2_legacy(UUID, UUID, TEXT) FROM %I',\n        schema_name, target_role);\n    END IF;\n    IF to_regprocedure(format(\n      '%I.continuum_operator_pseudonymize_scope_v2(uuid,uuid,text)', schema_name\n    )) IS NOT NULL THEN\n      EXECUTE format(\n        'REVOKE ALL ON FUNCTION %I.continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT) FROM %I',\n        schema_name, target_role);\n    END IF;\n    IF to_regprocedure(format(\n      '%I.continuum_operator_set_coordination_principal_quota(uuid,uuid,integer,integer)',\n      schema_name\n    )) IS NOT NULL THEN\n      EXECUTE format(\n        'REVOKE ALL ON FUNCTION %I.continuum_operator_set_coordination_principal_quota(UUID, UUID, INTEGER, INTEGER) FROM %I',\n        schema_name, target_role);\n    END IF;\n  ELSIF to_regprocedure(format(\n    '%I.continuum_coordination_reserve_resource_creation(uuid)', schema_name\n  )) IS NOT NULL THEN\n    -- Schemas 0056 through 0060 use their published table-wide UPDATE profile.\n    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I.coordination_resources TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.coordination_leases TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, DELETE ON TABLE %I.coordination_operation_receipts TO %I',\n      schema_name, target_role);\n    IF to_regprocedure(format(\n      '%I.continuum_coordination_fencing_nondecreasing()', schema_name\n    )) IS NULL THEN\n      EXECUTE format('GRANT UPDATE ON TABLE %I.coordination_operation_receipts TO %I',\n        schema_name, target_role);\n    ELSE\n      EXECUTE format('REVOKE UPDATE ON TABLE %I.coordination_operation_receipts FROM %I',\n        schema_name, target_role);\n    END IF;\n    EXECUTE format('GRANT SELECT ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage TO %I',\n      schema_name, schema_name, target_role);\n    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage FROM %I',\n      schema_name, schema_name, target_role);\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_coordination_reserve_resource_creation(UUID), %I.continuum_coordination_scope_fencing_floor(UUID) TO %I',\n      schema_name, schema_name, target_role);\n  ELSIF to_regprocedure(format(\n    '%I.continuum_operator_reclaim_coordination_resource(uuid,uuid,text)', schema_name\n  )) IS NOT NULL THEN\n    -- Schema 0055 used the original coordination profile before helper-owned counters.\n    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I.coordination_resources TO %I',\n      schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.coordination_leases, %I.coordination_operation_receipts TO %I',\n      schema_name, schema_name, target_role);\n    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I.coordination_scope_usage, %I.coordination_principal_usage TO %I',\n      schema_name, schema_name, target_role);\n    EXECUTE format('GRANT SELECT ON TABLE %I.coordination_fencing_floors TO %I',\n      schema_name, target_role);\n  END IF;\nEND;\n$coordination_grants$;\n\nGRANT USAGE, SELECT ON SEQUENCE\n  :\"continuum_schema\".audit_log_id_seq,\n  :\"continuum_schema\".principal_user_scope_approvals_id_seq,\n  :\"continuum_schema\".principal_offboarding_run_events_id_seq\nTO :\"continuum_app_role\";\n\nGRANT EXECUTE ON FUNCTION\n  :\"continuum_schema\".continuum_org_scope_id(),\n  :\"continuum_schema\".continuum_audit_retention_minimum_days(),\n  :\"continuum_schema\".continuum_offboarding_expected_audit_metadata(JSONB),\n  :\"continuum_schema\".continuum_membership_is_effective(BOOLEAN, TEXT),\n  :\"continuum_schema\".continuum_disable_principal(UUID, UUID)\nTO :\"continuum_app_role\";\n\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),\n  :\"continuum_schema\".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),\n  :\"continuum_schema\".continuum_activate_entra_memberships(UUID, TEXT, UUID[]),\n  :\"continuum_schema\".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),\n  :\"continuum_schema\".continuum_takeover_manual_org_admin(UUID, UUID, UUID),\n  :\"continuum_schema\".continuum_complete_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_resume_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_restart_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB),\n  :\"continuum_schema\".continuum_start_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_redact_offboarding_audit(UUID, UUID, BIGINT[]),\n  :\"continuum_schema\".continuum_record_offboarding_event(UUID),\n  :\"continuum_schema\".continuum_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),\n  :\"continuum_schema\".continuum_reactivate_principal(UUID, UUID),\n  :\"continuum_schema\".continuum_rotate_sync_database_identity(UUID, NAME, UUID),\n  :\"continuum_schema\".continuum_record_entra_sync_success(UUID, INTEGER),\n  :\"continuum_schema\".continuum_record_entra_sync_failure(UUID, TEXT, INTEGER),\n  :\"continuum_schema\".continuum_require_sync_session(UUID),\n  :\"continuum_schema\".continuum_cleanup_legacy_offboarding_audit_requests(INTEGER),\n  :\"continuum_schema\".continuum_get_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_get_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_authorize_audit_retention(UUID),\n  :\"continuum_schema\".continuum_sync_observe_entra_group(UUID, TEXT, TEXT),\n  :\"continuum_schema\".continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]),\n  :\"continuum_schema\".continuum_sync_deactivate_entra_groups(UUID, TEXT[]),\n  :\"continuum_schema\".continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT),\n  :\"continuum_schema\".continuum_operator_complete_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_resume_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_restart_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB),\n  :\"continuum_schema\".continuum_operator_start_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]),\n  :\"continuum_schema\".continuum_operator_record_offboarding_event(UUID),\n  :\"continuum_schema\".continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),\n  :\"continuum_schema\".continuum_operator_reactivate_principal(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_pseudonymize_scope(UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_revoke_entra_group_binding(UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_offboard_scope_access(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_remove_entra_membership(UUID, UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN)\nFROM :\"continuum_app_role\";\n\nSELECT set_config('continuum.application_grant_target', :'continuum_app_role', TRUE);\nSELECT set_config('continuum.application_grant_schema', namespace.nspname, TRUE)\nFROM :\"continuum_schema\".scopes scope\nJOIN pg_catalog.pg_class relation ON relation.oid = scope.tableoid\nJOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace\nLIMIT 1;\nDO $repair_function_revokes$\nDECLARE schema_name TEXT := current_setting('continuum.application_grant_schema');\n        target_role NAME := current_setting('continuum.application_grant_target')::name;\n        signature TEXT;\nBEGIN\n  FOREACH signature IN ARRAY ARRAY[\n    'continuum_operator_list_coordination_privacy_repairs(uuid,uuid,integer)',\n    'continuum_operator_list_coordination_privacy_repairs(uuid,uuid,uuid,integer)',\n    'continuum_operator_list_coordination_privacy_repair_page(uuid,uuid,integer)',\n    'continuum_operator_coordination_scope_privacy_state(uuid,uuid)',\n    'continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)',\n    'continuum_operator_set_promotion_webhook_ids(uuid,text[])',\n    'continuum_operator_offboarding_actual_state_is_erased(uuid,uuid)'\n  ] LOOP\n    IF to_regprocedure(format('%I.%s', schema_name, signature)) IS NOT NULL THEN\n      EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',\n        schema_name, signature, target_role);\n    END IF;\n  END LOOP;\nEND;\n$repair_function_revokes$;\n\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE\n  :\"continuum_schema\".principal_offboarding_runs,\n  :\"continuum_schema\".principal_offboarding_run_events,\n  :\"continuum_schema\".principal_offboarding_events\nFROM :\"continuum_app_role\";\nREVOKE UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".audit_log\nFROM :\"continuum_app_role\";\nREVOKE USAGE, SELECT ON SEQUENCE\n  :\"continuum_schema\".principal_offboarding_events_id_seq\nFROM :\"continuum_app_role\";\nREVOKE USAGE, SELECT ON SEQUENCE\n  :\"continuum_schema\".principal_offboarding_takeover_events_id_seq\nFROM :\"continuum_app_role\";\n\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_offboarding_completion_requests\nFROM :\"continuum_app_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_principal_reactivation_requests\nFROM :\"continuum_app_role\";\nREVOKE ALL ON TABLE\n  :\"continuum_schema\".continuum_entra_guarded_mutations,\n  :\"continuum_schema\".continuum_principal_disable_requests,\n  :\"continuum_schema\".continuum_canonical_org_scope\nFROM :\"continuum_app_role\";\nREVOKE EXECUTE ON FUNCTION\n  :\"continuum_schema\".continuum_backfill_audit_offboarding_scopes(INTEGER)\nFROM :\"continuum_app_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_write_offboarding_run_internal(UUID, UUID, TEXT, JSONB),\n  :\"continuum_schema\".continuum_apply_audit_retention_internal_v44(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT)\nFROM :\"continuum_app_role\";\nREVOKE ALL ON TABLE\n  :\"continuum_schema\".continuum_audit_retention_policy,\n  :\"continuum_schema\".continuum_trusted_database_identities,\n  :\"continuum_schema\".continuum_retired_sync_database_identities,\n  :\"continuum_schema\".continuum_entra_reapproval_requests,\n  :\"continuum_schema\".principal_offboarding_audit_requests,\n  :\"continuum_schema\".continuum_offboarding_restart_requests\nFROM :\"continuum_app_role\";\n\nDO $tag_profile$\nDECLARE schema_name TEXT:=current_setting('continuum.application_grant_schema');\n        target_role NAME:=current_setting('continuum.application_grant_target')::name;\nBEGIN\n  IF to_regclass(format('%I.tag_vocabularies',schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.tag_vocabularies TO %I',schema_name,target_role);\n  END IF;\n  IF to_regclass(format('%I.promotion_events',schema_name)) IS NOT NULL\n    AND to_regclass(format('%I.promotion_event_deliveries',schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT SELECT,INSERT ON TABLE %I.promotion_events TO %I',schema_name,target_role);\n    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %I.promotion_event_deliveries TO %I',schema_name,target_role);\n  END IF;\n  IF to_regclass(format('%I.embedding_backfill_checkpoints',schema_name)) IS NOT NULL\n    AND to_regclass(format('%I.embedding_backfill_failures',schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.embedding_backfill_checkpoints,%I.embedding_backfill_failures TO %I',\n      schema_name,schema_name,target_role);\n  END IF;\nEND;\n$tag_profile$;\n\nDO $promotion_registry_readers$\nDECLARE schema_name TEXT:=current_setting('continuum.application_grant_schema'); target_role NAME:=current_setting('continuum.application_grant_target');\nBEGIN\n  IF to_regprocedure(format('%I.continuum_promotion_webhook_ids()',schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_promotion_webhook_ids(),%I.continuum_promotion_outbox_is_ready() TO %I',schema_name,schema_name,target_role);\n  END IF;\nEND;\n$promotion_registry_readers$;\nDO $provider_runtime_gate$\nDECLARE schema_name TEXT := current_setting('continuum.application_grant_schema');\n        target_role NAME := current_setting('continuum.application_grant_target')::name;\nBEGIN\n  IF to_regprocedure(format(\n    '%I.continuum_assert_current_pgvector_profile()', schema_name\n  )) IS NOT NULL THEN\n    EXECUTE format(\n      'GRANT EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() TO %I',\n      schema_name, target_role);\n    EXECUTE format('SELECT %I.continuum_grant_application_vector_functions($1::name)', schema_name) USING target_role;\n  ELSIF to_regprocedure(format('%I.continuum_grant_application_vector_functions()',schema_name)) IS NOT NULL THEN\n    EXECUTE format('SELECT %I.continuum_grant_application_vector_functions()',schema_name);\n  END IF;\nEND;\n$provider_runtime_gate$;\n\n-- Reconcile provider access only after the exact application profile is in\n-- place. This explicit regrant leaves unrelated role registrations and shared\n-- provider/PUBLIC privileges unchanged.\nSELECT :\"continuum_schema\".continuum_assert_application_role_allowlist(\n  :'continuum_app_role'::name\n);\nCOMMIT;\n",
    "sha256": "73b7fac241fc3edd077d91c4fc5cc49cd70c620410f82059d19641fe73ebc024"
  },
  "grant-operator-role.sql": {
    "sql": "\\set ON_ERROR_STOP on\n\\if :{?continuum_operator_role}\n\\else\n  \\echo 'continuum_operator_role must name a dedicated existing non-owner login role'\n\\endif\n\\if :{?continuum_principal_id}\n\\else\n  \\echo 'continuum_principal_id must be the bound manual org-admin UUID'\n\\endif\n\\if :{?continuum_schema}\n\\else\n  \\set continuum_schema public\n\\endif\n\n-- First apply grant-application-role.sql to this dedicated operator role, then\n-- run this script as the migration owner. Never grant it to the shared app role.\nBEGIN;\nSELECT :\"continuum_schema\".continuum_register_trusted_database_identity(\n  :'continuum_operator_role'::name, :'continuum_principal_id'::uuid, TRUE, FALSE\n);\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".entra_groups\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_operator_pseudonymize_scope_v2_legacy(UUID, UUID, TEXT)\nFROM :\"continuum_operator_role\";\nGRANT EXECUTE ON FUNCTION\n  :\"continuum_schema\".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),\n  :\"continuum_schema\".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_revoke_entra_group_binding(UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_offboard_scope_access(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_pseudonymize_scope(UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_pseudonymize_scope_v2(UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_reclaim_coordination_resource(UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_operator_set_coordination_scope_quota(UUID, UUID, INTEGER),\n  :\"continuum_schema\".continuum_operator_sweep_coordination_state(UUID, INTEGER),\n  :\"continuum_schema\".continuum_operator_scrub_coordination_principal(UUID, UUID, UUID, INTEGER),\n  :\"continuum_schema\".continuum_operator_list_coordination_privacy_repairs(UUID, UUID, INTEGER),\n  :\"continuum_schema\".continuum_operator_list_coordination_privacy_repairs(UUID, UUID, UUID, INTEGER),\n  :\"continuum_schema\".continuum_operator_offboarding_actual_state_is_erased(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_set_coordination_principal_quota(UUID, UUID, INTEGER, INTEGER),\n  :\"continuum_schema\".continuum_change_manual_org_admin(UUID, UUID, TEXT, BOOLEAN),\n  :\"continuum_schema\".continuum_takeover_manual_org_admin(UUID, UUID, UUID),\n  :\"continuum_schema\".continuum_operator_complete_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_get_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_authorize_audit_retention(UUID),\n  :\"continuum_schema\".continuum_operator_resume_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_restart_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_write_offboarding_run(UUID, UUID, TEXT, JSONB),\n  :\"continuum_schema\".continuum_operator_start_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_operator_redact_offboarding_audit(UUID, UUID, BIGINT[]),\n  :\"continuum_schema\".continuum_operator_record_offboarding_event(UUID),\n  :\"continuum_schema\".continuum_operator_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),\n  :\"continuum_schema\".continuum_operator_reactivate_principal(UUID, UUID),\n  :\"continuum_schema\".continuum_operator_remove_entra_membership(UUID, UUID, UUID, TEXT),\n  :\"continuum_schema\".continuum_rotate_sync_database_identity(UUID, NAME, UUID),\n  :\"continuum_schema\".continuum_cleanup_legacy_offboarding_audit_requests(INTEGER)\nTO :\"continuum_operator_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_trusted_database_identities\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_retired_sync_database_identities\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_entra_reapproval_requests\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_entra_guarded_mutations\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),\n  :\"continuum_schema\".continuum_activate_entra_memberships(UUID, TEXT, UUID[])\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_complete_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_resume_offboarding_run(UUID, UUID),\n  :\"continuum_schema\".continuum_restart_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_write_offboarding_run(UUID, UUID, TEXT, JSONB),\n  :\"continuum_schema\".continuum_start_offboarding_run(UUID, UUID, JSONB),\n  :\"continuum_schema\".continuum_redact_offboarding_audit(UUID, UUID, BIGINT[]),\n  :\"continuum_schema\".continuum_record_offboarding_event(UUID),\n  :\"continuum_schema\".continuum_apply_audit_retention(UUID, TIMESTAMPTZ, INTEGER, UUID, INTEGER, JSONB, TEXT, TEXT),\n  :\"continuum_schema\".continuum_reactivate_principal(UUID, UUID)\nFROM :\"continuum_operator_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_get_offboarding_run(UUID, UUID)\nFROM :\"continuum_operator_role\";\nSELECT set_config('continuum.operator_grant_schema', :'continuum_schema', TRUE);\nSELECT set_config('continuum.operator_grant_target', :'continuum_operator_role', TRUE);\nDO $provider_profile$\nDECLARE schema_name TEXT := current_setting('continuum.operator_grant_schema');\n        target_role NAME := current_setting('continuum.operator_grant_target')::name;\nBEGIN\n  IF to_regprocedure(format('%I.continuum_operator_list_coordination_privacy_repair_page(uuid,uuid,integer)', schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_list_coordination_privacy_repair_page(UUID,UUID,INTEGER) TO %I',schema_name,target_role);\n  END IF;\n  IF to_regprocedure(format('%I.continuum_operator_coordination_scope_privacy_state(uuid,uuid)', schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_coordination_scope_privacy_state(UUID,UUID) TO %I',schema_name,target_role);\n  END IF;\n  IF to_regprocedure(format('%I.continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)', schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_promotion_scope(UUID,UUID,UUID,INTEGER) TO %I',schema_name,target_role);\n  END IF;\n  IF to_regprocedure(format('%I.continuum_operator_set_promotion_webhook_ids(uuid,text[])',schema_name)) IS NOT NULL THEN\n    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_set_promotion_webhook_ids(UUID,TEXT[]) TO %I',schema_name,target_role);\n  END IF;\n  IF to_regclass(format('%I.continuum_pgvector_role_profiles', schema_name)) IS NOT NULL THEN\n    EXECUTE format(\n      'SELECT %I.continuum_grant_application_vector_functions($1::name)', schema_name\n    ) USING target_role;\n    EXECUTE format('SELECT %I.continuum_assert_application_vector_profile($1::name)',schema_name) USING target_role;\n  END IF;\nEND;\n$provider_profile$;\nSELECT :\"continuum_schema\".continuum_assert_operator_role_allowlist(\n  :'continuum_operator_role'::name\n);\nCOMMIT;\n",
    "sha256": "3f8fabcf4ec59abf84d00979285fd9a8a2a3500633ea1705355e90886b437f84"
  },
  "grant-sync-role.sql": {
    "sql": "\\set ON_ERROR_STOP on\n\\if :{?continuum_sync_role}\n\\else\n  \\echo 'continuum_sync_role must name a dedicated existing non-owner login role'\n\\endif\n\\if :{?continuum_principal_id}\n\\else\n  \\echo 'continuum_principal_id must be a dedicated enabled service-principal UUID'\n\\endif\n\\if :{?continuum_schema}\n\\else\n  \\set continuum_schema public\n\\endif\n\n-- Run as the migration owner. Never grant this role to the shared app role.\nBEGIN;\nSELECT :\"continuum_schema\".continuum_register_trusted_database_identity(\n  :'continuum_sync_role'::name, :'continuum_principal_id'::uuid, FALSE, TRUE\n);\nREVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA :\"continuum_schema\"\nFROM :\"continuum_sync_role\";\nREVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA :\"continuum_schema\"\nFROM :\"continuum_sync_role\";\nREVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA :\"continuum_schema\"\nFROM :\"continuum_sync_role\";\nREVOKE ALL PRIVILEGES ON SCHEMA :\"continuum_schema\" FROM :\"continuum_sync_role\";\nGRANT USAGE ON SCHEMA :\"continuum_schema\" TO :\"continuum_sync_role\";\nGRANT SELECT ON TABLE\n  :\"continuum_schema\".scopes,\n  :\"continuum_schema\".principals,\n  :\"continuum_schema\".entra_groups,\n  :\"continuum_schema\".scope_memberships,\n  :\"continuum_schema\".entra_sync_state\nTO :\"continuum_sync_role\";\nGRANT INSERT ON TABLE :\"continuum_schema\".principals, :\"continuum_schema\".audit_log\nTO :\"continuum_sync_role\";\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE\n  :\"continuum_schema\".entra_groups,\n  :\"continuum_schema\".scope_memberships\nFROM :\"continuum_sync_role\";\nREVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE :\"continuum_schema\".entra_sync_state\nFROM :\"continuum_sync_role\";\nGRANT USAGE, SELECT ON SEQUENCE :\"continuum_schema\".audit_log_id_seq\nTO :\"continuum_sync_role\";\nGRANT EXECUTE ON FUNCTION\n  :\"continuum_schema\".continuum_activate_entra_memberships(UUID, TEXT, UUID[]),\n  :\"continuum_schema\".continuum_require_sync_session(UUID),\n  :\"continuum_schema\".continuum_record_entra_sync_success(UUID, INTEGER),\n  :\"continuum_schema\".continuum_record_entra_sync_failure(UUID, TEXT, INTEGER),\n  :\"continuum_schema\".continuum_sync_observe_entra_group(UUID, TEXT, TEXT),\n  :\"continuum_schema\".continuum_sync_deactivate_entra_memberships(UUID, TEXT[], UUID[]),\n  :\"continuum_schema\".continuum_sync_deactivate_entra_groups(UUID, TEXT[]),\n  :\"continuum_schema\".continuum_sync_quarantine_entra_group(UUID, TEXT, TEXT),\n  :\"continuum_schema\".continuum_verify_sync_database_identity(UUID)\nTO :\"continuum_sync_role\";\nSELECT set_config('continuum.sync_grant_schema', namespace.nspname, TRUE)\n  FROM :\"continuum_schema\".principals principal\n  JOIN pg_class relation ON relation.oid = principal.tableoid\n  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace\n LIMIT 1;\nSELECT set_config('continuum.sync_grant_target', :'continuum_sync_role', TRUE);\nDO $provider_runtime_gate$\nDECLARE schema_name TEXT := current_setting('continuum.sync_grant_schema');\n        target_role NAME := current_setting('continuum.sync_grant_target')::name;\nBEGIN\n  IF to_regprocedure(format(\n    '%I.continuum_assert_current_pgvector_profile()', schema_name\n  )) IS NOT NULL THEN\n    EXECUTE format(\n      'GRANT EXECUTE ON FUNCTION %I.continuum_assert_current_pgvector_profile() TO %I',\n      schema_name, target_role);\n  END IF;\nEND;\n$provider_runtime_gate$;\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_trusted_database_identities\nFROM :\"continuum_sync_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_retired_sync_database_identities\nFROM :\"continuum_sync_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_entra_reapproval_requests\nFROM :\"continuum_sync_role\";\nREVOKE ALL ON TABLE :\"continuum_schema\".continuum_entra_guarded_mutations\nFROM :\"continuum_sync_role\";\nREVOKE ALL ON FUNCTION\n  :\"continuum_schema\".continuum_register_trusted_database_identity(NAME, UUID, BOOLEAN, BOOLEAN),\n  :\"continuum_schema\".continuum_create_user_scope_approval(UUID, UUID, UUID, UUID[], TEXT),\n  :\"continuum_schema\".continuum_upsert_entra_group_binding(UUID, TEXT, TEXT, UUID, TEXT)\nFROM :\"continuum_sync_role\";\nSELECT :\"continuum_schema\".continuum_verify_database_identity_configuration();\nSELECT :\"continuum_schema\".continuum_verify_sync_retirement_authority_configuration();\nCOMMIT;\n",
    "sha256": "e83c36a34813db0cce10ef15f8c21bf6043fca9e7cb9c55dd33972b7fa2bf5ef"
  }
} as const;

type Witness = { kind: 'ready'; stderr: string } | { kind: 'exit'; code: number | null; stderr: string };
async function observe(kind: 'REST' | 'MCP', env: NodeJS.ProcessEnv): Promise<Witness> {
  let port: number | undefined;
  if (kind === 'REST') {
    const socket = createServer();
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('Startup fixture could not allocate port');
    port = address.port;
    await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(kind === 'REST'
    ? '../../dist/api/server.js' : '../../dist/api/mcp.js', import.meta.url))], {
    env: { ...env, ...(port === undefined ? {} : { CONTINUUM_API_PORT: String(port) }) },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', stdout = '', outputBytes = 0, finished = false;
  let resolve!: (value: Witness) => void;
  let reject!: (error: Error) => void;
  const observed = new Promise<Witness>((done, fail) => { resolve = done; reject = fail; });
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const finish = (value: Witness) => { if (!finished) { finished = true; resolve(value); } };
  const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024) { fail(new Error('Compiled startup output exceeded 32 KiB')); return; }
    stdout += chunk.toString('utf8');
    if (kind === 'MCP') for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      try {
        const response = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string } } };
        if (response.id === 1 && response.result?.serverInfo?.name === 'continuum') finish({ kind: 'ready', stderr });
      } catch { fail(new Error('Compiled MCP emitted non-protocol stdout')); return; }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024) { fail(new Error('Compiled startup output exceeded 32 KiB')); return; }
    stderr += chunk.toString('utf8');
  });
  child.stdin.on('error', () => undefined);
  child.once('error', fail);
  child.once('exit', (code) => finish({ kind: 'exit', code, stderr }));
  const deadline = setTimeout(() => fail(new Error(`Compiled ${kind} startup exceeded 8 seconds`)), 8_000);
  if (kind === 'MCP') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'standup-upgrade-review', version: '1' },
  } }) + '\n');
  else void (async () => {
    while (!finished) {
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(300) });
        if (ready.status === 200 && (await ready.json() as { database?: string }).database === 'ready') {
          const scopes = await fetch(`http://127.0.0.1:${port}/api/v0/scopes`, {
            headers: { Authorization: `Bearer ${env.CONTINUUM_PRINCIPAL_EXTERNAL_ID}` }, signal: AbortSignal.timeout(300),
          });
          if (scopes.status === 200) { await scopes.arrayBuffer(); finish({ kind: 'ready', stderr }); return; }
        }
      } catch { /* Finite child watch bounds retries; no secret-bearing error text is printed. */ }
      await new Promise((done) => setTimeout(done, 20));
    }
  })().catch(() => fail(new Error('Compiled startup probe failed')));
  try { return await observed; }
  finally {
    finished = true; clearTimeout(deadline); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let force: ReturnType<typeof setTimeout> | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1_500);
      await Promise.race([closed, new Promise<never>((_done, failure) => {
        closeDeadline = setTimeout(() => failure(new Error('Compiled child failed bounded cleanup')), 3_000);
      })]);
    } finally { if (force) clearTimeout(force); if (closeDeadline) clearTimeout(closeDeadline); }
  }
}

async function roleUpgradeAcceptance(boundRuntime?: 'REST' | 'MCP') {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `standup_upgrade_${suffix}`;
  const roles = ['app', 'operator', 'sync', 'report'].map((kind) => `standup_upgrade_${kind}_${suffix}`);
  const [appRole, operatorRole, syncRole, reportRole] = roles;
  const admin = randomUUID(), syncPrincipal = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'continuum-standup-upgrade-'));
  const source = new URL('../../migrations/', import.meta.url);
  const maintenance = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: '-c statement_timeout=5000 -c lock_timeout=1000' });
  const owner = new pg.Pool({ connectionString: databaseUrl, max: 1,
    options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
  const pools: pg.Pool[] = [owner];
  const clientClosures: Promise<void>[] = [];
  const track = (pool: pg.Pool) => pool.on('connect', (client) => {
    clientClosures.push(new Promise<void>((resolve) => client.once('end', () => resolve())));
  });
  track(owner);
  const createdRoles: string[] = [];
  const passwords = new Map<string, string>();
  const logins = new Map<string, pg.Pool>();
  try {
    await maintenance.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const file of (await readdir(source)).sort()) if (/^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 89) {
      await copyFile(new URL(file, source), join(directory, file));
    }
    expect((await runMigrations(owner, directory)).at(-1)?.name).toBe('0089_promotion_outbox.sql');
    expect((await owner.query("SELECT pg_catalog.to_regclass('actor_principal_mappings') AS present")).rows)
      .toEqual([{ present: null }]);
    await owner.query(`INSERT INTO principals(id,external_id,kind,display_name) VALUES
      ($1::uuid,$1::uuid::text,'user','Upgrade administrator'),($2::uuid,$2::uuid::text,'service','Upgrade sync')`, [admin, syncPrincipal]);
    await owner.query(`INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
      SELECT $1::uuid,id,'admin','manual','manual',TRUE FROM scopes WHERE kind='org' AND name=''`, [admin]);
    for (const role of roles) {
      const password = randomUUID();
      await maintenance.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)}`);
      createdRoles.push(role); passwords.set(role, password);
    }
    async function grant(filename: keyof typeof PRIOR_GRANTS, variables: Record<string, string>, prior: boolean) {
      const original = prior ? PRIOR_GRANTS[filename].sql : await readFile(join(process.cwd(), 'scripts', filename), 'utf8');
      if (prior) expect(createHash('sha256').update(original).digest('hex')).toBe(PRIOR_GRANTS[filename].sha256);
      let sql = original.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
      for (const [key, value] of Object.entries({ continuum_schema: schema, ...variables })) {
        sql = sql.replaceAll(`:"${key}"`, quote(value)).replaceAll(`:'${key}'`, literal(value));
      }
      const client = await owner.connect(); let discard = false;
      try { await client.query(sql); }
      catch (error) { try { await client.query('ROLLBACK'); } catch { discard = true; } throw error; }
      finally { client.release(discard); }
    }
    async function grants(prior: boolean) {
      await grant('grant-application-role.sql', { continuum_app_role: appRole }, prior);
      await grant('grant-application-role.sql', { continuum_app_role: operatorRole }, prior);
      await grant('grant-operator-role.sql', { continuum_operator_role: operatorRole, continuum_principal_id: admin }, prior);
      await grant('grant-sync-role.sql', { continuum_sync_role: syncRole, continuum_principal_id: syncPrincipal }, prior);
    }
    await grants(true);
    await owner.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(reportRole)}; GRANT SELECT ON memories TO ${quote(reportRole)}`);
    await owner.query('SELECT continuum_register_pgvector_reporting_profile($1::name,TRUE)', [reportRole]);
    await owner.query('SELECT continuum_grant_application_vector_functions($1::name)', [reportRole]);
    const profiles = async () => (await owner.query(`SELECT database_role_oid,profile_kind,provider_schema_oid
      FROM continuum_pgvector_role_profiles ORDER BY database_role_oid`)).rows;
    const identities = async () => (await owner.query(`SELECT database_role,database_role_oid,principal_id,can_approve,can_sync
      FROM continuum_trusted_database_identities ORDER BY database_role_oid`)).rows;
    const originalProfiles = await profiles(), originalIdentities = await identities();
    expect(originalProfiles.map((row) => row.profile_kind).sort()).toEqual(['application','operator','reporting','sync']);
    expect(originalIdentities).toHaveLength(2);
    for (const role of roles) {
      const url = new URL(databaseUrl); url.username = role; url.password = passwords.get(role)!;
      url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000`);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 1 }); track(pool); pools.push(pool); logins.set(role, pool);
      expect((await pool.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
    }
    const app = logins.get(appRole)!;
    await reconcilePgvectorProviderGrants(app, { expectedSchema: schema });
    await requireCoordinationContractReady(app, { expectedSchema: schema });
    await requirePromotionOutboxReady(app, { expectedSchema: schema });
    const appUrl = new URL(databaseUrl); appUrl.username = appRole; appUrl.password = passwords.get(appRole)!;
    appUrl.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000`);
    const env: NodeJS.ProcessEnv = { ...process.env, PGOPTIONS: '', CONTINUUM_DATABASE_URL: appUrl.toString(),
      CONTINUUM_APPLICATION_SCHEMA: schema, CONTINUUM_AUTH_MODE: 'dev', CONTINUUM_EMBEDDING_PROVIDER: 'none',
      CONTINUUM_PRINCIPAL_EXTERNAL_ID: admin, CONTINUUM_BEARER: admin, CONTINUUM_DB_POOL_MAX: '1',
      CONTINUUM_DB_CONNECTION_TIMEOUT_MS: '1000', CONTINUUM_SHUTDOWN_TIMEOUT_MS: '1000',
      CONTINUUM_PROMOTION_SHUTDOWN_WAIT_MS: '500' };
    delete env.CONTINUUM_EMBEDDING_CONFIG;
    for (const key of Object.keys(env)) if (key.startsWith('CONTINUUM_INGEST_') && key.endsWith('_ENABLED')) env[key] = 'false';
    const kinds: Array<'REST' | 'MCP'> = boundRuntime ? [boundRuntime] : ['REST','MCP'];
    const legacy = new Map<'REST' | 'MCP', Witness>();
    for (const kind of kinds) legacy.set(kind, await observe(kind, env));

    const forward = '0090_standup_activity.sql';
    await copyFile(new URL(forward, source), join(directory, forward));
    expect((await runMigrations(owner, directory)).map((entry) => entry.name)).toEqual([forward]);
    expect(await runMigrations(owner, directory)).toEqual([]);
    expect(await profiles()).toEqual(originalProfiles); expect(await identities()).toEqual(originalIdentities);
    const publicTables = ['actor_principal_mappings','memory_activity_attributions','standup_thread_closures'];
    const privateTables = ['standup_producer_bindings','standup_identity_generation_counts'];
    for (const [role, pool] of logins) {
      const reader = role === appRole || role === operatorRole;
      for (const table of [...publicTables, ...privateTables]) for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        expect((await pool.query('SELECT pg_catalog.has_table_privilege($1::text,$2::text) AS allowed',
          [table,privilege])).rows, `${role}/${table}/${privilege}`).toEqual([{ allowed: reader && publicTables.includes(table) && privilege === 'SELECT' }]);
      }
      for (const helper of ['continuum_record_standup_activity(uuid,jsonb)','continuum_standup_producer_context()','continuum_standup_is_ready()']) {
        expect((await pool.query('SELECT pg_catalog.has_function_privilege($1::text,$2::text) AS allowed', [helper,'EXECUTE'])).rows)
          .toEqual([{ allowed: reader }]);
      }
      for (const helper of ['continuum_operator_bind_standup_producer(uuid,name,uuid,text,text)',
        'continuum_operator_map_standup_actor(uuid,text,text,uuid,text)', 'continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)']) {
        expect((await pool.query('SELECT pg_catalog.has_function_privilege($1::text,$2::text) AS allowed', [helper,'EXECUTE'])).rows)
          .toEqual([{ allowed: role === operatorRole }]);
      }
      if (!reader) {
        await expect(pool.query('SELECT * FROM memory_activity_attributions LIMIT 1')).rejects.toMatchObject({ code: '42501' });
        await expect(pool.query('SELECT continuum_standup_is_ready()')).rejects.toMatchObject({ code: '42501' });
      }
    }
    expect((await owner.query(`SELECT relation.relname,acl.privilege_type FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl
      WHERE namespace.nspname=$1::text AND relation.relname=ANY($2::text[]) AND acl.grantee=0`,
      [schema,[...publicTables,...privateTables]])).rows).toEqual([]);
    expect((await owner.query(`SELECT helper.proname,acl.privilege_type FROM pg_catalog.pg_proc helper
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=helper.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(helper.proacl,pg_catalog.acldefault('f',helper.proowner))) acl
      WHERE namespace.nspname=$1::text AND helper.proname LIKE '%standup%' AND acl.grantee=0`, [schema])).rows).toEqual([]);
    await requireStandupReady(app, { expectedSchema: schema });
    await grants(false);
    expect(await profiles()).toEqual(originalProfiles); expect(await identities()).toEqual(originalIdentities);
    for (const role of [appRole,operatorRole]) await reconcilePgvectorProviderGrants(logins.get(role)!, { expectedSchema: schema });
    for (const kind of kinds) {
      expect((await observe(kind, env)).kind, `${kind} same-binary upgraded positive`).toBe('ready');
      const before = legacy.get(kind)!;
      expect(before.kind, `${kind} must not serve pre-90`).toBe('exit');
      if (before.kind === 'exit') { expect(before.code).not.toBe(0); expect(before.stderr).toMatch(/standup|migration|DEPENDENCY_UNAVAILABLE/i); }
    }
    if (boundRuntime) {
      const producerId = randomUUID();
      await owner.query(`INSERT INTO principals(id,external_id,kind,display_name)
        VALUES($1::uuid,$1::uuid::text,'service','Serving-pool producer')`, [producerId]);
      expect((await logins.get(operatorRole)!.query(`SELECT continuum_operator_bind_standup_producer(
        $1::uuid,$2::name,$3::uuid,$4::text,$5::text) AS binding`,
        [admin,appRole,producerId,`serving.${suffix}`,'github'])).rows[0].binding).toBeTruthy();
      expect((await app.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context).not.toBeNull();
      // The exact same credentials/schema/role reached readiness above. Only
      // the real audited producer binding changes; no forged GUC or role flag.
      const bound = await observe(boundRuntime, env);
      expect(bound.kind, `${boundRuntime} serving pool must reject producer authority before readiness`).toBe('exit');
      if (bound.kind === 'exit') {
        expect(bound.code).not.toBe(0);
        expect(bound.stderr).toMatch(/producer|standup|DEPENDENCY_UNAVAILABLE/i);
      }
    }
  } finally {
    const failures: unknown[] = [];
    const endings = Promise.allSettled(pools.map((pool) => pool.end()));
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([(async () => {
      for (const result of await endings) if (result.status === 'rejected') failures.push(result.reason);
      await Promise.all(clientClosures);
    })(), new Promise<never>((_done, failure) => {
      closeDeadline = setTimeout(() => failure(new Error('Upgrade fixture physical clients did not end within 5 seconds')), 5_000);
    })]); } catch (error) { failures.push(error); }
    finally { if (closeDeadline) clearTimeout(closeDeadline); }
    try {
      let sessions = 1;
      const drainDeadline = Date.now() + 5_000;
      while (sessions !== 0 && Date.now() < drainDeadline) {
        sessions = (await maintenance.query('SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE usename=ANY($1::text[])', [createdRoles])).rows[0].count;
        if (sessions !== 0) await new Promise((done) => setTimeout(done, 20));
      }
      if (sessions !== 0) throw new Error('Upgrade fixture still has live role sessions; refuse cleanup');
      await maintenance.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      for (const role of createdRoles.reverse()) {
        await maintenance.query(`DROP OWNED BY ${quote(role)}`); await maintenance.query(`DROP ROLE ${quote(role)}`);
      }
    } catch (error) { failures.push(error); }
    finally { try { await maintenance.end(); } catch (error) { failures.push(error); } }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Standup upgrade fixture cleanup failed');
  }
}

it('upgrades canonical 89 live role profiles to 90 and gates the same compiled APP runtimes before serving',
  () => roleUpgradeAcceptance(), 180_000);
it.each(['REST','MCP'] as const)('compiled %s rejects a real producer-bound serving APP pool after a healthy unbound control',
  (kind) => roleUpgradeAcceptance(kind), 180_000);
