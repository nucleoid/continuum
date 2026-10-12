# Scope provisioning rollout

`continuum.ensure_scope` requires an explicit `admin` membership on the
singleton org scope. Scope creation uses the same authenticated principal and current membership
checks as other mutations. An existing scope still requires this authority when
called through `ensure_scope`.

## Before rollout

1. Inventory every MCP client, hook, and agent that calls `ensure_scope`.
2. List current org-admin memberships. The inventory intentionally omits
   `external_id`. In explicit development authentication mode that identifier
   is a bearer credential; in Entra mode it identifies a principal but does not
   authenticate the caller:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" -f scripts/list-org-admins.sql
   ```

   For each admin, determine whether it still writes to the org scope, creates
   scopes with `ensure_scope`, promotes memories into org scope, reads audit
   entries for other principals, or generates knowledge-gap reports. Use the
   real audit evidence: scope creation is
   recorded as `action='write'` with
   `metadata->>'operation' = 'create_scope'`; promotion is recorded as
   `action='promote'` with `scope_id` equal to the singleton org scope; audit
   access is recorded as `action='read'` with
   `metadata->>'view' = 'audit'`, `metadata->>'orgAdmin' = 'true'`, and a
   `metadata->'filter'->>'principalId'` other than the caller (including null,
   which means all principals). Knowledge-gap reports are recorded as
   `action='read'` with `metadata->>'view' = 'insights-gaps'`. Inspect the
   callers as well as recent rows. In particular, REST promotion and the MCP
   `continuum.promote` tool are audited, but library callers can invoke the
   exported unaudited `promoteMemory` function, so absence of a promotion row
   alone is not proof that a principal does not promote memories.

   Keep `admin` when scope creation, promotion into org, cross-principal audit
   access, or knowledge-gap reporting is required; demote to `writer` only when
   org writes are the sole requirement; demote to `reader` when org reads are
   the sole requirement; remove the membership only when no explicit org role
   is needed.
   Both scripts key on the non-secret principal UUID printed by the inventory,
   refuse to change anything other than exactly one current manual org admin,
   and require another active manual org admin before removing or demoting it:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" \
     -v principal_id='<principal UUID>' -v replacement_role=writer \
     -f scripts/demote-org-admin.sql
   # Use replacement_role=reader instead when only org reads are required.
   psql "$CONTINUUM_DATABASE_URL" \
     -v principal_id='<principal UUID>' \
     -f scripts/remove-org-admin.sql
   ```

   Record the principal UUID, former `admin` role, and replacement action in
   change control. To reverse either membership change, restore that UUID with:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" \
     -v principal_id='<principal UUID>' \
     -f scripts/restore-org-admin.sql
   ```
3. Pre-create scopes required by non-admin callers or move provisioning into an
   operator workflow.
4. Use an existing authenticated org administrator for provisioning. Keep
   routine agents and capture services on their least-privilege memberships.
   Org admin permits scope creation, org writes, cross-principal audit access,
   vocabulary administration, and knowledge-gap reports. It does not replace
   the separate DB-bound operator role for protected administration.
5. Apply every packaged migration through `0088`, finish the owner-only `0081`
   contract backfill, and converge the current application/operator/sync grants
   before starting matching binaries. Follow [offboarding rollout](./offboarding.md)
   and [tag vocabulary rollout](./tag-vocabularies.md). The migration owner
   needs database `TEMPORARY` for `0083`'s role-planning table. Runtime connections
   use the application profile and an explicit search path containing only the
   configured `CONTINUUM_APPLICATION_SCHEMA`, which defaults to `public`; keep
   `pg_catalog` implicit.
6. Select the credential for the explicit authentication mode. In `entra` mode,
   use a validated Entra access token for an already provisioned principal with
   effective org-admin membership, or a current service API key for an existing
   appropriately authorized service principal. Configure the tenant, audience,
   allowed clients, delegated scope, and application role as described in
   [authentication.md](./authentication.md). A principal's public `external_id`
   is not an Entra-mode credential. Never create a readable identifier and
   treat it as a production bearer token.
7. Build the checkout, then call the supplied one-shot MCP client from a private
   terminal. It launches `node dist/api/mcp.js` directly, so npm banners cannot
   enter the stdio protocol. Its legacy-named credential variable contains the
   credential accepted by the configured mode, not necessarily an external ID:

   ```sh
   npm run build
   export CONTINUUM_DATABASE_URL="$CONTINUUM_APPLICATION_DATABASE_URL"
   export CONTINUUM_AUTH_MODE=entra
   # Also configure the Entra settings and exact application schema/path above.
   read -r -s -p 'Scope provisioning bearer: ' scope_provisioning_bearer
   CONTINUUM_PRINCIPAL_EXTERNAL_ID="$scope_provisioning_bearer" \
     node scripts/ensure-scope.mjs project booking-engine
   unset scope_provisioning_bearer
   ```

   `CONTINUUM_APPLICATION_DATABASE_URL` is a private convenience variable; the
   program reads `CONTINUUM_DATABASE_URL`. Do not persist credentials in an MCP
   config or create scopes by bypassing the audited service with direct SQL.
   Repeat the one-shot client for each approved scope, then remove temporary
   shell state. Restart old MCP processes during the maintenance window.

### Development-only identity bootstrap

Explicit `CONTINUUM_AUTH_MODE=dev` accepts an existing principal's `external_id`
as its bearer. This is a development boundary, even when the identifier is
random. Do not expose dev mode outside a trusted development machine.

The legacy SQL bootstrap scripts create a service principal named Scope
Provisioning Operator with a 64-character lowercase hexadecimal identifier.
They do not issue an Entra token or a hashed service API key. On a private
development terminal, generate the identifier with `openssl rand -hex 32`, then
use the prompts rather than placing it in shell arguments:

```sh
psql "$CONTINUUM_DATABASE_URL" -f scripts/create-scope-operator.sql
psql "$CONTINUUM_DATABASE_URL" -f scripts/grant-org-admin.sql
psql "$CONTINUUM_DATABASE_URL" \
  -v principal_id='<non-secret UUID printed by the create script>' \
  -f scripts/verify-scope-operator.sql
