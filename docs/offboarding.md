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

Mapping requires the target principal to have current or historical membership
on the scope. A scope with another active member is rejected by default. If a
review confirms that a delegate or ingest identity legitimately shares the
personal scope, the operator must acknowledge that all of those memberships
will be deactivated by using `--allow-other-active-members`, or REST field
`"allowOtherActiveMembers": true`. Names and authorship are never ownership
evidence.

Dry-run reports personal-memory, live-memory, embedding, active scope-membership,
and raw audit-query counts without writing an audit or changing state. It also
returns bounded, sorted member and author principal UUID evidence, with explicit
truncation flags, so the operator can detect a mistaken mapping without exposing
names or memory content. Execution is limited to 10,000 memories so
the redaction, archive transition, embedding deletion, membership deactivation,
principal disablement, pseudonymization, and audit commit remain one bounded
transaction. Every membership on the owned scope is deactivated, including
delegate and ingest identities. Larger scopes are rejected intact and require a reviewed retention
plan; the service never partially erases one owned scope. Safe retries return
`alreadyOffboarded: true` only after verifying that no live memories, embeddings,
active scope memberships, or raw target queries remain. Retry output includes
the first offboarding audit ID, timestamp, and original counts. A dirty retry
runs the complete erasure again and records a repair event rather than silently
reporting success.

Every memory in the mapped user scope has its title and body replaced with the
fixed `[erased]` tombstone, metadata and tags cleared, source identifiers
removed, and state set to `archived`. Memories in team, project, role, and org
scopes are preserved even when the departing principal authored them. Their
stable author UUID remains an audit reference and resolves to the principal's
stable `erased-<uuid-prefix>` pseudonym. The original display name is removed
from the ordinary `principals` table. Audit metadata contains UUIDs, counts, and
the pseudonym, never the removed display name or memory content. Raw recall text
in the departing principal's `audit_log.query` rows is set to null in the same
transaction, so it cannot remain visible through audit or knowledge-gap output.

Disabling the principal atomically deactivates all sourced memberships and
revokes service credentials. The existing final-manual-org-admin guard can
reject the whole operation. Membership sync and offboarding share an advisory
lock, so a concurrent snapshot cannot restore access during erasure. Disabled
identity rows retain the immutable external ID to deny silent re-provisioning.
Only the audited `reactivate-principal` operator action can enable the identity.
It clears the offboarded lifecycle marker and records
`previously_offboarded: true`, but does not itself restore memberships, keys,
names, or erased content. A later authoritative membership sync can restore
eligible sourced memberships, and the reactivated principal can then capture
new content. A later offboarding therefore always performs a fresh complete
erasure pass.

Database triggers delete derived embeddings whenever any path changes a memory
to `archived`, including lifecycle, supersession, direct maintenance, and
offboarding. Embedding writes lock and recheck the parent memory, so they cannot
commit for archived content and cannot race cleanup. Expired but still-live
rows remain the lifecycle sweeper's responsibility until its atomic transition.
The database also rejects inserting a live memory, or changing a memory back to
live, in a scope whose mapped owner is currently offboarded.

Migration `0022_offboarding_erasure.sql` uses a five-second `lock_timeout` and
deletes embeddings already attached to archived memories before installing the
ongoing triggers. Apply it before starting the new application version, during
a window where long membership-sync and write transactions can be allowed to
finish. A lock-timeout failure rolls the migration back intact and should be
retried after the blocker is removed. During a rolling deploy, old instances do
not expose the new operator workflow; complete the migration before invoking
offboarding.

This is an application-data boundary. Operators must separately apply their
documented retention policy to encrypted database backups, database/WAL logs,
external source systems, infrastructure logs, and provider telemetry. This
repository does not claim a deployed erasure workflow or deletion from those
systems. Preserved shared memories intentionally retain stable author UUIDs and
source metadata needed for shared provenance. For GitHub-derived shared
memories, that metadata can include a mutable GitHub login; this documented
shared-memory identity exception is not removed by personal-scope offboarding.
