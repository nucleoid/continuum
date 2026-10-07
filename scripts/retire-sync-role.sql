\set ON_ERROR_STOP on
\if :{?retired_sync_role}
\else
  \echo 'retired_sync_role must name the retired sync role'
\endif
\if :{?confirm_retired_sync_role_oid}
\else
  \echo 'confirm_retired_sync_role_oid must equal the reviewed PostgreSQL role OID'
\endif
\if :{?confirm_legacy_unrecorded_sync_role}
\else
  \set confirm_legacy_unrecorded_sync_role ''
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run as the migration owner after stopping every Continuum process. This is
-- the explicit remediation path for an installation that recorded 0048 before
-- retired roles were changed to NOLOGIN.
BEGIN;
CREATE TEMP TABLE continuum_retired_sync_input (
  retired_sync NAME NOT NULL,
  confirmed_oid OID NOT NULL,
  application_schema NAME NOT NULL,
  legacy_confirmation TEXT NOT NULL
) ON COMMIT DROP;
INSERT INTO continuum_retired_sync_input
VALUES (:'retired_sync_role', :'confirm_retired_sync_role_oid'::oid,
        :'continuum_schema', :'confirm_legacy_unrecorded_sync_role');

DO $retire$
DECLARE
  retired_sync NAME;
  confirmed_oid OID;
  application_schema NAME;
  legacy_confirmation TEXT;
  retired_oid OID;
  schema_oid OID;
  owner_oid OID;
  active_identity BOOLEAN;
  recorded_sync_history BOOLEAN;
  legacy_unsafe_privileges BOOLEAN;
