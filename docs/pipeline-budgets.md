# Pipeline resource budgets

The library exports an opt-in `Budget`, checked version-1 profiles,
`runBudgetedStage`, bounded JSON serialization, safe operational receipts, and
PostgreSQL workflow/attempt accounting. These resource controls grant no source,
provider-disclosure, mutation or publish authority. Only trusted composition code
configures them, never REST/MCP fields or contributed text. No reranker,
extractor, synthesizer, refresh worker or connector is enabled by this addition.
There is no new paid default or inline credential store.

## Checked profiles

`starterProfile` is an opt-in foreground profile. Existing unconfigured library,
REST, stdio, remote MCP and embedding behavior retains its documented defaults.

| Resource | Starter ceiling |
| --- | ---: |
| Candidate identities | 200 |
| Hydrated bytes, per item / aggregate | 1 MiB / 4 MiB |
| Complete serialized adapter inputs | 1 MiB |
| Complete context tokens | 16,384 |
| Serialized outputs | 1 MiB |
| Output / reasoning / total completion tokens | 2,048 / 0 / 2,048 |
| Calls / retries | 4 / 3 |
| Unsettled concurrent calls | 2 |
| Retained input plus response allowance | 4 MiB |
| Generated artifacts / stored artifacts | 1 MiB / 1 MiB |
| Overall foreground / optional stage deadline | 30 s / 5 s |
| Spend | 0 integer microcurrency units |

The zero-price identity is `local-zero-v1`, currency `USD`. Deterministic fake
or explicitly local adapters can declare that schedule. This does not assert
a hosted model is free. Priced work needs an operator-approved profile and
versioned rate schedule; starter spend cannot admit it. Built-in adapters do not
guess real-provider tokenizers, prices or generation caps.

Profiles are copied and frozen. Amounts must be nonnegative safe integers;
lifetime, stage duration, retained bytes, concurrency and item hydration bounds
must be positive. Item hydration cannot exceed aggregate hydration, stage time
cannot exceed lifetime, and output plus reasoning tokens cannot exceed total
completion tokens. Lifetime is at most one day, stage time at most 300 seconds,
candidate count at most 10,000 and calls/concurrency at most 1,024. Output reserves
at least 512 bytes for safe failure reporting. Background callers must choose an
explicit finite profile; worker loops do not renew workflow lifetime.

`child()` shares the same ledger. Retry, fallback, requeue and provider switch
cannot refresh allowance. `consume` atomically charges non-call work, including
candidate, hydration, artifact and storage amounts. `reserve` admits one call,
all amounts and retained bytes together or changes nothing. Attempt identity
history is bounded by the call ceiling. Candidate/hydration, input/context, call
and retry charges are cumulative. Only output/spend dimensions can be refunded
by explicit bounded settlement. Omitted dimensions retain their maxima.

These units are operational reservations, not measured JavaScript heap, GPU
allocation, filesystem overhead or independently settled remote invoices.
Existing tighter database, transport, provider and process limits still apply.

## Complete request and capability contracts

A `BudgetAdapter<Input, Output>` declares locality, exact model/profile identity,
request deadline, cancellation support, response-body bytes, enforceable
output/reasoning/total-completion caps, token accounting and a versioned price
schedule. Its serializer includes every prompt, metadata value, citation,
receipt when used, tool schema and protocol/model wrapper. Credentials stay in
the trusted adapter, outside reference data and receipts. Missing credentials,
missing capabilities, unconfigured pricing, policy denial, exhaustion and
provider failure have distinct bounded reasons.

Token accounting must be exact or a validated conservative bound for that exact
model/profile, including model/protocol overhead and a validation identity.
The enabling operator must qualify this capability; a validation string alone
does not prove correctness. No generic character/token heuristic is supplied
for real providers. Model or overhead changes require compatible accounting.

`boundedJson` counts the exact UTF-8 bytes it returns incrementally, with at most
256 UTF-16 units in each temporary quoted string. It rejects cycles, accessors,
functions, symbols, non-finite numbers, unsupported prototypes, more than 10,000
nodes and depth greater than 32. These fixed resource limits produce a budget
overflow, including for valid stored metadata; unsupported shapes produce a
type error. Dates use the intrinsic ISO projection rather
than contributed `toJSON` code. Escaping, keys and wrappers count. The adapter
must send those exact bytes and enforce response limits during body reading.
Buffering an unbounded body then returning a small projection violates the
contract. Types do not sandbox arbitrary in-process JavaScript or force a
provider to honor its declared caps.

