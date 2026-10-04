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
`0.92`; startup rejects values outside `0` through `1`.

Candidates are advisory only. `possible-conflict` means a nonidentical
fact/fact or decision/decision pair is highly similar; it does not assert a
contradiction. Continuum never automatically supersedes an existing memory.
Provider, embedding-storage, or candidate-probe failures do not reject the
capture and expose no provider or memory content in diagnostics. Concurrent
duplicate writes may miss each other in v0 because detection is intentionally
best-effort and does not serialize captures.

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
