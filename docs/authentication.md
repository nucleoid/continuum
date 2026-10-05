# Authentication and Entra membership sync

Continuum requires an explicit authentication mode at every REST API or MCP
process start:

- `CONTINUUM_AUTH_MODE=dev` enables the local integration-test identity where a
  bearer value is an existing principal `external_id`.
- `CONTINUUM_AUTH_MODE=entra` requires `CONTINUUM_ENTRA_TENANT` (a tenant UUID)
  and `CONTINUUM_ENTRA_AUDIENCE`.

Entra mode loads the tenant's OIDC discovery document and JWKS, then validates
signature, issuer, audience, and token lifetime with `jose`. The immutable `oid`
claim owns principal identity. A changed `name` only updates display metadata.
Delegated tokens create user principals; client-credential tokens create
service principals. A principal cannot change kind through a later token.

Service API keys contain 256 random bits and use the `ctm_` prefix. Continuum
stores only SHA-256 hashes plus a display prefix and final four characters.
Keys can be restricted to one capture source and expire for authentication 90
days after issue or rotation. Issue and rotation require an org administrator;
the credential mutation and its audit entry commit atomically. The cleartext
key is returned only by the issue or rotation call.

## Membership sync

Run `npm run sync:memberships` from a nightly scheduler. It requires:

- `CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true`
- `CONTINUUM_GRAPH_ACCESS_TOKEN`
- `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, the external ID of an existing org admin
- the normal database configuration

The Graph token is read from the environment and is never logged. The job
fetches every matching group and member page before opening the sync
transaction. Any failed, malformed, untrusted, or oversized response aborts
without changing membership state.

New groups use `continuum-{kind}-{name}-{role}`. The org form has an empty name,
for example `continuum-org--admin`. A group is permanently bound to its Entra
object ID, target scope, and role when first seen. Later display-name changes
update metadata only. If a bound group disappears, its sourced membership rows
are soft-deactivated. A disappeared group is not silently reactivated if the
same object ID returns; an administrator must investigate it. Manual membership
rows and rows sourced by other groups are not changed.

Sync accepts at most 500 groups, 10,000 members per group, and 50,000 total
memberships. One database advisory transaction lock serializes jobs. The
membership changes, group state, and bounded audit summary commit together.
