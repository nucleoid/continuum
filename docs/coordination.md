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
- 10,000 retained successful-acquire receipts per principal by default;
- 1,000 separately counted contended-acquire receipts per principal by default,
  each with a 90-second horizon. Approval-bound operators may raise either
  limit through `continuum_operator_set_coordination_principal_quota` for a
  shared service principal or fleet;
- release receipts remain available for their full 24-hour replay horizon and
  do not consume a counter. A later release never evicts retained replay
  evidence;
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

Global receipt sweeping uses `coordination_receipts_global_sweep_idx`.
Terminal leases receive `cleanup_eligible_at` only after release or displacement
from `coordination_resources.current_lease_id`. Current expired generations are
therefore not rescanned on every sweep. Global and per-principal cleanup use
`coordination_leases_cleanup_ready_idx` and
`coordination_leases_principal_cleanup_idx` respectively. Upgrade backfill uses
the durable `last_lease_id` cursor and the
`coordination_leases_cleanup_pending_idx` partial index. Completion requires a
final non-`SKIP LOCKED` check, so a locked low key cannot be skipped forever or
cause false completion.

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
limit, while `continuum_operator_set_coordination_principal_quota` adjusts the
two acquire limits. The shared application role cannot execute these operator
functions, directly update usage/counter tables, or update protected lease and
resource identity columns; owner-owned triggers and narrow `SECURITY DEFINER`
helpers maintain counters.

Audit metadata is bounded and server-generated. It includes operation, outcome,
owned request/run/lease IDs where applicable, owned token, resource UTF-8
length, and SHA-256 of exact resource bytes. It never contains resource text,
credentials, request bodies, another holder's identifiers, memory bodies, or
vectors. Audit failure rolls back the whole operation.

## Deployment, mixed versions, and rollback

Apply through migration `0077_coordination_review_2_online_finish.sql`
(0064 and 0070 remain concurrent-index steps), then **re-run
`scripts/grant-application-role.sql`** for every application and dedicated
operator role. Re-run `scripts/grant-operator-role.sql` immediately afterward
for dedicated operators. The exact role verifier deliberately rejects both
missing coordination grants and broader manual grants.

Do not run the current offboarding binary against a database below 0063: it
requires the versioned coordination privacy state introduced there. During a
rolling application upgrade, finish database migration and exact grant-profile
convergence before enabling Entra-sourced coordination or offboarding traffic
on any current node.

The schema supports 0056 and current writers concurrently. A database
`BEFORE INSERT` guard clamps a 0056-style contended acquire receipt from its
legacy 24-hour retention to 90 seconds before the 0057 CHECK is evaluated.
Current writers already emit 90 seconds. Older nodes still return the generic
API `NOT_FOUND` for lock routes while upgraded nodes return coordination codes.
Harnesses must branch on the response `code`, never HTTP 404 alone, and must
fail closed until all target nodes advertise the coordination surface. Keep
the compatibility trigger until a later published migration explicitly retires
0056 rollback support.

A binary rollback leaves coordination tables, receipts, quota counters, and
fencing floors in place. Do not drop or truncate them. Migration 0061 gates the
old unversioned pseudonymization entry point: binaries older than the 0061-aware
release fail closed during offboarding instead of treating one bounded batch as
complete. Every node must run a binary that calls
`continuum_operator_pseudonymize_scope_v2` before applying 0061. Before
re-enable, apply all forward migrations, re-run the grant scripts and identity
verifier, and resume with the retained counters.

Migrations 0068 through 0073 are forward-only. Before applying them, drain offboarding traffic
from binaries older than the 0067-aware service. After it is applied, an older
binary may read and write ordinary coordination state, but it must not be used
as an offboarding worker: the database refuses its completed-run restart when
coordination privacy is the only dirty state. This refusal preserves immutable
lifecycle completion; it is not a signal to retry the old command. Route the
principal to a current node and use `repair-coordination-privacy`. A binary
rollback therefore leaves offboarding traffic disabled until a current binary
and the exact application/operator grant profiles are restored.

