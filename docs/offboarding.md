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

These mutation routes are operator-only database operations. The API process
serving them must use a dedicated DB-bound operator session; the shared
application role receives `403 FORBIDDEN` from `owned-user-scope` and all
irreversible offboarding calls. A normal public API deployment should not mount
these routes on its shared application pool. Dry-run remains readable through
the ordinary authenticated service, but mapping, execution, restart,
reactivation, redaction, takeover, and audit retention use the operator role.

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
and `scope_ids`. This lets the operator detect a mistaken
mapping without exposing names or memory content. Audit preview limits apply to
rows examined before redaction-policy filtering. If a branch reaches that
limit, `auditRows` and `auditQueries` are explicitly truncated/unknown even
when the returned dirty-row count is zero.

Execution immediately disables and pseudonymizes the principal and scope,
deactivates owned-scope access, quarantines its Entra bindings, and deletes
aliases in the first transaction. Those database fences remain closed while
memories and audit rows are processed in retry-safe batches. `batchSize`
defaults to 1,000 and accepts 1 through 5,000 through REST or CLI
`--batch-size`; each response reports cumulative processed counts, bounded
remaining-work indicators, batch number, and `complete`. Durable UUID and audit
ID keyset cursors ensure every resumed batch scans bounded windows. Memory and
`scope_ids` relationships are normalized at audit insertion into an indexed
`(selector_kind, scope_id, audit_id)` relation, then traversed by audit ID.
Request IDs remain correlation metadata and never expand an erasure target set. After the
principal and owned-scope write fence is closed, the run records one immutable
audit high-water ID. Every selector exhausts only its window through that fence.
Durable memory, one-time scope cleanup, and audit cursor exhaustion, rather
than repeated dirty-history scans or full recounts, decide completion.
Principals with more than 10,000 memories
or 50,000 audit rows use the same path and are not rejected. Reissue the exact
confirmed REST operation until `complete: true`. The admin CLI does this loop by
default; `--once` performs one batch for external orchestration, and
`list-incomplete-offboarding` lists durable unfinished runs. Every membership on the owned scope
is deactivated, including delegate and ingest identities. Database triggers
reject later active memberships or bindings while its owner remains offboarded.
Safe retries return `alreadyOffboarded: true` only when an immutable `completed`
run event exists for the current run UUID, the principal and scope pseudonyms
remain in place, and the database write fences remain closed. Memory, embedding,
access, alias, binding, and historical audit cleanliness are trusted from the
guarded immutable completion receipt and durable phase cursors; completed
retries do not rescan clean pre-fence history. A legacy state without a run
receipt is never accepted from a truncated preview. Rows above the fence are rejected
at the principal/owned-scope audit boundary. Dry-run and retry output includes
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
UUID columns and exact `metadata.scope_ids` membership. Free-form,
request-ID, or recursive scope-name matching is not used. This also reaches
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
are excluded from redaction. The cumulative processed-count and bounded-ID
operational receipt is also written to `principal_offboarding_events`. Those
counts are application-reported telemetry, not independently measured database
facts. The actor UUID is accepted only when it matches the DB-bound operator
session and remains an effective manual org administrator. Both evidence ledgers reject update,
delete, and truncate operations. The compact privacy-safe event ledger is outside
ordinary `audit_log` retention and is the authoritative retry evidence after
audit rows have been pruned. It contains UUIDs, counts, timestamps, and
truncation flags only, never memory text, names, queries, or verification notes.
Before the first irreversible batch write, a `started` row containing the run
UUID, initiator UUID, exact approval ID, and acknowledgement hash is appended to
`principal_offboarding_run_events`. Finalization appends a `completed` row that
preserves the initiator and records
`completion_basis: database_verified_erasure`. The function constructs this
evidence itself and labels cumulative counters under
`telemetry.trust: application_reported`; caller JSON cannot become immutable
completion evidence. The ledger rejects update,
delete, and truncate; mutable cursor progress is never the sole authorization
record. Any current effective org administrator may resume an incomplete run;
the first cross-admin takeover by a current effective org administrator and the
eventual finalizer are appended to the
immutable run/takeover ledgers while preserving the original initiator. Direct
deletion of run progress is rejected, `completed_at` cannot be
set without the matching append-only completion row, and fences/cursors cannot
move backwards within a run. Reactivation reads the immutable completed event,
not mutable `completed_at`, and appends a `reactivated` event with the presented
administrator UUID before committing. This evidence survives ordinary
`audit_log` retention.

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
the canonical tombstone. Embedding writes take a key-share lock and recheck the
parent memory, so they cannot commit for archived content and cannot race
cleanup. Expired but still-live rows in an offboarding-fenced owned scope are
skipped by lifecycle preview and sweep until offboarding tombstones them, so
they cannot stall unrelated scopes.
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
transaction. Migration
`0029_offboarding_reactivation_trust_boundary.sql` revokes the capability's
default `PUBLIC` execute grant and separates its mandatory database guard audit
from authenticated application actor attribution. The database row uses the
noninteractive lifecycle principal and records the presented effective-admin
UUID as `authorization_principal_id`. It does not claim that UUID is the SQL
caller. The application writes the authenticated actor's
`principal_reactivated` audit in the same transaction, so failure of either
audit rolls back the lifecycle update.
Migration `0030_offboarding_round7_integrity.sql` closes two-step marker
clearing, protects mutable run progress, adds compound memory/request cursors,
records immutable reactivation evidence, and resolves memory-only audit rows to
their owned scope. Migration `0031_offboarding_round7_indexes.sql` builds the
subject-memory cursor index concurrently and requires it to be valid before the
migration is recorded. Read-audit producers also discard caller-supplied
`operation`, `source`, `request_id`, and `record_kind` policy keys.

