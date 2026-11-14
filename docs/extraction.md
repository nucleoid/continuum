# Optional asynchronous extraction

Extraction is disabled by default. Stock REST, stdio and remote MCP install no
extractor or worker. The public library supports explicitly composed local
implementations without an SDK, hosted account or mandatory model vendor.
Registering an adapter alone grants no database authority. No real model is
qualified by the synthetic tests or this guide.

Accepted capture remains authoritative and unchanged. Generated assertions are
immutable `extracted-assertion` evidence versions with `generated/unverified`
status, exact source-version parents, source-family identity and byte-span
citations. They are separate from legacy memories, ordinary recall, review
queues and generated AGENTS.md. Model output is never a verification event or
truth probability. Unknowns, unsupported fields and temporal uncertainty remain
explicit. No fuzzy entity identifier becomes an enterprise identity.

## Installation and opt-in

Migrate through `0094_extraction.sql` as the migration owner, following 0093 and
0092. There is no dependency on ordinal 0091 or a generic queue. Regrant exact
APP and OP profiles. SYNC/reporting acquire no extraction capabilities. Startup
checks the owner-recorded extraction function bodies and required triggers as
well as the existing evidence and accounting contracts. Missing readiness fails
closed even when extraction is disabled. Connectivity health is separate.

Trusted composition creates an `ExtractionRegistry`, registers an explicit
`ExtractionProfile` and computes `extractionDescriptor(profile)`. The profile
records an exact model/profile/version, schema, prompt, locality, complete
serialization, response cap, qualified token accounting, versioned price
schedule and finite `BudgetProfile`. Its overall lifetime is at most 20 seconds,
provider timeout at most 15 seconds, chunk size 4..65536 UTF-8 bytes and chunk
count 1..64. The operator reviews the exact descriptor and uses the actual bound
OP LOGIN to install it:

```sql
SELECT continuum_operator_install_extractor(
  :'admin_uuid'::uuid, :'reviewed_descriptor'::jsonb, TRUE);
```

The descriptor is configuration, never credentials. Keep provider credentials in
the implementation's private configuration. A real provider needs independently
reviewed accounting and enforceable completion/response limits for that exact
version/profile. A validation identifier alone is not qualification. The
starter budget has zero priced spend; it cannot activate a paid provider.
Installing or replacing a descriptor advances its generation and fences older
work. There is no automatic provider switch or hosted fallback.

Use a separate existing non-owner isolated LOGIN for processing. As migration
owner, run the checked script with the actual tenant schema and worker role:

```text
psql <owner-url> -X -v ON_ERROR_STOP=1 -v continuum_schema=public \
  -v continuum_extraction_worker_role=continuum_extraction_worker \
  -f scripts/grant-extraction-worker-role.sql
```

It grants only seven typed worker/readiness functions and schema USAGE. It does
not install APP, OP, raw memory/evidence reads, general evidence registration,
raw accounting, configuration, or schema ownership. The operator separately
approves its current service principal, exact scope, installed profile and
locality through the actual bound OP session:

```sql
SELECT continuum_operator_bind_extraction_worker(
  :'admin_uuid'::uuid, :'worker_login'::name, :'service_uuid'::uuid,
  :'scope_uuid'::uuid, :'profile_id'::text, TRUE);
```

The service principal must retain current writer authority. The worker uses the
actual approved LOGIN, with its role name/OID and binding generation. A UUID,
`SET ROLE`, custom GUC, original capturer or caller metadata cannot impersonate
it. Role attributes, membership edges, parameter settings and excess tenant
privileges fail closed. The sole accepted creator edge is owner ADMIN with
SET and INHERIT disabled on PostgreSQL 16. Stop affected processes before
changing bindings. Revocation uses the same function with FALSE.

A current scope administrator then enables a reviewed source allowlist and
installed profile using `PUT /api/v0/scopes/:id/extraction`:

```json
{"profile":"reviewed-local-v1","sources":["manual"],"enabled":true}
```

