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
metadata. Final delivered block authority is checked again after output validation
and the required read audit, within the same transaction. Unknown/withheld are
not proof of absence. Old permissions, a version author, a saved UUID, a source
prefix, a caller GUC or `SET ROLE` confer no processing or reader authority.

Synthesis never receives previous generated prose as evidence. Claims require
exact selected version citations and quotes. Structured output rejects unsupported
fields, duplicate claims, unsupported labels and conflicts with fewer than two
cited versions. These checks establish citation mechanics, not a natural-language
truth judge. A configured model still requires separately qualified semantic
alignment, labels, unknown and contradiction false-positive measurements.
`renderBrief` escapes all contributed text and locators inside reference-data
boundaries. Source text cannot select tools, identities, credentials or policies.

## Installation

Apply owner-reviewed `0097_project_briefs.sql` after ledgered 0096. 0091 remains
unrelated and is not a prerequisite. All published migration bytes remain intact.
Regrant exact APP and OP profiles. SYNC/reporting receive no brief privileges.
Serving startup now requires `continuum_brief_is_ready()`, including owner-recorded
function bodies, search paths, ACLs and enabled guards. Connectivity readiness
alone does not prove this contract or completed physical erasure.

Trusted composition registers a `BriefProfile` in `BriefRegistry`, with an exact
adapter/model/profile, version, complete serializer, validated token accounting,
enforceable response/completion caps, finite `BudgetProfile` and qualification.
The current port admits only `local-zero-v1` zero-price schedules and zero spend.
`synthetic-only` qualification requires local execution. An `operator-qualified`
profile carries the SHA-256 of its separately reviewed actual evidence report.
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

A writer/admin requests a refresh, which returns a queued run, not immediate
model completion. Repeating the same key returns the original run, and after
processing its currently authorized result. Changing mode/dry-run under that key
conflicts. Readers cannot refresh. Requests cannot supply evidence IDs or provider
configuration. Dry runs create managed immutable preview versions without moving
the visible head or entering normal history. Their added/removed block-ID diff
is withheld unless both sides remain readable. They never expose hidden old prose.

## Bounded refresh and workers

`processBrief` executes one domain run. `BriefWorker` is an explicit optional
custom-runtime worker, with no stock registration. It polls once per registered
profile, default 1000 ms (100..30000), with a 5000 ms shutdown wait (1..10000).
At most 32 profiles are registered. One poll may enqueue one typed repair after
invalidation; there is no general task executor, cron service or fairness promise.

The inventory admits at most 32 exact source/assertion/event versions. Metadata
and reconciliation reserve a conservative fixed 132 candidate units in addition
to selected inputs. Tight profiles safely abstain. Per-item/aggregate hydration,
complete prompt/schema/citation serialization, response bytes, token/call/spend,
control/provenance storage and final output allowance all consume the original
budget. Final library and actual REST/MCP envelopes are measured before audit
commit; remote limits can tighten them. Oversized results refuse delivery instead
of truncating citations or admitting an oversized best item.

Observed project/org generations are committed row state. Source and policy
changes advance them transactionally. Short snapshot/apply fences use current
dependency generations and scope rows, not allocation-order sequence MAX or a
timestamp cursor. A later lower-sequence commit remains dirty. A bounded cut or
new un-enrolled source records incomplete coverage and preserves the previous
processed watermark; its observed generation is not a claim that the stream was
drained. Large scopes can remain partial and require deliberate new refresh work.
No unbounded scan-progress, liveness or tenant-volume qualification is claimed.

Full refresh requests every section. Delta refresh recomputes affected sections
from the same current evidence inventory, and mechanically copies unchanged
blocks with their exact bytes/dependencies. New/removed families, changed
configuration or unknown dependency scope conservatively dirty the whole brief.
Canonical content identities preserve unchanged blocks during full regeneration
too. Deterministic fixtures converge; stochastic models require semantic/citation
convergence measurements, not promised byte equality.

Run, workflow, attempt, budget owner/generation and LOGIN binding attach before
hydration. The immutable workflow lifetime is at most 20 seconds, with a 30-second
lease and provider timeout at most 15 seconds. Time begins before the claim round
trip; database remaining duration and the local monotonic clock both bound work.
Provider I/O runs outside transactions. Apply locks the definition/head and
rechecks exact dependencies, source audience, enabled profile/configuration,
binding, lease, original settled attempt, deadline and head CAS. Versions, typed
dependencies, required audit and head movement commit atomically.

Crashes, stale leases, cancellation, failed settlement and restart park work
unavailable; they never replace identities, renew a deadline or refund ambiguous
maxima. There is no automatic provider retry or orphan-recovery API. Late actual
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

Quiesce old artifact readers/writers and privacy workers, back up data and both
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

The separately versioned `project-briefs-v1` evaluation measures actual persisted
deterministic full/delta mechanics, exact alignment, labels, unknown/contradiction
precision and false positives, complete budget receipts, p50/p95 and duplicate
extraction/absent connector ablations. Frozen v1 inputs and existing score gates
remain unchanged. Reports are synthetic mechanism evidence only. Real model
quality, live connector authority, paid cost, paired performance, normalized
storage and production acceptance remain unqualified.