Migration `0033_offboarding_bounded_selectors.sql` installs the normalized
ordered selector relation and insert trigger, durable memory/scope phases,
batched linked traversal support, immutable owner mapping identity, a guarded
completion capability, hardened `SECURITY DEFINER` search paths with `pg_temp`
last, and the reduced embedding lock. It does not copy audit history in that
schema/trigger transaction. Instead it records an immutable high-water fence
and installs `continuum_backfill_audit_offboarding_scopes(batch_size)`; the
migrator advances that history in ordered batches of 1,000, each in its own
transaction. The insert trigger synchronously captures rows above the fence.
Offboarding refuses to begin, and database completion refuses to append its
receipt, until the completion watermark is true. Existing incomplete
round-seven runs have their normalized memory, `scope_ids`, and linked cursors
rewound because those review-era cursors cannot prove coverage of the new
relation. Completed immutable receipts are preserved.
Migration `0034_offboarding_completion_invariants.sql` is an upgrade-safe
replacement of the completion function and phase trigger: it verifies every
durable phase and exact cumulative receipt field inside the database before a
`completed` event can be appended. Migration
`0035_offboarding_selector_cursor_indexes.sql` builds both selective cursor
indexes concurrently, verifies that each is valid, and drives the resumable
selector backfill before recording itself. Migrations `0036` and `0037` safely
translate an installation that had already applied the rejected round-seven
0033/0035 pair: the old blocking copy is recognized as caught up, incomplete
run cursors are rewound, and the same bounded finisher is invoked.
Migration `0038_offboarding_search_path_hardening.sql` pins `pg_catalog`, the
owning application schema, and finally `pg_temp` for every Continuum
security-definer and trigger function. This prevents an application session
from substituting temporary relations during completion, reactivation,
offboarded-audit, embedding, membership, or other database guard checks.
Migration `0039_offboarding_completion_state.sql` is the upgrade-safe boundary
for the least-privilege run capabilities and completion-state validation. It is
separate because deployed databases may already have recorded `0038`; changing
that file would not replay it. Migration
`0040_offboarding_post_completion_integrity.sql` is the corresponding
upgrade-safe follow-up for installations that already recorded `0039`: it
protects the verified principal, owned-scope, and audit tombstones against
post-completion mutation and reapplies owner-scoped function hardening. It does
not rewrite application tables or backfill rows, but it does replace guard
functions and take the associated short catalog/function-definition locks.
Its five-second `lock_timeout` and 30-second `statement_timeout` make lock
contention a visible, retryable migration failure instead of an unbounded
deployment stall; rerun the unapplied migration after the conflicting
transaction drains.
Migration `0041_offboarding_completion_trust.sql` prevents any progress rewrite
after completion and refuses to restart a completed run while its indexed
erasure state remains true. A completed run can be replaced only when later
state is demonstrably dirty and repair is required. It also replaces completion
evidence with the database-constructed trust labels above and reapplies the
canonical quoted-schema `search_path` check for both fresh and upgraded custom
schema names.
Migration `0042_offboarding_final_remediation.sql` is the primary trust-boundary upgrade.
It lets any current effective organization administrator resume an incomplete
run, records the first cross-admin takeover and the finalizer immutably, and
keeps fresh-run/restart authorization separate from resume authority. It also
removes direct application-role audit mutation and completion-ledger insertion,
routes those operations through cutoff/fence-checked functions, protects manual
organization-admin membership changes, and fails closed on an unsafe
foreign-owned Continuum `SECURITY DEFINER` function.
Migration `0043_audit_retention_selection_order.sql` preserves the retention
selection's `(at,id)` endpoints while
comparing exported rows in ID order, including histories where timestamp order
and insertion order differ.
Migration `0044_offboarding_restart_evidence.sql` preserves honest
application-reported counter labels. Migration
`0045_offboarding_trust_boundary.sql` enforces owner-controlled audit retention,
trusted approval and Entra administrator paths, server-generated correlation,
upgrade-safe function ACLs, per-takeover evidence, and one bounded restart proof.
Migration `0046_offboarding_authority_remediation.sql` binds approvals and sync
to separately provisioned database roles, restores manual-admin DML protection,
removes legacy request-ID authority, aligns retention cutoff evidence, and
restores early immutable-start validation.
Migration `0047_offboarding_role_boundary.sql` removes caller-UUID authority
from the shared role, makes Entra membership principal/source identity
immutable, protects revocation, quarantine, and freshness writes, and adds
guarded binding reapproval and sync-identity rotation. The legacy
`principal_offboarding_audit_requests` rows are deliberately not deleted by a
catalog migration. After taking a database backup, an operator may call
`continuum_cleanup_legacy_offboarding_audit_requests(batch_size)` repeatedly
with a bounded batch size from 1 through 5,000 until it returns zero.
Migration `0048_offboarding_independent_review.sql` removes table-level Entra
and membership updates from the sync role, replaces them with field-limited
security-definer operations, makes provider group IDs immutable, binds mutable
run locking to the operator role, and makes database-role rotation revoke the
old sync binding and grants in the same transaction. During upgrade it fails on
mixed approve+sync rows or multiple legacy sync authorities. For one
unambiguous sync-only row it revokes every privilege on the application schema,
its tables, sequences, and functions, then deletes only that sync-only row;
legacy approve-only rows have no OID provenance and must be removed under
change control before migration, then explicitly re-registered afterward. This
prevents a dropped and recreated same-name operator role from inheriting stale
authority. Newly registered identities are bound to immutable PostgreSQL role
OIDs, so dropping and recreating a role with the same name does not recover
authority. The migration also forbids mixed capability rows. Operator binding
revocation is a DB-bound security-definer
operation: raw operator `UPDATE` on `entra_groups` is revoked, and revocation,
quarantine, and deactivation triggers accept only transaction-local guarded
mutation markers.

