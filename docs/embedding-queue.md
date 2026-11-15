# Deferred capture embeddings

Capture commits the source memory, required write audit, optional capture replay
receipt and durable embedding work in one transaction. REST returns 201 for a
new source and 200 for a replay. The acknowledgement performs no embedding or
relation-provider request. Full-text reads and the source-only AGENTS.md generator
can use the source immediately; acknowledgement does not establish a vector,
extraction result, semantic quality or a running worker.

REST adds `embeddingStatus`; MCP adds `embedding_status`. `embedded` means an
exact matching current vector is available. Initial `related` is always `[]`.
Queued work is not `EMBEDDING_FAILED`. Single-memory fetch includes bounded
attempt counts and operational timestamps; browse and recall do not expose jobs,
routes, receipts, candidates, provider responses or raw failure text.

| State | Meaning |
| --- | --- |
| `queued` | Durable current work awaits an approved worker. |
| `processing` | A current lease owns work; the vector is not committed. |
| `retry_wait` | Work waits for persisted backoff or provider capacity. |
| `ready` | A current source generation and approved vector space match. |
| `not_configured` | Capture had no embedding provider configured. |
| `blocked_policy` | A route, local-only target or approved process policy is unavailable. |
| `permanent_failure` | Explicit isolated input rejection or metadata-only oversize disposition. |
| `cancelled` | Source lifecycle/privacy or an explicit operator cancellation fenced work. |
| `superseded` | A newer source/target eligibility generation replaces this work. |

## Replay

Use optional REST `Idempotency-Key`, MCP `idempotency_key`, or CLI
`--idempotency-key`. Keys contain 1 to 128 visible ASCII characters. Retain the
same key when recovering an ambiguous request; the CLI never resubmits
automatically. Normalized semantic payload, authenticated principal, operation
and resolved scope UUID define the receipt. Tag normalization/order and JSON
object key order are canonical; body whitespace and array order remain meaningful.
Neither the raw key nor a copied source body is stored in the receipt.

The same key and payload return the existing memory and current status across
transports. A changed payload returns `CONFLICT`. Replay rechecks enabled
identity, credential source restriction, current scope access and source expiry.
Lost writer authority alone does not prevent an otherwise authorized read replay.
Revocation, physical erasure or lost read authority prevent old source delivery.

Replay retention is at least 24 hours. Each principal may retain at most 10,000
receipts. Admission prunes at most 100 expired eligible receipts and never evicts
an unexpired guarantee, active job or ambiguous attempt. Saturation rejects the
new write atomically. After expiry and eligible pruning, a reused key may create
a new source. Privacy erasure overrides retention and clears both digests and
source/actor linkage. Keep the existing webhook delivery identity when replaying
ingestion; ingestion enqueues through the same capture primitive and performs no
best-effort post-commit embedding.

## Configuration and authority

Apply the complete migration chain and exact APP/OP grants. The new forward
migration installs private queue tables, original accounting and source/vector
guards. It does not infer descriptors for historical vectors, enqueue the
historical corpus, install providers, probe models or start a worker.

One immutable `(provider, 768)` registry entry binds model, request profile and
`memory-title-body-v1` transformation. A vector-affecting model/profile change
requires a new provider-qualified storage ID. A reviewed transport-only endpoint
change can retain the vector-space identity. Credentials are excluded from target
identity. Existing unqualified vectors remain stored but do not satisfy current
semantic reads; use deliberately configured bounded backfill to repair them.

A current manual org administrator on the actual bound OP database session uses
the existing admin entrypoint:

```text
npm run admin -- embedding-target target.json
npm run admin -- embedding-policy routing.json
npm run admin -- embedding-bind-worker binding.json
npm run admin -- embedding-control pause all
npm run admin -- embedding-control drain <target-fingerprint>
npm run admin -- embedding-control resume <target-fingerprint>
npm run admin -- embedding-control reconcile <target-fingerprint> 100
npm run admin -- embedding-control retry <target-fingerprint> 100
npm run admin -- embedding-control cancel <target-fingerprint> 100
npm run admin -- embedding-metrics
npm run admin -- embedding-leases all 100
```

