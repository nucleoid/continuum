# API operations

The API exposes separate liveness and readiness signals:

- `GET /health` remains the compatibility liveness endpoint. It is cheap and
  does not query PostgreSQL.
- `GET /health/live` is an explicit alias for liveness.
- `GET /health/ready` runs `SELECT 1` with a bounded timeout and returns 503
  while the runtime is shutting down or PostgreSQL is unavailable. Shutdown is
  reported as `database: "shutting_down"`; dependency failures remain
  `database: "unavailable"`. It reports only whether an embedding provider is
  configured and its safe provider ID. It never calls the embedding provider.

Use `/health/ready` to control traffic and `/health/live` for process restart
decisions. Existing deployments that probe `/health` keep their previous
liveness behavior.

`CONTINUUM_READINESS_TIMEOUT_MS` controls the database readiness deadline and
defaults to 1000 milliseconds. `CONTINUUM_SHUTDOWN_TIMEOUT_MS` controls the
whole graceful shutdown deadline and defaults to 10000 milliseconds. Both must
be positive integers.

On `SIGTERM` or `SIGINT`, the runtime marks readiness false, stops accepting
connections, asks registered workers to stop, drains in-flight work, and closes
the PostgreSQL pool. Orderly signal shutdown exits zero. A deadline expiry
destroys remaining sockets, performs best-effort pool cleanup, and exits
nonzero. The shutdown operation and pool closure are idempotent.
A second termination signal expedites shutdown by closing remaining sockets
and taking the nonzero forced-exit path.

## Current schema and runtime prerequisites

Apply every packaged migration through `0090`, finish the owner-only `0081`
coordination backfill, and converge current application/operator/sync profiles
before starting matching binaries. Use the migration-owner connection for this
work, then restore the runtime application connection. `0083` needs database
`TEMPORARY` for its role-planning table and a reviewed writer-drain window. See
[offboarding rollout](./offboarding.md) and [tag rollout](./tag-vocabularies.md).

REST and MCP verify their provider profile and trusted `0081` coordination
readiness capability at startup. That capability proves coordination repair
completion, not installation of tag/embedding migrations or every later schema object. Identity
sync keeps its separate provider verification. `/health/ready` checks database
connectivity and shutdown state, not complete migration or provider health.

Set `CONTINUUM_APPLICATION_SCHEMA` explicitly for a custom tenant (default
`public`), and use only that schema in the resolved explicit runtime search
path. Keep `pg_catalog` implicit and omit provider and co-tenant namespaces.
The migrator's validated `0001` application/provider overlay is a separate
bootstrap rule, not a runtime search-path exception. Configure the explicit
authentication mode as described in [authentication.md](./authentication.md).

## Recall diagnostics and embedding maintenance

Optional vector failures preserve full-text candidates for the affected provider
group. REST recall includes `diagnostics` with `vector` (`used`, `disabled`,
`failed`, or `partial`) and bounded `groups` entries. MCP preserves its result
array and uses `_meta.diagnostics`; these diagnostic details retain camelCase,
including optional `localOnlyUnavailableScopes`. Group fields are provider, dim,
status, and optional errorCode. This is not a claim that an unavailable database
or failed required audit can deliver results.

The shared optional-vector deadline is capped at 30 seconds; each provider still
has its configured chunk deadline. Exact vector scans are provider/dimension
qualified and may need measured deployment-specific index or partition work.
Fallback logs use counts and safe status codes, not query text or vectors.

Use [embedding-backfill.md](./embedding-backfill.md) for bounded preview, count,
mutating backfill, and migration recovery. Backfill's five-second statement and
one-second lock limits preserve stricter current settings; keep a finite outer
process deadline. Drain old writers before the provider-qualified key upgrade.
The migration owner needs database TEMPORARY for 0083, 0085, 0089 and 0090.

## Promotion runtime composition

Current REST and stdio MCP startup also verify the trusted promotion-outbox
readiness capability installed by 0089 before serving, even with empty local
callback registries. Finish the full migration chain and exact APP/OP regrants
before starting these binaries. Startup does not repair missing schema or
change grants, and the connectivity readiness endpoint does not monitor
consumer progress. Stock REST starts an empty idle webhook registry; stock MCP
produces events without starting a consumer. Custom consumers need explicit
composition and the durable operator-configured ID set. See
[extensions](./extensions.md) for at-least-once delivery, callback capacity,
SQL/cancellation/shutdown limits, mixed versions and downstream-copy privacy.

Current startup also checks the 0090 Standup schema and rejects a bound activity
producer on the serving pool. This check runs at startup, not continuously.
Use distinct serving and producer roles; stop affected processes before changing
their bindings, then restart and verify. Quiesce activity producers and
offboarding during the complete-chain upgrade, regrant exact APP/OP profiles,
and configure reviewed actor mappings before enabling attributed capture.
Configured producer identity drift makes deliveries fail closed rather than
fall back to ordinary capture. See [Standup](./standup.md) for recovery and
unchanged queued-delivery replay.

