# API operations

The API exposes separate liveness and readiness signals:

- `GET /health` remains the compatibility liveness endpoint. It is cheap and
  does not query PostgreSQL.
- `GET /health/live` is an explicit alias for liveness.
- `GET /health/ready` runs `SELECT 1` with a bounded timeout and returns 503
  while the runtime is shutting down or PostgreSQL is unavailable. It reports
  only whether an embedding provider is configured and its safe provider ID.
  It never calls the embedding provider.

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

Every response carries `X-Request-Id`. A conservative inbound ID is preserved;
other values are replaced with a generated UUID. JSON errors also include the
request ID in the existing REST envelope:

```json
{ "code": "INVALID_INPUT", "error": "Invalid request", "requestId": "..." }
```

Completion logs contain only timestamp, request ID, HTTP method, a route
template or redacted bounded path, status, duration, and authenticated
principal UUID when available. Headers, cookies, bodies, query values, recall
text, memory IDs, and raw internal errors are excluded.