Configuration files are bounded to 64 KiB. A target file contains `target`,
`profile`, `window` and `enabled`. `target` is the credential-free
`embeddingTarget()` projection. `profile` is a checked pipeline profile with
one concurrent dispatch and at most 4 MiB hydration. `window` contains finite
`seconds` (1 to 86,400), `dispatches` (1 to 100,000), `inputBytes`, `tokens`,
`spendMicros` and the approved `rateSchedule`. There is no enabled hosted price,
tokenizer, model substitution or spend default.

A routing file contains `routing` and its reviewed SHA-256 `digest`. Routing is
`{default, scopes, kinds}`. Each selection is `{target, localOnly}`; target is a
registered fingerprint or null. `scopes` keys are actual scope UUIDs, `kinds`
keys are supported scope kinds. Exact scope overrides kind, then default. A
local-only selection never selects a hosted replacement. The operator receives
the durable generation/digest; configure the same values in each serving process
as `CONTINUUM_EMBEDDING_POLICY_GENERATION` and
`CONTINUUM_EMBEDDING_POLICY_DIGEST`, alongside its normal provider routing.
Drift produces blocked work rather than process-local authorization.

A binding file contains `role`, enabled service `principalId`, `scopeId`,
`target` fingerprint and `enabled`. First create a dedicated non-owner LOGIN and
apply `scripts/grant-embedding-worker-role.sql` with `continuum_schema` and
`continuum_embedding_worker_role`. It grants only bounded worker functions, no
memory table browsing, source mutation or configuration. Name and immutable role
OID must match the actual `session_user`. A UUID argument, `SET ROLE`, GUC or
creator membership cannot impersonate this binding. APP, OP, SYNC, reporting and
worker profiles remain separate. No end-user reauthentication is required.

## Independent worker

Run `continuum-embed-worker` or `npm run embed-worker` explicitly. Supply private
`CONTINUUM_EMBEDDING_WORKER_DATABASE_URL`, the application schema, and an absolute
`CONTINUUM_EMBEDDING_WORKER_COMPOSITION` module path. The trusted module exports
`createEmbeddingWorkerTargets(env)`, returning 1 to 16 distinct provider entries
`{target, policy, provider, profile}`. This is installed server code, never memory
content or a remotely selected module. Providers must supply a complete matching
pipeline serializer, qualified token bound, finite approved pricing and response
capability. Stock provider constructors describe their vector spaces but do not
manufacture these accounting capabilities. Unqualified composition fails closed.

The process uses a dedicated pool of two clients with finite acquisition and
five-second statement/one-second lock ceilings, preserving stricter limits. It
runs one dispatch per provider worker. Separate provider workers permit healthy
routes to progress while another callback drains. Polling is one second. Claims
contain at most 32 jobs, clamped to adapter capability and one approved privacy
lineage unit. Metadata byte admission and a repeated locked gate bound aggregate
title, separator and body hydration to 4 MiB. An individually oversized input is
classified without loading its body. The lease is 30 seconds, renewed every ten
seconds; renewal never extends the original accounting deadline.

Provider calls run outside transactions. Current source generation, routing,
residency, expiry, disabled owned-scope state and lease ownership gate hydration,
dispatch and apply. Successful vector, server-owned `related` merge, one completion
identity, required audit and ready state commit together. A current vector already
supplied by backfill reconciles without overwriting it. Backfill's own repair
audits remain distinct. Completion never replaces unrelated metadata with an old
snapshot. The current queue accepts no worker-supplied relation candidates and
retains an empty advisory list.

## Outages, ambiguity and privacy

Provider execution is at least once. Original dispatch identities and maximum
reservations persist across retries and restarts. Provider-wide circuit state,
one durable half-open owner and equal-jitter 1-second to 5-minute backoff bound
outages. Sanitized Retry-After seconds and HTTP dates can delay retries. Auth
failures park the provider until explicit reviewed recovery. A bare 400/413/422,
malformed response or all-failing ambiguous batch never marks every source poison.
Explicit multi-input rejection splits subsequent work into durable halves under
the original workflow. Diagnostic dispatch is bounded to 64 calls and eight
ambiguous failures, further limited by the original profile and window. A
diagnostic singleton becomes permanent only after explicit input rejection and
a successful control in that workflow. An all-failing tree remains retryable.

