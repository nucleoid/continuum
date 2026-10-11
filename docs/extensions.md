# Extension points

Continuum exposes in-process extension registries for retrieval enrichment and
promotion notification. Both registries reject invalid or duplicate IDs and
execute extensions in sorted ID order. IDs must match
`^[a-z][a-z0-9.-]{0,63}$` because they become response keys and persisted
delivery identifiers.

## Retrieval enrichers

A `RetrievalEnricher` receives an immutable clone of memories that have already
passed ACL filtering and ranking. It returns one plain JSON object or `null` for
each result. Continuum places each object under
`result.enrichments[enricherId]`. An enricher cannot replace core fields,
scores, excerpts, ordering, or another extension's namespace.

Admitted enrichers run concurrently under one request deadline. A pre-aborted
request invokes none. Per process, up to four healthy unsettled calls per enricher ID
and 16 unsettled calls overall are admitted. Once a call times out or is aborted
but remains unsettled, that ID admits no new calls until its detached calls settle. Admission checks a conservative
input-size estimate before cloning: 1 MiB per snapshot and 8 MiB retained across
snapshots, with finite depth and node limits. These are input accounting limits,
not measured process memory. An oversized or saturated input fails open to core
results. Timeout does not free an unsettled extension's slot or retained input;
actual settlement does. Before the first deadline, up to four overlapping calls
for one ID can hang and retain snapshots; the limits prevent unbounded accumulation.
Four IDs with four detached calls each can fill all16 process slots, and retained
near1MiB snapshots can exhaust the8MiB input budget. Later requests then fail open
with `saturated` warnings, possibly omitting all enrichment across principals.
If those promises never settle, fix or disable the extension and restart every
affected REST/MCP process to clear the process-local fences and snapshots.
Creating a fresh registry instance or changing an ID is not a recovery mechanism.

Each admitted call shares the request deadline. The default is 250
milliseconds and `CONTINUUM_ENRICHER_TIMEOUT_MS` accepts values from 1 through
5000. The combined serialized output is limited to 16 KiB. Functions, symbols,
accessors, non-finite numbers, circular values, class instances, excessive
depth, and oversized output are rejected. Exceptions, invalid output, and
timeouts omit only the affected namespace. Logs identify the extension and a
safe failure category without recording extension error text or memory data.

REST and MCP use the same recall service and expose the same `enrichments`
object. An empty registry does not add the property, preserving the existing
response shape. The AGENTS.md generator selects and renders memories through
its own hardened text-data boundary rather than serializing `RecallResult`, so
it does not render extension output and its generated format remains unchanged.

```ts
const extensions = defaultExtensionRegistries();
extensions.retrievalEnrichers.register({
  id: 'work-items',
  async enrich(results, { principalId, signal }) {
    return Promise.all(results.map(async (result) => ({
      links: await lookupLinks(result.memory.id, principalId, signal),
    })));
  },
});
```

Extensions receive only the principal ID and an abort signal. They do not
receive bearer tokens, request headers, or transport objects.

## Promotion webhooks

Every committed promotion creates a stable `promotion_events.id`. One delivery
row is created for each webhook ID in the operator-owned registry at promotion time. Destination
creation, source update, promotion audit, event creation, and delivery creation
share one database transaction. A rollback leaves none of them committed.

The promotion worker claims rows with `FOR UPDATE SKIP LOCKED` and a bounded
lease, commits that claim, then invokes callbacks outside the transaction.
Success is acknowledged while the worker still owns the delivery; this lets a
callback that settles after abort durably complete even if its lease has just
expired, while the owner fence rejects stale completion after another process
has reclaimed it.
Failures use bounded exponential backoff with jitter. After the configured
attempt limit, a delivery enters `dead_letter`. A successful webhook is not
blocked by another webhook's failure.

Delivery is at least once. A process can complete a callback and fail before
acknowledgement, so consumers must deduplicate using `event.eventId`. The event
ID remains unchanged through claims, retries, lease recovery, and manual retry.
Webhook IDs that are not registered by a running worker remain pending.

Producer delivery identities are installation-wide. A current manual organization
administrator using a bound OP role configures them with
`SELECT continuum_operator_set_promotion_webhook_ids($1::uuid,$2::text[])`.
The setter accepts at most 1024 valid extension IDs, stores their sorted distinct
set and writes a mandatory audit record. APP roles cannot configure the registry
or read its owner-only table directly. SYNC and reporting roles receive no rights.
Promotion reads the configured IDs under a shared row lock in the same transaction
as its event. A nonempty local producer registry must match that set or promotion
returns `CONFLICT` without committing any promotion writes. An empty producer
registry uses the configured IDs, so stock REST and MCP producers enqueue the same
deliveries without importing consumer implementations.

