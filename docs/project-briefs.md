# Maintained project briefs

Briefs are opt-in structured reference data, separate from memories and generated
AGENTS.md. Stock runtimes install an empty synthesis registry and no brief worker.
No hosted provider, repository connector, credential, deployment, scheduler,
publication destination, historical regeneration or reindex is enabled.

Each project has one definition with a configuration generation and a visible
head. Versions are immutable and retain their previous version, database cutoff,
observed scope generations, processed watermark, input manifest, profile/schema/
prompt identity and original durable cost/deadline accounting through their run.
Blocks have service-assigned stable identities and the fixed sections `purpose`,
`decisions`, `implementation`, `unknowns`, `coverage`. Labels are
`implemented_fact`, `recorded_intent`, `inference`; the current source-only
implementation refuses `implemented_fact`. Repository implementation proof stays
unknown. An assertion that an implementation exists is recorded reference data,
not independently verified code evidence.

## Audience and current authority

The audience is one explicit project plus currently eligible org references.
Every transitive evidence root must be in that intersection. User/team/role
sources, personal activity, connector roots and their derivatives are excluded
before processing. Extra memberships of the requester or bound worker cannot
widen this audience. Canonical promotion lineage and original expiry still
restrict selection. Duplicate extracted assertions whose source family is
already selected do not become another independent vote. Explicit current event
annotations are separate exact-version inputs; stale annotations disappear, and
ingestion time never supplies a missing event date.

Current/history/dry-run reads use the same locked source, root-generation,
membership, Entra-freshness, expiry and privacy gates. A whole unavailable block
is withheld before its prose, citations or hash are hydrated. Safe partial reads
can retain unaffected blocks; withheld inputs mask cutoff, coverage and watermark
metadata. Final delivered block authority and the complete response projection
are checked again after output validation and the required read audit, within the
same transaction. A changed expiry, coverage or preview diff refuses delivery and
rolls back that audit, including when no block was generated. Unknown/withheld are
not proof of absence. Old permissions, a version author, a saved UUID, a source
prefix, a caller GUC or `SET ROLE` confer no processing or reader authority.

Current, history and preview reads lock their complete selected source/root union
in UUID order before visiting individual blocks. A history page selects at most
ten versions and 320 blocks; the internal lock helper reads metadata only and
does not grant access or bypass any block gate. SQL deadlines still bound waits;
this is not a universal contention or fairness guarantee.

The processed watermark and scope counters remain internal; the wire `watermark`
is null. `fresh` reports current admitted dependencies and configuration, not
absence of newer unprocessed evidence. Coverage describes the recorded cutoff.
An automatic inventory check with identical authorized inputs does not invoke
synthesis or create a visible version/history event. Excluded private changes
therefore cannot change a reader's freshness or reveal generation counts.

Synthesis never receives previous generated prose as evidence. Claims require
exact selected version citations and quotes. Structured output rejects unsupported
fields, duplicate claims, unsupported labels and conflicts with fewer than two
cited versions. These checks establish citation mechanics, not a natural-language
truth judge. A configured model still requires separately qualified semantic
alignment, labels, unknown and contradiction false-positive measurements.
Every input disclosed to a synthesis call restricts every block it generates,
including inputs omitted from citations. Without a declared isolation contract,
one call receives the whole inventory and every block inherits it. A source
change can therefore dirty the whole brief; an omitted citation never narrows
its authority. Reuse requires identical disclosed input versions.

The optional `independent-section-requests-v1` profile contract permits separate
purpose, decision and combined implementation/unknown/coverage calls. Ordinary
decision sources enter the decision and combined groups; other source memories
enter the purpose and combined groups. Unknown assertion influence enters all
groups. Each generated block inherits every input of its actual group. The
combined group sees the complete admitted inventory. Unchanged groups retain
their exact block bytes, identities and dependencies mechanically.

This contract requires independent adapter requests with no shared conversation,
response cache or other cross-group content context. The descriptor pins the
trusted composition's declaration; a label or report hash does not prove provider
context isolation. Real-provider qualification must verify it. Missing isolation
uses `whole-inputs-v1`, with whole-input calls and dependencies. Stock installation
still has no provider. The local synthetic fixture only demonstrates mechanics.
`renderBrief` escapes all contributed text and locators inside reference-data
boundaries. Source text cannot select tools, identities, credentials or policies.

## Installation

Apply owner-reviewed `0097_project_briefs.sql` after ledgered 0096. 0091 remains
unrelated and is not a prerequisite. All published migration bytes remain intact.
Regrant exact APP and OP profiles. SYNC/reporting receive no brief privileges.
Serving startup now requires `continuum_brief_is_ready()`, including owner-recorded
function bodies, search paths, PUBLIC execution ACLs and enabled guards. Exact
APP/OP profile checks and regrants remain separate startup prerequisites. Connectivity readiness
alone does not prove this contract or completed physical erasure.