Migration 0069 makes completion depend on current database state as well as
durable progress. It replays the privacy audit cursor as version 3, including
owned-scope lock rows left by pre-0065 installations. Discovery is bounded by
a principal UUID cursor and a partial incomplete/version index. A live shared
lease returns `blockedUntil` and `progressed: false`; the CLI stops that run
instead of polling, and never writes a batch event for a no-progress attempt.
The database rejects offboarding run creation or start while a disabled-only
privacy repair is pending.

Migration 0070 builds the linkable-key audit index concurrently. Migrations
0071 and 0072 preserve cursor-compatible repair discovery and least-privilege
grants while closing completion and quota gaps. Migration 0073 replaces the
completed-principal scan with a trigger-maintained dirty-principal table. Its
one-time backfill starts from the linkable-audit, receipt, and lease indexes and
applies disabled/mapped/completed eligibility before insertion. Production
pages merge that dirty index with the partial incomplete-progress index, so
50,000 clean completed principals do not add page work. Reactivation removes a
marker; later eligible dirty mutations restore it; UUID cursor semantics remain
exclusive and stable between statement snapshots.

Migration 0073 also removes detached purge from the pre-scrub position. Every
scrub follows principal, sorted shared scope, then sorted usage-row order.
Advisory contention uses try-locks and usage rows use `NOWAIT`; the supported
wrapper converts SQLSTATE 55P03 into `reason: lock_busy` instead of waiting for
a caller timeout. Expired detached receipts are purged only after the scrub has
finished taking scope locks, with `SKIP LOCKED` on receipt rows and the detached
usage row already held. Current service calls translate typed SQLSTATE 55P03
to `lock_busy`; direct SQL receives the SQLSTATE and must handle it explicitly.
0073 preserves existing grants on the replaced operator entry points and adds
no new runtime-role grant requirement.

Migrations 0074 through 0077 are the forward-only repair for existing 0073
installations. Drain every pre-0074 offboarding and privacy-repair worker before
applying them and keep those workers drained through the 0075 index/backfill
and 0076/0077 remediation. Migration
`0076_coordination_review_2_remediation.sql` adds database-enforced entry
negotiation: runtime roles without client privacy version 4 are refused before
any mutation by the stable privacy wrapper and offboarding start/create guard.
The guard applies only to a separate non-owner runtime role. PostgreSQL owners
bypass it for maintenance, so a single-role installation where the application
connects as the migration/function owner has no old-client refusal boundary.
Use distinct migration-owner, application, and operator roles before relying on
the guard. The current application binary also checks that the 0076 guard exists
and the 0077 reconciliation completed before any privacy repair or non-dry-run
offboarding mutation.

0076 is transactional and uses a one-second lock timeout while replacing
triggers on `principal_user_scopes`. Apply it in a quiet window and retry the
complete migration if lock acquisition fails; the failed transaction leaves no
partial 0076 state. 0077 is restartable and safe to retry. The historical
environment name `CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE` controls both
the v4 and v5 reconciliation batches despite its name. 0076 also preserves
completed scrub work when only detached cleanup is busy.
The packaged migrator applies lock and statement timeouts to the restartable
backfill, reduces a contended batch adaptively, and accepts
`CONTINUUM_COORDINATION_V4_BACKFILL_BATCH_SIZE` from 1 through 5,000. Re-run
the exact grant profiles before restart. Binary rollback to a pre-0074 worker
is unsupported and is refused on the protected mutation paths. Rollback is
forward-only: restore a current binary or ship another migration; never remove
the negotiation guard or mark a partial repair complete.

The packaged migrator verifies every pinned published checksum before any
fresh or upgrade SQL executes. It defers 0073's historical in-transaction
backfill and performs that work after the 0074 trigger and lifecycle repair
through 0075's concurrent index and restartable batches. Migration 0077 runs
the bounded eligibility reconciliation introduced by 0076. Use the packaged
migrator for fresh installs and upgrades. Applying 0073 directly with `psql`
retains its published historical blocking behavior and is unsupported.

