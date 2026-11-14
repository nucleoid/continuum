# Evidence lifecycle

Migration 0093 adds a lazy, internal evidence foundation. Stock REST, MCP and
CLI do not expose derivative creation, extraction, synthesis or a connector.
No provider or paid stage is enabled. Legacy recall and generated AGENTS.md
select source memories only; evidence payload tables are separate.

## Versions and authority

`evidence_versions` records immutable identity, exact typed parents, previous
version, scope, original expiry and transform/model/prompt/schema version IDs.
Canonical source JSON includes scope, title, body, type, tags, source/reference
and metadata, excluding only operational `related` metadata. Its SHA-256 and
payload live together in the erasable payload table. Operational timestamp and
advisory relation changes alone do not create a content version. Lifecycle,
expiry, substantive content and policy changes advance eligibility generations.
Source policy snapshots and derivative root snapshots retain provenance, never
a reusable allow. No startup source-history rewrite or automatic backfill runs.

Each version has at most 64 direct parents, 256 distinct authority roots
including itself, depth 16 and 1 MiB of payload. Duplicate parents, cycles,
unknown edge/artifact kinds and incomplete closures fail closed. Source
participation locks the source. Derivative registration locks source rows,
roots and current principal/membership authority in stable order, rechecks
current versions, intersects dependencies, writes the audit and publishes its
current pointer with compare-and-swap in one transaction. Repair creates a new
version and retains the explicit previous-version link.

Sources, assertions, observations, brief sections, history, cache, trace,
managed export and queued payload have separate typed identities. Trusted
composition must register a payload owner before service hydration/admission.
All managed bytes remain in `evidence_payloads`; registering an owner does not
authorize another cache, filesystem export or trace store. Connector evidence
and receipts are unsupported and deny. Contributed fields cannot select an
owner, model, policy, credential or operator identity.

The current gate runs before metadata disclosure and hydration, before provider
disclosure and again before delivery/apply. It checks closure completeness,
root generations, revoked/erased state, current enabled identity, effective
scope membership, Entra freshness and PostgreSQL clock expiry. Every inherited
scope is required. Database time is sampled after locks; transaction time alone
does not prove freshness. A history/copy is subject to the same current gate.
Unknown external authority denies. An external allow has independently trusted
database-domain checked/valid-until bounds. Local-only roots forbid hosted
disclosure. The bound OP policy capability changes these restrictions and
advances their generation atomically with its audit.

The service uses issue 26's pure policy inside its owned READ COMMITTED
transaction over locked, current database facts. It does not call the exclusive
autocommit adapter within that transaction. Low-level SQL capabilities are
trusted composition boundaries, not authenticated network endpoints.

Every registered source mutation, including approved older/direct writers,
advances its root and durable dirty generation in the mutation transaction.
The guard audit must succeed. Descendant writes are asynchronous and bounded;
the generation mismatch denies serving immediately. Positive verification
cannot extend the captured original ceiling or revive an old derivative.
Canonical promotion requires reciprocal links plus matching source content,
tags and reference. It preserves the original ceiling and transitive source
scope/policy restrictions. A source prefix or metadata marker alone cannot
establish lineage. Promotion ancestry is bounded by the same depth/root limits.
Its trusted transition attestation does not depend on later mutable child text.
A fresh parent source version is published at the advanced generation before
the destination adopts that exact parent closure. Stale generations are copied
exactly and denied, never relabelled as current. Missing external validity bounds
and non-finite policy/expiry timestamps are rejected in SQL.

## Durable work and cancellation

`materializeEvidence` performs an explicitly composed poll, default page 100,
maximum 1000, with an explicit 1..30000 ms admission deadline. Each owned SQL
transaction preserves stricter timeouts and otherwise uses five-second statement
and one-second lock limits. Configure finite pool acquisition and an outer
process deadline too. A started SQL operation can finish after the loop's
admission deadline. There is no stock worker timer or general job framework.

Each committed dirty root generation is independently claimable. Owner UUID,
claim generation and a maximum 30-second lease fence pages. UUID keyset cursors
advance only through resolved rows; a locked invalidation row rolls back the
page. No maximum allocated ID implies commit-order completion. A delayed commit
remains discoverable after later work completes. Completion of one poll means
that claimed generation completed, not that every installation root is clean.

