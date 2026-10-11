# Embedding resilience and backfill

## Implemented runtime behavior

Continuum sends every provider bounded arrays (`/api/embed` for Ollama 0.3.4+
and the
native embeddings endpoint for hosted providers). Routed-provider `batch_size`
is the maximum number of texts in each HTTP request, not the backfill scan size;
the CLI `--batch-size` controls how many selected memories are handed to a
provider at a time. Every HTTP chunk has its own deadline. The response must
contain exactly one finite vector
of the configured dimension for every input. Request text and vectors are not
included in errors, logs, diagnostics, or audit metadata.

Recall computes full-text candidates first. Embedding, vector validation, or
vector SQL failures disable only the affected provider group. REST includes a
`diagnostics` object. MCP preserves its existing result array and publishes the
same object in result `_meta.diagnostics`. Audit summaries record
`vector_status` and bounded group codes. Operational logs emit
`embedding_recall_fallback` counts without queries, memory text, vectors, or
raw exception messages.

The shared recall deadline follows the longest routed provider timeout and is
hard-capped at 30 seconds. Provider-local timeouts still apply. Vector SQL is an
exact provider-and-dimension-qualified scan under the same deadline; deployments
that outgrow it require provider-specific partitioning or indexes. ANN redesign
is outside this feature.
The remaining shared budget is recomputed before each vector catalog and
distance query. Borrowed clients keep their caller transaction, settings, and
locks; their recall SQL is serialized across calls and bounded cleanup finishes
before full-text fallback hydration. Provider IO remains independent of that
SQL queue.

## Operator backfill procedure

1. Apply migrations and configure the same scope routing used by the API.
2. Run `npm run embed-backfill -- --count`.
3. Preview a bounded pass with `--dry-run --max-rows 100` and an optional
   `--scope project:name`.
4. Run bounded batches. Start conservatively for local GPU or CPU capacity.
5. Inspect the JSON counts and sanitized `embedding_backfill` audit failures.

The scanner first pages only IDs, scope metadata, and text byte counts. It then
loads title/body for one count- and byte-bounded provider batch. `--count`
never loads title/body, so memory does not grow with the aggregate candidate
body set. A single title/body pair larger than the 4 MiB hydration budget is
recorded as a durable `EMBEDDING_INPUT_TOO_LARGE` failure without loading or
sending the text. Cursor progress remains in stable UUID order.
The 4 MiB aggregate limit uses current database sizes at hydration, including
rows that grew after the ID scan. Deferred rows are rebatched without replaying
successfully stored prefixes. Manual `--mark-failed` reads only ID and routing
metadata, never title or body.

Useful controls are `--provider`, `--batch-size`, `--max-rows`, `--scope`, and
`--max-errors`. Deterministic input rejections are bisected to a single memory,
recorded in durable backfill state, audited once, and never retried even after
audit retention removes the audit event. To retry known failures after fixing
the underlying data or provider, use `--retry-failures` with an explicit
`--provider`; an optional `--scope` limits which durable failure rows are
cleared. Retry clearing is unavailable in count or dry-run modes. The last
completed or audited memory is checkpointed before an exhausted error budget
stops the command. Authentication,
rate-limit, network, and timeout failures stop that provider immediately. Ambiguous
5xx, invalid-response, non-JSON limit, and unrecognized request failures receive a
bounded diagnostic bisection. An isolated ambiguous row is recorded as a retryable
`suspect`, not durable poison; it is retried on the next run and removed after a
successful write. If every diagnostic leaf fails, the result remains a provider
outage and no row is suppressed. Diagnostic probing is capped at 64 sub-batch
requests per failed batch and stops after more than eight ambiguous probe
failures, limiting additional pressure during a provider brownout. A one-item provider batch cannot distinguish an
isolated input from an outage, so an ambiguous provider failure stops that
provider immediately without advancing its cursor or recording a suspect.