Workers still register callback implementations at the composition boundary.
Every worker replica must use the same expected ID set; a stock empty worker is
idle and unregistered IDs remain pending. Core does not initialize registration
from application callbacks. Configure IDs through the operator before enabling
consumers. Coordinate ID changes and consumer deployment; removing an ID does
not delete prior pending deliveries, and consumers deduplicate by event ID.

Do not mix old producers or old offboarding runtimes with this release. Older
producers can omit delivery rows, and new workers cannot reconstruct omitted
events. Older offboarding code does not scrub the outbox; the installed 0089
physical predicate prevents false completion, so old code can remain incomplete
instead of repairing those rows. Quiesce all producers and
worker replicas, complete migration 0089, explicitly regrant every APP and OP
role, configure IDs, then enable the new binaries. Current REST and MCP startup
checks outbox readiness without repairing or granting it. Rolling back binaries
requires the same quiescence and an operator assessment of retained outbox data;
reverting only application code does not restore privacy or producer parity.

Operational events report claims, pending age, attempts, lease recovery,
success, failure, timeout, dead-letter state, and shutdown lease release. Raw
callback errors are neither logged nor persisted. `last_error` contains only a
bounded safe category.

### Dead letters and manual retry

Operators can inspect delivery state directly:

```sql
SELECT event_id, webhook_id, state, attempt_count, lease_generation,
       available_at, lease_owner, lease_expires_at, last_error
FROM promotion_event_deliveries
ORDER BY available_at;
```

After correcting the consumer, call the exported
`manualRetryPromotionDelivery(pool, eventId, webhookId)` function. It changes
only a `dead_letter` row, clears its error and lease, resets its attempt count,
and makes it immediately claimable. It returns `false` if the named delivery is
not dead-lettered. Before retrying a timed-out consumer that ignores abort,
quiesce its worker replicas and confirm the old callback has settled or its
process has exited. Manual retry does not retract a running callback; clearing
its durable lease can otherwise admit an overlapping consumer on another
replica. Privacy-cancelled deliveries cannot be manually retried.

`manualRetryPromotionDelivery` is a low-level, unaudited raw-database capability.
It carries no principal identity and performs no human authorization or audit
insert. It is not a REST/MCP retry endpoint. Both trusted APP and OP database
roles already have delivery-table UPDATE rights for storage operations. Use this
helper only through trusted database administration after the quiescence above;
it does not provide attributed operator-action auditing. A deployment that adds
a principal-facing retry surface must enforce authorization and a mandatory audit
record in the same transaction itself. Do not expose the raw helper directly to
ordinary end-user requests.

### Worker settings

- `CONTINUUM_PROMOTION_POLL_MS`, default `1000`
- `CONTINUUM_PROMOTION_CLAIM_BATCH`, default `10`, maximum `100`
- `CONTINUUM_PROMOTION_LEASE_MS`, default `30000`
- `CONTINUUM_PROMOTION_CALLBACK_TIMEOUT_MS`, default `5000`, must be less than the lease
- `CONTINUUM_PROMOTION_DATABASE_TIMEOUT_MS`, default `5000`, must be less than the lease
- `CONTINUUM_PROMOTION_SHUTDOWN_WAIT_MS`, default `5000`
- `CONTINUUM_PROMOTION_MAX_ATTEMPTS`, default `10`
- `CONTINUUM_PROMOTION_BASE_BACKOFF_MS`, default `1000`
- `CONTINUUM_PROMOTION_MAX_BACKOFF_MS`, default `300000`

Worker owners are unique process-instance identifiers. On shutdown the worker
stops claiming new rows and waits for any claim already in flight before
deciding whether callbacks may start. It renews only the exact deliveries with
active callbacks during the configured grace period. A callback that succeeds
during that period is durably acknowledged before its lease can be released.
`CONTINUUM_PROMOTION_SHUTDOWN_WAIT_MS` must be strictly less than
`CONTINUUM_PROMOTION_LEASE_MS`. This leaves a bounded lease fence after the
shutdown deadline while callbacks receive abort and the process exits. For REST,
keep the outer `CONTINUUM_SHUTDOWN_TIMEOUT_MS` above the worker grace if the whole
grace is required; a shorter outer deadline can end the process and close its pool
first. Neither deadline forcibly interrupts JavaScript. Abrupt exit can leave a
lease to expire and a successful callback to be delivered again.