Repair jobs retain original workflow, attempt, owner UUID and generation before
hydration/provider work. Explicit artifact composition supplies the adapter and
finite budget profile, at most 30 seconds. Inputs use currently eligible parent
replacements; no old quarantined prose is given to a generator. Publication
requires newly generated wording, the exact admitted surviving parent set,
current source authority, settled accounting, current job ownership and pointer
CAS. Removing a citation is not repair. Missing surviving evidence abstains.

Timeout/requeue never resets allowance, releases ambiguous reservations or
replaces original execution identities. Failed settlement is a bounded
unavailable result; conservative charges remain. Cancellation fences durable
accounting and job publication. Expired attempts with persisted identities park
unavailable instead of invoking another provider. There is no automatic orphan
reconciliation or retry allowance. Deliberate original-identity settlement
requires actual settlement or proved process exit under the budget runbook.

## Erasure and physical proof

Source deletion or the canonical tombstone revokes the source and records
erasure work atomically. Bounded traversal deletes source/derivative payloads
and their hashes, marks versions erased, revokes current roots and cancels jobs
and durable workflows. Provenance retains only approved machine version IDs,
policy snapshots, opaque UUIDs and accounting facts, never the erased text.

Approved personal-scope offboarding also scans every owned version and every
transitive managed copy, including shared-scope caches/history/exports and old
source scopes after a move. Scope UUID lineage selects work. Its durable erasure
cursor does not advance past a locked gap; dirty completed work reopens the
cursor. Each batch processes at most 1000 versions, clipped to the requested
offboarding batch. Protected canonical audit receipts record progress.

Completion checks actual payload rows, version state, cancelled jobs and
revoked affected current roots, composed with the existing canonical memory, all-provider vector,
audit, coordination, outbox and Standup predicates. Counters and old receipts
cannot prove completion. Locked residuals remain incomplete. A dirty restored
copy forces repair even after a previous completed receipt. Shared source
memories authored by a disabled principal remain shared; approved owned-scope
lineage, rather than author name, selects erasure.
Erasing old history does not revoke an independently regenerated current version
whose new wording and exact closure no longer use the erased source. Its old
history is erased and stale jobs remain fenced; the new authorized body survives.

An already admitted request may physically send after a later fence. Stored
erasure does not retract process memory, downloaded copies, downstream systems,
logs or retained backups. Strict cutoff requires quiescing producers/workers
and proving settlement or process exit, plus separate downstream/backup policy.

## Upgrade and rollback

Apply the packaged chain through 0093 as migration owner, with database
TEMPORARY privilege and finite outer maintenance deadline. 0093 requires 0092;
ordinals need not be contiguous. An unrelated optional migration is not implied
by this prerequisite. All published migration files remain unchanged.

Quiesce affected writers, readers, workers and offboarding processes. Back up
data and both migration ledgers. 0093 creates empty tables and functions with
five-second lock and 60-second per-statement DDL limits. It takes trigger/catalog
locks but does no historical source scan. These are not total maintenance-time
or volume guarantees. Rehearse the actual workload before a live upgrade.

Regrant exact APP, OP and SYNC profiles. APP receives only reviewed registration,
gating and bounded materialization capabilities. OP adds bound policy, repair
and approved erasure operations. SYNC gets no evidence payload or worker
authority. Raw tables, schema ownership and internal validators remain owner
only. Existing independent optional capabilities are preserved; their grants
still require their own migration/runbook. Invalid role snapshots require
explicit regrant, never broad grants or a wider search path.

Current stock startup requires the hardened evidence readiness helper and its
owner-recorded function-body contract. Missing schema, disabled source guard or
changed helper bodies fail closed without repair. No reauthentication, new
credential, embedding-provider access, reindex or automatic backfill is needed.
Old offboarding/artifact binaries are incompatible with enabled evidence data.
Disable admission, fence/drain work and use reviewed forward recovery. Binary
rollback cannot reconstruct erased payloads. Schema reversal needs a verified
backup with deliberate replay; never delete migration/accounting ledgers.