Apply all 52 migrations through `0052_offboarding_review_repair.sql`.
Migration `0049_offboarding_review_remediation.sql` makes principal disablement
create bounded transaction-local guards for its existing membership cascade,
binds owned-scope access cleanup to a started incomplete run and its mapped
user scope, takes the membership-sync lock, and writes an operation audit. It
routes both sync registration and rotation through the same isolated-role
validation and least-privilege installer, enforces one sync binding, makes the
retired role `NOLOGIN`, and revokes ambient `PUBLIC` schema usage. Approval
registration also rejects privileged roles, ownership, raw Entra authority,
and non-owner membership edges. The database owner may retain a test or
maintenance `SET ROLE` edge because that role already owns the trusted
security-definer boundary. All other membership edges fail closed.
Migration `0050` repairs the startup identity verifier for installations that
already recorded `0049`; fresh installations receive the corrected verifier
from `0049` and then record the same forward repair.
Migration `0051` is the forward-only security contract for fresh databases and
databases that already ledgered an older 0048/0049 variant. It reasserts the
OID-bound identity, rotation, retirement, scope-cleanup, disable-cascade,
one-sync-index, trigger, `search_path`, and privilege contracts. It also adds
guarded, audited Entra-membership deletion and makes membership-sync verify its
exact table, sequence, function, schema, and default-ACL allow-list before any
Graph request. Extra `UPDATE`, `DELETE`, `TRIGGER`, ownership, membership,
function execution, or `PUBLIC`/default privilege fails startup closed.
Migration `0052` is the forward repair for databases that may already have
recorded an edited `0051`. It binds the canonical organization scope to an
owner-controlled UUID and fails closed if that marker is absent or ambiguous.
The only empty-database bootstrap accepted is the single canonical `org/''`
row, which immediately rebinds the marker. It restores all principal,
Entra-group, and membership
triggers, normalizes both transient capability-table shapes, and checks column
ACLs as well as table ACLs. Sync startup rejects owner and superuser sessions
and rechecks operator and sync membership edges at each privileged call. The
application grant script revokes both marker tables and validates its exact
direct allow-list—including schema and ambient `PUBLIC` privileges—before
returning success. The application role has no scope
row update authority; the operator-only pseudonymization function owns the one
supported user-scope name mutation, while `id`, `kind`, and the canonical
organization identity remain immutable.

