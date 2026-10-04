# Embedding resilience and backfill

Continuum sends Ollama arrays to `/api/embed` in bounded chunks. Every HTTP
chunk has its own deadline. The response must contain exactly one finite vector
of the configured dimension for every input. Request text and vectors are not
included in errors, logs, diagnostics, or audit metadata.

Recall computes full-text candidates first. Embedding, vector validation, or
vector SQL failures disable only the affected provider group. REST includes a
`diagnostics` object. MCP preserves its existing result array and publishes the
same object in result `_meta.diagnostics`. Audit summaries record
`vector_status` and bounded group codes. Operational logs emit
`embedding_recall_fallback` counts without queries, memory text, vectors, or
raw exception messages.

## Backfill procedure

1. Apply migrations and configure the same scope routing used by the API.
2. Run `npm run embed-backfill -- --count`.
3. Preview a bounded pass with `--dry-run --max-rows 100` and an optional
   `--scope project:name`.
4. Run bounded batches. Start conservatively for local GPU or CPU capacity.
5. Inspect the JSON counts and sanitized `embedding_backfill` audit failures.

Useful controls are `--provider`, `--batch-size`, `--max-rows`, `--scope`,
`--max-retries`, `--retry-base-ms`, and `--max-errors`. `--cursor UUID`
requires `--provider`. A nonzero exit indicates invalid configuration, lock
contention, database failure, or an exhausted error budget. The command never
falls back from a local-only route to a hosted provider.
