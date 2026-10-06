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
body set. Cursor progress remains in stable UUID order.

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

`--cursor UUID` requires `--provider`. Saved and explicit cursors wrap once at
the end of the UUID range, and completion is reported only after the lower
range has also been scanned. Use `--no-wrap` with an explicit cursor when an
operator intentionally wants only the upper UUID range. If one ambiguous row
cannot be diagnosed because no surrounding row succeeds, use
`--provider ID --mark-failed UUID` after verifying the provider is healthy. This
records the same durable failure and audit without calling the provider. It
cannot be combined with preview, retry, or cursor controls. Do not use it during
a provider-wide outage. The command never falls back from a local-only route to
a hosted provider.

Checkpoint rows are keyed by `(provider, dim, scope_filter)` and contain
`cursor` plus `updated_at`. Failure rows are keyed by
`(memory_id, provider, dim)` and contain `disposition` (`durable` or `suspect`),
sanitized `reason`, and `failed_at`. A checkpoint is never advanced past a
suspect row; this is especially important for `--cursor --no-wrap`, whose next
run must still encounter that row. `--mark-failed` records operator disposition
without moving sequential scan progress.

## Operator migration 0010 rollout and rollback

Migration `0010_provider_embeddings_backfill.sql` builds the new unique index
concurrently, then attaches it as the primary key in a short transaction with a
bounded lock timeout. The migrator runs the mixed online DDL file through its
no-transaction path because PostgreSQL forbids concurrent index creation in a
transaction block.

Migration `0011_embedding_backfill_failures.sql` creates the durable state table
without scanning `audit_log`. No released version emitted embedding-backfill
failure audits before this feature's supported upgrade path, so a whole-audit
seed index and scan would add rollout cost without recoverable supported data.

The installed migrator takes one deployment-wide advisory lock and gives up
after its bounded acquisition deadline (30 seconds by default). It does not
wait indefinitely or start a second migration stream. Treat that nonzero exit
as a deployment failure: do not route new application binaries until one
migrator has completed all pending files.

Before applying 0010, drain every process running the old write path. Old writers
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

To roll back, first stop all embedding writers and take a database backup. Choose
the one provider row to retain for each memory, then deduplicate before restoring
the former key. The checked script
`scripts/rollback-embedding-provider-key.sql` keeps the newest row and uses
provider and dimension as deterministic ties. Review that ordering for the
deployment before running it. To prefer a specific provider, add a leading
`(provider = 'provider-id') DESC` term to the script's window ordering.

```sql
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY memory_id
           ORDER BY embedded_at DESC, provider, dim
         ) AS position
    FROM memory_embeddings
)
DELETE FROM memory_embeddings e
 USING ranked r
 WHERE e.ctid = r.ctid
   AND r.position > 1;
DROP INDEX CONCURRENTLY IF EXISTS memory_embeddings_memory_id_rollback_idx;
CREATE UNIQUE INDEX CONCURRENTLY memory_embeddings_memory_id_rollback_idx
  ON memory_embeddings (memory_id);

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE memory_embeddings DROP CONSTRAINT memory_embeddings_pkey;
ALTER TABLE memory_embeddings
  ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY
  USING INDEX memory_embeddings_memory_id_rollback_idx;
DELETE FROM _continuum_migrations
 WHERE name IN (
   '0010_provider_embeddings_backfill.sql',
   '0013_embedding_provider_scan_index.sql',
   '0014_embedding_provider_scan_index_rebuild.sql'
 );
COMMIT;
```

Verify that no memory has more than one row before starting old binaries:

```sql
SELECT memory_id, count(*)
  FROM memory_embeddings
 GROUP BY memory_id
HAVING count(*) > 1;
```

An empty result is required. The checkpoint and durable-failure tables may remain
in place during rollback; old binaries do not access them. The checked rollback
script also removes the 0010, 0013, and 0014 migration ledger rows in the same
bounded key-swap transaction. A later upgrade can therefore rebuild the
provider-qualified key and scan index instead of skipping them against the
rolled-back schema.