The final database verification is exact and executes once: the completion
event trigger checks every memory and every audit row linked to the run's
bounded fence before appending completion. On very large per-subject histories,
set the supported `verificationTimeoutMs` API option or
`--verification-timeout-ms <1-300000>` admin-CLI option from measured query plans
and database load. The default is 30 seconds. A timeout rolls back the current
batch and commits no completion receipt; retain the run and retry. Do not weaken
or skip verification, and do not claim completion from progress counters alone.

Directly setting `principals.offboarded_at` is an internal write fence, not a
supported offboarding operation or evidence that erasure completed. It may be
used by migration-owner diagnostics and tests, but application workflows must
create and finish the durable run through the service. Reactivation and all
completion claims continue to require the immutable run events; a bare marker
has neither effect.

The post-completion scope and audit guards use `NOWAIT` when they key-share-lock
the owning principal. This avoids the opposite lock-order deadlock between a
dirty write and offboarding/reactivation. A concurrent conflict therefore
fails immediately with PostgreSQL `55P03` (`lock_not_available`). The caller
must roll back and retry the entire transaction after the lifecycle operation
commits; do not retry only the rejected statement inside an aborted
transaction.

Production must use separate migration-owner, shared application, dedicated
operator, and dedicated sync login roles. The operator and sync roles must not
be granted to the shared application role. Rollout is an explicit maintenance
window: **stop** every API, MCP, admin, retention, and membership-sync process;
take and verify a **backup**; **migrate** through
`0052_offboarding_review_repair.sql` as the owner; **regrant** the shared app,
operator, and sync profiles; **verify** the identities; then **start** only the
`0052`-aware binaries. Mixed pre-`0052`/`0052` binaries or grants are
unsupported. Do not run migration
and old binaries concurrently, because old sync code writes freshness directly
and old application code expects shared-role offboarding authority.
The supported and CI-tested database major is PostgreSQL 16 with pgvector.
Qualify another major independently before migration; successful SQL parsing
alone is not a supported rollout.

Migration `0051` performs its privilege preflight before changing any object.
The connecting migration role must directly own every application object and
must own, or inherit the effective owner role for, the application schema.
PostgreSQL 16 database owners satisfy the latter for the default `public`
schema through `pg_database_owner`. If a sync identity is registered, the
role must either be superuser or have `CREATEROLE` plus `ADMIN OPTION` on that
exact OID-bound sync role, because retirement uses `ALTER ROLE ... NOLOGIN`.
Effective schema ownership is required for the `PUBLIC` schema/default-
privilege revocations. Failed preflight leaves no partial 0051 changes. The
supported least-privilege path is a non-superuser schema/object owner with
`CREATEROLE` and narrowly scoped `ADMIN OPTION` on managed sync roles, not
blanket superuser access. On PostgreSQL 16, grant that administration edge as
`GRANT sync_role TO migration_owner WITH ADMIN OPTION, SET FALSE, INHERIT FALSE`;
the owner must be able to retire the role but must not inherit or `SET ROLE`
into the runtime identity.
Migration `0052` additionally proves retirement authority during its preflight,
when a sync identity is installed or rotated, and whenever the identity
verification script runs. A non-superuser migration definer therefore needs
`CREATEROLE` and `ADMIN OPTION` on both the current and candidate sync roles.
Revoking that edge later makes verification fail before an emergency rotation
is needed.

