# Memory evaluation

This source-checkout harness establishes synthetic mechanism evidence before
feature work. It does not change serving behavior, add a migration, install a
provider, contact a model, or authorize a production feature. SHA-derived stub
vectors demonstrate plumbing, not semantic model quality. No private corpus,
credentials, model judge, or live provider configuration belongs in these files.

Build with Node 22 and restore the ordinary project dependencies. A PostgreSQL
16 server with pgvector and a disposable-test maintenance LOGIN is required.
The LOGIN needs CREATE DATABASE, CREATE ROLE and migration-owner authority in
the newly created database. Never supply a production maintenance connection.
The harness creates one randomly named database, applies the existing migration
chain, emulates the reviewed standalone SQL path of APP and bound OP/SYNC grant scripts, connects as three
real non-superuser LOGINs, and drops only its own database and roles in finally
cleanup. It never resets, migrates, or drops the database named in the URL.
No `psql` executable is needed for this harness; the complete repository test
suite separately requires it. Runtime reads use the APP connection; approved
personal erasure uses the bound OP connection. SYNC payload denial is checked.

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=384'
$env:CONTINUUM_EVAL_DATABASE_URL = '<disposable-test maintenance URL>'
npm run eval:memory -- --manifest evals/offline-v1.json --output .fire-off/baseline.json
```

Commit the intended source before capturing a report. The runner requires a
clean checkout, records the exact head, refuses an existing output path, and
emits JSON and adjacent Markdown. Use an ignored local output directory, or
exclude `.fire-off/` through local Git exclude. CI captures its baseline once
inside the PostgreSQL evaluator test, using the current Git head and a fixed
offline profile, alongside complete test coverage. No separate baseline step
can skip the full suite. Fixtures, the runner, compiled test helpers, private reports and
live configuration are excluded from the npm tarball and container context.
`npm run smoke:cli-package` checks that exclusion. Grant emulation is checksum-pinned
to the current scripts and fails on any change before removing psql directives.
It is not a general psql interpreter. The container tests independently cover
the packaged transaction-profile applier; this harness uses the standalone path.

## Frozen fixtures

`evals/fixtures/v1/manifest.json` pins schema, seed 25, reference clock,
file hashes, split policy, hard caps, and the relationship gate. Its SHA-256 is
anchored in `src/evaluation/test-helpers.ts`. JSON bytes are preserved by
`.gitattributes`. Editing a file and refreshing only its checksum fails the
manifest anchor. Future fixture or gate changes require a new version and
retained predecessor reports; do not update v1 after publication. Loaded corpora
are deeply frozen and comparison accepts only instances verified by this loader.

Every case declares a stable query/task ID, frozen development/holdout split,
operation, expected exact source versions and relevance grades, prohibited
versions, abstention, claims, chunks, contradiction sets, typed fixture relations,
and lifecycle events. Relation metadata stays in the evaluator and is never
persisted as production relation candidates or rendered into AGENTS.md.
Each synthetic document declares its source and assertion version, copy-family
ID, code/non-code kind, supported controlled tags, scope and source-document
authorization, residency, event interval and ingestion time. A copy family
identifies known reuse and does not assert independent truth. Malformed event
intervals are intentional cases for a future temporal adapter; missing version,
unknown fields, contradictory judgments, duplicated IDs and oversized UTF-8
payloads are schema failures. There is no random train/holdout reshuffle.

Cases cover empty/no-relevant/all-denied evidence, same-family copies,
contradiction, denied scopes, source-document denial despite assertion
visibility, expiry, revocation, personal erasure, explicit supersession,
instruction-like content, code and non-code sources, delayed ingestion,
malformed temporal evidence, partial chunks, unknowns, connector denial,
local-only routing, and future relationship expansion. The fixture reference
clock and seeded insertion order are fixed. PostgreSQL retains its real clock
for lifecycle authority: fixture expiry is set at the database-time boundary,
not by replacing production clocks. No current event-time reasoning feature is
implied by recording temporal fixture metadata. Ranking cases share one project
corpus per split, so unrelated sources compete across queries. Each query has
approved direct evidence, contextual evidence, a linked supporting relationship
without the query terms, and judged non-relevant proposals/retired-project
distractors. Varied titles and exact term counts avoid differently graded
lexical ties. Logical memory UUIDs and insertion order derive from the seed.

## Evaluator contracts and scores

`scoreRetrieval` accepts ranked exact `(id, version)` references and judgments
with grades 1 through 3. Cutoff defaults to 10. Precision divides unique relevant
hits by returned slots, so duplicate slots cost precision. Recall divides those
hits by all relevant exact versions. Evidence coverage divides represented
families by relevant families and reports the independent-family count
separately; copies cannot manufacture independent coverage. MRR uses the first
relevant rank. nDCG uses gain `2^grade - 1` and logarithmic rank discount against
the ideal judged ranking. Tied input ranks retain the adapter's delivered order;
equal-grade ties have equal gain. Repeated exact versions receive gain once.
Undefined denominators are JSON null, not perfect scores. Empty output with
relevant evidence and nonempty output without relevant evidence each register
an abstention error. Unjudged evidence has zero relevance, not implicit approval.

`scoreClaims` scores authoritative structured claim IDs, exact citation-version
sets, implemented-fact/recorded-intent/inference labels, unknown preservation,
contradiction preservation, claim recall, unsupported assertion rate, and
completed/expected chunk coverage separately. A stale citation is unsupported;
missing chunks remain partial. These are fixture-label judgments, not an
unimplemented natural-language truth judge. Missing expected claims cost recall;
an empty claim list has undefined precision/alignment. Optional future model
judges cannot override source policy, authorization, deletion, or exact-version
checks.

`evaluateTaskPair` runs the same bounded adapter with retrieved evidence and
policy-permitted oracle evidence. A correct oracle run with an incorrect
retrieved-evidence run identifies a retrieval miss; incorrect oracle citations,
labels, unknowns, coverage or abstention identify a reasoning failure. A
missing adapter is `not_supported`, never an empty successful answer. Adapter
exceptions, malformed output, byte overflow or a one-second per-stage deadline
are `failed`. The caller must contain arbitrary adapter processes externally;
JavaScript cannot stop an abort-ignoring callback. Prohibited or unauthorized
input, delivery, or citations fail the independent gate even with high quality.
Tests use deterministic fake extraction/synthesis adapters only as contract
evidence. No production extraction or synthesis adapter is registered.

The service baseline measures lexical recall, hybrid RRF with local stub vectors,
and failed-vector full-text fallback over identical cases. Other operations
measure full memory reads, explicit supersession, database-time expiry,
membership revocation, physical personal tombstones/all-vector erasure, required
read auditing, deterministic generator selection/ETags and escaped data blocks.
Generator checks use its independent shared service, not recall ordering.
The direct erasure residual query covers memory tombstones and all provider
vectors only. Canonical OP completion verifies the wider lifecycle predicate;
the harness does not manufacture private audit or outbox snapshots and does not
claim independent residue coverage for those absent payloads. It makes no
delivery claim from probing an administrator who already lacks user-scope access.
The three recall configurations repeat non-retrieval service checks; those rows
are mechanism repetitions, not independent statistical samples. Vector-only
recall has no shared-service selector and is `not_supported`. Reranking,
extraction, synthesis, temporal reasoning, source connectors and relationship
expansion are also `not_supported` until real feature adapters exist.

## Comparisons and acceptance

Capture the predecessor feature head before every later feature experiment.
`runBaseline` emits `experiments` for each measured recall ablation using
`experimentFromReport`. These records carry bounded source-report evidence and
derive every holdout sample, security outcome, p95 and storage measurement.
`compareExperiments(before, after, corpus)` requires the loaded corpus, exact
equality with its complete holdout query set, versioned inputs, predecessor identity,
identical fixture/policy/budget hashes, seed, runner, repetition rule and storage
budget. Exactly one feature flag changes; unchanged adapter versions must
match. It rederives values from the source reports and rejects hand-edited
scores, omitted queries, security outcomes and resource measurements. It rejects
input/gate drift and mismatched query pairs. A missing
adapter remains `not_supported`. `compareRuns` is the lower-level paired metric
primitive; missing resource measurements yield `insufficient_evidence`.
Reports record both the tested checkout `head` and the PR branch `sourceHead`.
Synthetic merge checkouts are marked `predecessorEligible: false` and cannot
establish an acceptance baseline. Preserve exact-head local or push baselines.
Research artifacts are not cryptographically authenticated; preserve their
provenance and reviewer evidence rather than accepting edited reports as truth.

Freeze the feature gate before observing results. The comparison contract uses
one paired mean per query, at least 20 independent query pairs, 2,000 seeded
paired bootstrap resamples, and a percentile 95% confidence interval. Repeated
model runs belong in each query mean, not as extra independent query samples.
Stubs do not prove model repeatability. The corpus has 24 varied recall holdout
queries with grades 3/2/3 for direct/context/linked evidence, plus five development
ranking queries and separate mechanism cases. Unapproved proposals and unrelated
retired-project sources have zero relevance. The linked evidence can improve
coverage as well as ranking. No graph adapter runs in the current baseline.
This synthetic set still may be insufficient for broader product claims. No baseline quality score
constitutes feature acceptance.

The user-approved relationship-v1 profile requires hybrid plus reranking as
its baseline, at least 5% relative holdout nDCG@10 gain, a paired 95% interval
strictly above zero, zero critical coverage regressions, zero security,
authorization, deletion, quarantine, residency or supersession regressions,
at most 10% higher p95 end-to-end latency, identical candidate/context/output/
call/spend caps, and at most 2x persisted bytes inside the same hard storage
budget. A zero baseline, missing measurements, insufficient samples, or missing
adapters cannot pass. Critical failures take precedence over statistical gains.
This profile authorizes neither graph runtime nor a paid experiment. It cannot
be reused as acceptance authorization for another mechanism; declare that
feature's gate first. Current lexical/hybrid/fallback records are measurements,
not an automatic feature acceptance comparison.

For another feature, publish its primary metric, minimum meaningful gain,
tolerated regression, independent critical gates, sample/repetition rules,
bootstrap seed and work/resource caps before executing its paired experiment.
Keep baseline and candidate reports with their exact repository heads and
fixture hashes. Do not tune on holdout or change more than one mechanism.

## Bounds and interpretation

The frozen profile caps 100 cases, 12 stages, 200 report rows, 16 KiB per source,
1 MiB per JSON artifact, 120 seconds of measured run work, 50 candidates per
lexical/vector branch, 10 hydrated final results, 64 KiB complete serialized
result context/output per row, 1024 stub calls including setup, zero retries,
zero reserved/actual provider spend, and 16 MiB application storage. The runner
signals cancellation after 180 seconds and lets isolated cleanup run; external finite command deadlines are still
required for database provisioning/cleanup. Forced external termination can
leave disposable resources; cleanup disables leftover LOGIN roles when possible.
The runner reports bounded allow-listed failure codes without raw errors.
PostgreSQL runtime statements are
limited to five seconds and lock waits to one second. Owner setup statements
have 60-second/5-second limits. No trace is printed or silently truncated.

Reports contain head, schema/fixture hashes, runner, seed, provider identity,
dimension/locality, prompt/schema identity, flags, sample/unsupported/failed
counts, measured p50/p95 latency, hard failures, hydration counts, complete
serialized context/output bytes, calls, retries, spend and persisted bytes.
Latency and physical index/TOAST allocation are measured fields and can vary;
seeded fixture ordering, scores, coverage, counts and policy identity reproduce.
Raw content, raw provider errors and connection strings are excluded.
Actual pre-fusion candidate counts and model token usage are unavailable in
current services; they are null with declared ceilings and unsupported
tokenization. They are not guessed from character counts. Storage includes
all application tables in the isolated database and their indexes/TOAST, including
memory, vectors, audits and all receipt/state tables, so future graph tables
cannot silently escape the measurement;
amplification needs a paired run and is null in a single baseline. Latency
includes service audit delivery and evaluator checks but excludes setup,
supersession/erasure preparation and database cleanup. It is a local synthetic
baseline, not production latency or full future-pipeline timing evidence.

Any future live evaluation requires a separately approved non-sensitive corpus,
explicit provider/model/connector and prompt/schema versions, permitted
residency, finite call/token/spend limits, usage reconciliation, repeated paired
runs and independent security checks. Unknown usage/cost is incomplete evidence,
not zero spend. The offline runner rejects live profiles and never loads their
configuration. Revert this tooling to roll it back; there is no migration,
backfill, reindex, permission change or session invalidation for serving nodes.