## Capture relation candidates

Successful REST and MCP captures include `related: []`. When an embedding
provider is configured, Continuum probes the target scope plus org and returns
up to five readable live, unexpired candidates in descending cosine similarity.
`CONTINUUM_RELATION_THRESHOLD` sets the inclusive threshold and defaults to
`0.92`. It accepts conventional decimal forms from `0` through `1` (for
example `0`, `0.92`, or `1.0`) and rejects alternate numeric syntaxes.

Candidates are advisory only. `possible-conflict` means a nonidentical
fact/fact or decision/decision pair is highly similar; it does not assert a
contradiction. Continuum never automatically supersedes an existing memory.
`metadata.related` is reserved; REST, MCP, and service callers that supply it
receive `INVALID_INPUT`. Provider or embedding-storage failure does not reject
capture and returns `embedded: false`. Candidate probing or metadata-storage
failure preserves the valid embedding, returns `embedded: true` with an empty
`related` array, and records only the bounded `RELATION_DETECTION_FAILED` audit
code. No failure path exposes provider, database, or memory content in
diagnostics. Promotion strips advisory relation metadata because source-scope
candidate IDs are not valid destination-scope evidence. Concurrent duplicate
writes may miss each other in v0 because detection is intentionally best-effort
and does not serialize captures.

Candidates are not review-queue items. A consumer that acts on them must
reauthorize candidate IDs for the current caller and
revalidate scope, state, expiry, provider, dimension, and relation before use.
Stored candidates never auto-supersede, reject, or mutate memory state.

## Decision supersession rollout

`POST /api/v0/supersede` and `continuum.supersede` replace one readable,
writable, live decision with a linked live successor in the same scope. The
predecessor archive, successor insert, and required write/archive audits are
atomic. PostgreSQL connection acquisition failures before that transaction
return `DEPENDENCY_UNAVAILABLE`; failures in optional embedding work after the
commit degrade to `EMBEDDING_FAILED`. A stale decision must be verified back to
live before it can be superseded.

Capture and supersession reject caller-supplied `metadata.related` and the
five migration-owned namespaces `continuum_legacy_tags`,
`continuum_legacy_metadata`, `continuum_tag_migration`,
`continuum_tag_rollback_compat`, and `continuum_migration_conflicts`, including
when no tags are requested. Successors store Continuum-owned `related: []`
without acting on advisory candidates. Tags are normalized and admitted against
the scope-kind vocabulary before optional provider work and rechecked under
locks at write time. Unknown tags return `UNKNOWN_TAGS` (HTTP 422) with camelCase
`scopeKind`, `unknownTags`, and bounded `allowedTags` details in both transports.
See [tag-vocabularies.md](./tag-vocabularies.md).

The archive transition deletes every provider embedding for the predecessor in the same database
transaction. Optional provider I/O runs only after supersession commits. On
success, one short database transaction stores the successor vector and records
provider, dimension, and `status: "succeeded"` in a derived audit. On provider, pool
connection, vector storage, or derived-audit failure, the committed supersession
still succeeds and reports `EMBEDDING_FAILED`; the predecessor remains
archived without its derived embeddings.
Continuum makes a best-effort attempt to record a bounded failed outcome audit,
but an unavailable database can prevent that derived audit. A local-only route
with no local provider records `embedding_policy: "local-only-unavailable"`
best-effort and remains full-text-only without falling through to a hosted
provider. The live successor remains searchable through full-text recall.

The historical supersession constraints are installed in this order. Migration
`0007_decision_supersession_constraints.sql` follows the existing ingestion
migrations and adds the self-link check as `NOT VALID`. Migration
`0008_decision_supersession_validation.sql` validates it only after the add
migration has committed and released its `ACCESS EXCLUSIVE` lock, so the scan
does not retain that stronger lock. Migration
`0009_decision_supersession_unique_index.sql` runs outside a transaction and
builds the branching-prevention index with `CREATE UNIQUE INDEX CONCURRENTLY`.
These files are part of the full current packaged migration chain, not a
complete current-install prerequisite by themselves. Databases that
ran the preview `0005_decision_supersession.sql` are also supported: `0007`
recognizes its existing check, `0008` validates it, and `0009` safely rebuilds
its index before the new migration names are recorded. All three migration
files are included in the npm package and discovered by `continuum-migrate`.

Every response carries a server-minted `X-Request-Id`. A conservative inbound
ID may be retained as non-linking request metadata, but it is never used as the
server correlation identity or an offboarding selector. JSON errors also include
the server request ID in the existing REST envelope:

```json
{ "code": "INVALID_INPUT", "error": "Invalid request", "requestId": "..." }
```

Completion logs contain only timestamp, request ID, HTTP method, a route
template or redacted bounded path, status, duration, and authenticated
principal UUID when available. Headers, cookies, bodies, query values, recall
text, memory IDs, and raw internal errors are excluded. Startup and internal
failure logs retain bounded, redacted error messages and safe error codes for
diagnosis.
