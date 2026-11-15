# Bounded relationship experiment

Decision: **inconclusive, no graph runtime authorized**. The frozen experiment
completed 360 measured observations plus 72 warmups across 24 independent holdout units at source commit
`e830a37ff849ffabbc0844f47c102184cea4c3a2`. All 15 focused Linux tests passed.
The synthetic gain does not establish eligible model quality, end-to-end latency
or normalized storage benefit. Close this evaluation without production graph
code; the preregistered gate does not justify serving complexity.

The [versioned result](../evals/relationship-result-v1.json) publishes all paired
query/mode rows, uncertainty, source identity, input hashes and raw-report digest.
Typed links improved synthetic nDCG@10 by 7.91% relative to both seed-only and
matched extra-candidate controls. The paired 95% bootstrap interval for the
absolute nDCG difference was [0.02009, 0.10394]. There were no observed fixture
security failures, critical coverage regressions, unmatched controls or fallbacks.
The run made 864 adapter calls plus 93 setup calls, with zero paid spend.
The matched control was rank-identical to seed-only in every query/repetition.
Under this unqualified reranker it could not separate candidate-count effects
from link semantics; the comparisons are diagnostic rather than that proof.

Both comparisons remain `insufficient_evidence`: the SHA/overlap baseline is
unqualified, audited end-to-end service timing was not measured, and total
persisted evidence/index/receipt amplification was not normalized. The 5,072,376
persisted diagnostic bytes include 3,874,816 bytes of empty-schema allocation;
they cannot establish the 2x storage gate. These fixture outcomes do not prove
production concurrency or physical erasure. The original report-input file is
the preserved preregistration-time preparation snapshot, not the measured result.

The experiment reuses the actual [memory evaluation](memory-evaluation.md)
loader, frozen corpus, relevance scorer, family coverage, paired bootstrap,
latency policy, isolated PostgreSQL fixture, storage accounting and resource
envelope. It uses the existing hybrid candidate selector and bounded reranking
runner. Existing corpus, assertions, gates, helpers and migrations are unchanged.
All prototype code resides in `src/evaluation/relationship-experiment.test.ts`,
outside compiled/package/container output. No API, schema, serving recall,
generated AGENTS.md or public exports change.

`evals/relationship-preregistration-v1.json` freezes exact predecessor heads,
the original corpus manifest, new ledger bytes, profile, all 24 holdout and five
development IDs, modes, limits, repetitions and decision rules before any run.
Its hash is pinned in the test. Development cases are not measured as holdout.
Changes to these inputs require a separately versioned registration before a
new run, with earlier reports retained. No parameter selection from holdout
scores is permitted.

The unchanged `relationship-v1` gate requires at least 5% relative holdout
nDCG@10 improvement over the strongest eligible hybrid plus reranking baseline,
paired 95% confidence interval strictly above zero, at least 20 independent
query/source-family units, 2,000 bootstrap resamples and seed 25. Repetitions
are averaged within each query; queries sharing judged source families are
collapsed into connected components before uncertainty estimation. Duplicate
assertions retain the original scorer's single-credit rule. Repeated calls,
edge counts and duplicate source families cannot increase independent N.

There must be no evidence-coverage regression on any declared critical holdout,
and zero security, authorization, deletion, quarantine, residency or supersession
failures. The p95 end-to-end latency ratio must be at most 1.1, with identical
candidate/context/output/call/spend ceilings. Total persisted evidence, indexes
and receipts, including failed/retried work at equal corpus volume and retention,
must be at most 2x baseline and within the unchanged 16 MiB hard ceiling. Zero
denominators, missing qualified baselines or missing resource evidence cannot pass.
No paid budget or provider probe is enabled.

The three paired arms are seed-only hybrid plus deterministic reranking,
explicit typed one-hop expansion, and an extra-candidate control. Each starts
from the same complete authorized split inventory and actual RRF selector. The
baseline reranks the first 20 candidates. Expansion considers at most ten seeds,
five metadata-only edges per seed and 50 deduplicated additions within the
100-identity aggregate allowance. The control takes the same additional count
from the remaining hybrid candidates, in hybrid order. Insufficient control
candidates trigger whole-stage fallback rather than an unequal comparison.
Reranking sees query and admitted source text through request-local aliases;
it sees no relevance grades, topology, edge type, confidence or curation notes.

