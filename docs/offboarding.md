# Offboarding and right to erasure

This document is the privacy, security, and operator runbook for application
offboarding. Review it with the organization's retention and incident-response
owners before enabling the workflow.

Offboarding is an explicit org-administrator operation. It is not inferred from
principal names, scope names, or memory authorship. Before offboarding, map the
immutable principal UUID to exactly one existing `user` scope UUID:

```text
npm run admin -- map-user-scope <principal-id> <user-scope-id>
npm run admin -- offboard-principal <principal-id> --dry-run
npm run admin -- offboard-principal <principal-id>
```

The REST equivalents are `PUT
/api/v0/admin/principals/:principalId/owned-user-scope` with `{ "scopeId":
"..." }`, and `POST /api/v0/admin/principals/:principalId/offboard` with `{
"dryRun": true|false }`. Normal authentication applies and the service checks
active org-admin authority inside the transaction.

Dry-run reports personal-memory, embedding, and active-membership counts without
writing an audit or changing state. Execution is limited to 10,000 memories so
the redaction, archive transition, embedding deletion, membership deactivation,
principal disablement, pseudonymization, and audit commit remain one bounded
transaction. Larger scopes are rejected intact and require a reviewed retention
plan; the service never partially erases one owned scope. Safe retries return
`alreadyOffboarded: true` and do not add duplicate audit events.

Every memory in the mapped user scope has its title and body replaced with the
fixed `[erased]` tombstone, metadata and tags cleared, source identifiers
removed, and state set to `archived`. Memories in team, project, role, and org
scopes are preserved even when the departing principal authored them. Their
stable author UUID remains an audit reference and resolves to the principal's
stable `erased-<uuid-prefix>` pseudonym. The original display name is removed
from the ordinary `principals` table. Audit metadata contains UUIDs, counts, and
the pseudonym, never the removed display name or memory content.

Disabling the principal atomically deactivates all sourced memberships and
revokes service credentials. The existing final-manual-org-admin guard can
reject the whole operation. Membership sync and offboarding share an advisory
lock, so a concurrent snapshot cannot restore access during erasure. Disabled
identity rows retain the immutable external ID to deny silent re-provisioning.
Only the audited `reactivate-principal` operator action can enable the identity;
it does not restore memberships, keys, names, or erased content.

Database triggers delete derived embeddings whenever any path changes a memory
to `archived`, including lifecycle, supersession, direct maintenance, and
offboarding. Embedding writes lock and recheck the parent memory, so they cannot
commit for archived content and cannot race cleanup. Expired but still-live
rows remain the lifecycle sweeper's responsibility until its atomic transition.

This is an application-data boundary. Operators must separately apply their
documented retention policy to encrypted database backups, database/WAL logs,
external source systems, infrastructure logs, and provider telemetry. This
repository does not claim a deployed erasure workflow or deletion from those
systems.