Pricing uses integer microcurrency rates per positive integer token unit for
input, output and reasoning separately. Each component rounds upward using
integer arithmetic; unsafe totals deny admission. Reserve worst-case spend
before dispatch. Usage provenance is `measured`, `provider-reported`, `estimated`
or `unknown`. Only bounded measured/provider-reported completion usage can
reduce a charge. Estimates, missing usage, invalid responses and ambiguous
failures do not imply refunds. Provider contract violations remain outside this
billing model.

## Deadlines and actual settlement

Lifetime uses a monotonic clock. Serialization and admission consume stage time;
dispatch uses the lesser of remaining lifetime, stage, transport and provider
caps. A trusted current-authority hook, when supplied, runs before dispatch and
before successful publication. It must recheck every source and destination,
including retries and fallback disclosure. Resource admission is not an authority
cache. The issue-26 policy adapter needs exclusive ownership of a clean
autocommit READ COMMITTED connection throughout its async call. Do not share that
connection concurrently or claim its final probe attests transaction history.

Cancellation stops future admission, requests abort and suppresses late results.
It cannot retract disclosed bytes or forcibly stop JavaScript. A deadline returns
a skipped result while retaining concurrency and byte reservations until the
underlying promise and accounting settlement finish. Process-wide fences survive
replacement budgets/registries: four healthy unsettled calls per adapter/model/
profile identity, 128 overall and 64 MiB retained allowance. Any detached call
blocks its identity until settlement. Changing IDs cannot evade global bounds.
Abort-ignoring dependencies can exhaust these finite fences; fix them and use
bounded shutdown/process replacement. Deadline expiry is not successful drain.

## Durable workflows

Migration `0092_pipeline_budgets.sql` explicitly requires ledgered `0090`.
Migration discovery sorts filenames and checks prerequisites, not contiguous
ordinals. Owner-controlled accounting tables are separate from payload storage.
They contain random workflow/attempt/worker IDs, checked profiles/counters,
deadlines, generations and settlement state. There are no principal/source IDs,
source contents, credentials, arbitrary receipt/error text or provider payloads.
They never enter recall, embeddings or generated AGENTS.md. No content-bearing
job receipt is introduced for offboarding; backups remain separate policy.

`createBudgetWorkflow` binds a stable run UUID and approved immutable profile.
Repeating it cannot change policy or extend the database-time deadline.
`pipelineAttempt` binds a stable attempt UUID, worker UUID and generation.
Reservation locks the workflow and commits before work. Duplicate attempts never
receive a second dispatch permit. `dispatch` commits a separate one-time
generation/deadline check. Crashes between reserve, dispatch, response and
settlement leave maxima reserved. There is no lease-expiry refund or exactly-once
remote billing claim.

`fenceBudgetWorkflow` transfers ownership and increments generation, optionally
making cancellation permanent. It never resets limits, deadline, counters or
unsettled attempts. New attempts after recovery need the same remaining budget.
Old owners cannot dispatch or publish, but may settle their actually completed
attempts. Repeated settlement is idempotent and grants no second publication
permit; conflicts fail visibly. Unresolved pre-dispatch crash reservations also
remain retained until deliberately reconciled. Requeue is not proof a call ended.
Workflow expiry also does not release retained slots or refund charges.

Composition must persist the original attempt UUID, worker UUID and generation
alongside its job state. After proving actual settlement or process exit, it can
use that original identity to settle conservatively with unknown usage, releasing
slots and retained bytes while keeping maximum spend. This foundation has no
attempt-listing or privileged orphan-reconciliation API. If those identities are
lost, library callers must cancel and abandon the blocked workflow, retaining its
ledger. Further work requires a separately approved new workflow; it is not an
automatic retry or permission to reset the previous budget.

There is no automatic accounting retention. Plan bounded workflow creation and
owner-controlled maintenance for expired, fully settled records under the
installation's accounting retention policy. Cleanup must verify actual attempt
settlement and remove selected attempt rows before their workflow rows. Never
delete unsettled or ambiguous attempts to clear a budget.

Pass the `DurableAttempt` to `runBudgetedStage` for queued calls. Keep the stable
workflow identity on restart; a fresh local budget cannot bypass durable totals.
Durable cancellation requires committing a cancelling workflow fence as well as
calling local `cancel()`. The database commit is the durable cutoff. A settlement
permit is not a fenced content-write transaction. Future apply consumers must
recheck generation, current policy and source versions in their authorized
write/audit transaction. These raw library APIs are trusted composition exports,
not authenticated operator endpoints. Worker UUID/generation fences protect
against stale cooperative workers, not other trusted APP/OP code: those roles
can read the workflow identity and transfer ownership. Do not expose these
capabilities directly to untrusted callers.

