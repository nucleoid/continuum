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

Issue #15 does not surface candidates in the review queue. Any future issue #12
decision workflow must reauthorize candidate IDs for the current caller and
revalidate scope, state, expiry, provider, dimension, and relation before use.
Stored candidates never auto-supersede, reject, or mutate memory state.

## Decision supersession rollout

`POST /api/v0/supersede` and `continuum.supersede` replace one readable,
writable, live decision with a linked live successor in the same scope. The
predecessor archive, successor insert, and required write/archive audits are
atomic. PostgreSQL connection acquisition failures return
`DEPENDENCY_UNAVAILABLE`. A stale decision must be verified back to live before
it can be superseded.

Supersession preserves the issue #15 metadata boundary: callers cannot provide
`metadata.related`, and successors store Continuum-owned `related: []` without
acting on advisory candidates. Embedding provider I/O runs only after the
supersession transaction commits. On success, the successor vector replaces the
archived vector and a derived audit records provider, dimension, and
`status: "succeeded"` in one short database transaction. On provider or vector
storage failure, the response reports `EMBEDDING_FAILED`, a derived audit records
the same provider fields with `status: "failed"`, and the archived vector is
retained. The live successor remains searchable through full-text recall.

Deploy migrations before routing traffic to the new endpoints. Migration
`0007_decision_supersession_constraints.sql` follows the existing ingestion
migrations, adds the self-link check as `NOT VALID`, and validates it without
blocking normal writes for the table scan. Migration
`0008_decision_supersession_unique_index.sql` runs outside a transaction and
builds the branching-prevention index with `CREATE UNIQUE INDEX CONCURRENTLY`.
Fresh databases apply `0001` through `0008` in lexical order. Databases that
ran the preview `0005_decision_supersession.sql` are also supported: `0007`
recognizes its existing check and `0008` safely rebuilds its index before the
new migration names are recorded. Both migration files are included in the npm
package and discovered by `continuum-migrate`.

Every response carries `X-Request-Id`. A conservative inbound ID is preserved;
other values are replaced with a generated UUID. JSON errors also include the
request ID in the existing REST envelope:

```json
{ "code": "INVALID_INPUT", "error": "Invalid request", "requestId": "..." }
```

Completion logs contain only timestamp, request ID, HTTP method, a route
template or redacted bounded path, status, duration, and authenticated
principal UUID when available. Headers, cookies, bodies, query values, recall
text, memory IDs, and raw internal errors are excluded. Startup and internal
failure logs retain bounded, redacted error messages and safe error codes for
diagnosis.
