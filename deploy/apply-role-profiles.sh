#!/bin/sh
set -eu
# Owner URL/password arrive through PG* environment and PGPASSFILE. Never trace.
: "${CONTINUUM_RUNTIME_ASSETS:=/assets}"
: "${CONTINUUM_APPLICATION_SCHEMA:?required}"
: "${CONTINUUM_APP_ROLE:?required}"
: "${CONTINUUM_OPERATOR_ROLE:?required}"
: "${CONTINUUM_SYNC_ROLE:?required (including dormant sync)}"
: "${CONTINUUM_ADMIN_PRINCIPAL_ID:?required}"
: "${CONTINUUM_SYNC_PRINCIPAL_ID:?required}"
: "${CONTINUUM_MAINTENANCE_MODE:?explicit fresh or upgrade required}"
case "$CONTINUUM_MAINTENANCE_MODE" in
  fresh|upgrade) ;;
  *) printf '%s\n' 'CONTINUUM_MAINTENANCE_MODE must be fresh or upgrade' >&2; exit 1 ;;
esac
run() {
  psql -X --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse \
    --set="continuum_schema=$CONTINUUM_APPLICATION_SCHEMA" "$@"
}
# Check existing authority before any grant script can upsert a binding. Upgrade
# values describe current reviewed bindings, including deliberate rotations;
# they never authorize a new binding. Quiesce operator/sync maintenance first.
run --set="maintenance_mode=$CONTINUUM_MAINTENANCE_MODE" \
  --set="continuum_operator_role=$CONTINUUM_OPERATOR_ROLE" \
  --set="continuum_sync_role=$CONTINUUM_SYNC_ROLE" \
  --set="continuum_admin_principal_id=$CONTINUUM_ADMIN_PRINCIPAL_ID" \
  --set="continuum_sync_principal_id=$CONTINUUM_SYNC_PRINCIPAL_ID" \
  --set="profile_app_role=$CONTINUUM_APP_ROLE" \
  --set="profile_operator_role=$CONTINUUM_OPERATOR_ROLE" \
  --set="profile_sync_role=$CONTINUUM_SYNC_ROLE" \
  --set="profile_admin_id=$CONTINUUM_ADMIN_PRINCIPAL_ID" \
  --set="profile_sync_id=$CONTINUUM_SYNC_PRINCIPAL_ID" \
  --set="application_grant=$CONTINUUM_RUNTIME_ASSETS/scripts/grant-application-role.sql" \
  --set="operator_grant=$CONTINUUM_RUNTIME_ASSETS/scripts/grant-operator-role.sql" \
  --set="sync_grant=$CONTINUUM_RUNTIME_ASSETS/scripts/grant-sync-role.sql" \
  --set="identity_verifier=$CONTINUUM_RUNTIME_ASSETS/scripts/verify-database-identities.sql" <<'SQL'
-- Hold the deployment session lock across each packaged script's commits.
-- All maintenance and identity-rotation producers must be quiesced first.
SELECT pg_catalog.pg_try_advisory_lock(7215328273579717613::bigint) AS profile_locked
\gset
\if :profile_locked
\else
  DO $$BEGIN RAISE EXCEPTION 'another maintenance session holds the deployment lock' USING ERRCODE='55000'; END$$;
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('search_path', format('%I', :'continuum_schema'), true);
CREATE TEMP TABLE continuum_profile_input ON COMMIT DROP AS
SELECT :'maintenance_mode'::text AS mode,
       :'continuum_operator_role'::text AS operator_role,
       :'continuum_sync_role'::text AS sync_role,
       :'continuum_admin_principal_id'::uuid AS admin_id,
       :'continuum_sync_principal_id'::uuid AS sync_id;
DO $bindings$
DECLARE i RECORD;
BEGIN
  SELECT * INTO STRICT i FROM continuum_profile_input;
  IF session_user <> current_user OR current_user::regrole::oid <>
     (SELECT relowner FROM pg_class WHERE oid = 'principals'::regclass) THEN
    RAISE EXCEPTION 'role profile preflight requires the direct migration owner';
  END IF;
  LOCK TABLE continuum_trusted_database_identities IN SHARE MODE;
  IF i.mode = 'fresh' THEN
    -- Correct partial or complete first-install grants may converge on retry.
    -- A foreign row, changed OID/actor or different authority never authorizes
    -- an upsert here, even if the configured actor would otherwise be valid.
    IF EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
      LEFT JOIN pg_roles role ON role.oid = identity.database_role_oid
      WHERE NOT (
        identity.database_role::text = i.operator_role AND role.rolname::text = i.operator_role
        AND identity.principal_id = i.admin_id AND identity.can_approve AND NOT identity.can_sync
        OR identity.database_role::text = i.sync_role AND role.rolname::text = i.sync_role
        AND identity.principal_id = i.sync_id AND identity.can_sync AND NOT identity.can_approve
      ) OR role.oid IS NULL
    ) THEN
      RAISE EXCEPTION 'fresh role binding does not match reviewed identity';
    END IF;
  ELSIF i.mode = 'upgrade' THEN
    IF NOT EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
      JOIN pg_roles role ON role.oid = identity.database_role_oid
      WHERE identity.database_role::text = i.operator_role AND role.rolname::text = i.operator_role
        AND identity.principal_id = i.admin_id AND identity.can_approve AND NOT identity.can_sync
    ) OR NOT EXISTS (
      SELECT 1 FROM continuum_trusted_database_identities identity
      JOIN pg_roles role ON role.oid = identity.database_role_oid
      WHERE identity.database_role::text = i.sync_role AND role.rolname::text = i.sync_role
        AND identity.principal_id = i.sync_id AND identity.can_sync AND NOT identity.can_approve
    ) OR (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync) <> 1 THEN
      RAISE EXCEPTION 'upgrade role binding does not match stored identity; use reviewed rotation or restore procedure';
    END IF;
  ELSE
    RAISE EXCEPTION 'role profile preflight requires fresh or upgrade mode';
  END IF;
END;
$bindings$;
COMMIT;
\set continuum_app_role :profile_app_role
\i :'application_grant'
\set continuum_app_role :profile_operator_role
\i :'application_grant'
\set continuum_operator_role :profile_operator_role
\set continuum_principal_id :profile_admin_id
\i :'operator_grant'
\set continuum_sync_role :profile_sync_role
\set continuum_principal_id :profile_sync_id
\i :'sync_grant'
\set continuum_app_role :profile_app_role
\i :'identity_verifier'
SELECT pg_catalog.pg_advisory_unlock(7215328273579717613::bigint);
SQL