The storage wrapper accepts an owned Pool and uses local five-second statement
and one-second lock limits, preserving stricter session settings. Commit/rollback
restore local settings. It never borrows or commits the policy adapter's
connection. Configure finite pool acquisition and caller deadlines too;
per-statement SQL limits do not bound an entire workflow.

## Retrieval, fallbacks and safe reporting

Optional budgets propagate through recall, memory-read gates, enrichment,
embedding boundaries and AGENTS.md. Authorized metadata admission charges shared
count/byte allowance before hydration. The hydration statement rechecks item
size, count and aggregate bytes in its own snapshot against that allocation.
Growth cannot consume another child's allocation. Failure may conservatively
consume the admitted charge. Stored sources are never truncated and an
oversized best item never bypasses the gate.

Recall retains hybrid selection; unaccountable embedding groups/enrichers skip
safely. Configured embeddings keep existing behavior without an envelope.
Budgeted embedding needs an explicitly composed compatible `pipelineAdapter`;
built-in HTTP adapters fail closed if directly given a budget without one.
Enrichment retains its existing process fence through actual adapter settlement.
Core fields and ranking remain unchanged. AGENTS.md still renders authorized
live source memories using its existing escaping/provenance boundary. Receipts
never enter its source bytes, selection or ETag. Whole-result overflow precedes
success read audit. Final adapters must count their actual complete output with
`serializeOutput`, including REST/MCP wrappers and double escaping. Service
output accounting adds a conservative projection; exact transport checks remain.

Future composition must retain admitted hybrid ranking on reranker skip, report
completed/skipped extraction chunks, and abstain from synthesis/refresh
publication when required inputs are incomplete. Connector denial must not invoke
a provider. No implicit source excerpting policy is added; existing recall
excerpts retain their flags and full-source fetch.

`budget.report()` exposes effective profile/rate identity, reserved/settled
amounts, retained resources, elapsed/remaining time, cancellation and safe receipt
events. Receipts have at most 32 entries within 4 KiB, including a reserved
512-byte failure event. This allowance is reserved from output at construction.
There are no recursive receipts-about-receipts. A report used as model input or
wire output must also fit that complete serialized envelope. Events contain
enumerated outcomes, elapsed time and provenance only. Never add source content,
hidden identifiers, credentials or raw provider errors. Domain audits remain
required success boundaries.

Separate synthetic `evals/pipeline-budget-v1.json` cases have zero security and
hard-budget-failure gates. The source test writes profile, outcome accuracy,
p50/p95, reserved/actual spend, fixture hash and head identity into
`.fire-off/pipeline-budget-eval.json`. These are local contract stubs, not real
provider quality/latency/billing measurements. Frozen `evals/fixtures/v1` bytes,
manifest and existing gate thresholds are unchanged.

## Rollout and rollback

No reauthentication, vector-space change, reindex or automatic backfill is needed.
Quiesce affected runtimes/workers, take a verified backup including migration
ledgers, migrate as owner, regrant and verify exact APP/OP/SYNC profiles, then
verify current startup. The migration owner needs database TEMPORARY for the
exact-profile snapshot. Migration 0092 creates empty tables and functions without
scanning or rewriting memories. Its five-second lock and 60-second DDL limits
are per statement, not a total migration/advisory-lock deadline. Rehearse under
a finite external maintenance deadline.

APP/OP receive only seven reviewed create/read/reserve/dispatch/settle/fence/
readiness function capabilities. Raw tables, schema ownership and validation
helpers stay owner-only. SYNC/reporting gain none. Both exact allowlist variants
preserve independent forward extensions. Current REST/stdio/remote pools verify
the hardened owner-controlled readiness helper before serving. A skipped invalid
role snapshot still requires explicit regrant and startup validation.

Enable priced stages only through approved composition, qualified capabilities/
prices and existing private credential configuration. This guide authorizes no
deployment. Rollback stops new admission, fences queued work, drains or verifies
process exit and retains ambiguous reservations for reconciliation. Old binaries
do not implement these optional pipeline controls. Never delete accounting or
migration history to clear budgets. Schema reversal requires a verified backup
and deliberate replay policy for later writes.
