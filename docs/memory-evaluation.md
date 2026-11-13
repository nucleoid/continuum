# Memory evaluation

This source-checkout harness establishes synthetic mechanism evidence before
feature work. It changes no serving behavior, migration, grant or public API.
SHA-derived 768-dimensional local stub vectors test plumbing, not semantic model
quality. No private corpus, hosted provider, connector, model judge, credential
or live configuration is loaded. Missing future adapters are `not_supported`.
The evaluator, fixtures, runner and private reports are excluded from the public
npm package and container context; package smoke checks these exclusions.

## Running mechanisms and recording evidence

Use Node 22, the ordinary locked project dependencies, Git, and PostgreSQL 16
with pgvector. The disposable-test maintenance LOGIN needs CREATE DATABASE,
CREATE ROLE and migration-owner authority in newly created databases. Never use
a production connection. Each run creates one random database, applies the
existing migration chain, applies checksum-pinned standalone APP and bound
OP/SYNC grant scripts, and connects as real non-superuser LOGINs. Finally cleanup
drops only that database and its new roles. The named maintenance database is
never migrated or reset. Runtime reads use APP; approved personal erasure uses
bound OP; SYNC payload denial is checked. The harness needs no psql executable;
the complete repository suite separately requires real psql.

Ordinary `npm test` runs the mechanism checks even in a dirty checkout. Reports
record both start/end cleanliness, actual head, committed tree and parent commits.
Dirty or changed input is ineligible for acceptance. Mechanism tests do not skip
their database assertions merely because report publication is unavailable.

