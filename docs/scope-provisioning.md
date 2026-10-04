# Scope provisioning rollout

`continuum.ensure_scope` requires an explicit `admin` membership on the
singleton org scope. This is an intentional breaking authorization change for
callers that previously created scopes without permission.

## Before rollout

1. Inventory every MCP client, hook, and agent that calls `ensure_scope`.
2. Pre-create scopes required by non-admin callers or move provisioning into an
   operator workflow.
3. Choose a dedicated operator principal with a high-entropy, non-enumerable
   `external_id`. Do not use a readable name and do not grant org admin to a
   shared agent or capture service merely to preserve the old behavior. During
   v0 the REST bearer credential is the literal `external_id`; org admin also
   permits org writes and full audit-log reads.
4. Confirm that the REST port is limited to the trusted operator network. If a
   high-entropy identity and that network restriction are not both in place,
   postpone this rollout until Entra validation ships in M4.
5. Create a fresh high-entropy identifier on the private operator terminal with
   `openssl rand -hex 32`. Paste it only at the prompts below; do not put the
   identifier in command arguments, shell history, tickets, or logs. Create the
   dedicated principal, then grant org admin:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" -f scripts/create-scope-operator.sql
   psql "$CONTINUUM_DATABASE_URL" -f scripts/grant-org-admin.sql
   ```

   The grant script is idempotent for an existing admin and refuses to replace
   an existing reader or writer role.

6. Verify the resulting membership and record the operator change through the
   deployment change-control process:

   ```sql
   SELECT p.external_id, sm.role
     FROM scope_memberships sm
     JOIN principals p ON p.id = sm.principal_id
     JOIN scopes s ON s.id = sm.scope_id
    WHERE p.external_id = '<paste the operator external_id in this private session>'
      AND s.kind = 'org' AND s.name = '' AND sm.role = 'admin';
   ```

7. Upgrade and restart every stdio MCP process. Old processes retain the
   unprotected implementation until they restart.

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

## Rollback

No migration or backfill is involved. Revert the application build and restart
MCP processes. Existing scopes, memberships, and `create_scope` audit entries
remain valid. Rolling back restores the insecure scope-creation behavior, so it
is an emergency measure rather than a steady state.