Finite window charges span endpoint/policy rotations of one provider identity.
Retries within one approved window reuse the original workflow, owner, deadline
and cumulative hydration/call/retry allowance. Releasing a lease, polling or
restarting a process cannot renew that allowance. An exhausted or expired
workflow waits for a later approved window; infrastructure failure does not
classify its source as poison. Changing an installed target profile advances the
durable policy generation and requires serving processes to adopt that identity.
Window duration is immutable for that provider, and an overlapping window keeps
its original ceilings. Unknown usage retains maximum token/cost charges. A later
approved time window adds separate capacity; it does not refund earlier work.
Transient settled failures can recover automatically without exhausting a source
job's lifetime attempt count.
Transient database settlement failures retain at most 64 metadata-only original
settlements per SQL store. A later poll retries that same settlement before new
work for its target, without another provider call or a new allowance. Pending
accounting makes shutdown unsuccessful. Lease status exposes bounded opaque
cohort/owner identities for deliberate recovery, separately from aggregate metrics.

A timeout cannot forcibly settle an abort-ignoring implementation. Process and
database provider fences remain until actual settlement. An expired lease alone
does not authorize another ambiguous dispatch. Stop every original sender and
verify exit before `embedding-recover-process recovery.json`, containing
`cohortId`, `originalOwner` and confirmation `CONFIRMED ORIGINAL PROCESS EXIT`.
The bound operator's confirmation is an operational attestation, not database
proof that an external process or remote computation stopped. Recovery retains
unknown maximum charges, never renews the old deadline and never revives privacy
cancellation. Crash after provider success can repeat provider work and cost.

Shutdown stops claims, requests abort and allows five seconds for callback
settlement. Unsettled shutdown exits unsuccessfully. Database pool closure has
its own five-second cleanup bound. Strict policy cutoffs require pausing intake,
quiescing all replicas and verifying process exit: already disclosed bytes cannot
be recalled. In-process, downstream and backup copies require their own policy.

Source mutation, archive, promotion, supersession, verification and physical
deletion advance eligibility fences. A bounded reconciler adopts newly approved
targets for previously accepted pending work, preserving original attempts.
Supersession and promotion do not adopt queue acknowledgement semantics in this
change; their vector writers still require original admitted generations and
approved spaces. Cancellation alone is not erasure. Approved offboarding scrubs
owned-source lineage, receipt digests, source hashes, route snapshots, leases and
all provider vectors in bounded pages. Actual residual predicates include locked
rows and reopen dirty completion. Opaque nonpayload accounting remains; progress
counters do not replace physical proof.

Metrics expose bounded aggregate status/count/age/attempt data through OP, with no
source text, memory-ID labels, raw errors or credentials. Example alerts: oldest
queued age above the team's target, processing without a healthy worker heartbeat,
repeated quota delay, parked provider, and new permanent failures. Operators must
install their own monitoring; these examples are not deployed alerts.

Before rollout, quiesce old capture/ingest/vector/offboarding binaries, retain a
verified backup and rehearse under a finite outer deadline. New schema DDL takes
ordinary table locks under five-second lock and 60-second per-statement budgets;
those are not whole-migration or volume guarantees. Existing vectors receive null
provenance rather than an inferred model history. Restart matching APIs after
migrations and exact grants, approve routes/budgets/bindings, then start workers.
An absent worker leaves durable source and full-text reads available with backlog.
Readiness verifies schema/roles/configuration, not provider availability or semantic
quality. This documentation is not live deployment evidence.

Prefer forward recovery. Stop and settle workers before any compatible binary
rollback. Older capture/offboarding binaries cannot preserve these guarantees.
Schema reversal requires a verified backup and deliberate delivery replay, never
ledger edits, implicit historical enqueue or collapsing vector spaces.
