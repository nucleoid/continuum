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

All enrichers run concurrently under one request deadline. The default is 250
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
    return results.map((result) => ({
      links: await lookupLinks(result.memory.id, principalId, signal),
    }));
  },
});
```

Extensions receive only the principal ID and an abort signal. They do not
receive bearer tokens, request headers, or transport objects.

## Promotion webhooks

Every committed promotion creates a stable `promotion_events.id`. One delivery
row is created for each webhook registered at promotion time. Destination
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

Operational events report claims, pending age, attempts, lease recovery,
success, failure, timeout, dead-letter state, and shutdown lease release. Raw
callback errors are neither logged nor persisted. `last_error` contains only a
bounded safe category.

### Dead letters and manual retry

Operators can inspect delivery state directly:

```sql
SELECT event_id, webhook_id, state, attempt_count, available_at,
       lease_owner, lease_expires_at, last_error
FROM promotion_event_deliveries
ORDER BY available_at;
```

After correcting the consumer, call the exported
`manualRetryPromotionDelivery(pool, eventId, webhookId)` function. It changes
only a `dead_letter` row, clears its error and lease, resets its attempt count,
and makes it immediately claimable. It returns `false` if the named delivery is
not dead-lettered.

### Worker settings

- `CONTINUUM_PROMOTION_POLL_MS`, default `1000`
- `CONTINUUM_PROMOTION_CLAIM_BATCH`, default `10`, maximum `100`
- `CONTINUUM_PROMOTION_LEASE_MS`, default `30000`
- `CONTINUUM_PROMOTION_CALLBACK_TIMEOUT_MS`, default `5000`, must be less than the lease
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
shutdown deadline while callbacks receive abort and the process exits.

At the grace deadline, the worker signals abort and detaches callbacks that do
not settle. `stop()` uses the same wall-clock deadline for callback drain,
renewal, and release, so a stuck database operation cannot extend shutdown.
Leases for ambiguous deliveries are not released or renewed after stop. A
process-wide in-flight fence excludes them from claims by replacement workers
in the same process until the original callback settles. Late success is then
acknowledged if the durable owner fence is still intact. A timeout has already
scheduled its bounded retry; a rejection after the worker's shutdown abort is
abandoned without charging the callback as a genuine failure. Settled callbacks
are removed from both the in-flight and retained sets. After a crash, expiry
provides at-least-once recovery, and
claims that end in repeated crashes are dead-lettered at the configured attempt
limit. Callback execution cannot be forcibly interrupted inside JavaScript, so
process exit remains the bounded cross-process execution fence. The worker does
not promise that abort-ignoring extension code settles in-process. Consumers
must still deduplicate by event ID. Claims that complete after stop begins,
callbacks unavailable in the local registry, and callbacks that reject after
the worker's own shutdown abort are abandoned without consuming an attempt.

The default registries are empty. Deployments register consumers at their
composition boundary. Core does not import or know about downstream products.