Only authored `decision-supersession` and `evidence-dependency` fixture ledger
records are considered. Each carries exact source/target versions, snapshot
hashes, direction, scope, policy version, generations, lifecycle and expiry.
The ledger is a synthetic input, not a claim that the original corpus contains
canonical persisted relationship authority. Original supports/contradicts edges
and capture `metadata.related` are never promoted into typed links. Family and
record counts do not represent truth probability. Topology-only incidence and
ranking diagnostics are reported; they cannot exclude query-conditioned shortcuts
in an authored fixture set or qualify real semantic benefit.

Fixture headers gate current version, scope/source permission, generation,
lifecycle, expiry, residency and hard temporal eligibility before body hydration.
Metadata byte sizes reserve hydration before reading bodies. Source policy is
rechecked before reranking and delivery, and links are rechecked after inference.
Cycles do not recurse. Invalid metadata, unavailable dependencies, budget failure,
timeout or changed authority restore the independently current baseline as a whole.
Cancellation suppresses delivery; late callbacks cannot resume hydration or apply
scores. Diagnostics contain bounded categories without hidden identities or raw
errors. These fixture checks do not prove the locked database concurrency,
physical erasure or provider-disclosure contracts of a future serving consumer.

To reproduce the focused run, use a clean source checkpoint, an exclusive
validation slot, the existing locked dependencies, complete predecessor Git
history and a disposable
PostgreSQL 16/pgvector maintenance connection:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=384'
$env:CONTINUUM_EVAL_SOURCE_SHA = git rev-parse HEAD
$env:CONTINUUM_RELATIONSHIP_EVAL_REPORT = '.fire-off/relationship-eval.json'
# Set CONTINUUM_TEST_DATABASE_URL through the existing private test configuration.
npx --no-install vitest run src/evaluation/relationship-experiment.test.ts --maxWorkers=1
```

Use a finite external 360-second deadline including cleanup. The database fixture
requires the existing CREATE DATABASE/ROLE and migration-owner test privileges;
runtime candidates use its actual APP LOGIN. It creates and cleans only its own
random database/roles. The frozen maximum is 1,024 total local adapter calls,
including setup and warmups, with 120 seconds each for setup and measured work.
An explicitly requested `CONTINUUM_RELATIONSHIP_EVAL_REPORT` is written
exclusively; select a new path or preserve a previous report before requesting
the same path again. Default `npm test` still executes the complete experiment
and assertions, without persisting a successful experiment report. No raw bodies
or credentials are included in the report. An incomplete run fails, never skips.
An ordinary setup, measurement or delivery-assertion failure preserves completed
observations and the active attempt's known resource usage before propagating the
failure. Without an explicit report path, failure evidence is retained in a new
private `.fire-off/relationship-failure-*/report.json` directory. Its report marks
execution incomplete and cannot enable graph runtime.
Forced process termination can prevent final report creation; retain the process
log as incomplete evidence. A repeated output path fails without replacing the
earlier report.

On the asynchronous embedding schema, fixture setup explicitly approves the
synthetic descriptor and exact scope route through its bound OP session, then
retains original source admission before preparing each vector through APP.
These current schema prerequisites do not change the frozen corpus, ledger,
profile, thresholds or historical result. A new run records its own current
source identity and resource evidence; it cannot relabel the earlier measurement.

One warmup and five measured repetitions run in seeded rotating interleaved mode order.
Reports retain exact input hashes, source/checkpoint cleanliness, execution order,
per-query scores, coverage, abstention, fallbacks, resource charges and topology
diagnostics. Candidate lookup plus fixture prototype timing is **not** an audited
end-to-end service measurement. Whole-database allocation/growth is diagnostic,
**not** normalized evidence/index/receipt storage. Both acceptance fields remain
null. Stock reranking is disabled; SHA embeddings and the local overlap reranker
are unqualified for model quality. No arithmetic result overrides these limits.
The report therefore cannot authorize serving graph work, even with a positive
synthetic score. The existing #25 acceptance fence is preserved.

Enabling a future graph requires an eligible baseline, verified paired service
timing, normalized total persisted storage and actual current-policy/lifecycle
concurrency evidence. This inconclusive result authorizes no integration phase.
The result artifact records focused validation at its own source commit; it
does not substitute for final-source, Windows, package/CLI, container, hosted
checks or independent review of the experiment change.

There is no reauthentication, session invalidation, configuration/secret change,
provider permission, migration, backfill, reindex or deployment. Rollback removes
the experiment files; serving and generated AGENTS.md behavior remain independent.
Private reports require their own retention and erasure policy.