```

Run these direct SQL scripts only through an explicitly reviewed database-owner
maintenance connection. The grant script ensures the matching manual membership
is active admin, including replacing a lower manual role. Record that authority
change by principal UUID. Restore the application connection before running the
one-shot MCP client with `CONTINUUM_AUTH_MODE=dev` and the development external
ID in `CONTINUUM_PRINCIPAL_EXTERNAL_ID`.

If this temporary development principal is no longer needed, the checked
retirement script removes its org membership and rotates its external ID while
retaining the UUID referenced by audit rows:

```sh
psql "$CONTINUUM_DATABASE_URL" -f scripts/retire-scope-operator.sql
```

Use a private terminal, remove temporary shell state, and clear credential-bearing
scrollback. For production service credentials, use the authenticated and
audited key issue/rotate/revoke workflow in [authentication.md](./authentication.md).

## Development prerequisites

The SQL-script integration test requires `psql` on `PATH` and a reachable
`CONTINUUM_TEST_DATABASE_URL`. When `psql` is absent, that test reports a skip;
the MCP one-shot client tests still run.

## Rollback

Treat the current schema and authority contract as forward-only. Do not roll
back to binaries that allow unauthenticated or unauthorized scope creation.
Follow the complete maintenance and tag-compatibility procedures in
[offboarding.md](./offboarding.md) and [tag-vocabularies.md](./tag-vocabularies.md);
reverting a build does not undo migrations, repair, or credential changes.

A membership change has its own reviewed reversal. Restore each recorded
principal UUID with `scripts/restore-org-admin.sql`, verify the result with
`scripts/list-org-admins.sql`, and record the restoration in change control.
Restoration reactivates the manual admin membership and must be an explicit
authority decision, not an automatic consequence of a code rollback.