At the grace deadline, the worker signals abort and detaches callbacks that do
not settle. `stop()` uses the same wall-clock deadline for callback drain,
renewal, and release, so a stuck database operation cannot extend shutdown.
Claim, acknowledgement, failure, timeout, and abandonment writes also use the
configured database deadline, so one unavailable database operation cannot
stop later polling cycles. Storage also gives owned pool transactions a 5-second
statement limit and 1-second lock limit, retaining stricter existing limits.
These are per-statement bounds, not a whole-transaction or connection-acquisition
guarantee. Commit or rollback restores the pool session settings; failed
rollback discards that connection. A caller-supplied transaction client keeps
its existing transaction and settings and must supply its own SQL containment.
Claims seek indexed eligible prefixes for the requested webhook IDs.
Interrupted-delivery normalization changes at most 100 exhausted rows per
claim and skips locked rows, so available work for the same ID can continue.
Several polls can be needed to normalize a large exhausted backlog.
Every post-claim mutation is fenced by event ID,
webhook ID, lease owner, attempt number, and a monotonic lease generation that
is not reset by manual retry. A late write from an older claim cannot mutate a
newer claim held by the same process owner, even when manual retry reuses the
same attempt number.
While running, a transient renewal or timeout-write failure signals abort but
keeps renewing an unsettled callback's exact owner, attempt and generation.
Definite ownership loss ends renewal. Successful callbacks with a pending ACK
use a separate rotating cohort of at most 10 concurrent reconciliation writes;
those writes do not delay the next lease-renewal cycle. A started callback
that rejects after ownership uncertainty keeps its attempt and bounded backoff.
This abort can arrive before the callback deadline while some lease margin remains.
It is deliberate fail-closed behavior when ownership cannot be confirmed, not a
promise of uninterrupted work until timeout. An abort-honoring consumer that has
actually started and then rejects is charged a failure; only shutdown-abandoned
invocations receive the documented refund. A late failure never shortens a retry
availability already committed by a timeout whose response was lost.
Leases for ambiguous deliveries are not released or renewed after stop returns. A
process-wide in-flight fence excludes them from claims by replacement workers
in the same process until the original callback settles. Admission is isolated
per webhook ID: a webhook can retain at most the configured claim-batch count,
and saturated webhook IDs are omitted from new claims while other IDs continue
to drain. A hard process-wide ceiling of 100 callbacks remains as a backstop
across unusually large registries. Late success is then
acknowledged if the durable owner fence is still intact. A timeout has already
scheduled its bounded retry, and shutdown release never moves that retry
earlier. A rejection after the worker's actual shutdown abort is abandoned
without charging the callback as a genuine failure. An abort caused by lease
ownership loss is instead persisted as a failed attempt when the ownership
fence still matches; if another owner has already reclaimed it, the fenced
write is a no-op and the durable lease state wins. Settled callbacks
are removed from both the in-flight and retained sets. After a crash, expiry
provides at-least-once recovery, and
claims that end in repeated crashes are dead-lettered at the configured attempt
limit. Callback execution cannot be forcibly interrupted inside JavaScript, so
process exit remains the bounded cross-process execution fence. The worker does
not promise that abort-ignoring extension code settles in-process. It caps
per-webhook callback admission at the configured claim batch, plus the global
ceiling, so detached callbacks cannot accumulate without bound or let one
webhook starve unrelated webhooks. Consumers must still deduplicate by
event ID. Claims that complete after stop begins,
callbacks unavailable in the local registry, and callbacks that reject after
the worker's own shutdown abort are abandoned without consuming an attempt.

The default registries are empty. Deployments register consumers at their
composition boundary. Core does not import or know about downstream products.

## Supported composition entrypoints

The package ships its `dist/api`, `dist/storage` and `dist/workers` modules and
has no `exports` restriction. These deep imports are the supported composition
boundary for this release; pin the package version when maintaining a custom
launcher. `createApp` and `buildMcpServer` are transport builders, not complete
startup or shutdown lifecycles. Register extensions before constructing them.

