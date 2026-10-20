# Delivery Forge UAT

This is a non-publishing acceptance run against an isolated approved project. It does not redesign the production harness or make GitHub/filesystem writes transactional. [Coordination](coordination.md) defines the authoritative lease protocol; [client onboarding](uat-client-onboarding.md) defines provider isolation.

## Actual tool contract

| Tool | Required input | Result |
| --- | --- | --- |
| `continuum.lock_acquire` | `scope`, exact `resource`, UUID `run_id`, UUID `request_id`, optional `ttl_seconds` | `acquired:true`, lease/run IDs, decimal-string `fencing_token`, expiry/server time; or successful `LOCK_HELD` contention with retry delay |
| `continuum.lock_renew` | `lease_id`, `run_id`, fresh `request_id`, optional TTL | Current generation renewed, unchanged token |
| `continuum.lock_release` | `lease_id`, `run_id`, fresh `request_id` | `released:true`; exact retained replay adds `already_released:true` |
| `continuum.lock_inspect` | `scope`, `resource` | Held state/time, with holder identity masked for other principals |

Use writer/admin membership on the exact scope. Locks are exclusive and non-reentrant, default TTL 300 seconds, allowed 30 through 900. Keep fencing tokens as decimal strings or compare with BigInt, never JS numbers. Receipts last at least 24 hours under a shared per-principal 10,000 budget. Renew/release can fail on saturation. Budget polling and renewals accordingly.

Use separate service principals A and B. The repeatable SDK smoke generates a unique `uat:delivery-forge:<UUID>` resource; never test on an active production issue key. Verify acquisition, exact replay, A's non-reentrant contention, B's contention/retry delay and masked inspect, wrong owner/run loss, renewal, release/replay, successor token increase, expiry takeover and stale renew/release rejection without clearing the successor. The script waits once for a 30-second synthetic lease, then leaves no intentionally held lease. Failed uncertain requests may retain a lease until TTL.

## Stop conditions and uncertain responses

Treat contention as success without dispatch. Honor the returned delay rather than tight polling. Stop dispatch and publication immediately on `LEASE_LOST`, authorization loss, renewal failure or uncertain renewal response. Preserve the original operation UUID and identical semantic input for permitted exact replay; changed input needs a new UUID. Inspect/reconcile ownership before reacquisition. A new generation needs a greater fencing token and must invalidate work dispatched under the old generation.

Exercise that stop condition through the actual Delivery Forge client with an in-memory or dry-run publication sink. Record that the sink receives no further operation after loss/uncertainty and that a successor remains held. A passing API smoke alone does not verify the harness stopped. Ordinary GitHub APIs and filesystems do not reject stale tokens; repository protection and orchestrator publication controls remain necessary.

## Controlled restart and persistence

The fixture supports three phases with the private variables in the onboarding guide:

```sh
node scripts/uat-mcp-smoke.mjs smoke
# Also set CONTINUUM_UAT_STATE_FILE to a new absolute private file path.
node scripts/uat-mcp-smoke.mjs checkpoint
# Restart only the approved project's API, preserve its DB/volume and all other services.
node scripts/uat-mcp-smoke.mjs recover
```

The checkpoint creates a synthetic fact and a 300-second lease and writes IDs, run/token, body digest, fixed expiry/state and an endpoint hash to a new mode-0600 file on a POSIX private filesystem; checkpoint refuses Windows. It never writes credentials. Recover within that TTL using fresh sessions and the same principal-A key; it verifies persisted full-body digest, fixed expiry/state and exact lease/token, renews, checks release and rejects a stale renewal. Do not count an expired checkpoint as restart persistence. It does not invoke Docker or restart a server itself. Preserve audit and migration/identity evidence separately. End old SDK sessions and require initialize after restart; process-local sessions cannot resume across instances.

Rehearse bounded recovery for DB unavailability, revoked disposable credentials, current membership loss and missed renewal. Never force-release another holder, reset fencing, delete receipts or restart validator workloads. Release while still authorized, otherwise wait for TTL.

## Results and boundaries

Record source/image identity, current migration/profile verification, client/version, timestamp, exact private UAT resource reference, per-step pass/fail, ownership-loss sink evidence, restart/persistence evidence, semantic lane result, native provider isolation and owner acceptance. Shared reports contain no tokens, memory bodies, private host/network inventory or client configuration snapshots. Leave failing/unexecuted criteria pending. Preserve both memory services and all data on rollback.

The initial Delivery Forge production adapter remains externally gated in its own repository. A ready Continuum endpoint does not enable that adapter automatically; actual harness integration and dry-run loss evidence must be supplied before claiming production click-test readiness.
