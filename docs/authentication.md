# Authentication and Entra membership sync

Continuum requires an explicit authentication mode at every REST API, MCP, or
operator process start. There is no production default:

- `CONTINUUM_AUTH_MODE=dev` enables the local integration-test identity where a
  bearer value is an existing principal `external_id`. Do not expose this mode
  outside a trusted development machine.
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
rotation. Issue, rotation, and revocation require an org administrator, and the
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
scope or role.

## Membership sync

Run `npm run sync:memberships` from a nightly scheduler. It requires:

- `CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true`
- `CONTINUUM_GRAPH_ACCESS_TOKEN`
- `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, the external ID of an org admin
- the normal database configuration

The job reads all approved bindings, including currently missing groups, then fetches each directly by
immutable ID. It does not perform name-based group discovery. A Graph 404 is a
definitive disappearance. If that immutable ID returns, its still-approved
binding is safely reactivated. Renames outside any naming convention remain active
and update metadata. Malformed, failed, duplicate, and oversized results are
counted in the audit summary and soft-deactivate access sourced by the affected
approved binding. Unbound and revoked IDs cannot confer access. Valid bound
groups remain authoritative, so removed memberships from those groups are
deactivated. A snapshot exceeding the whole-run bound quarantines all active
Entra-sourced access before the run reports failure.

Empty snapshots fail closed. By default, a run that would deactivate more than
25 percent of active bindings rolls back. After investigation, an operator may
set `CONTINUUM_MEMBERSHIP_SYNC_ALLOW_MASS_DEACTIVATION=true` for one run. A sync
also rolls back if it would remove the synchronizing administrator's authority
or the organization's last active administrator. Manual memberships and rows
sourced by other groups are unchanged.

Only direct user members are fetched through the typed Graph user-member
endpoint. Nested groups are intentionally not expanded. Users are not
provisioned by sync; an Entra user must already have a Continuum principal,
normally from successful first sign-in, before group membership becomes active.

The migration is additive for credential and binding tables, deactivates all
pre-approval Entra memberships, and gives defaults
to new membership provenance columns, so an older binary can continue writing
manual rows during a rolling deployment. A database trigger rejects active
Entra memberships without approval, so a pre-remediation binary cannot restore
name-based first binding. Run migrations before starting the new binary and
pause the membership-sync scheduler until every sync worker is upgraded; an old
worker does not understand ID-authoritative disappearance checks. Roll back
application binaries only after confirming they tolerate the new columns; do
not roll back the schema by dropping audit or provenance data.