Trusted composition registers a `BriefProfile` in `BriefRegistry`, with an exact
adapter/model/profile, version, complete serializer, validated token accounting,
enforceable response/completion caps, finite `BudgetProfile` and qualification.
Spend defaults to zero. `synthetic-only` qualification requires local execution
and a zero spend allowance. An `operator-qualified` profile can declare a finite
nonzero allowance with a matching validated price schedule and currency. It is
unavailable until a bound OP explicitly installs that descriptor and a project
administrator enables it. Every call reserves its conservative maximum before
dispatch; unknown usage retains that charge. An `operator-qualified` profile
carries the SHA-256 of its separately reviewed actual evidence report.
That report reference is an operator attestation, not runtime proof of review.
Synthetic tests cannot manufacture it. No real provider is bundled or qualified.
Credentials stay in trusted installation code, outside descriptors, reference
inputs, managed payloads and logs.

A current manual org administrator on the actual bound OP LOGIN installs the
reviewed descriptor from `briefDescriptor(profile)`:

```sql
SELECT continuum_operator_install_brief_profile(
  :'admin_uuid'::uuid, :'reviewed_descriptor'::jsonb, TRUE);
```

Provision an existing isolated non-owner LOGIN using the checked owner script:

```text
psql <owner-url> -X -v ON_ERROR_STOP=1 -v continuum_schema=public \
  -v continuum_brief_worker_role=continuum_brief_worker \
  -f scripts/grant-brief-worker-role.sql
```

Its six worker/readiness capabilities grant no raw memory/evidence/accounting
tables, APP/OP profile, generic registration or repository access. The bound OP
then approves the exact service principal, project, profile and LOGIN name/OID:

```sql
SELECT continuum_operator_bind_brief_worker(
  :'admin_uuid'::uuid, :'worker_login'::name, :'service_uuid'::uuid,
  :'project_scope_uuid'::uuid, :'profile_id'::text, TRUE);
```

The service must retain current writer authority. Role attributes, membership
edges, parameter settings and excess tenant privileges fail closed. Use a
dedicated pool; never borrow the exclusive autocommit evidence-policy adapter
inside these owned READ COMMITTED transactions. Repository authority is not
inherited from this binding or from a refresher's upstream credentials.

A current project administrator opts in with
`PUT /api/v0/scopes/:id/brief` and `{"profile":"reviewed-local-v1","enabled":true}`.
Identical settings preserve the generation; profile/enabled changes fence older
queued work. Operator installation, worker binding and project opt-in are distinct.
First enrollment drains ongoing memory, evidence-root and event writers before
creating its scope generations, within the existing SQL lock/statement bounds.
Existing enrollments avoid that fence.

## REST and MCP

All reads require authentication, current source authority and a successful
transactional delivery audit. Responses use private/no-store caching.

| Operation | REST | MCP |
| --- | --- | --- |
| Current | `GET /api/v0/briefs?project=name` | `continuum.brief`, `project` |
| Refresh | `POST /api/v0/briefs/refresh` | `continuum.refresh_brief` |
| History | `GET /api/v0/briefs/:id/versions?limit=3&cursor=uuid` | `continuum.brief_history`, `brief_id`, `limit`, `cursor` |
| Configuration | `PUT /api/v0/scopes/:id/brief` | `continuum.brief_configure`, `scope_id`, `profile`, `enabled` |

REST refresh accepts only `project`, `mode: full|delta`, `dryRun` and
`idempotencyKey` (1..128 characters). MCP uses `dry_run`, `idempotency_key`.
REST outputs use `runId`, `definitionId`, `scopeId`, `previousVersion`, `dryRun`,
`nextCursor`; MCP explicitly projects `run_id`, `definition_id`, `scope_id`,
`previous_version`, `dry_run`, `next_cursor`. Block fields and labels are shared.
Project names are at most 500 characters. History defaults to three versions,
maximum ten, using an exclusive version cursor ordered by database creation time
and UUID. Invalid/cross-definition cursors refuse the request.
Oversized history responses refuse delivery; request a smaller page limit.

A writer/admin requests a refresh, which returns a queued run, not immediate
model completion. Repeating the same key returns the original run, and after
processing its currently authorized result. Changing mode/dry-run under that key
conflicts. Readers cannot refresh. Requests cannot supply evidence IDs or provider
configuration. Dry runs create managed immutable preview versions without moving
the visible head or entering normal history. Their added/removed block-ID diff
is withheld unless both sides remain readable. They never expose hidden old prose.

