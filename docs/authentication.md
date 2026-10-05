# Authentication and Entra membership sync

Continuum requires an explicit authentication mode at every REST API, MCP, or
operator process start. There is no production default:

- `CONTINUUM_AUTH_MODE=dev` enables the local integration-test identity where a
  bearer value is an existing principal `external_id`. Do not expose this mode
  outside a trusted development machine. API and MCP startup emit a warning to
  stderr whenever this mode is selected.
- `CONTINUUM_AUTH_MODE=entra` requires a tenant UUID, audience, delegated user
  scope, and application role in `CONTINUUM_ENTRA_TENANT`,
  `CONTINUUM_ENTRA_AUDIENCE`, `CONTINUUM_ENTRA_USER_SCOPE`, and
  `CONTINUUM_ENTRA_SERVICE_APP_ROLE`. `CONTINUUM_ENTRA_ALLOWED_CLIENT_IDS`
  must contain one or more comma-separated application (client) UUIDs.

Entra mode loads only the configured tenant's OIDC metadata and Microsoft JWKS
over HTTPS with bounded timeouts. Rejected metadata loads are evicted so a
later request retries. Tokens must be RS256 v2 access tokens from that tenant.
Delegated user tokens must carry `idtyp=user`, the configured `scp` value, and
an `azp`/`appid` in the client allow-list. Client-credential tokens must carry
`idtyp=app`, an allow-listed UUID client ID, and the configured `roles` value.
Audience, issuer, lifetime, and immutable `oid` are also validated. ID tokens
and tokens from unlisted or role-unassigned applications are rejected.
All credential, JOSE, JWKS, key, and claim failures return an authentication
failure without exposing provider details.

The immutable `oid` claim owns principal identity. A changed `name` only
updates display metadata, and a principal cannot change kind. Stdio MCP
sessions revalidate credentials every 30 seconds and terminate at token or API
key expiry, rotation, or revocation.

## Service API keys

Service API keys contain 256 random bits and use the `ctm_` prefix. Continuum
stores only SHA-256 hashes plus a display prefix and final four characters.
Keys can be restricted to one capture source and expire 90 days after issue or
rotation. `allowed-source` is an exact match against the caller-supplied
`source` field on REST and MCP capture operations. It does not make the key
capture-only and does not narrow recall or other operations; those continue to
use the service principal's scope memberships. Use a dedicated least-privilege
service principal when a credential must have capture-only effective access.
Issue, rotation, and revocation require an org administrator, and the
credential mutation and audit commit atomically. Cleartext is returned only by
issue or rotation.

Use the checked admin transport with `CONTINUUM_ADMIN_ACTOR` set to an existing
org administrator:

```text
npm run admin -- issue-key <service-external-id> [allowed-source]
npm run admin -- rotate-key <key-id>
npm run admin -- revoke-key <key-id>
```

## Approved group bindings

Group names never grant access. Before sync can activate membership, an org
administrator must approve the immutable Entra group object ID, target scope
ID, and role:

```text
npm run admin -- bind-group <group-id> <scope-id> <reader|writer|admin> [display-name]
npm run admin -- revoke-group <group-id>
```

Binding and revocation are audited. Revocation atomically soft-deactivates all
memberships sourced by that group, excludes it from future Graph fetches, and
cannot be undone by sync. `bind-group` is the only way to explicitly approve it
again. A tenant user cannot create a privileged group with a matching name and
self-escalate. Renames only update display metadata and never alter the approved
scope or role. At most 500 bindings may be approved and unrevoked at once;
provisioning the 501st is rejected without changing an existing binding.

## Membership sync

Run `npm run sync:memberships` from a nightly scheduler. It requires:

- `CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true`
- `CONTINUUM_GRAPH_ACCESS_TOKEN`
- `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, the external ID of an org admin
- the normal database configuration

Before enabling the scheduler, retain an independently managed manual org
administrator as a break-glass identity. Invalid-input quarantine is
intentionally fail-closed and takes precedence over availability: if the only
org-admin access is sourced by a malformed, duplicate, or oversized
Entra result, that access is removed and direct database recovery is required.

The job reads all approved bindings, including currently missing groups, then fetches each directly by
immutable ID. It does not perform name-based group discovery. A Graph 404 is a
definitive disappearance. If that immutable ID returns, its still-approved
binding is safely reactivated. Renames outside any naming convention remain active
and update metadata. Malformed, duplicate, and oversized results are
counted in a durable screening audit and soft-deactivate access sourced by the
affected approved binding. That quarantine commits before valid results are
applied, so a later global threshold or administrator guard cannot restore
stale invalid access. Unbound and revoked IDs cannot confer access. Valid bound
groups remain authoritative, so removed memberships from those groups are
deactivated. A snapshot exceeding the whole-run bound quarantines all active
Entra-sourced access before the run reports failure.

Graph authentication, authorization, rate-limit, service, timeout, and
transport failures abort snapshot collection before synchronization starts.
They do not convert every approved group into malformed input or quarantine
the last successfully synchronized access set. The job reports failure so the
scheduler can retry. Invalid Graph payloads and untrusted pagination links are
still contained to the affected binding and quarantined fail-closed.

Empty snapshots fail closed. By default, a run that would deactivate more than
25 percent of active bindings rolls back. After investigation, an operator may
set `CONTINUUM_MEMBERSHIP_SYNC_ALLOW_MASS_DEACTIVATION=true` for one run. A sync
also rolls back valid authoritative changes if they would remove the
synchronizing administrator's authority or the organization's last active
administrator. Already committed invalid-input quarantine and its audits are
not rolled back. Manual memberships and rows sourced by other groups are
unchanged.

Only direct user members are fetched through the typed Graph user-member
endpoint. Nested groups are intentionally not expanded. Users are not
provisioned by sync; an Entra user must already have a Continuum principal,
normally from successful first sign-in, before group membership becomes active.

This release does not support a mixed-version rolling deployment. Stop every
API, MCP, admin, and membership-sync process built from the old version, then
apply the migrations, then start only the new binaries. The database trigger
enforces the approved binding's immutable group ID, target scope, and role on
inserts and relevant updates, but old binaries do not understand the complete
ID-authoritative sync and provenance contract. Pause external schedulers for
the entire stop/migrate/start window. Treat the schema as forward-only: do not
restart old binaries after migration and do not roll back by dropping audit,
credential, binding, or provenance data.
