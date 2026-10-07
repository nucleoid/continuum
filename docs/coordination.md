# Coordination leases

Continuum exposes a dedicated coordination domain for exclusive, non-reentrant
leases. Coordination shares Continuum authentication, explicit scope
membership, PostgreSQL durability, REST, MCP, and audit infrastructure. It is
not semantic memory: lease data is never embedded, recalled, promoted, rendered
into generated AGENTS.md output, or sent to an embedding provider.

This document describes the API contract shipped by the package. It does not
claim that any particular deployment has applied migration
`0054_coordination_leases.sql`, upgraded its servers, or integrated a
production agent harness.

## Authorization

Every operation requires a currently active, explicit `writer` or `admin`
membership on the exact scope. These do not grant coordination access:

- implicit readability of the organization scope;
- explicit `reader` membership;
- administrator membership on a different scope;
- a lease ID, run ID, request ID, or fencing token by itself.

Continuum locks the relevant principal, membership, and Entra freshness rows
inside the operation transaction. It rechecks effective membership with a fresh
database clock immediately before commit. Unknown and unauthorized scopes are
both reported as `SCOPE_NOT_FOUND` for acquire and inspect. Unknown, expired,
released, replaced, wrong-owner, wrong-run, or no-longer-authorized lease
generations are all reported as `LEASE_LOST` for renew and release.

Revoking a credential prevents new authenticated calls but does not silently
delete an already issued lease. Revoking membership prevents later lease
operations. The lease remains until release or TTL expiry.

## Exact resource identity

A resource is an opaque, case-sensitive Unicode string:

- well-formed Unicode only;
- 1 through 512 UTF-8 bytes;
- no C0 or C1 control code points (the Unicode Cc ranges U+0000-U+001F and U+007F-U+009F);
- no leading or trailing ECMAScript whitespace.

Continuum does not trim, case-fold, normalize Unicode, resolve paths, infer
parents, or perform overlap matching. For example, composed `é` and
`e` plus a combining accent are distinct keys.

The canonical issue key for harnesses is:

```text
github:<owner>/<repo>:issue:<number>
```

Use a separate exact key such as `schema-migrations` for project-wide schema
serialization. Keys must not contain secrets or personal text.

## Lease lifecycle

Acquisition is exclusive, non-blocking, and non-reentrant. PostgreSQL row locks
serialize all server processes for one exact `(scope, resource)` pair.

- A free, released, or expired resource produces `acquired: true`.
- An unexpired lease produces successful contention with
  `acquired: false` and `reason: "LOCK_HELD"`.
- A fresh request from the current owner and run still contends.
- Only an exact idempotent replay can return the original result.
- Expired means `expires_at <= clock_timestamp()`.
- Server time is sampled after row-lock waits.
- Renew resets expiry to fresh server time plus the requested TTL.
- Release clears only the exact current generation.
- A stale renew or release can never affect a successor.

TTL is an integer from 30 through 900 seconds and defaults to 300 seconds.

Each successful takeover increments a durable PostgreSQL `BIGINT` fencing
counter. Tokens are canonical decimal strings end-to-end and are never parsed
as JavaScript numbers. Resource rows are never automatically deleted by
application traffic, so fencing history survives release, expiry, receipt
cleanup, server restart, and binary rollback. An approval-bound operator may
reclaim an inactive key; the owner-only scope-level fencing floor seeds any
later recreation, so the next token remains strictly greater without retaining
a dictionary-attackable resource digest. At
`9223372036854775807`, later acquisition fails permanently
with `FENCING_TOKEN_EXHAUSTED`; the counter never wraps or resets.

## MCP

The four MCP tools use snake_case fields:

- `continuum.lock_acquire`
- `continuum.lock_renew`
- `continuum.lock_release`
- `continuum.lock_inspect`

### Acquire

```json
{
  "scope": "project:continuum",
  "resource": "github:nucleoid/continuum:issue:7",
  "run_id": "3fde8850-90ac-4c4d-9460-b83cb78d8aaf",
  "request_id": "96edcd85-7ee4-43d0-8708-c33320d49015",
  "ttl_seconds": 300
}
```

Successful acquisition:

```json
{
  "acquired": true,
  "scope": "project:continuum",
  "resource": "github:nucleoid/continuum:issue:7",
  "lease_id": "79c47cef-146a-4445-87a8-0d3cbd5b617e",
  "run_id": "3fde8850-90ac-4c4d-9460-b83cb78d8aaf",
  "fencing_token": "42",
  "expires_at": "2026-10-07T12:05:00.000000Z",
  "server_time": "2026-10-07T12:00:00.000000Z"
}
```

Contention is a successful MCP result, not an application error:

```json
{
  "acquired": false,
  "reason": "LOCK_HELD",
  "scope": "project:continuum",
  "resource": "github:nucleoid/continuum:issue:7",
  "expires_at": "2026-10-07T12:05:00.000000Z",
  "retry_after_seconds": 180,
  "server_time": "2026-10-07T12:02:00.000000Z"
}
```