Pgvector extension members are governed separately from Continuum-owned
functions. Managed PostgreSQL may own those routines with a provider role, so
the ownership preflight and `PUBLIC` drift check exclude only objects recorded
as members of the `vector` extension. If such routines remain executable by
`PUBLIC`, application roles inherit that extension-owned contract. If the
provider revokes `PUBLIC`, the extension owner must pregrant `EXECUTE` to each
application role. Re-run `grant-application-role.sql` after every vector
extension update so newly added routines are checked. If the target is the
dedicated operator role, immediately re-run `grant-operator-role.sql` as well;
the application profile intentionally strips operator-only capabilities before
the operator profile restores them. Continuum-owned
functions remain closed to `PUBLIC` without exception.
Continuum also removes the creating role's global default `PUBLIC EXECUTE` for
future functions; PostgreSQL's built-in function default cannot be removed by
an `IN SCHEMA` default-privilege command.
The application role must not own the event ledger, completion-capability
table, or security-definer functions, and receives no direct privilege on the
capability table. Direct `completed` inserts then fail at the trigger.
Apply the repository's exact post-migration grants (the role must
already exist and must not own the schema or functions):

Before applying 0048 or upgrading an installation that already recorded 0048,
export the approve-only rows with their expected human
principal and live PostgreSQL role OID. Because the legacy registry stored only
names, remove those rows under reviewed migration-owner change control. Do not
guess provenance from the currently resolved name. Migrations 0048 and 0049
both refuse to continue while an unproven legacy approval row remains. Reapply each reviewed
operator binding with `grant-operator-role.sql` after 0049.

Fresh 0048 execution changes its removed legacy sync role to `NOLOGIN`. If an
installation already recorded the earlier 0048 revision, run the checked
`scripts/retire-sync-role.sql` as the migration owner for that exact old role
before starting 0051-aware processes. The script refuses an active trusted
identity, membership edges, and application-object ownership before revoking
the role's application authority and login.

```sh
psql "$CONTINUUM_MIGRATION_OWNER_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=continuum_schema=public \
  --set=continuum_app_role=continuum_app \
  --file=scripts/grant-application-role.sql

psql "$CONTINUUM_MIGRATION_OWNER_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=continuum_schema=public \
  --set=continuum_app_role=continuum_operator \
  --file=scripts/grant-application-role.sql

psql "$CONTINUUM_MIGRATION_OWNER_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=continuum_schema=public \
  --set=continuum_operator_role=continuum_operator \
  --set=continuum_principal_id='<manual-admin-uuid>' \
  --file=scripts/grant-operator-role.sql

psql "$CONTINUUM_MIGRATION_OWNER_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=continuum_schema=public \
  --set=continuum_sync_role=continuum_sync \
  --set=continuum_principal_id='<dedicated-service-principal-uuid>' \
  --file=scripts/grant-sync-role.sql
```

The sync identity is a dedicated service principal with `kind = 'service'` and
an enabled lifecycle state, never a
named human administrator. To rotate credentials or the bound service identity,
create a fresh empty non-owner role and have the currently bound operator rotate
to it atomically:

```sql
SELECT continuum_rotate_sync_database_identity(
  '<operator-admin-uuid>', 'continuum_sync_next', '<new-service-principal-uuid>'
);
```

Both the provisioning script and rotation function require a fresh role with no
membership or `SET ROLE` edge in either direction, apart from an existing
database-owner edge. They reject superuser, `CREATEDB`, `CREATEROLE`,
`REPLICATION`, `BYPASSRLS`,
schema-`CREATE`, application-object ownership, an existing operator/sync
binding, application DML, and operator execution authority. They install the
least-privilege sync profile, binds the new service principal by role OID, and
revokes **all** application-schema table, sequence, function, and schema
authority plus the old sync-only registry row in one transaction. The retired
role is also changed to `NOLOGIN`. The sync role
can read only `scopes`, `principals`, `entra_groups`, `scope_memberships`, and
`entra_sync_state`; it cannot read `memories`, including titles or bodies.
Rotation fails rather than claiming cleanup if the retired role inherits from
another role or owns an application-schema object; remove that authority in a
separately reviewed maintenance change and retry. Run one sync and verify
`entra_sync_state.last_success_at` before dropping the old service principal
and retired database role. Human offboarding or demotion therefore cannot
silently stop sync.