The migrator executes SQL using canonical LF line endings while published
migration verification continues hashing original bytes with only Git CRLF
materialization canonicalized. `.gitattributes` also pins `*.sql` to LF. A
fresh CRLF checkout therefore completes the full chain, while lone CR bytes,
extra CR bytes, and substantive published migration changes still fail closed.
Stored-function repair converts only CRLF pairs. A lone CR inside a string
literal remains data, including inside an owner-owned function whose name starts
with `continuum_`; foreign-owner, co-tenant non-Continuum, and extension-member
functions remain outside the repair boundary.

Migration 0061 contains the historical installation-wide receipt-counter
recount and takes coordination table locks. An installation upgrading from
0060 or earlier must apply 0061 in a maintenance window with coordination
traffic stopped; later migrations cannot make already executed DDL online.
Migrations 0063 and 0064 perform no installation-wide recount. Their privacy
work is restartable, keyset-bounded, and backed by concurrently built indexes.

Offboarding first deactivates every owned-scope membership and disables the
principal in the same transaction. The owned user scope is then erased in
bounded receipt, lease, and resource phases. Each call processes at most 1,000
rows per phase and records durable progress; the maximum fencing token is
preserved in the owner-only scope floor before resource deletion. All non-owned
scopes, including team, project, organization, role, and another user's scope,
remain shared state, but retained leases and receipts are moved to an
installation-wide detached principal and their run IDs and payload hashes are
independently randomized in bounded batches. The detached identity is disabled.
Shared-scope handling is independent of scope kind: team, project, role,
organization, and another user's scope are all retained while the departing
principal's lease/receipt identity is detached. Lock audit metadata is reduced
to `operation`, `outcome`, `fencing_token`, `resource_bytes`, `transport`, and
`own_lease`; request, run, lease, resource, resource digest, and unknown keys
are removed. Unrelated immutable retention/offboarding evidence is untouched.
Privacy version 2 reopens progress previously completed by 0059 or 0060, and
migrations 0066 and 0067 reopen completed version-2 rows after the 0065
lock-audit classifier change, including disabled direct-scrub principals. The
ordinary bounded scrub re-scrubs every shared kind,
including role and another user's scope. Audit
metadata advances on a durable `(principal_id,id)` cursor and completion is
recorded only after an empty page proves exhaustion. Operators may restart the
same offboarding command after timeout or interruption; counters and cursors
resume without rescanning completed pages.
`list-incomplete-offboarding` does not discover a completed historical run that
0063 reopened only for privacy v2. Use the bounded
`list-coordination-privacy-repairs` operator command instead. It distinguishes
completed offboarding from disabled-only direct scrub state. Resume an
offboarded row with the ordinary confirmed offboarding command; resume a
disabled-only row only with `repair-coordination-privacy`. Runtime roles receive
only least-privilege discovery and repair functions and no direct
progress-table privileges.
Version 3 canonicalizes lock metadata in owned and shared scopes. Completion
uses one shared lifecycle predicate plus a full coordination-state predicate;
the non-coordination repair check and full offboarding check cannot drift.
Completion is not recorded until owned-scope erasure and shared-scope
detachment are both complete. Append-only coordination operator events survive
audit retention and offboarding. Lock audit metadata retains operation evidence
but removes the resource digest, which could otherwise disclose low-entropy
resource names by brute force.

Direct scope pseudonymization requires zero active memberships and zero live
leases. Direct principal scrubbing additionally requires a disabled or
offboarded target, its exact mapped owned user scope, and never reassigns a live
lease. Started, per-batch, and completed evidence is written to immutable
operator events. Principal lifecycle serialization precedes scope serialization.
Membership insertion, activation, deactivation, disablement, offboarding,
reactivation, pseudonymization, and shared-history scrubbing all follow
principal-before-scope order. Membership writes take the per-scope advisory lock
only when principal or scope privacy progress exists; an ordered scope-row gate
closes the progress creation race without consuming one transaction advisory
lock per ordinary membership write. No-op active updates do not lock. An
explicit principal reactivation may reopen its
mapped owned user scope; it does not restore detached historical identities.

Release always commits when otherwise authorized. Exact replay remains
available for every release receipt throughout its documented 24-hour horizon.

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