Contention never reveals the holder's principal, run ID, lease ID, or token.

### Renew

```json
{
  "lease_id": "79c47cef-146a-4445-87a8-0d3cbd5b617e",
  "run_id": "3fde8850-90ac-4c4d-9460-b83cb78d8aaf",
  "request_id": "b9e01faa-7f26-49c2-82cd-0277d7b56527",
  "ttl_seconds": 300
}
```

Success returns `renewed`, the lease and run IDs, the unchanged decimal
fencing token, `expires_at`, and `server_time`.

### Release

```json
{
  "lease_id": "79c47cef-146a-4445-87a8-0d3cbd5b617e",
  "run_id": "3fde8850-90ac-4c4d-9460-b83cb78d8aaf",
  "request_id": "e76fa9a5-18bf-4f73-8183-2fd89154ba88"
}
```

First success returns `{"released":true}`. Exact retained replay returns
`{"released":true,"already_released":true}` and never touches a successor.

### Inspect

```json
{
  "scope": "project:continuum",
  "resource": "github:nucleoid/continuum:issue:7"
}
```

Inspect always returns `held`, `scope`, `resource`, and `server_time`.
It adds `expires_at` when held. It adds `lease_id`, `run_id`, and
`fencing_token` only when the caller's principal owns the current lease.
Another holder is represented only by `held: true` and expiry.

Application errors use the existing JSON text envelope and set `isError: true`.

## REST

REST uses equivalent camelCase fields:

- `POST /api/v0/locks/acquire`
- `POST /api/v0/locks/renew`
- `POST /api/v0/locks/release`
- `GET /api/v0/locks?scope=...&resource=...`

Success, including contention, is HTTP 200. Status mappings are:

| Status | Codes |
|---|---|
| 400 | `INVALID_INPUT`, `INVALID_SCOPE` |
| 404 | `SCOPE_NOT_FOUND` |
| 409 | `LEASE_LOST`, `IDEMPOTENCY_CONFLICT`, `COORDINATION_QUOTA_EXCEEDED`, `FENCING_TOKEN_EXHAUSTED` |
| 503 | `COORDINATION_TIMEOUT`, `DEPENDENCY_UNAVAILABLE` |

REST request bodies are strict. Unknown fields are rejected.

## Idempotency and ambiguous responses

Acquire, renew, and release require a request UUID. The durable key is
authenticated principal plus operation plus request UUID. Continuum hashes a
canonical length-prefixed tuple of normalized semantic input after defaults are
applied. Reusing a key with different input returns
`IDEMPOTENCY_CONFLICT` without mutating lease state.

Acquire and release receipts are retained for 24 hours from the operation's
database server time. Renew receipts are short-lived: through the renewed
expiry plus a 60-second retry margin, capped at 24 hours:

- acquire success replays its original response only while that generation is
  still current and unexpired;
- acquire contention replays the original contention, even if the holder has
  since changed;
- renew success replays its original conservative timestamps without extending
  again, and only while the generation remains current and unexpired;
- release success replays with `alreadyReleased` or `already_released`, even
  if a successor now exists.

Authorization is revalidated before any receipt result or conflict is exposed.
Replay adds no duplicate audit row.

Once a receipt expires, bounded cleanup may remove it and its idempotency
guarantee ends. For renew, do not retry after the renewed expiry plus the
60-second margin. A contended acquire receipt is retained for 90 seconds; a successful acquire or
release receipt is retained for 24 hours. Do not blindly retry beyond the
applicable horizon. Inspect, reconcile local ownership state, and use a new
request ID.

Server-side `lock_timeout` is one second and `statement_timeout` is five
seconds. Timeout maps to `COORDINATION_TIMEOUT`. Request cancellation is
checked before work, after blocking stages, and immediately before commit.
Continuum does not use a local query timeout that could reject while a mutating
statement continues unseen. If the network makes commit versus response
uncertain, retry the exact request within the receipt horizon.

## Limits and cleanup

V1 hard limits are:

- 10,000 ever-created, unreclaimed resource keys per scope by default
  (operator-adjustable from 1 through 1,000,000);
- at most 100 newly created resource keys per principal per rolling hour;
- 10,000 retained successful-acquire receipts per principal;
- 1,000 separately counted contended-acquire receipts per principal, each with
  a 90-second horizon;
- 10,000 retained release receipts per principal;
- at most 100 retained renew receipts per lease; renew receipts do not consume
  acquire or release quota, so documented TTL/3 renewal cannot starve lease
  maintenance;
- at most 100 expired receipts and terminal lease histories reclaimed by an
  application operation, and at most 1,000 of each by operator maintenance.

An existing resource remains usable when its scope reaches the key limit.
Continuum never automatically evicts resource rows or fencing history. Quota, lease state,
receipt, usage counters, and audit metadata commit atomically.

