\set ON_ERROR_STOP on
\set VERBOSITY terse
-- Run once after the complete migration chain, as the direct migration owner.
-- Entra external_id is the reviewed user object UUID, matching runtime auth.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('search_path', format('%I', :'continuum_schema'), true);
CREATE TEMP TABLE bootstrap_admin_input ON COMMIT DROP AS
SELECT :'continuum_admin_principal_id'::uuid AS admin_id,
       lower(:'continuum_admin_entra_object_id')::uuid::text AS external_id,
       :'continuum_admin_display_name'::text AS display_name,
       :'continuum_sync_principal_id'::uuid AS sync_id,
       :'continuum_sync_external_id'::text AS sync_external_id;
DO $bootstrap$
DECLARE i RECORD; org_id UUID;
BEGIN
  SELECT * INTO STRICT i FROM bootstrap_admin_input;
  IF session_user <> current_user OR current_user::regrole::oid <>
     (SELECT relowner FROM pg_class WHERE oid = 'principals'::regclass) THEN
    RAISE EXCEPTION 'production administrator bootstrap requires the direct migration owner';
  END IF;
  LOCK TABLE principals, scope_memberships, continuum_trusted_database_identities IN EXCLUSIVE MODE;
  org_id := continuum_org_scope_id();
  IF org_id IS NULL OR NOT EXISTS (SELECT 1 FROM scopes WHERE id=org_id AND kind='org' AND name='')
     OR i.admin_id = i.sync_id OR i.external_id = i.sync_external_id
     OR length(i.display_name) NOT BETWEEN 1 AND 256
     OR length(i.sync_external_id) NOT BETWEEN 1 AND 256
     OR EXISTS (SELECT 1 FROM principals WHERE id IN (i.admin_id,i.sync_id)
                  OR lower(external_id) IN (i.external_id,lower(i.sync_external_id)))
     OR EXISTS (SELECT 1 FROM scope_memberships WHERE scope_id=org_id)
     OR EXISTS (SELECT 1 FROM continuum_trusted_database_identities)
     OR EXISTS (SELECT 1 FROM memories) THEN
    RAISE EXCEPTION 'administrator bootstrap requires a fresh canonical organization without existing authority or content';
  END IF;
  INSERT INTO principals(id,external_id,kind,display_name) VALUES
    (i.admin_id,i.external_id,'user',i.display_name),
    (i.sync_id,i.sync_external_id,'service','Membership synchronization');
  INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active)
    VALUES(i.admin_id,org_id,'admin','manual','manual',true);
  INSERT INTO audit_log(principal_id,action,scope_id,metadata)
    VALUES(i.admin_id,'write',org_id,jsonb_build_object(
      'operation','production_initial_admin_granted','database_authority','migration_owner',
      'target_principal_id',i.admin_id,'sync_principal_id',i.sync_id));
END;
$bootstrap$;
COMMIT;
