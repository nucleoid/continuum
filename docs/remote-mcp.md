# Remote MCP

Streamable HTTP is an optional `/mcp` endpoint in the API process. It is disabled by default. REST, CLI and stdio behavior remain available. Remote tools share `buildMcpServer` registrations and current service authorization, including AGENTS.md/freshness, Standup and coordination. Discovery grants no authority. Required domain audits retain `transport: "mcp"`; operational events contain bounded correlation IDs and status information, never credentials or tool arguments.

## Configuration

Production requires the complete existing `CONTINUUM_AUTH_MODE=entra` configuration even for service-key-only clients, current application-role grants/schema/startup readiness, an operator-configured HTTPS reverse proxy, and affinity to one enabled instance:

```text
CONTINUUM_MCP_HTTP_ENABLED=true
CONTINUUM_MCP_PUBLIC_URL=https://memory.example.com/mcp
CONTINUUM_MCP_TRUSTED_PROXY_CIDRS=192.0.2.10/32
CONTINUUM_AUTH_MODE=entra
```

The proxy must rate-limit unauthenticated traffic per client before forwarding. The application does not trust forwarded client IPs for that limit. The proxy terminates TLS, forwards the canonical configured public Host (an explicit HTTPS port443 normalizes away), and sets exactly one `X-Forwarded-Proto: https`. Only explicitly trusted direct socket peers are accepted. Forwarded client IP and forwarded Host are never authority. Express global trust-proxy behavior is unchanged. Optional `CONTINUUM_MCP_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins. No Origin is valid for SDK clients; present unapproved, malformed or null origins fail. No browser CORS access is advertised.

For explicit local development only, set `CONTINUUM_MCP_HTTP_LOOPBACK_DEV=true`, an HTTP loopback public URL such as `http://127.0.0.1:4000/mcp`, and either configured auth mode. Both the configured host and actual socket peer must be loopback. Dev authentication remains unsuitable for an untrusted network. No listener, certificates or proxy are deployed by enabling this option in source.

Send `Authorization: Bearer <access-token>` or `Authorization: ApiKey <service-key>` on every POST, GET and DELETE. Bearer and ApiKey aliases for the same service key are equivalent. Cookies and query credentials are not authentication. Requests reject query strings, duplicate sensitive headers, oversized headers, compressed bodies, GET/DELETE bodies, automatic HEAD and unsupported methods. POST requires uncompressed application/json and Accept application/json plus text/event-stream with nonzero quality; GET requires text/event-stream.

## Session lifecycle

Use a Streamable HTTP MCP client to initialize, send the initialized notification, discover tools and call them. Each session has one independent server/transport. It binds principal UUID, principal kind, credential kind, an opaque process-keyed credential digest and source restriction. The server keeps no credential bytes in its session map. A session ID never authenticates a request.

Fresh authentication runs before each dispatch. Rotation, refresh or a changed source restriction requires a new initialize. Unknown, mismatched, expired and deleted IDs return the same authenticated 404. Invalid credentials return 401. Current memberships and transactional mutation checks apply on every shared service execution. Calls admitted while valid can overlap later revocation; committed operations and audits are not retrospectively revoked.

Authenticated GET can reconnect to a live local session. GET streams close at credential expiry or their bounded window, then reauthenticate on reconnect. There is no EventStore or historical response replay. Nonempty Last-Event-ID is rejected. Restart, wrong replica or session loss requires new initialize. DELETE invalidates lookup before cleanup. An interrupted mutation can have an unknown outcome: inspect state before retrying a non-idempotent write. Coordination request IDs retain their documented service replay semantics.

## Bounds

All overrides are finite positive decimal integers with checked ceilings. Names below use the `CONTINUUM_MCP_HTTP_` prefix.

| Suffix | Default | Maximum |
| --- | ---: | ---: |
| BODY_BYTES, OUTPUT_BYTES | 1048576 | 16777216 |
| SESSIONS | 100 | 10000 |
| PRINCIPAL_SESSIONS | 5 | 100 |
| INITIALIZE_MS | 5000 | 30000 |
| IDLE_MS | 600000 | 3600000 |
| LIFETIME_MS | 3600000 | 86400000 |
| STREAMS | 100 | 10000 |
| CALLS | 20 | 1000 |
| PRINCIPAL_CALLS | 4 | 100 |
| REQUEST_MS, STREAM_MS | 30000 | 300000 |
| MESSAGE_RATE | 120/minute | 10000/minute |
| MESSAGE_BURST | 20 | 1000 |
| PROXY_RATE | 6000/minute | 60000/minute |
| PROXY_BURST | 1000 | 10000 |
| BODY_READ_MS | 5000 | 30000 |
| AUTHENTICATIONS | 100 | 1000 |
| PROXY_INITIALIZE_RATE | 6/minute | 60/minute |
| PROXY_INITIALIZE_BURST | 2 | 20 |
| UNSETTLED_GRACE_MS | 5000 | 60000 |
| CANCELLED_IDS | 100 | 10000 |
| PEER_RATE | 60/minute | 10000/minute |
| PEER_BURST | 10 | 1000 |
| PEERS | 1000 | 100000 |
| BUCKETS | 2000 | 100000 |
| BATCH_MESSAGES | 20 | 20 |

