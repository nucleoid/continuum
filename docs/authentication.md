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

Set **Assignment required?** to **Yes** on Continuum's Entra enterprise
application, then assign only approved users and groups. The API client used to
obtain delegated tokens must also be present in
`CONTINUUM_ENTRA_ALLOWED_CLIENT_IDS`; tenant membership by itself is never an
authorization grant. Continuum admits both member tokens (`acct=0`) and guest
tokens (`acct=1`) under the same rule: the immutable `oid` must already have at
least one active Continuum scope membership. Missing `acct` is accepted because
it is an optional Entra claim, but any other value is rejected. A first valid
user sign-in remains rejected until membership sync provisions the immutable
principal and activates an approved group binding. Service tokens never
provision their principal; an administrator must use `provision-service`
first. Deactivation makes later REST requests fail authentication immediately;
long-lived MCP sessions revalidate on their normal 30-second interval. This
database check is defense in depth and does not replace the required
enterprise-application assignment.

The immutable `oid` claim owns principal identity. UUID-shaped principal
external IDs are stored in lowercase, and actor and ingest principal
configuration accepts either UUID case. A changed `name` updates display
metadata only when the value actually changes, and a principal cannot change
kind. Stdio MCP sessions revalidate credentials every 30 seconds and terminate
at token or API key expiry, rotation, or revocation.

Tenant and client UUID configuration is canonicalized to lowercase at startup.
This is a representation rule only; Entra UUID comparisons remain
case-insensitive.

## Service API keys

Service API keys contain 256 random bits and use the `ctm_` prefix. Continuum
stores only SHA-256 hashes plus a display prefix and final four characters.
Keys can be restricted to one write source and expire 90 days after issue or
rotation. `allowed-source` is an exact match against the caller-supplied
`source` field on REST and MCP capture and supersede operations. It does not
make the key write-only and does not narrow read operations; those continue to
use the service principal's scope memberships. Use a dedicated least-privilege
service principal when a credential must have narrower effective access.
Issue, rotation, and revocation require an org administrator, and the
credential mutation and audit commit atomically. Cleartext is returned only by
issue or rotation.

The `deploy-event` and `terminal-summary` ingest transports use this same
database-backed API-key verifier in Entra mode. Send `Authorization: ApiKey
ctm_...` (or the backward-compatible `Bearer ctm_...` scheme). A legacy bearer
value containing a service principal's public `external_id` is rejected.
Source-restricted keys must match the exact ingest plugin ID. GitHub HMAC and
Azure DevOps Basic webhook verification are unchanged.

Use the checked admin transport with `CONTINUUM_ADMIN_ACTOR` set to an existing
org administrator:

```text
npm run admin -- issue-key <service-external-id> [allowed-source]
npm run admin -- rotate-key <key-id>
npm run admin -- revoke-key <key-id>
```

Provision an Entra service principal before accepting its app token:

```text
npm run admin -- provision-service <entra-object-id> <display-name>
```

Disabling any principal is an audited, fail-closed operator action. It
deactivates every membership and permanently revokes every current service key.
Database triggers enforce those effects even for direct database changes and
prevent deletion, demotion, or disabling of the final effective manual
break-glass org administrator. Reactivation is also explicit and audited, but
does not restore memberships or keys:

```text
npm run admin -- disable-principal <principal-id>
npm run admin -- reactivate-principal <principal-id>
```

After reactivation, explicitly restore required access and issue a new service
key. Old keys never become valid again.

For user erasure, use the separate explicit ownership mapping and offboarding
workflow in [offboarding.md](./offboarding.md). A disabled offboarded external ID
cannot be silently provisioned by sign-in or membership sync.

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
Group and member object IDs are stored as lowercase canonical UUIDs. Migration
normalizes legacy mixed-case rows. If multiple legacy bindings differ only by
case, their sourced access is quarantined, duplicate rows are consolidated, and
the retained inactive binding requires explicit operator review and `bind-group`
reprovisioning.

## Membership sync

Run `npm run sync:memberships` from a nightly scheduler. Operators may run the
same command on demand after a Graph outage, binding change, or approved
mass-deactivation investigation. It requires:

- `CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true`
- `CONTINUUM_GRAPH_ACCESS_TOKEN`
- `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, the external ID of an active, manually
  sourced org admin
- `CONTINUUM_ENTRA_MAX_STALENESS_HOURS`, an integer from 1 through 168
  (default 48, allowing one delayed nightly run plus token refresh/recovery)
- the normal database configuration

Before enabling the scheduler, retain an independently managed, active manual
org administrator as a break-glass identity and configure that identity as the
sync actor. Every run verifies the actor itself before any Graph request and
before screening or quarantine. It fails with `FORBIDDEN` without changing
access when the actor is not an active manual org admin. Because this authority
is manually sourced, Entra staleness or self-quarantine cannot lock out sync;
`bind-group` provides an audited recovery path for quarantined bindings.
Invalid-input quarantine is
intentionally fail-closed and takes precedence over Entra-sourced availability:
admin access sourced by a malformed, duplicate, or per-group oversized Entra
result is removed while the required manual break-glass administrator remains.

Quarantine is durable state, distinct from an ordinary 404 disappearance. A
later valid Graph response cannot silently reactivate a quarantined binding;
an org administrator must inspect the failure and run `bind-group` explicitly.
Migration `0017_entra_quarantine_state.sql` conservatively marks every inactive,
approved, unrevoked pre-upgrade binding as `LEGACY_INACTIVE_REVIEW`, because old
rows did not record whether inactivity came from a 404 or invalid input. Review
and explicitly reprovision those bindings after the upgrade.

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
deactivated. A snapshot containing more than 500 group results or more than
50,000 total membership entries is rejected and audited as a whole before
screening, without changing existing bindings or memberships. One unexpected
extra result must not quarantine an otherwise valid tenant. Duplicate group
result accounting counts every unusable result while deactivating each affected
binding only once.

Successful authoritative snapshots provision at most 50,000 user principals
from immutable Graph member object IDs before granting their sourced
memberships. Until that bounded provisioning occurs, a first user sign-in is
rejected without creating a principal or storing mutable display-name PII.
Authorized sign-in may then refresh the existing principal's display name.

Graph authentication, authorization, rate-limit, service, timeout, transport,
response-body timeout/drop/truncation, non-JSON body, malformed pagination,
untrusted next-link, cycle, and page-cap exhaustion failures abort snapshot
collection before synchronization starts.
HTTP 429 and 503 responses receive at most two bounded retries. The job honors
`Retry-After` seconds or dates, capped at 60 seconds per retry. Failures do not
convert every approved group into malformed input or quarantine the binding.
The job records a durable rejection audit and reports the safe
`DEPENDENCY_UNAVAILABLE` code. A whole-run overflow is recorded before the CLI
returns the stable `PAYLOAD_TOO_LARGE` code.

Continuum records the last successful snapshot and the configured staleness
bound in `entra_sync_state`. Every authorization query still requires
`scope_memberships.active`; Entra-sourced rows are additionally denied once
the durable last-success deadline expires, even if the scheduler has stopped.
On the next failed attempt after expiry, all still-active Entra-sourced rows are
soft-deactivated and the count is included in the rejection audit. A later
successful authoritative snapshot may reactivate valid rows and resets the
deadline. Manual and other sourced memberships are not affected. Operators
must alert on rejection audits and on a deadline approaching expiry rather
than silently preserving stale access.
Deterministically invalid group identity or membership data remains contained
to the affected binding and quarantined fail-closed. Member pagination is
restricted to trusted Microsoft Graph v1.0 URLs, rejects cycles, stops at the
10,000-member bound, and has a separate generous 10,001-page safety cap so
short Graph pages are not mistaken for durable tenant corruption.

Empty snapshots fail closed. By default, a run that would deactivate more than
25 percent of active bindings rolls back. After investigation, an operator may
set `CONTINUUM_MEMBERSHIP_SYNC_ALLOW_MASS_DEACTIVATION=true` for one run. A sync
also rolls back valid authoritative changes if they would remove the
synchronizing administrator's authority or the organization's last active
administrator. Already committed invalid-input quarantine and its audits are
not rolled back. Manual memberships and rows sourced by other groups are
unchanged.

Only direct user members are fetched through the typed Graph user-member
endpoint. Nested groups are intentionally not expanded. A successful bounded
snapshot provisions its immutable user object IDs before activating sourced
memberships. Sign-in never provisions an unknown user.

This release does not support a mixed-version rolling deployment. Stop every
API, MCP, admin, and membership-sync process built from the old version, then
apply all migrations through `0021_principal_deactivation.sql`,
review the inactive bindings conservatively quarantined by
`0017_entra_quarantine_state.sql`, then start only the new binaries. The
migrator recognizes the exact pre-renumber Entra filenames used by review
builds and records their public sequence aliases under the same advisory lock,
so it does not replay an already applied identity migration. Unrelated or
partial filenames are never treated as aliases. The
database trigger
enforces the approved binding's immutable UUID, target scope, role, lifecycle,
and 500-binding cardinality on membership and binding writes. Binding changes
that would orphan active sourced memberships are rejected; the audited
`revoke-group` and `bind-group` operations deactivate first and support explicit
recovery or reprovisioning. If migration reports malformed binding state or
more than 500 approved bindings, it leaves the old schema and access unchanged.
Use `revoke-group` (while the old processes remain stopped) to resolve excess
valid bindings, or repair the named malformed rows under database-owner change
control, then rerun migration. Migration 0019 derives freshness only from a
durable prior successful-sync audit, defaulting to the fail-closed Unix epoch
when none exists. Migration 0020 applies the same correction to review-era
deployments that had already installed the earlier migration-time seed. Old
binaries do not understand the complete
ID-authoritative sync and provenance contract. Migration 0018 lowercases
UUID-shaped principal external IDs and aborts before mutation if legacy rows
would collide after canonicalization; opaque identities remain unchanged.
Pause external schedulers for
the entire stop/migrate/start window. Treat the schema as forward-only: do not
restart old binaries after migration and do not roll back by dropping audit,
credential, binding, or provenance data.