One operator database role is bound to one manual organization-administrator
principal. A takeover changes application membership, but does not silently
rebind that database role. Before disabling or demoting the bound principal,
use the migration owner (or another already bound operator role) in a reviewed
maintenance transaction to call
`continuum_register_trusted_database_identity(operator_role, new_admin_uuid,
TRUE, FALSE)`, then reconnect as the operator role and verify its approval
capability. Do not reuse sync rotation for operator rebinding and do not share a
single operator login among multiple human principals.

The shared-role script enumerates ordinary capture, embedding, identity,
service-key, webhook, lifecycle, and read-only retention/offboarding previews.
Approval, irreversible retention/offboarding, binding provisioning,
manual-admin changes, and Entra activation are excluded.
Run `grant-application-role.sql` for the dedicated operator role before adding
its DB-bound approval grants, including when regranting an existing operator
during upgrade. The application script is transactional: an exact allow-list
failure rolls back every revoke instead of leaving the operator partially
stripped. The dedicated sync role receives only the reads,
writes, and activation function needed by authoritative sync. The scripts revoke
the identity registry and registration function from every non-owner role. The
application script also explicitly revokes both
backend-local capability tables and the selector-backfill function from the
application role. Do not
replace it with ownership, schema `CREATE`, broad `ALL TABLES`, or `PUBLIC`
function execution. The application role has no direct `UPDATE` or `DELETE` on
`audit_log`, no insert privilege on `principal_offboarding_events`, and no path
to create or alter a manual organization administrator. The guarded functions
derive completion/event fields from the locked run and re-check that the
presented actor is a current effective administrator. The migration/function
owner remains a trusted database-administration boundary.

Before each concurrent create, the migrator resolves the named index in
`current_schema()`, drops that exact schema-qualified object concurrently only
when `pg_index.indisvalid` is false, and then creates it. A post-create directive
requires the exact index to exist and be valid before the migration ledger can
record success. A timeout or failed build leaves the file unapplied and safely
retryable.

Rollback is forward-only and requires the verified pre-migration backup for any
data that bounded legacy cleanup has removed. Application rollback is supported
only to a 0052-aware binary and its matching grant profile. Stop all processes
and confirm there are zero incomplete runs with `list-incomplete-offboarding`;
then deploy the selected `0052`-aware binary, reapply all three grant profiles,
run identity verification, and restart. Pre-`0052` binaries are incompatible with the new
approval and sync boundary and are not a supported application-first rollback.
Database rollback requires a separate forward migration; do not drop guards or
regrant the shared role ad hoc. Completed offboarding erasure is irreversible
and is never undone by binary or schema rollback.

Before restart, run the checked verification script using the actual role and
schema names:

```sh
psql "$CONTINUUM_MIGRATION_OWNER_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=continuum_schema=public \
  --set=continuum_app_role=continuum_app \
  --set=continuum_sync_role=continuum_sync_next \
  --set=continuum_operator_role=continuum_operator \
  --set=retired_sync_role=continuum_sync_old \
  --file=scripts/verify-database-identities.sql
```

The script fails unless `PUBLIC` and the migration owner's application-schema
default ACLs are closed, exactly one OID-bound sync row exists, every registry
OID still resolves to its recorded name, the sync role matches the exact 0052
allow-list, the shared application role matches its exact allow-list, the
expected operator is approval-only, and a supplied retired role both exists and
is `NOLOGIN` without schema, principal-table, or audit-sequence authority. Omit
`--set=retired_sync_role=...` only on an initial install with no retired role;
after rotation, supply the exact recorded old role name. Parameter ACLs or
per-role settings on application, operator, or sync identities make validation
fail because they can change trigger behavior. The
membership-sync executable repeats the sync-role allow-list gate at every
startup before Graph I/O; this script remains the cross-role maintenance gate.

Because 0048 and 0049 deliberately delete legacy registry rows, revoke grants,
and disable the retired login, restoring pre-0049 behavior requires the verified pre-migration
backup and matching old binaries. Regranting the retired credential by hand is
not a rollback.

This is an application-data boundary. Operators must separately apply their
documented retention policy to encrypted database backups, database/WAL logs,
external source systems, infrastructure logs, and provider telemetry. This
repository does not claim a deployed erasure workflow or deletion from those
systems. Preserved shared memories intentionally retain stable author UUIDs and
source metadata needed for shared provenance. For GitHub-derived shared
memories, that metadata can include a mutable GitHub login; this documented
shared-memory identity exception is not removed by personal-scope offboarding.
