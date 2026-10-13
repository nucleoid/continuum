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
run() {
  psql -X --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse \
    --set="continuum_schema=$CONTINUUM_APPLICATION_SCHEMA" "$@"
}
run --set="continuum_app_role=$CONTINUUM_APP_ROLE" \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-application-role.sql"
run --set="continuum_app_role=$CONTINUUM_OPERATOR_ROLE" \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-application-role.sql"
run --set="continuum_operator_role=$CONTINUUM_OPERATOR_ROLE" \
  --set="continuum_principal_id=$CONTINUUM_ADMIN_PRINCIPAL_ID" \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-operator-role.sql"
run --set="continuum_sync_role=$CONTINUUM_SYNC_ROLE" \
  --set="continuum_principal_id=$CONTINUUM_SYNC_PRINCIPAL_ID" \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-sync-role.sql"
run --set="continuum_app_role=$CONTINUUM_APP_ROLE" \
  --set="continuum_operator_role=$CONTINUUM_OPERATOR_ROLE" \
  --set="continuum_sync_role=$CONTINUUM_SYNC_ROLE" \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/verify-database-identities.sql"