The following `continuum-rest.mjs` is a runnable REST composition after normal
APP-role database, authentication and embedding environment configuration.
Configure the operator registry to `['promotion-log']` before launching it.
Its sample consumer only logs the stable event ID; a real consumer must implement
idempotency and abort handling for its own side effects.

```js
import { randomUUID } from 'node:crypto';
import { defaultExtensionRegistries, enrichmentConfigFromEnv } from '@continuum/core';
import { createApp, formatOperationalError } from '@continuum/core/dist/api/server.js';
import { startRuntime } from '@continuum/core/dist/api/runtime.js';
import { createReadinessState } from '@continuum/core/dist/api/readiness.js';
import { authModeFromEnv, createAuthenticator, entraConfigFromEnv, warnOnDevAuthMode } from '@continuum/core/dist/api/auth.js';
import { getPool, closePool } from '@continuum/core/dist/storage/pool.js';
import { applicationSchemaFromEnv, reconcilePgvectorProviderGrants, requireCoordinationContractReady, requirePromotionOutboxReady } from '@continuum/core/dist/storage/provider-lifecycle.js';
import { makeEmbeddingRouterFromEnv } from '@continuum/core/dist/embeddings/factory.js';
import { warnOnMissingEmbeddingRoutingScopes } from '@continuum/core/dist/embeddings/router.js';
import { configuredReviewHorizonDays } from '@continuum/core/dist/services/review-queue.js';
import { relationThresholdFromEnv } from '@continuum/core/dist/services/relations.js';
import { PromotionEventWorker, promotionWorkerOptionsFromEnv } from '@continuum/core/dist/workers/promotion-events.js';

async function main() {
  const pool = getPool();
  const schemaOptions = { expectedSchema: applicationSchemaFromEnv() };
  await reconcilePgvectorProviderGrants(pool, schemaOptions);
  await requireCoordinationContractReady(pool, schemaOptions);
  await requirePromotionOutboxReady(pool, schemaOptions);
  const mode = authModeFromEnv();
  warnOnDevAuthMode(mode);
  const authenticator = createAuthenticator(pool, mode, mode === 'entra' ? entraConfigFromEnv() : undefined);
  const embeddingProvider = makeEmbeddingRouterFromEnv();
  await warnOnMissingEmbeddingRoutingScopes(pool, embeddingProvider);
  const extensions = defaultExtensionRegistries();
  extensions.retrievalEnrichers.register({ id: 'memory-kind', async enrich(results) {
    return results.map(({ memory }) => ({ kind: memory.type }));
  } });
  extensions.promotionWebhooks.register({ id: 'promotion-log', async onPromoted(event) {
    console.info(JSON.stringify({ event: 'custom_promotion', eventId: event.eventId }));
  } });
  const expected = (await pool.query('SELECT continuum_promotion_webhook_ids() AS ids')).rows[0].ids;
  if (JSON.stringify(expected) !== JSON.stringify(extensions.promotionWebhooks.ids())) {
    throw new Error('Custom producer IDs do not match the operator registry');
  }
  const readiness = createReadinessState();
  const enrichmentShutdown = new AbortController();
  const app = createApp(pool, { embeddingProvider, authenticator, readiness,
    readinessTimeoutMs: Number(process.env.CONTINUUM_READINESS_TIMEOUT_MS ?? 1000),
    reviewHorizonDays: configuredReviewHorizonDays(), relationThreshold: relationThresholdFromEnv(),
    retrievalEnrichers: extensions.retrievalEnrichers, promotionWebhooks: extensions.promotionWebhooks,
    enrichment: { ...enrichmentConfigFromEnv(), signal: enrichmentShutdown.signal } });
  const worker = new PromotionEventWorker(pool, extensions.promotionWebhooks,
    promotionWorkerOptionsFromEnv(`custom-api:${process.pid}:${randomUUID()}`));
  await startRuntime(app, { port: Number(process.env.CONTINUUM_API_PORT ?? 4000), readiness,
    workers: [{ stop() { enrichmentShutdown.abort(); } }, worker], closePool,
    shutdownTimeoutMs: Number(process.env.CONTINUUM_SHUTDOWN_TIMEOUT_MS ?? 10000) });
}
main().catch(async (error) => {
  console.error(JSON.stringify({ event: 'startup_failed', error: formatOperationalError(error) }));
  process.exitCode = 1;
  try { await closePool(); } catch { console.error('Custom startup pool cleanup failed'); }
});
```

