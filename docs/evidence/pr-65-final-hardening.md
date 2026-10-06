# PR 65 final hardening evidence

This receipt records every bounded Node, npm, TypeScript, Vitest, and project-code
invocation performed during the final issue 34 hardening pass. Commands are run
serially through the repository's required cgroup wrapper. Vitest invocations
use one worker and disable file parallelism. No full suite is run.

The originating incident involved an unbounded Vitest process tree observed at
approximately 3.2 GB. These commands use a 768 MiB memory limit, 128 MiB swap
limit, a 384 MiB V8 old-space limit, and an explicit wall deadline.

## Receipts

Receipts are appended after each invocation with command, systemd unit,
result/exit status, service runtime, CPU time, memory peak, and swap peak.

1. `CONTINUUM_WALL_SECONDS=120 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/embeddings/ollama.test.ts --maxWorkers=1 --no-file-parallelism'`
   - Unit `continuum-bounded-3589675-1791273566445096918.service`; invocation `f10fee63063c44ca840996cc3f2a75cb`.
   - Success, exit 0; 1 file, 26/26 tests; Vitest 9.35s; service 12.654s; CPU 1.172s; memory peak 320.0K; swap peak 0B.

2. `CONTINUUM_WALL_SECONDS=180 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/storage/recall.test.ts --maxWorkers=1 --no-file-parallelism'`
   - Unit `continuum-bounded-3598612-1791273594803647209.service`; invocation `d4f17a4f70934d01b39db96cb63ac660`.
   - Success, exit 0; 1 file, 12/12 tests; Vitest 3.59s; service 4.511s; CPU 1.481s; memory peak 328.0K; swap peak 0B.

3. `CONTINUUM_WALL_SECONDS=300 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/maintenance/embed-backfill.test.ts --maxWorkers=1 --no-file-parallelism'`
   - Unit `continuum-bounded-3599658-1791273612307420984.service`; invocation `a3c45c44e2e94280ae5ce43ea22beb97`.
   - Exit 1; 47/50 passed. Three regressions exposed two cursor-finalization bugs and missing top-level partial-invalid suspect recording; service 18.812s; CPU 3.240s; memory peak 484.0K; swap peak 0B.

4. Same command as receipt 3 after the first fixes.
   - Unit `continuum-bounded-3601007-1791273649315967339.service`.
   - Exit 1; 48/50 passed. It exposed that suspect cursor retention retried the same row inside one invocation and that transient partial-invalid vectors must retain their one-item retry; service 13.506s; CPU 3.017s; memory peak 1.3M; swap peak 0B.

5. Same command as receipt 3 after same-run suspect suppression and partial-invalid retry restoration.
   - Unit `continuum-bounded-3602944-1791273688806935780.service`; invocation `dff351af336a4fe7ba2a88110070b868`.
   - Exit 1; 49/50 passed. Product behavior was correct; the recovered regression's one-call assertion contradicted the preserved one-item retry contract and was corrected to assert `[3, 1]`; service 11.985s; CPU 2.966s; memory peak 404.0K; swap peak 0B.

6. Same command as receipt 3 after correcting the recovered assertion.
   - Unit `continuum-bounded-3608247-1791273722538314805.service`; invocation `bf229ed53b5d446b81f531fdabeb4c06`.
   - Success, exit 0; 1 file, 50/50 tests; Vitest 14.33s; service 15.427s; CPU 3.345s; memory peak 408.0K; swap peak 0B.

7. `CONTINUUM_WALL_SECONDS=240 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/storage/migrator.test.ts --maxWorkers=1 --no-file-parallelism'`
   - Unit `continuum-bounded-3614573-1791273746838450398.service`; invocation `25604a6cb1ec4d7e80e7972a8738c56f`.
   - Exit 1; 13/14 passed. The sole failure was the now-obsolete historical-audit seeding test; no released supported upgrade source exists for those rows, so the test was removed with the scan; service 2.506s; CPU 1.496s; memory peak 0B; swap peak 0B.

8. Same command as receipt 7 after removing the unsupported seed regression.
   - Unit `continuum-bounded-3617566-1791273769900368495.service`; invocation `b7c036a77d73419d8e968d4dfb474595`.
   - Success, exit 0; 1 file, 13/13 tests; Vitest 1.37s; service 1.995s; CPU 1.321s; memory peak 468.0K; swap peak 0B.