## Bounded refresh and workers

`processBrief` executes one inventory page or completes one domain run. Its
`progress` outcome means committed metadata progress, with the same queued run,
no provider call and no new visible version. `BriefWorker` is an explicit optional
custom-runtime worker, with no stock registration. It polls once per registered
profile, default 1000 ms (100..30000), with a 5000 ms shutdown wait (1..10000).
At most 32 profiles are registered. Each processing call may enqueue one typed
repair after invalidation. A poll follows metadata progress immediately, with at
most nine processing calls per profile under the original deadline. There is no
general task executor, cron service or fairness promise.

The inventory admits at most 32 exact source/assertion/event versions per page,
and 63 per original run. The remaining slot in the evidence foundation's 64 direct
parent bound belongs to the restrictive policy anchor. Pages advance a persisted
kind/UUID cursor inside the same original workflow, deadline and allowance.
There are still at most 32 output blocks; a model cannot expand that output
ceiling by returning many claims across several section calls. Metadata probes,
admitted identities and at most 32 previous-block reconciliation identities
consume the original candidate budget. Conservative per-page storage accounting
can exceed physical allocation: each page charges the full retained manifest's
payload allowance again. Tight profiles safely abstain. Source snapshot
adoption and per-item/aggregate hydration,
complete prompt/schema/citation serialization, response bytes, token/call/spend,
control/provenance storage and final output allowance all consume the original
budget. Final library and actual REST/MCP envelopes are measured before audit
commit; remote limits can tighten them. Oversized results refuse delivery instead
of truncating citations or admitting an oversized best item.

Observed project/org generations are committed row state. Canonical source and
policy changes advance them transactionally; lazy enrollment and valid snapshot
pointer maintenance do not represent another source change. A page reads the
frontier before selection, samples its cutoff before a final fresh frontier read,
and requires both tokens to match. It holds no epoch-row lock across source reads
or snapshot adoption. A concurrent commit detected within a page or between
metadata pages restarts the pre-disclosure inventory, at most twice,
without refunding work or replacing its allowance/deadline. A lower-ID or delayed
lower-sequence commit therefore cannot disappear behind a saved UUID cursor.
The internal watermark separates inventory cycle, kind/UUID position, committed
scope frontier and complete coverage; allocation-order MAX and timestamps are
not completion proofs. A finite cap records partial coverage. Completed capped
work does not enqueue another allowance merely because it is partial. Large
scopes can remain partial and need deliberate new work; there is no unlimited
scope-volume or universal liveness claim.
After inventory closes, exact admitted dependencies and current authority gates
control synthesis and publication. A later unrelated frontier change does not
discard valid output at its recorded cutoff; the next inventory checks newer work.

Allowances bound each original workflow. A deliberate new request key or a
genuinely changed source frontier creates new work; there is no rolling
installation-wide spend quota or automatic queue retention policy. Operators
enabling priced profiles must separately bound incoming work and retained data.

Full refresh requests every section. Delta refresh recomputes affected sections
from the same current evidence inventory, and mechanically copies unchanged
blocks with their exact bytes/dependencies. New/removed inputs dirty every group
to which they were disclosed. Changed configuration or unknown dependency scope
can conservatively dirty the whole brief.
Canonical content identities preserve unchanged blocks during full regeneration
too. Deterministic fixtures converge; stochastic models require semantic/citation
convergence measurements, not promised byte equality.

Run, workflow, original first-attempt identity, budget owner/generation and LOGIN
binding attach before hydration. Each actual section call receives a distinct,
immutable payload-free attempt record in that same workflow, bounded by its call
ceiling. No retry overwrites an older attempt. The immutable workflow lifetime
is at most 20 seconds, with a 30-second
lease and provider timeout at most 15 seconds. Time begins before the claim round
trip; database remaining duration and the local monotonic clock both bound work.
Provider I/O runs outside transactions. Apply locks the definition/head and
rechecks exact dependencies, source audience, enabled profile/configuration,
binding, lease, every current section's dispatched/settled attempt, deadline and
head CAS. Versions, typed
dependencies, required audit and head movement commit atomically.
The complete version, including retained blocks, must pass the ordinary guarded
view before publication; oversized output leaves the previous head available.