Allowed IDs are `manual`, `github-pr`, `github-branch`, `ado-workitem`,
`deploy-event`, and `terminal-summary`, with no duplicates. This cannot expand a
credential's capture-source restrictions or a tag vocabulary. Scope opt-in and
operator installation/binding are separate authorities. Removing either or
changing its generation fences in-flight output. Source-root local-only and
current external restrictions also apply before every disclosure and commit.

## Capture, chunks and work

The shared memory-insert trigger enrolls the exact captured source and enqueues
its version/profile/configuration identity in the capture transaction. Manual
capture, authenticated webhook delivery reservation/replay, capture audits and
trusted Standup attribution retain their atomic boundaries. Failed required
audits leave no partial source/job/attribution set. Replay returns its existing
memory IDs and does not enqueue again. Capture responses report `queued`,
`skipped` or `not-configured`, never model completion. New webhook responses add
per-memory extraction status; replay uses its existing response contract.

Provider work runs outside transactions. `processExtraction` executes one typed
run; `ExtractionWorker` supplies optional explicit polling and bounded shutdown
for a custom runtime's `workers` list. Use its dedicated worker pool. Defaults
are one poll per second, one run per installed local registry profile, a
30-second lease and five-second shutdown wait. Poll intervals are 100..30000 ms,
shutdown waits 1..10000 ms and a registry contains at most 32 profiles. SQL uses
five-second statement and one-second lock bounds, preserving tighter settings.
Configure finite pool-acquisition and outer process deadlines separately.

Chunks address the exact UTF-8 canonical evidence JSON, including its title,
body, source/reference and metadata, excluding operational `related`. Offsets
are zero-based, start-inclusive/end-exclusive bytes. Nonoverlapping chunks
split only on Unicode scalar boundaries and cover every byte. Stable chunk
identity includes source version, bounds and SHA-256. All chunks belong to one
source family. Identical hashes in another scope grant no access and reveal no
deduplication information. A source exceeding hydration/chunk bounds remains
captured with an explicit skipped/budget receipt.

Adapters receive reference data in an explicit untrusted envelope, without user
credentials. Strict schema and exact UTF-8 quote/span checks reject unsupported
fields, fabricated citations and instruction fields. Invalid output skips its
chunk while healthy chunks can commit. Zero assertions is a successful explicit
empty chunk. SQL rechecks the original source version, complete root closure,
current worker authority, enabled profile/configuration, expiry, residency,
binding and lease immediately before applying each result. Assertions, typed
evidence edges, required audits and chunk completion commit together. Stale
results never rewrite captured truth. Coverage distinguishes complete, partial,
skipped, pending and unavailable work.

## Accounting, retries and containment

Run identity permanently retains its original workflow, budget owner and
generation. Attempt identities attach before hydration and each new dispatch;
original attempt/LOGIN/claim identities remain immutable. Every chunk/retry
shares the original durable calls, retries, spend, storage and deadline. A new
local `Budget` after restart does not replace durable allowance. The workflow
lifetime starts on first claim, not while a source waits in the queue. Its
20-second maximum leaves lease slack for final SQL; expiry still rejects late
publication.

Before hydration the durable ledger reserves source snapshot storage plus a
conservative serialized control-record allowance for descriptors, bounded
chunks, attempts and receipts. Generated payloads also charge a conservative
4 KiB per-assertion provenance allowance. These are operational retained-byte
bounds, not measured heap or normalized physical PostgreSQL allocation.

Only `ExtractionTransientError` from a trusted adapter classifies a transient
provider failure. A settled transient can queue another attempt, with a 100 ms
minimum durable delay, under the remaining original allowance. Polling is
bounded and provides no universal fairness guarantee. Permanent/invalid chunks
are separately visible. Expired interrupted claims park unavailable; they do
not dispatch a second ambiguous call. Retry never resets a budget or deadline.

Accounting commits before dispatch and actual settlement releases retained
resources. Timeouts, lease expiry and cancellation retain ambiguous maxima.
Late settlement uses only the original attempt's LOGIN and accounting identity;
it grants no publication permission. Durable settlement rejection becomes a
bounded unavailable result. Safe receipts contain enums, machine identities,
timestamps and accounting only, without raw model/source/error text or secrets.

