# Scope provisioning rollout

`continuum.ensure_scope` requires an explicit `admin` membership on the
singleton org scope. This is an intentional breaking authorization change for
callers that previously created scopes without permission.

## Before rollout

1. Inventory every MCP client, hook, and agent that calls `ensure_scope`.
2. Pre-create scopes required by non-admin callers or move provisioning into an
   operator workflow.
3. Choose a dedicated operator principal. Do not grant org admin to a shared
   agent or capture service merely to preserve the old behavior. Org admin also
   permits org writes and full audit-log reads.
4. Confirm that the principal already exists in `principals`, then run the
   checked bootstrap script:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" \
     -v ON_ERROR_STOP=1 \
     -v external_id='the-dedicated-operator-external-id' \
     -f scripts/grant-org-admin.sql
   ```

5. Verify the resulting membership and record the operator change through the
   deployment change-control process.
6. Upgrade and restart every stdio MCP process. Old processes retain the
   unprotected implementation until they restart.

The v0 stdio principal and REST bearer identity are self-asserted placeholders.
Until Entra validation ships in M4, only trusted operators may launch MCP with
database credentials or use this bootstrap procedure.

## Rollback

No migration or backfill is involved. Revert the application build and restart
MCP processes. Existing scopes, memberships, and `create_scope` audit entries
remain valid. Rolling back restores the insecure scope-creation behavior, so it
is an emergency measure rather than a steady state.