Principal limits cannot exceed global limits; idle lifetime cannot exceed absolute lifetime. One standalone GET is allowed per session. Trusted proxy authentication failures use separate finite buckets. Once exhausted, unmatched requests are rejected before authentication work. A live session with matching opaque credential digest remains eligible for fresh authentication; that digest never authenticates or supplies current permissions. A separate small rate and burst reserve admits new initialize attempts. Established valid fleet requests do not consume the shared failure budget. Global authentication concurrency remains bounded to protect resources, without claiming total DDoS resistance; direct loopback peers retain the smaller peer limit. Session reservations include pending initialization and initialized-notification waits. Idle renewal requires authenticated activity. Credential expiry caps absolute lifetime, calls and streams. At most AUTHENTICATIONS authentications and CALLS concurrent JSON readers remain unsettled process-wide. Body readers also have a PRINCIPAL_CALLS per-principal cap and a separate BODY_READ_MS deadline; four additional small-body readers reserve control admission with at most one per principal. The first message token is charged before parsing. Every raw JSON-RPC batch member counts against message admission; active request IDs cannot be reused. Initialization must be a single message. Only implemented tools/list, tools/call, ping, initialize and initialized/cancellation notifications are accepted. Control notifications and DELETE have separate bounded admission so full call capacity does not prevent cancellation. Rate buckets have finite cardinality and only expire after their full refill window.

The separate remote execution APP pool has five connections, and authentication has its own two-connection APP pool. Both have one-second acquisition, server-side statement_timeout at most five seconds and lock_timeout at most one second. Stricter existing server limits win. Shared REST pool limits are unchanged. This is a per-statement budget, not proof that a transaction or arbitrary extension finishes within five seconds.

Per-call client cancellation normally ends only that POST once its requests have responded or been cancelled; sibling calls, GET and later calls keep their session. Cancelled IDs cannot be reused. The locked SDK retains cancellation routing tombstones, so a session reaching CANCELLED_IDS cancellations closes and requires initialize. Execution fences are still retained until actual work settles. Server deadlines request cancellation, suppress late delivery and close affected sessions. Disconnect can close the session and requests abort. JavaScript cannot forcibly stop an arbitrary dependency. Execution slots remain retained across session deletion and controller recreation until the underlying handler settles. Normal call or execution-pool saturation is an admission limit and does not evict healthy REST traffic. Only cancelled work still unsettled after its request deadline plus UNSETTLED_GRACE_MS counts toward unhealthy fence saturation; prompt cancellation does not immediately change readiness. Readiness checks the remote pool when a connection slot is available and preserves the main database probe during ordinary remote load. Fence exhaustion makes readiness fail with remote capacity information; replace the process through bounded shutdown if dependencies ignore abort forever. Shutdown invalidates sessions, closes GET streams and asks calls to abort, then waits for actual settlement within the existing runtime shutdown budget. Deadline expiry is never reported as successfully drained work. Previously committed writes and audits remain real.

Remote full-memory reads, recall, decision history, AGENTS.md/freshness and old mutation sources apply bounded UTF8 hydration gates before loading full content. Exact escaped MCP projections are checked before read success audits, including recall enrichments and metadata. Aggregate generator budgets cover all selected scopes and escaping. Oversized authorized results fail with PAYLOAD_TOO_LARGE before successful delivery audits or mutations. Compact incremental JSON preparation prevents deeply nested metadata from expanding through pretty indentation. Stored content is never truncated. These optional bounds preserve existing stdio/REST defaults and retrieval selection. Remaining transport output overruns close the session rather than buffer oversized responses indefinitely. Slow or disconnected consumers must reinitialize when their session closes. Operational logs use enumerated lifecycle outcomes and tool names with server-generated correlations; shared service errors are sanitized before logging.

## Rollout and rollback

This addition needs no migration, backfill, reindex or new credential store. Leave it disabled to preserve existing configuration. Enablement, public proxy policy, affinity and client adoption require separate operator installation work. This issue does not install or switch clients.

Mixed binaries against the unchanged current schema retain REST/stdio compatibility. Remote clients must stay on a compatible enabled instance. Drain remote work before disabling the endpoint or rolling back the binary; retained data and audits stay intact. Remote sessions cannot survive a process restart, credential refresh or rotation. No forced login is introduced for existing transports.

This transport was tested against the existing lock contract, SDK 1.29.0; the original compatible manifest range is preserved. Existing dependency audit findings remain separate maintenance work. The remote server does not invoke SDK OAuth client helpers and validates socket peers through Node BlockList rather than Express proxy-addr; this scoped reachability assessment does not assert that the package has no advisories.
