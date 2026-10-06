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
npm run admin -- offboard-principal <principal-id> --confirm-scope <user-scope-id> --batch-size 1000
npm run admin -- list-incomplete-offboarding
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

Dry-run reports bounded lower-bound previews for personal memories, live
memories, embeddings, active scope memberships, and raw audit queries without
writing an audit or changing state. `countEvidence` identifies the preview
limit and every truncated field; an unlisted field is exact. It also
returns bounded, sorted member and author principal UUID evidence, explicit
truncation flags, and audit selection counts by principal, scope, memory,
`scope_ids`, and linked request. This lets the operator detect a mistaken
mapping without exposing names or memory content.

Execution immediately disables and pseudonymizes the principal and scope,
deactivates owned-scope access, quarantines its Entra bindings, and deletes
aliases in the first transaction. Those database fences remain closed while
memories and audit rows are processed in retry-safe batches. `batchSize`
defaults to 1,000 and accepts 1 through 5,000 through REST or CLI
`--batch-size`; each response reports cumulative processed counts, bounded
remaining-work indicators, batch number, and `complete`. Durable UUID and audit
ID keyset cursors ensure every resumed batch scans bounded windows. After the
principal and owned-scope write fence is closed, the run records one immutable
audit high-water ID. Every selector exhausts only its window through that fence;
the linked-request selector starts after request-ID discovery is complete.
Cursor exhaustion, rather than repeated dirty-history scans or full recounts,
decides audit completion. Principals with more than 10,000 memories
or 50,000 audit rows use the same path and are not rejected. Reissue the exact
confirmed REST operation until `complete: true`. The admin CLI does this loop by
default; `--once` performs one batch for external orchestration, and
`list-incomplete-offboarding` lists durable unfinished runs. Every membership on the owned scope
is deactivated, including delegate and ingest identities. Database triggers
reject later active memberships or bindings while its owner remains offboarded.
Safe retries return
`alreadyOffboarded: true` only after verifying the exact memory tombstone fields,
principal and scope pseudonyms, zero embeddings, aliases, active memberships,
and zero unrevoked Entra bindings,
and no dirty audit query or metadata rows. Dry-run and retry output includes
dirty-memory and dirty-audit indicators. Retry output also includes the first durable
evidence ID, timestamp, and exact cumulative processed counts from the completed
run. A dirty
retry resumes or repairs bounded work and records a repair event rather than
silently reporting success.

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
same batch transaction. Selection uses separately indexed `UNION` branches for
UUID columns, exact `metadata.scope_ids` membership, and exact `request_id`
linkage. Free-form or recursive scope-name matching is not used. This also reaches
delegate/admin summaries whose `scope_id` is null, so they cannot remain visible through the audit API or
knowledge-gap output. Audit inserts lock the principal row and are rejected
after offboarding; an in-flight recall that loses this race fails closed instead
of returning results with an unsanitized late audit row.

Offboarding is not globally atomic across all batches. Until `complete: true`,
audit rows beyond the current keyset cursors can still contain raw query text and
remain visible to authorized audit and knowledge-gap readers. The principal and
owned scope are fenced immediately, but operators must treat an incomplete run
as active privacy work and resume it promptly. A query already copied into a
preserved shared org knowledge-gap memory is shared provenance, not an owned
scope row; offboarding does not rewrite that shared record.

When the departing principal acted as an administrator, API-key,
principal-admin, Entra-binding, membership-sync, and audit-retention metadata is
retained only through an explicit per-operation or per-source field allowlist;
`query`, names, arbitrary numbers/booleans, and merely UUID-looking values are
removed. This includes binding provision/update/reactivation/revocation history
and audit-retention counts, hashes, and run IDs. Each changed
ownership acknowledgement is written to the immutable
`principal_user_scope_approvals` ledger with approver UUID, timestamp, reviewed
UUIDs, and evidence hash. UUID-only mapping and erasure receipt audit operations
are excluded from redaction. The exact cumulative processed-count and bounded-ID
receipt is also written to
`principal_offboarding_events`. Both evidence ledgers reject update, delete,
and truncate operations. The compact privacy-safe event ledger is outside
ordinary `audit_log` retention and is the authoritative retry evidence after
audit rows have been pruned. It contains UUIDs, counts, timestamps, and
truncation flags only, never memory text, names, queries, or verification notes.
Before the first irreversible batch write, a `started` row containing the run
UUID, initiator UUID, exact approval ID, and acknowledgement hash is appended to
`principal_offboarding_run_events`. Finalization appends a `completed` row that
preserves the initiator, identifies the finalizer, and records exact cumulative
processed counts. The ledger rejects update,
delete, and truncate; mutable cursor progress is never the sole authorization
record.

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
Only the audited `reactivate-principal` operator action can enable the identity,
and it is refused while a durable offboarding run is incomplete.
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

Migration `0022_offboarding_principal_lifecycle.sql` contains only the short
`principals` alteration and uses five-second lock and 30-second statement
timeouts. Migration `0023_offboarding_erasure.sql` installs the ledgers and
database guards after that lock is released. Migration
`0024_offboarding_embedding_cleanup.sql` installs the bounded maintenance
function `continuum_cleanup_archived_embeddings(batch_size)`; it does not claim
that historical cleanup completed. Call it in separate committed transactions
with a batch size from 1 through 5,000 until it returns zero. Migration
`0025_offboarding_audit_indexes.sql` is marked no-transaction and creates the
selector-plus-ID cursor indexes and metadata indexes concurrently. Migration
`0026_offboarding_round6_hardening.sql` installs append-only run evidence and
the first database reactivation guard. Migration
`0027_offboarding_bounded_completion.sql` adds the durable audit fence, exact
processed-count accumulators, and a SECURITY DEFINER reactivation capability
that cannot be spoofed with a caller-set custom GUC. Migration
`0028_offboarding_reactivation_authorization.sql` requires an effective org
administrator and appends the reactivation audit inside that same database
transaction. Direct ordinary application SQL can neither clear the lifecycle
columns nor invoke the capability for a non-admin actor. Database-owner access
remains a trusted administrative boundary. Before each concurrent
create, the migrator resolves the named index in `current_schema()`, drops that
exact schema-qualified object concurrently only when `pg_index.indisvalid` is
false, and then creates it. A post-create directive requires the exact index to
exist and be valid before the migration ledger can record success. A timeout or
failed build leaves the file unapplied and safely retryable.

Apply all seven offboarding migrations before starting the new application version. Old
instances can continue ordinary traffic after `0023`, but they do not know the
offboarding workflow and an old authenticated request may already be in flight.
Do not invoke offboarding until all seven migrations are recorded on every shared
database and all old application instances have drained. Rollback is
application-first: stop invoking offboarding, drain the new instances, and
deploy the old application only after `list-incomplete-offboarding` reports
zero incomplete runs. An old application must never resume against an
unfinished erasure. Do not drop the new columns, tables, functions, or
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