Coordination operations lock authorization first, then the exact receipt and
resource state. Offboarding locks active memberships in deterministic principal
and source order before it reads any coordination state. A PostgreSQL deadlock
or lock timeout maps to `COORDINATION_TIMEOUT`; retry the complete idempotent
operation, never a statement inside the aborted transaction. Principal usage
remains a residual hot row only when a successful acquire, contention, release,
or new-resource rate reservation changes its counter. Renewals do not touch it.

Global receipt sweeping uses
`coordination_receipts_global_sweep_idx`; terminal lease sweeping uses
`coordination_leases_terminal_sweep_idx`. Per-principal cleanup retains its
principal-leading indexes.

Operator maintenance is exposed only through the approval-bound database role:
`continuum_operator_reclaim_coordination_resource` removes at most 1,000
expired receipts and terminal lease generations, refuses a live lease or any
retained receipt, preserves the scope fencing floor, and frees one key slot.
`continuum_operator_sweep_coordination_state` performs indexed cleanup in
batches of at most 1,000 for inactive principals. Quota changes, reclaim, and sweeps write operator audit events. Operators must
set transaction-level `lock_timeout` and `statement_timeout` before invoking
maintenance; PostgreSQL function `SET` clauses do not bound the already-running
calling statement, so Continuum does not claim a function-local deadline.
`continuum_operator_set_coordination_scope_quota` adjusts a reviewed scope
limit. The shared application role cannot execute these operator functions or
directly update either usage/counter table; owner-owned triggers and narrow
`SECURITY DEFINER` helpers maintain counters.

Audit metadata is bounded and server-generated. It includes operation, outcome,
owned request/run/lease IDs where applicable, owned token, resource UTF-8
length, and SHA-256 of exact resource bytes. It never contains resource text,
credentials, request bodies, another holder's identifiers, memory bodies, or
vectors. Audit failure rolls back the whole operation.

## Deployment, mixed versions, and rollback

Apply through migration `0057_coordination_privacy_race_remediation.sql`, then **re-run
`scripts/grant-application-role.sql`** for every application and dedicated
operator role. Re-run `scripts/grant-operator-role.sql` immediately afterward
for dedicated operators. The exact role verifier deliberately rejects both
missing coordination grants and broader manual grants.

During a mixed-version rollout, older nodes return the generic API `NOT_FOUND`
for lock routes while upgraded nodes return coordination codes. Harnesses must
branch on the response `code`, never HTTP 404 alone, and must fail closed until
all target nodes advertise the coordination surface.

A binary rollback leaves coordination tables, receipts, quota counters, and
fencing floors in place. Do not drop or truncate them. Before re-enable, apply
all forward migrations, re-run the grant scripts and identity verifier, and
resume with the retained counters. This preserves idempotency and fencing
across rollback/re-enable cycles.

Offboarding first deactivates every owned-scope membership and disables the
principal in the same transaction. Deterministically ordered membership locks
drain operations that already hold the coordination authorization lock; later
renewals fail authorization. It then preserves the maximum scope fencing value
and replaces coordination resource text (and matching lease/receipt text
through cascading foreign keys) with opaque random labels, even if a now
non-renewable lease has not reached its old expiry. Lease IDs, receipt outcomes,
and fencing values remain intact; every retained payload hash is overwritten
with independent cryptographically random bytes. No
resource hash or digest remains in a floor table. Lock
audit metadata retains operation evidence but removes the resource digest,
which could otherwise disclose low-entropy resource names by brute force.

## Harness guidance

A harness should:

1. Acquire before provisioning or dispatching a worker.
2. Store lease ID, decimal fencing token, run ID, and conservative deadline in
   its local run manifest.
3. For a 300-second lease, renew about every 100 seconds (roughly TTL divided
   by three) using a deterministic scheduler and a fresh request ID. Preserve
   that request ID across transport retries.
4. Interpret the server deadline using local monotonic elapsed time and a
   safety margin. Never extend locally based only on wall-clock guesses.
5. If renewal or ownership becomes uncertain, stop dispatch and publication,
   pause affected workers before the last confirmed deadline, and reconcile.
6. Release only after the worker and task-owned child processes are quiescent.
7. Fail closed if Continuum is unavailable. Do not fall back to GitHub labels
   or process-local locks as ownership authority.

V1 has no atomic multi-resource acquisition. Sort exact `(scope, resource)`
pairs lexically, acquire in that global order, and release the acquired prefix
if any acquisition fails. Do not dispatch while only a partial required set is
held.

GitHub labels may mirror status for people, but they are not ownership
authority.

## Fencing guarantee boundary

A lease does not terminate an expired worker and does not make GitHub,
filesystem, database, or deployment side effects transactional. A fencing token
is effective only when the downstream target validates it. A monotonic token
alone cannot reject an expired holder before the target has observed a newer
one, and GitHub does not natively enforce Continuum tokens.

For repository publication, retain orchestrator-only credentials, exact-head
checks, branch protection, and normal review gates. There remains a
check-to-action race. Do not advertise linearizable end-to-end GitHub writes,
exactly-once publication, general filesystem fencing, force-steal, shared
leases, hierarchy, fairness, or atomic multi-resource batches.