BEGIN
  SELECT input.retired_sync, input.confirmed_oid, input.application_schema,
         input.legacy_confirmation
    INTO retired_sync, confirmed_oid, application_schema, legacy_confirmation
    FROM continuum_retired_sync_input input;
  PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
  PERFORM pg_advisory_xact_lock(834641726154302120::bigint);
  SELECT role.oid INTO retired_oid FROM pg_roles role WHERE role.rolname = retired_sync;
  IF retired_oid IS NULL THEN
    RAISE EXCEPTION 'retired sync role does not exist';
  END IF;
  IF retired_oid <> confirmed_oid THEN
    RAISE EXCEPTION 'retired sync role OID confirmation does not match reviewed target';
  END IF;
  SELECT namespace.oid, relation.relowner INTO schema_oid, owner_oid
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = format('%I.principals', application_schema)::regclass;
  EXECUTE format(
    'LOCK TABLE %I.continuum_trusted_database_identities,
                %I.continuum_retired_sync_database_identities,
                %I.continuum_unresolved_retired_sync_database_identities
       IN SHARE ROW EXCLUSIVE MODE',
    application_schema, application_schema, application_schema
  );
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_trusted_database_identities identity
        WHERE identity.database_role_oid = $1
     )', application_schema
  ) INTO active_identity USING retired_oid;
  IF active_identity THEN
    RAISE EXCEPTION 'refusing to retire an active trusted database identity';
  END IF;
  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.continuum_retired_sync_database_identities history
        WHERE history.database_role_oid = $1
          AND history.database_role = $2
     )', application_schema
  ) INTO recorded_sync_history USING retired_oid, retired_sync;
  IF NOT recorded_sync_history
     AND legacy_confirmation <> 'RETIRE UNRECORDED LEGACY SYNC ROLE' THEN
    RAISE EXCEPTION 'unrecorded legacy sync role requires exact legacy confirmation';
  END IF;
  IF NOT recorded_sync_history THEN
    EXECUTE format(
      'SELECT
         EXISTS (
           SELECT 1 FROM pg_class relation
           CROSS JOIN LATERAL aclexplode(COALESCE(
             relation.relacl, acldefault(
               CASE WHEN relation.relkind = ''S'' THEN ''s''::"char" ELSE ''r''::"char" END,
               relation.relowner))) privilege
            WHERE relation.relnamespace = $2
              AND privilege.grantee = $1
              AND NOT (
                (relation.relkind IN (''r'',''p'',''v'',''m'',''f'') AND (
                  (relation.relname IN (''scopes'',''principals'',''entra_groups'',
                                        ''scope_memberships'',''entra_sync_state'')
                    AND upper(privilege.privilege_type) = ''SELECT'')
                  OR (relation.relname = ''principals''
                    AND upper(privilege.privilege_type) = ''INSERT'')
                  OR (relation.relname = ''audit_log''
                    AND upper(privilege.privilege_type) = ''INSERT'')
                )) OR (relation.relkind = ''S''
                  AND relation.relname = ''audit_log_id_seq''
                  AND upper(privilege.privilege_type) IN (''USAGE'',''SELECT''))
              )
         ) OR EXISTS (
           SELECT 1 FROM pg_proc function
           CROSS JOIN LATERAL aclexplode(COALESCE(
             function.proacl, acldefault(''f'', function.proowner))) privilege
            WHERE function.pronamespace = $2 AND privilege.grantee = $1
              AND function.proname NOT IN (
                ''continuum_activate_entra_memberships'',
                ''continuum_require_sync_session'',
                ''continuum_record_entra_sync_success'',
                ''continuum_record_entra_sync_failure'',
                ''continuum_sync_observe_entra_group'',
                ''continuum_sync_deactivate_entra_memberships'',
                ''continuum_sync_deactivate_entra_groups'',
                ''continuum_sync_quarantine_entra_group'',
                ''continuum_verify_sync_database_identity'')
         ) OR EXISTS (
           SELECT 1 FROM pg_namespace namespace
           CROSS JOIN LATERAL aclexplode(COALESCE(
             namespace.nspacl, acldefault(''n'', namespace.nspowner))) privilege
            WHERE namespace.oid = $2 AND privilege.grantee = $1
              AND upper(privilege.privilege_type) <> ''USAGE''
         ) OR EXISTS (
           SELECT 1 FROM pg_attribute attribute
           CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
           JOIN pg_class relation ON relation.oid = attribute.attrelid
            WHERE relation.relnamespace = $2 AND privilege.grantee = $1
         ) OR EXISTS (
           SELECT 1 FROM pg_parameter_acl parameter_acl
           CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) privilege
            WHERE privilege.grantee = $1
         ) OR EXISTS (
           SELECT 1 FROM pg_db_role_setting setting WHERE setting.setrole = $1
         )', application_schema
    ) INTO legacy_unsafe_privileges USING retired_oid, schema_oid;
    IF legacy_unsafe_privileges THEN
      RAISE EXCEPTION 'unrecorded role has unsafe privileges outside the legacy sync footprint';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE retired_oid IN (membership.roleid, membership.member)
       AND NOT (membership.roleid = retired_oid AND membership.member = owner_oid
                AND membership.admin_option
                AND NOT membership.set_option
                AND NOT membership.inherit_option)
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace namespace
     WHERE namespace.oid = schema_oid AND namespace.nspowner = retired_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_class relation
     WHERE relation.relnamespace = schema_oid AND relation.relowner = retired_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
     WHERE function.pronamespace = schema_oid AND function.proowner = retired_oid
  ) THEN
    RAISE EXCEPTION 'retired sync role has membership or owns application objects';
  END IF;
  EXECUTE format(
    'SELECT %I.continuum_require_sync_retirement_authority($1)', application_schema
  ) USING retired_oid;
  EXECUTE format(
    'INSERT INTO %I.continuum_unresolved_retired_sync_database_identities
       (database_role, previous_database_role_oid, resolution_kind, cluster_epoch, marked_at)
     SELECT history.database_role, history.database_role_oid,
            ''superseded'', epoch.epoch, history.retired_at
       FROM %I.continuum_retired_sync_database_identities history
       CROSS JOIN %I.continuum_database_identity_epoch epoch
      WHERE history.database_role = $1 AND history.database_role_oid <> $2
        AND epoch.singleton
     ON CONFLICT (database_role, previous_database_role_oid) DO UPDATE SET
       resolution_kind = ''superseded'',
       cluster_epoch = EXCLUDED.cluster_epoch,
       marked_at = LEAST(
         continuum_unresolved_retired_sync_database_identities.marked_at,
         EXCLUDED.marked_at)',
    application_schema, application_schema, application_schema
  ) USING retired_sync, retired_oid;
  EXECUTE format(
    'DELETE FROM %I.continuum_retired_sync_database_identities
      WHERE database_role = $1 AND database_role_oid <> $2',
    application_schema
  ) USING retired_sync, retired_oid;
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I',
    application_schema, retired_sync);
  EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL', retired_sync);
  EXECUTE format(
    'INSERT INTO %I.continuum_retired_sync_database_identities
       (database_role_oid, database_role)
     VALUES ($1, $2)
     ON CONFLICT (database_role_oid) DO UPDATE SET
       database_role = EXCLUDED.database_role, retired_at = now()',
    application_schema
  ) USING retired_oid, retired_sync;
END;
$retire$;
COMMIT;
