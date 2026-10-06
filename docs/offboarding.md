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
npm run admin -- offboard-principal <principal-id> --confirm-scope <user-scope-id>
```

The REST equivalents are `PUT
/api/v0/admin/principals/:principalId/owned-user-scope` with `{ "scopeId":
"..." }`, and `POST /api/v0/admin/principals/:principalId/offboard`. REST
defaults to `{ "dryRun": true }`. Irreversible execution requires `{ "dryRun":
false, "confirmScopeId": "<owned-user-scope-id>" }`; that UUID must match the
locked mapping. API-key credentials are rejected for these operator routes.
Normal authentication still applies and the service checks active org-admin
authority inside the transaction.

Mapping requires the target principal to have current or historical `writer` or
`admin` membership on the scope; reader access alone is not ownership proof. A
scope with any membership history or authorship from another principal is
rejected by default, even when that membership is now inactive. If a review
confirms that a delegate, ingest identity, or prior author legitimately shares
the personal scope, the operator must acknowledge that history by using
`--allow-other-active-members`, or REST field `"allowOtherActiveMembers": true`.
The acknowledgement stores the complete bounded, sorted set of reviewed member
and author principal UUIDs plus a SHA-256 hash bound to the owner and scope.
Execution requires current evidence to be a subset of that set; a newly
appearing principal fails closed until the operator repeats the explicit review.
Truncated evidence can never be acknowledged. Mapping audit contains only UUID
lists, the evidence hash, and explicit truncation flags. Names alone are never
ownership evidence.

Dry-run reports personal-memory, live-memory, embedding, active scope-membership,
and raw audit-query counts without writing an audit or changing state. It also
returns bounded, sorted member and author principal UUID evidence, with explicit
truncation flags, so the operator can detect a mistaken mapping without exposing
names or memory content. Execution is limited to 10,000 memories and 50,000
total affected rows (memories, embeddings, memberships, aliases, Entra
bindings, selected audit rows, per-memory receipts, and fixed control rows) so
the redaction, archive transition, embedding deletion, membership deactivation,
principal disablement, principal and scope pseudonymization, and audit commit
remain one bounded transaction. Every membership on the owned scope is
deactivated, including delegate and ingest identities. Entra bindings targeting
the scope are revoked and quarantined; database triggers reject later active
memberships or bindings while its owner remains offboarded. Larger operations
are rejected intact and require a reviewed retention plan; the service never
partially erases one owned scope. Safe retries return
`alreadyOffboarded: true` only after verifying the exact memory tombstone fields,
principal and scope pseudonyms, zero embeddings, aliases, active memberships,
and zero unrevoked Entra bindings,
and no dirty audit query or metadata rows. Dry-run and retry output includes
dirty-memory and dirty-audit counts. Retry output also includes the first durable
evidence ID, timestamp, and original counts. A dirty retry
runs the complete erasure again and records a repair event rather than silently
reporting success.

Every memory in the mapped user scope has its title and body replaced with the
fixed `[erased]` tombstone, type normalized to `context`, metadata and tags
cleared, source identifiers and memory-to-memory links removed, lifecycle dates
cleared, and state set to `archived`. The owned user scope name is replaced by
a deterministic UUID-derived pseudonym. Memories in team, project, role, and org
scopes are preserved even when the departing principal authored them. Their
stable author UUID remains an audit reference and resolves to the principal's
stable `erased-<uuid-prefix>` pseudonym. The original display name is removed
from the ordinary `principals` table. Audit metadata contains UUIDs, counts, and
the pseudonym, never the removed display name or memory content. Raw recall text
and free-text audit metadata (including verification notes) on rows tied to the
principal, owned scope, or its memories are replaced by a fixed tombstone in the
same transaction. Selection uses UUID columns, exact `metadata.scope_ids`
membership, exact JSON string-value equality for the old scope name, and exact
`request_id` linkage; SQL wildcard semantics are never used. This also reaches
delegate/admin summaries whose `scope_id` is null, so they cannot remain visible through the audit API or
knowledge-gap output. Audit inserts lock the principal row and are rejected
after offboarding; an in-flight recall that loses this race fails closed instead
of returning results with an unsanitized late audit row.

The original count and bounded-ID receipt is also written to
`principal_offboarding_events`. That compact privacy-safe ledger is outside
ordinary `audit_log` retention and is the authoritative retry evidence after
audit rows have been pruned. It contains UUIDs, counts, timestamps, and
truncation flags only, never memory text, names, queries, or verification notes.

Disabling the principal atomically deactivates all sourced memberships and
revokes service credentials. Provider aliases resolving to the user are deleted
in the same transaction and included in dirty retry counts. The existing
final-manual-org-admin guard can
reject the whole operation. Membership sync and offboarding share an advisory
lock, so a concurrent snapshot cannot restore access during erasure. Disabled
identity rows retain the immutable Entra object ID solely as the minimal
pseudonymous deny-list key needed to prevent silent re-provisioning. This
documented exception can still be personal data and must not be used for display
or new authorization; aliases and display names are removed or pseudonymized.
Only the audited `reactivate-principal` operator action can enable the identity.
It clears the offboarded lifecycle marker and records
`previously_offboarded: true`, but does not itself restore memberships, keys,
names, or erased content. A later authoritative membership sync can restore
eligible sourced memberships only after an administrator explicitly re-approves
any quarantined owned-scope binding. The reactivated principal can then capture
new content. A later offboarding therefore always performs a fresh complete
erasure pass.

Database triggers delete derived embeddings whenever any path changes a memory
to `archived`, including lifecycle, supersession, direct maintenance, and
offboarding. Archived tombstone content in an offboarded owned scope is
database-immutable; the guarded repair path can only move dirty content toward
the canonical tombstone. Embedding writes lock and recheck the parent memory, so they cannot
commit for archived content and cannot race cleanup. Expired but still-live
rows remain the lifecycle sweeper's responsibility until its atomic transition.
The database also rejects inserting a live memory, or changing a memory back to
live, in a scope whose mapped owner is currently offboarded.

Migration `0022_offboarding_erasure.sql` uses a five-second `lock_timeout`, a
30-second `statement_timeout`, and targeted audit scope, request-ID, and
`scope_ids` indexes. Application transactions apply the same timeouts and
materialize bounded audit target IDs once rather than repeating selection
scans. It also installs the columns, ledgers, and database guards. Migration
`0023_offboarding_embedding_cleanup.sql` runs afterward with a five-second lock
timeout and a 30-second statement timeout. Separating cleanup means the scan and
delete of old archived embeddings never runs while `0022` holds `ACCESS
EXCLUSIVE` on `principals`. A timeout rolls back that migration intact; remove
the blocker or schedule a larger maintenance window and retry.

Apply both migrations before starting the new application version. Old
instances can continue ordinary traffic after `0022`, but they do not know the
offboarding workflow and an old authenticated request may already be in flight.
Do not invoke offboarding until both migrations are recorded on every shared
database and all old application instances have drained. Rollback is
application-first: stop invoking offboarding, drain the new instances, and
deploy the old application. Do not drop the new columns, tables, functions, or
triggers during that rollback; the old application tolerates them, while
dropping the guards would reopen late-write races. Schema removal requires a
separate reviewed migration only after no offboarded principals or owned-scope
mappings remain. Offboarding erasure itself is irreversible and is not undone
by an application rollback.

This is an application-data boundary. Operators must separately apply their
documented retention policy to encrypted database backups, database/WAL logs,
external source systems, infrastructure logs, and provider telemetry. This
repository does not claim a deployed erasure workflow or deletion from those
systems. Preserved shared memories intentionally retain stable author UUIDs and
source metadata needed for shared provenance. For GitHub-derived shared
memories, that metadata can include a mutable GitHub login; this documented
shared-memory identity exception is not removed by personal-scope offboarding.
