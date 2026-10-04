# Scope provisioning rollout

`continuum.ensure_scope` requires an explicit `admin` membership on the
singleton org scope. This is an intentional breaking authorization change for
callers that previously created scopes without permission.

## Before rollout

1. Inventory every MCP client, hook, and agent that calls `ensure_scope`.
2. List current org-admin memberships. The inventory intentionally omits
   `external_id` because it is the live v0 bearer credential:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" -f scripts/list-org-admins.sql
   ```

   For each admin, determine whether it still writes to the org scope, creates
   scopes with `ensure_scope`, promotes memories into org scope, or reads audit
   entries for other principals. Use the real audit evidence: scope creation is
   recorded as `action='write'` with
   `metadata->>'operation' = 'create_scope'`; promotion is recorded as
   `action='promote'` with `scope_id` equal to the singleton org scope; audit
   access is recorded as `action='read'` with
   `metadata->>'view' = 'audit'`, `metadata->>'orgAdmin' = 'true'`, and a
   `metadata->'filter'->>'principalId'` other than the caller (including null,
   which means all principals). Inspect the callers as well as recent rows.
   Keep `admin` when scope creation, promotion into org, or cross-principal audit
   access is required; demote to `writer` only when org writes are the sole
   requirement; remove the membership only when no explicit org role is needed.
   Both scripts key on the non-secret principal UUID printed by the inventory,
   refuse to change anything other than exactly one current org admin, and
   refuse to remove or demote the last org admin:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" \
     -v principal_id='<principal UUID>' -v replacement_role=writer \
     -f scripts/demote-org-admin.sql
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
4. Choose a dedicated operator principal with a high-entropy, non-enumerable
   `external_id`. Do not use a readable name and do not grant org admin to a
   shared agent or capture service merely to preserve the old behavior. During
   v0 the REST bearer credential is the literal `external_id`; org admin also
   permits org writes and full audit-log reads.
5. Confirm that the REST port is limited to the trusted operator network. If a
   high-entropy identity and that network restriction are not both in place,
   postpone this rollout until Entra validation ships in M4.
6. Create a fresh high-entropy identifier on the private operator terminal with
   `openssl rand -hex 32`. Paste it only at the prompts below; do not put the
   identifier in command arguments, shell history, tickets, or logs. Create the
   dedicated principal, record the principal UUID printed by the create script,
   then grant org admin:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" -f scripts/create-scope-operator.sql
   psql "$CONTINUUM_DATABASE_URL" -f scripts/grant-org-admin.sql
   ```

   The grant script is idempotent for an existing admin and refuses to replace
   an existing reader or writer role.

7. Verify the resulting membership and record the operator change through the
   deployment change-control process without placing the bearer in query text:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" \
     -v principal_id='<non-secret UUID printed by the create script>' \
     -f scripts/verify-scope-operator.sql
   ```

8. Build the reviewed checkout, then call the MCP tool through the supplied
   one-shot client from a private terminal. This launches `node dist/api/mcp.js`
   directly, so npm cannot write banners into the stdio protocol. Never create
   scopes with direct SQL and never persist this credential in an MCP config:

   ```sh
   npm run build
   export CONTINUUM_DATABASE_URL
   read -r -s -p 'Scope operator external_id: ' scope_operator_id
   CONTINUUM_PRINCIPAL_EXTERNAL_ID="$scope_operator_id" \
     node scripts/ensure-scope.mjs project booking-engine
   unset scope_operator_id
   ```

   Repeat the one-shot client for each approved scope, stop after provisioning,
   remove any temporary shell state, and clear terminal scrollback before
   screen sharing. The startup error does not echo an unknown credential.
   Upgrade and restart every ordinary stdio MCP process too; old processes
   retain the unprotected implementation until they restart.

The v0 stdio principal and REST bearer identity are self-asserted placeholders.
Until Entra validation ships in M4, only trusted operators may launch MCP with
database credentials or use this bootstrap procedure, and REST must remain on a
trusted network. Remove the temporary org-admin membership after provisioning
if no ongoing operator workflow needs it. Retire the temporary credential with
the checked script below; it removes the org membership and rotates
`external_id` while retaining the principal UUID referenced by audit rows:

```sh
psql "$CONTINUUM_DATABASE_URL" -f scripts/retire-scope-operator.sql
```

The interactive prompts keep the bearer out of command arguments and shell
history, but the value is visible while typed and may remain in terminal
scrollback. Use a private operator session and clear it after retirement.

## Development prerequisites

The SQL-script integration test requires `psql` on `PATH` and a reachable
`CONTINUUM_TEST_DATABASE_URL`. When `psql` is absent, that test reports a skip;
the MCP one-shot client tests still run.

## Rollback

No migration or backfill is involved. Revert the application build and restart
MCP processes. Existing scopes, memberships, and `create_scope` audit entries
remain valid. Rolling back restores the insecure scope-creation behavior, so it
is an emergency measure rather than a steady state.

Reverting application code does not undo an admin demotion or removal. Restore
each recorded principal UUID with `scripts/restore-org-admin.sql`, verify the
result with `scripts/list-org-admins.sql`, and record the restoration in change
control.