Crashes, stale leases, cancellation, failed settlement and ambiguous restart park
work unavailable. They never replace identities, renew a deadline or refund
ambiguous maxima. A completed rejected provider promise can queue a retry only
after every original attempt has actually settled and the original remaining
call/retry/time budgets admit every nonempty dirty section group. Backoff is
persisted at 1, 2 then 4 seconds,
with at most three retries; tighter original limits can stop earlier. Earlier
successful section outputs are discarded on a failed generation rather than
stored as an unmanaged retry cache. Unknown usage retains its charged maxima.
An automatic refresh with a completed inventory checks the latest failed
inventory for the same head, configuration, profile and worker binding. Identical
admitted versions and dirty sections cannot buy another provider attempt. A new
coarse frontier can retain a separately charged bounded metadata probe, whose
unused provider allowance is cancelled before dispatch. The original paid
workflow, attempts, deadline and charges remain unchanged. Genuinely changed
inputs or context can repair automatically; a deliberate new manual key can
request new work on the same inputs. Replaying that key does not repeat it.
Backoff makes work eligible; poll cadence and other profiles can still consume
its remaining original deadline. It does not guarantee every permitted retry.
There is no orphan-recovery API. Late actual
settlement uses only the original LOGIN/accounting identity and grants no publish
permission. Duplicate apply after an ambiguous commit returns its original version.
An invalid/failed generation preserves the independently readable unaffected old
blocks; current source gates withhold stale ones. An empty answer stays unknown.
Shutdown aborts/fences admission and waits for actual work. An abort-ignoring call
retains process/accounting fences, and an unsettled shutdown rejects.

SQL operations use five-second statement and one-second lock bounds, preserving
tighter settings. They do not bound pool acquisition or whole worker lifetime;
configure finite pool acquisition and an outer process deadline. Contention can
produce a bounded unavailable outcome. Database permits cannot retract bytes
already admitted to a process or physically prevent a later network send.

## Erasure and rollout

All prose, quotes and hashes live in managed evidence payloads. Run manifests
contain machine identities and byte accounting, never copied bodies or secrets.
Current/history/preview blocks inherit source expiry and privacy lineage.
Canonical evidence erasure deletes their bytes and indexed block hashes. Approved
offboarding also cancels original brief workflows/runs in bounded pages, selected
by owned-source-scope lineage even after a scope move. Physical completion checks
actual blocks, run cancellation and workflow state; counters and old receipts are
insufficient. Locked gaps remain incomplete. Payload-free machine identities and
accounting remain; process/provider/downloaded/backup copies need separate policy.

Quiesce old memory/artifact readers/writers and privacy workers, back up data and both
ledgers, apply the forward migration as owner with database TEMPORARY privilege,
regrant exact profiles and verify readiness before restarting compatible binaries.
0097 verifies predecessor bodies, owners, SQL-NULL search paths and ACLs before
wrapping; it updates only the changed lifecycle-definition pins. It creates empty
tables/indexes and trigger/catalog guards with five-second lock and 60-second
per-statement DDL bounds. It performs no historical payload rewrite or CHECK scan
of existing evidence versions. DDL/FK locks and the complete maintenance window
still need actual-size rehearsal and a finite outer deadline. No universal volume
or total lock-duration guarantee is made.

No user reauthentication, forced regeneration, backfill or vector reindex is
required for the disabled default. Old serving/offboarding binaries cannot serve
or prove erasure for enabled briefs. Rollback disables admission and fences/drains
workers while preserving current source/read/erasure guards and conservative
accounting. Schema reversal requires a verified backup and reviewed replay;
binary rollback cannot restore erased bytes. Never delete ledgers or broaden
roles/search paths to recover availability. No live operation is authorized here.

Configuring a previously unenrolled project creates its definition and scope
epochs even when the requested initial state is disabled. The first-configuration
writer fence and compatible-writer requirements therefore apply before that
configuration request; disabling synthesis does not un-enroll a scope.

Current promotion clients acquire both enrolled scope epochs in UUID order before
inserting the destination. Lifecycle batches lock their selected memories' epochs
in that same order before transitions. Old promotion and lifecycle clients lack
these capabilities and can invert epoch locks. Do not mix those
old writers with enrolled brief scopes; disabling synthesis does not remove the
enrolled epoch rows. Regrant APP/OP profiles and restart compatible writers.

The separately versioned `project-briefs-v1` evaluation measures actual persisted
deterministic full/delta mechanics, exact alignment, labels, unknown/contradiction
precision and false positives, complete budget receipts, p50/p95 and duplicate
extraction/absent connector ablations. Frozen v1 inputs and existing score gates
remain unchanged. Reports are synthetic mechanism evidence only. Real model
quality, live connector authority, paid cost, paired performance, normalized
storage and production acceptance remain unqualified.

The extraction ablation seeds a duplicate managed generated assertion; it does
not invoke or bill an extractor. The connector ablation registers no connector.
Latency uses five sequential observations per variant/mode without a warmup;
these diagnostics do not meet the frozen paired performance acceptance protocol.