9. `CONTINUUM_WALL_SECONDS=180 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/tsc --pretty false'`
   - Unit `continuum-bounded-3617974-1791273779762856904.service`; invocation `ce64a7c855344f91b9de9c1ebb0cc4bc`.
   - Exit 2; TypeScript correctly rejected the existing protected hosted-provider timeout against the new public provider deadline contract; service 5.638s; CPU 7.829s; memory peak 476.0K; swap peak 0B.

10. Same command as receipt 9 after exposing the hosted timeout as public read-only provider metadata.
    - Unit `continuum-bounded-3618521-1791273795373642590.service`; invocation `4ef850faed3441d4bf6cf33fbda8d3fb`.
    - Success, exit 0; service 6.478s; CPU 7.809s; memory peak 480.0K; swap peak 0B.

11. `CONTINUUM_WALL_SECONDS=300 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/embeddings/factory.test.ts src/embeddings/hosted.test.ts src/embeddings/ollama.test.ts src/maintenance/embed-backfill.test.ts src/maintenance/embed-backfill-cli.test.ts src/storage/embeddings.test.ts src/storage/migrator.test.ts src/storage/recall.test.ts --maxWorkers=1 --no-file-parallelism'`
    - Unit `continuum-bounded-3620311-1791273840435340615.service`; invocation `06da78aaaa144fa99ddea9a2e2130685`.
    - Exit 1; 169/170 passed across 8 files. Product tests passed; the new no-wrap fixture omitted its required explicit `providerId`; service 16.445s; CPU 5.427s; memory peak 472.0K; swap peak 0B.

12. Same command as receipt 11 after fixing the fixture.
    - Unit `continuum-bounded-3621602-1791273873146465653.service`; invocation `c2b6fe0b95a74313afa9d3c60877e634`.
    - Exit 1; 169/170 passed. The regression exposed that end-of-range completion cleared a deliberately retained unresolved cursor; service 16.069s; CPU 5.415s; memory peak 324.0K; swap peak 0B.

13. Same command as receipt 11 after preserving unresolved end-of-range checkpoints.
    - Unit `continuum-bounded-3622892-1791273906541884002.service`; invocation `e01841f51b9042b3bafefbc22e2f5bd1`.
    - Success, exit 0; 8 files, 170/170 tests; Vitest 15.73s; service 16.577s; CPU 5.365s; memory peak 296.0K; swap peak 0B.

14. Same command as receipt 9 at final source state.
    - Unit `continuum-bounded-3624937-1791273955136653190.service`; invocation `9746eaff03464c5ab2a03505d9415998`.
    - Success, exit 0; service 5.864s; CPU 7.368s; memory peak 324.0K; swap peak 0B.

## Remote-head reconciliation and exact-head verification

Before publication, the remote branch had moved from the requested lease point
`28e55f7676862f15fdfdac8c8d3056c4336616eb` to
`3c87f319756172dc4e9fe9a94147c3c67bc5f164`. Stable patch IDs proved that
those two commits contain the same issue-34 change (`a5eb5f0ba5579aff4e4d17aa621ab0cc85a5fe58`);
the latter is the same patch rebased onto newer `master` work. The one local
final-hardening commit was therefore rebased onto `3c87f31` without conflict,
preserving the newer base instead of overwriting it.

15. `CONTINUUM_WALL_SECONDS=300 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && ./node_modules/.bin/vitest run src/embeddings/factory.test.ts src/embeddings/hosted.test.ts src/embeddings/ollama.test.ts src/maintenance/embed-backfill.test.ts src/maintenance/embed-backfill-cli.test.ts src/storage/embeddings.test.ts src/storage/migrator.test.ts src/storage/recall.test.ts --maxWorkers=1 --no-file-parallelism'`
    - Unit `continuum-bounded-3633332-1791274143873929653.service`; invocation `24360b0d0ed74db883b2ae58d814e922`.
    - Success, exit 0; 8 files, 170/170 tests; Vitest 19.49s; service 19.913s; CPU 5.052s; memory peak 324.0K; swap peak 0B.

16. `CONTINUUM_WALL_SECONDS=180 /home/fuego/.openclaw/workspace/artifacts/continuum-bounded-run.sh /bin/bash -lc 'cd /tmp/continuum-issue-34 && npm run build'`
    - Unit `continuum-bounded-3635395-1791274168907169573.service`; invocation `b41e658db3d646708065137c3c52136c`.
    - Success, exit 0; TypeScript build completed; service 5.152s; CPU 7.655s; memory peak 468.0K; swap peak 0B.