For a custom MCP launcher, use the same pool, schema gates, canonical-ID check,
configured embedding router and authenticator before building the transport.
Deep-import `buildMcpServer` from `@continuum/core/dist/api/mcp.js`; pass the
registered enrichers and webhooks in its dependencies. Authenticate the bearer
with `authenticator.authenticate('Bearer', token)` and reject absent or lifecycle
principals, then pass `authenticated.principal` and `authenticated.allowedSource`.
Connect it to `StdioServerTransport` from `@modelcontextprotocol/sdk` (declare that
SDK dependency in the launcher package). Retain the stock MCP launcher's 30-second
credential revalidation, token-expiry timer, and fatal startup/credential handling;
passing a principal once does not provide ongoing credential validation. On
shutdown, abort enrichment, close the MCP server and pool, and apply a finite
process deadline. Keep protocol stdout exclusively for MCP messages. Run webhook
consumers in the REST composition or a dedicated worker with the same ID set,
not an unbounded background task in a stdio session.

Promotion into a scope mapped to a disabled user is masked as `403 FORBIDDEN`
with `Target scope is unavailable for promotion`, after normal destination ACL
checks. An explicitly acknowledged shared-scope capture override can still permit
capture into that scope. It does not authorize promotion or bypass outbox privacy.

While retained non-ACK fences exist, each drain logs `promotion_worker_capacity`
with `retainedFences`, `processInFlight` and `processCapacity` (100), then logs a
clearing count after settlement. These are retained-fence counts, not a promise
that every retained consumer is still executing user code. At least 100 distinct
hung IDs can occupy all process slots and stop healthy work; below that limit a
healthy ID may receive only one slot per poll. Restart all affected worker
processes through bounded shutdown to clear abort-ignoring consumers. Different
in-process worker registries are unsupported. Serial claims can still consume
bounded database time before later IDs are admitted.

## Owned-scope privacy

Approved offboarding includes the promotion outbox in its physical completion
proof. A bounded operator-only batch replaces an owned destination's personal
scope-name snapshot with the canonical erased scope name and clears retained
callback errors. Stable event, memory, scope and principal UUIDs remain for
accounting. Related deliveries become `privacy_cancelled`: their lease and
owner are cleared and their generation advances. They cannot be claimed,
manually retried or acknowledged by an older delivery generation. Ordinary
application roles cannot update event snapshots or invoke the erasure helper.
The helper requires a bound approval identity, current manual organization
administrator, immutable approved disabled-user mapping and its authorized
run. Audit failure rolls the transaction back.

Completion waits for actual outbox state, rather than an old erasure receipt.
Retries commit bounded progress and check the current physical state again.
A callback that has already received its event may retain that original
payload or have sent it downstream. Losing its durable ownership fence stops
future acknowledgement or retry writes; the next ownership check signals
abort. JavaScript cannot retract a payload or force an abort-ignoring consumer
to stop. Operators must arrange downstream erasure separately when required.
Core makes no downstream deletion promise. To clear live consumer snapshots,
quiesce producers, stop every worker replica through bounded shutdown and
confirm process exit for callbacks that ignore abort. Stored-state completion
alone does not prove that a consumer process or downstream system has erased
its copy.

## Migration history and branch builds

Apply `0089_promotion_outbox.sql` as the application-schema migration owner
with database `TEMPORARY` privilege. Quiesce old producers and worker replicas
for cutover, use a finite external migration-process deadline, and complete
migrations before enabling the new binaries. A skipped-role NOTICE is visible
when the SQL is run through psql; the TypeScript migrator does not forward that
NOTICE. Always run the explicit grant scripts and require the exact-profile and
readiness startup checks rather than inferring role readiness from migration
success. Its 5-second lock and 60-second
statement limits apply per statement, not to the whole migration transaction.

The outbox schema ships as `0089_promotion_outbox.sql`. Earlier unmerged branch
builds used names such as `0007_promotion_outbox.sql` while other branches also
owned the `0007` prefix. Those names were never a supported shared migration
history. Continuum records the complete filename in `_continuum_migrations`, so
renaming a migration after applying an unreleased branch does not make the old
database equivalent to a clean released history.

Production and shared environments must migrate only from a released linear
history. Recreate disposable databases that ran an earlier branch migration.
For non-disposable data, stop and compare both the schema and migration ledger
before any manual reconciliation; do not insert or rename ledger rows merely to
silence `relation already exists`. A fresh database should record only the
released filenames in order, including `0089_promotion_outbox.sql`.
