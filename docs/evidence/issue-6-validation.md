# Issue 6 embedding validation

This receipt records fresh local validation for [issue #6](https://github.com/nucleoid/continuum/issues/6) and [PR #9](https://github.com/nucleoid/continuum/pull/9). It does not claim public CI success or a production deployment.

Executed source: `b64b1fe3d45475554d0306e76cc699e1be581a9c`. The evidence was produced from an immutable Git snapshot. This receipt is a documentation-only follow-up; application, migration and test bytes remain those of the executed source.

## Full validation

The contained Linux run built TypeScript, migrated a fresh database through 0088 and ran the complete suite:

```sh
npm run build
node dist/storage/migrate-cli.js
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism --hookTimeout=180000
```

| Result | Observed value |
| --- | --- |
| Test files passed | 150 |
| Tests passed | 1,602 |
| Existing psql-dependent skips | 2 |
| Failed tests | 0 |
| Reported suite duration | 661.02 seconds |
| Process exit status | 0 |
| Container OOM termination | None |
| Unhandled errors | None observed |

The Node build/test container enforced 768 MiB RAM, 128 MiB additional swap, a 384 MiB V8 heap limit, two CPUs and a 256-process limit. Tests used one worker without file parallelism. An external 3,600-second process deadline sent termination followed by forced termination after ten seconds if needed. These limits describe the build/test container, not a measured aggregate memory peak across the laptop or the separately managed PostgreSQL fixture.

Published migrations 0001 through 0083 remained unchanged. Fresh migrations 0084 through 0088 completed using the current checksum and execution-provenance guards.

## Focused acceptance

Additional contained runs passed the following proofs:

- Manual failure marking transferred no title/body. SQL hydration admitted current text sizes below the 4 MiB aggregate bound even when rows grew after the ID scan, then processed deferred rows without replaying stored prefixes. A held memory-row lock self-bounded while an unrelated provider progressed.
- Recall reserved only the remaining shared budget for each catalog/distance query. Checked-out clients retained caller transactions, settings, uncommitted data and locks through successful groups, SQL failure, timeout fallback and concurrent recall calls. SQL cleanup completed before hydration, and provider IO that ignored abort was not joined.
- Concurrent providers persisted separate vectors for one memory without a lock upgrade deadlock. Wall-clock expiry while a writer was row-blocked and archive winning before unlock both prevented persistence. Direct archived-memory insertion still failed at the published database guard.
- Interrupted primary-key attachment rolled back to the original key with vectors intact, then canonical retry succeeded. An interrupted scan-index ledger write retried without replacing the valid artifact. A real matching INVALID index was repaired, while a valid wrong-shaped index was rejected without being dropped.
- Existing APP/OP profiles retained their role/provider identities and received the intended durable-table rights. Real authenticated CRUD, startup verification and regrant passed; SYNC/reporting access remained denied. The compiled backfill main accepted valid APP/OP roles and rejected configured-schema mismatch and actual privilege drift without repairing it.
- API and service diagnostics, deterministic AGENTS.md generation, provider validation, package installation, packaged migration artifacts, the installed backfill entrypoint and entrypoint probes passed. Package and entrypoint validation preceded the final test/documentation-only follow-ups; production and harness bytes did not change afterward.

The focused core/review run passed 290 tests, the rollout suite passed all 44 cases, the storage-boundary suite passed seven cases, and the corrected offboarding/bootstrap suites passed all 59 cases. Complete independent source review of `9276425f7239ee3c461861b3fcb3af6f60ca55d2` and the subsequent documentation source review of `b64b1fe3d45475554d0306e76cc699e1be581a9c` returned ship. This receipt was added afterward and is not covered by those earlier approvals.

## Historical evidence boundary

Earlier process-memory runs that escaped their intended containment are invalid measurements. The earlier 3.22 GB incident has no established measured root cause. Fresh bounded validation establishes the tested behavior under the stated limits; it does not retrospectively validate those measurements or prove the cause of that incident. No live deployment, GPU performance or hosted-provider capacity result is claimed.