For a published baseline, commit the intended source and explicitly identify the
source commit. `.fire-off/` and generated CI report paths are Git-ignored.

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=384'
$env:CONTINUUM_EVAL_DATABASE_URL = '<disposable-test maintenance URL>'
$env:CONTINUUM_EVAL_SOURCE_SHA = git rev-parse HEAD
npm run eval:memory -- --manifest evals/offline-v1.json --output .fire-off/baseline.json
```

The CLI requires clean stable input, an explicit source identity and a new output
path. It writes bounded JSON and adjacent Markdown with no overwrite. Select a
fresh output name for each run. `CONTINUUM_EVAL_REPORT` requests the same checked
publication inside the database test; a dirty requested publication fails instead
of silently writing eligible evidence. Without that variable, dirty-tree mechanism
tests run normally. CI captures its report once inside the full suite and uploads
only the named baseline files, complete source coverage and package artifact.

## Frozen corpus and grading

`evals/fixtures/v1/manifest.json` pins synthetic status, reference clock, seed 25,
file hashes, split policy, relevance rubric, sampling policy, hard caps and the
user-approved relationship gate. Its SHA-256 is anchored in the loader. JSON bytes
are protected by `.gitattributes`. Loaded corpora are deeply frozen. Do not edit
v1 after its first publication; later changes require a new version and retained
predecessor reports. Pre-publication repairs invalidate earlier fixture hashes.

Every case has stable IDs, development/holdout membership, exact source versions,
graded relevance, prohibited versions, abstention, claim labels, chunks,
contradiction sets, relations and lifecycle events. Documents declare source and
assertion versions, copy families, code/non-code origin, controlled tags, scope,
source permission, state, residency and temporal metadata. Unknown fields,
unknown source references, inconsistent copies, contradictory labels, duplicate
IDs and oversized UTF-8 sources fail validation. Temporal anomalies are deliberate
future-adapter inputs, not implemented event-time reasoning.

The `relevance-v1` rubric applies to each question:

- Grade 3: directly answers the operational question with an operative record.
  Equally direct accounts of an unresolved conflict receive the same grade; no
  winner is inferred. Both Fjord timezone accounts are grade 3.
- Grade 2: complementary causal or implementation evidence needed to explain or
  verify the answer, rather than merely repeating it.
- Grade 1: useful diagnostic or historical context that does not establish the
  answer or authority. A last-successful-sync timestamp is context for membership
  freshness; an operator's name on a disable receipt is not freshness evidence.
- Grade 0: unapproved, rejected, superseded or disproven claims; unrelated topics,
  UI examples and disclaimers that merely state another procedure is independent.
  Moraine database recovery, Larch housekeeping reminders, Dune/Juniper dashboard
  descriptions and the disproven older Quill package account receive zero.

Twenty-four independently authored operational holdouts vary counts, grades,
lexical coverage, contradictions and decoy placement. Five separately authored
development cases use transcripts, tables and test observations. Some local
neighborhoods are empty or unhelpful; some direct answers have no outgoing edges.
Historical proposals and unrelated records can initiate supports, depends-on or
contradicts edges. Cross-topic links and bad imported keys are retained as noise.
Relation `basis` notes document the synthetic source-link observation for review;
they are withheld from adapters along with all relevance judgments.

The loader rejects graph features whose per-split relevance precision exceeds
.75 or lack both positive and negative examples: outgoing/incoming incidence and
each typed source/target incidence. A second negative control ranks the full
inventory without the query using those features and stable ID tie-breaks; its
maximum mean holdout nDCG must stay below .25. These are corpus shortcut checks,
not feature-acceptance thresholds or evidence that all possible shortcuts are
impossible. Reports retain the diagnostics. No model was tuned on holdout scores.

## Shared inventory and policy boundary

Ranking cases share one complete store per split. The service baseline seeds
that inventory; `retrievalInput(corpus, case)` supplies the same authorized live
inventory and its available-endpoint edges to a future fixture adapter. It never
selects a hand-picked per-question neighborhood. Other questions' sources compete
for rank and have zero relevance unless explicitly judged for the current query.
Non-ranking mechanism cases remain isolated. Baseline and candidate comparisons
must use the same inventory; each row records a rederived inventory hash.

The split-wide forbidden set unions scope/source denial, nonlive state, explicit
prohibitions, effective lifecycle events and execution-incompatible residency.
Unknown exact versions also fail delivery. These checks apply even when a query
returns another case's forbidden source. The baseline additionally checks the
actual delivered denied-scope identity. Cross-case regression tests cover source
denial, denied scope, stale/quarantined state and hosted/local-only incompatibility.
Authorization failure is independent of relevance and statistical improvement.

Adapter input contains only query, source id/version/title/body and typed source/
target references. It excludes grades, expected claims, abstention labels, policy
labels, relation curation notes and forbidden bodies. Complete serialized input
must fit 64KiB before invocation; output is bounded to 64KiB and ten exact
references, with a one-second adapter deadline. Exceptions and malformed output
are sanitized failures. External finite process containment remains necessary
for callbacks that ignore cancellation. No production graph is implemented;
fixture relations never enter memory metadata, capture candidates or AGENTS.md.
No `metadata.related` field is consumed.

Current SQL supports live, stale, archived and promoted memories, not quarantine.
A quarantined negative fixture is withheld from baseline admission, and its state
adapter is reported `not_supported`. Fixture policy checks are not a claim that
production quarantine or a future relationship feature is implemented.

## Scores and current services

Retrieval scores use exact versioned references, cutoff 10, gains `2^grade - 1`
and logarithmic rank discount. Precision charges duplicate slots; recall and
nDCG credit one assertion unit once. Copies share an explicit unit and family,
with consistent grade. Independent family coverage is separate. Unjudged sources
have zero relevance. MRR uses the first relevant rank. Undefined denominators are
JSON null, not perfect scores; empty/nonempty abstention errors remain explicit.

Claim scoring separately checks exact citations, implemented-fact/recorded-intent/
inference labels, unknowns, contradictions, unsupported assertions and chunk
coverage. Oracle and retrieved-evidence task runs diagnose reasoning failure
versus retrieval miss. These are structured fixture judgments, not an unimplemented
natural-language truth judge. Missing task adapters are `not_supported`.

The baseline measures lexical recall, hybrid RRF with local stubs and failed-vector
full-text fallback. It also exercises point reads, supersession, database-time
expiry, current membership revocation, canonical OP personal erasure, required
read audit delivery, generator selection/ETags and escaped reference-data blocks.
The erasure probe independently covers memory tombstones and all provider vectors;
canonical completion checks its wider lifecycle predicate. No independent private
outbox/audit payload residue claim is made. Vector-only, reranking, extraction,
synthesis, temporal, connector and relationship adapters remain `not_supported`.

## Latency and comparisons

The frozen `service-latency-v1` rule runs one warmup and five measured observations
per query and mode. Modes rotate in a seeded, interleaved order for each repetition.
Quality has one per-query mean, never five independent query samples. Latency is
the per-query median of five service deliveries; p95 uses those medians. Reports
retain service samples, observation count and execution-order digest.

Only the actual service call is timed, including the service's required audit
delivery. The audit identity fence precedes timing. Read audit IDs are checked
after timing, filtered by principal and fence, without growing count scans.
Generator verification reads happen after the timed rendered delivery and cannot
supply audit evidence for it. Scoring, serialization, audit SQL and repeat checks
are recorded separately as evaluator overhead. Erasure preparation is setup; its
residual-proof row does not claim timed serving delivery.

A future latency acceptance comparison must execute baseline/candidate in a
declared paired interleaved session on the same environment, with this same
sampling policy, inventory and caps. Missing/mismatched paired session or
environment identity yields `insufficient_evidence`. Current single-head baseline
reports have no paired session and do not satisfy that future gate. Repeating two
uncontrolled serial runs on different hosts is not latency acceptance evidence.

`experimentFromReport` derives scores, critical failures, medians, storage and
policy identity from bounded source evidence. `compareExperiments` rederives
them, requires every frozen holdout query, the predecessor feature head, identical
fixture/policy/budget hashes and exactly one changed mechanism. Missing adapters
stay unsupported. Scores, sample medians or inventory identities edited away from
their source evidence cannot establish acceptance. Reports are research artifacts,
not cryptographically authenticated; preserve exact-input execution receipts.

Source head and checkout head are distinct. Explicit source identity, clean stable
head/tree and matching source head are required for acceptance eligibility. CI
synthetic merge checkouts with a different PR source are ineligible. Parent commits
and CI event context are recorded. A legitimate committed default-branch merge is
eligible when its own actual head is explicitly identified and clean. Git ancestry
alone cannot infer whether a local merge was intended as synthetic; without an
explicit source identity the collector reports checkout-only provenance and
ineligibility rather than guessing that intent. Clean synthetic CI reports may be
published as mechanism evidence while remaining ineligible as predecessors.

The unchanged user-approved relationship-v1 gate requires hybrid plus reranking,
at least 5% relative holdout nDCG@10 gain, a paired 95% confidence interval strictly
above zero, at least 20 independent query pairs and 2,000 bootstrap samples at
seed 25. It also requires zero critical coverage/security/authorization/deletion/
quarantine/residency/supersession regressions, p95 at most 1.1x, identical work and
spend caps, and evidence storage at most 2x within the hard ceiling. A zero quality
baseline or zero storage-growth denominator is `insufficient_evidence`, never a
pass. Critical failures override statistical gains. This gate authorizes no graph
runtime or paid experiment and cannot authorize a different feature's acceptance.

## Bounds and storage

The frozen profile caps 100 cases, 12 stages, 512 output rows, 16KiB per source,
1MiB per JSON artifact, 120 seconds of setup and a separate 120 seconds of work.
It permits 50 candidates per lexical/vector branch, ten final hydrated results,
64KiB complete context/output per delivery, 1,024 stub calls including setup,
warmups and repetitions, no retries, no reserved/actual provider spend, and 16MiB
accounted persisted storage. Rows aggregate repeated observations, not silently
truncate them. Capacity is checked before database creation. Cancellation occurs
after the combined 240-second phase limit; use a finite 360-second external command
deadline including cleanup. The full source suite keeps its 1,200-second cap and
384MiB Node old-space limit. Forced termination can leave owned test resources.

Storage snapshots include all persistent user namespaces, ordinary/partitioned
tables, materialized views, sequences and their indexes/TOAST, plus large-object
data/metadata. Raw database size is also recorded. After empty migrated setup,
growth is the greater of relevant-relation growth and whole-database growth,
floored at zero. This catches catalog/other-schema growth without allowing a
different relation to hide known application growth. Accounted persisted bytes
are empty application allocation plus that growth. The unchanged 16MiB ceiling
applies to this conservative total; the 2x gate compares growth only. Fixed empty
database/catalog allocation cannot dilute amplification. All components and the
accounting equality are validated. No hard ceiling is silently raised.

Reports include actual runtime/version identity, fixture hashes, provider locality,
prompt/schema identity, flags, sample/unsupported/failed counts, service latency,
evaluator overhead, hydration, complete serialized bytes, calls, retries, spend,
storage components and provenance. Physical allocation and timing may vary;
fixture order, scores, policy and counts reproduce. Actual pre-fusion candidate
counts and model token usage are unavailable and remain null with declared
ceilings. They are not guessed from character counts. Raw content, raw errors
and connection strings are excluded. There is no live-quality or production
performance claim. Revert tooling to roll back; no serving migration, backfill,
reauthentication, reindex or session invalidation is needed.