The JSON report includes `providerReports`, preserving each provider's counters,
cursor, completion state, sanitized `errorCode`, `unresolvedCount`,
`unresolvedTruncated`, and `unresolvedIds`. Each `unresolvedIds` list is a sample
capped at 25 entries; `unresolvedCount` retains the full count and
`unresolvedTruncated` reports whether the sample was shortened. The top-level
fields aggregate retryable suspects across providers. Provider-local
database and advisory-lock failures do not prevent later routed providers from
running. Any incomplete provider or provider error makes the CLI exit nonzero
after printing the report.
Each provider's database work uses a five-second statement limit and one-second
lock limit, retaining stricter existing session limits. Prior settings are
restored before the backfill-owned connection is released; a failed restoration
discards that owned connection. These are per-statement limits, not a total
backfill run duration. Keep a finite outer process deadline for operational runs.

`--cursor UUID` requires `--provider`. Saved and explicit cursors wrap once at
the end of the UUID range, and completion is reported only after the lower
range has also been scanned. Use `--no-wrap` with an explicit cursor when an
operator intentionally wants only the upper UUID range. If one ambiguous row
cannot be diagnosed because no surrounding row succeeds, use
`--provider ID --mark-failed UUID` after verifying the provider is healthy. This
records the same durable failure and audit without calling the provider. It
cannot be combined with preview, retry, or cursor controls. Do not use it during
a provider-wide outage. A successful mark is an explicit incomplete backfill
result and therefore exits nonzero; an unrouted or ineligible target also fails
without changing the existing checkpoint. The command never falls back from a
local-only route to a hosted provider.

Checkpoint rows are keyed by `(provider, dim, scope_filter)` and contain
`cursor` plus `updated_at`. Failure rows are keyed by
`(memory_id, provider, dim)` and contain `disposition` (`durable` or `suspect`),
sanitized `reason`, and `failed_at`. A checkpoint is never advanced past a
suspect or unresolved ambiguous row, even when later provider batches complete;
this is especially important for `--cursor --no-wrap`, whose next run must still
encounter that row. `--mark-failed` records operator disposition without moving
sequential scan progress.

## Operator migration 0084 rollout and rollback

Migration `0084_provider_embeddings_backfill.sql` builds the new unique index
concurrently, then attaches it as the primary key in a short transaction with a
bounded lock timeout. The migrator runs the mixed online DDL file through its
no-transaction path because PostgreSQL forbids concurrent index creation in a
transaction block.

Migration `0085_embedding_backfill_failures.sql` creates the durable state table
without scanning `audit_log`. No released version emitted embedding-backfill
failure audits before this feature's supported upgrade path, so a whole-audit
seed index and scan would add rollout cost without recoverable supported data.

The installed migrator takes one deployment-wide advisory lock and gives up
after its bounded acquisition deadline (30 seconds by default). It does not
wait indefinitely or start a second migration stream. Treat that nonzero exit
as a deployment failure: do not route new application binaries until one
migrator has completed all pending files.

Before applying 0084, drain every process running the old write path. Old writers
use the former `memory_id` conflict target and are incompatible after the primary
key changes to `(memory_id, provider, dim)`. Keep old writers drained until every
API, MCP, lifecycle, and maintenance process is running the new version. The
table remains readable throughout the concurrent index build, but the short
constraint swap takes a table lock.

The bounded scanner, checkpoints, durable/suspect isolation, provider routing,
and deadline behavior are implemented by this release. Draining old writers,
upgrading Ollama to 0.3.4+, running migrations successfully, choosing batch
sizes, monitoring exact-scan latency, and executing any future partition/index
plan are deployment responsibilities.

To reverse the schema upgrade, stop every memory and embedding writer and
restore a verified pre-upgrade database backup, including both migration
ledgers. Preserve deliveries and post-backup writes for deliberate replay; a
backup restore does not retain them automatically. Verify the restored schema,
role profiles and configured runtime startup before resuming the compatible
application. Do not delete ledger rows or downgrade the primary key in place.
The checked scripts/rollback-embedding-provider-key.sql refuses that unsafe
operation before changing any data. Multiple provider vectors cannot be
transparently represented by the former single-memory key.

Prior historical process-memory measurements that escaped their intended
containment are invalid. They do not establish that the original memory incident
was fixed. Acceptance requires fresh source-specific, contained local results;
historical server receipts are not current validation evidence.