Shutdown stops admission, aborts work, fences publication and waits within its
bound. An abort-ignoring call keeps the shared process fences and reservation
until actual settlement. An unsettled shutdown rejects; use verified process
exit rather than treating the timer as proof. After separately proving that
the original process exited, an actual bound operator can reconcile a known
persisted attempt conservatively:

```sql
SELECT continuum_operator_recover_extraction(
  :'admin_uuid'::uuid, :'run_uuid'::uuid, :'original_attempt_uuid'::uuid,
  'CONFIRMED ORIGINAL PROCESS EXIT');
```

This confirmation attests external operational evidence; SQL cannot prove
process exit. The operation refuses an active lease and audits the action. It
uses original identities, refunds no unknown token/spend/output maxima, and
does not renew the workflow or restore a cancelled run. A never-reserved attempt
gets an immutable abandonment receipt. Recovery may leave work unavailable
when its original deadline/allowance is spent. There is no automatic new budget.

## Status, reads and retry

`GET /api/v0/memories/:id/extraction` returns current authorized safe identity,
coverage, version/profile provenance and bounded outcome. `?assertions=true`
also reads immutable assertion payloads. Current source and every assertion
gate run before delivery or counts are exposed; stale/denied data is
unavailable. Reads are private/no-store and require audit delivery. They expose
no other-scope job metadata. Complete assertion read output is capped at 256 KiB;
oversized output refuses delivery rather than truncating assertions or citations.

`POST /api/v0/memories/:id/extraction/retry` accepts an empty object. It requires
current scope-admin authority, current policy/configuration, settled accounting,
a classified transient and remaining original allowance. Ordinary readers
cannot retry. Completed, privacy-cancelled, expired, permanent or ambiguous work
cannot gain fresh allowance through this endpoint.

MCP registers `continuum.extraction_status` with `memory_id` and optional
`include_assertions`; `continuum.extraction_retry` with `memory_id`; and
`continuum.extraction_configure` with `scope_id`, `profile`, `sources`, `enabled`.
Shared services enforce the same rules for stdio and remote MCP. Remote
execution cancellation also fences these transaction calls. No model invocation
runs in a status/configuration request or becomes session-owned background work.

## Erasure, upgrade and rollback

All source/assertion payloads remain in the managed evidence store. Work records
contain no copied bodies. Canonical offboarding physically deletes every
affected source/derivative payload and content hash, removes chunk hashes/spans,
and cancels runs/workflows using approved scope UUID lineage. Immutable receipts
retain only approved machine metadata and accounting identities. Locked chunk
rows remain residuals and prevent completion; a later bounded retry erases them.
Current physical predicates inspect actual tables, not counters or old receipts.
Stored-state erasure cannot retract admitted process/provider/downloaded bytes
or backups. Quiesce producers and workers, prove settlement/process exit and
apply separate downstream/backup retention policy for a strict cutoff.

Before rollout, drain writers, workers, readers and offboarding processes; back
up data and migration/accounting ledgers. The owner needs TEMPORARY for 0094's
exact-role snapshot. The migration creates empty tables/functions and triggers,
with five-second lock and 60-second per-statement DDL limits; these are not a
whole maintenance deadline or a volume qualification. Rehearse the actual
installation under a finite outer deadline, regrant APP/OP and separately
provision/bind workers, then require all startup gates. No historical scan,
backfill, reindex, reauthentication or session invalidation is implied.

Old artifact/offboarding binaries cannot serve or erase these records safely.
Disable admission and drain/fence workers before binary replacement, preserving
current invalidation and physical erasure guards. Binary rollback does not
reconstruct omitted work or undo erasure. Schema reversal requires a verified
backup and reviewed replay. Never edit published migrations, remove ledgers,
broaden roles or widen runtime search paths to recover availability. This guide
authorizes no live configuration, paid experiment or deployment.
