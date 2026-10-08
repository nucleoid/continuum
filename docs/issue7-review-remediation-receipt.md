# Issue 7 DO NOT SHIP remediation receipt

Date: 2026-10-07 UTC

## Repository identity and sequencing

- Repository: `nucleoid/continuum` (`R_kgDOU9y0tQ`), public.
- Branch: `feature/7-coordination-leases`.
- Reviewed input HEAD: `ac22cfd6da36c7738d61fdf30a22f76c4cd58d6d`.
- Reviewed input tree: `73322c875ddaf5dd17b6db79001c39837ceb4d1b`.
- Merge base: `7bfedb7a00ae5f2b28dd349324bbf4f7cd197874`.
- Tests/docs-only RED: `1116d32340a73387bf5bb72f42eba67830e78cc5`
  (tree `ddfbda00e604b81da70fe9f8f185944998f0fd02`).
- GREEN commit and tree are reported after the commit because a commit cannot
  contain its own hash.
- No remote feature branch existed at start. No archive checkout or archived
  content was used.
- No reset, rebase, force, squash, dependency, workflow, package-manifest,
  lockfile, push, PR, merge, deployment, visibility, or external-review action
  was performed.

RED was committed before production implementation. Under the hard resource
wrapper, passing controls remained green while the new tests materially exposed
all four reviewed defects: incomplete real CLI commands exited zero; detached
receipt purge blocked behind the shared usage row and shared-scope lock order;
the production four-argument discovery function read 351,668 buffers with
50,000 clean completed rows; and full-chain CRLF execution failed in migration
0065 while a tampered published 0072 was not rejected.

## Implemented repair

- Non-dry-run incomplete offboarding and privacy-repair CLI outcomes now use
  exit 3 for typed blocking (`live_lease`/`lock_busy`) and exit 2 for other
  incomplete outcomes. JSON output retains progress, reason, and resume state;
  complete and dry-run outcomes remain exit 0.
- Forward migration 0073 installs a dirty-principal index maintained by the
  relevant principal, audit, progress, receipt, and lease mutations. Production
  four-argument discovery merges pending progress with eligible dirty markers,
  applies stable cursor/target restrictions before limiting, and does not scan
  clean completed principals.
- Privacy cleanup now follows one global order: principal, sorted scopes, then
  sorted detached usage. Advisory acquisition is try-lock based and usage-row
  acquisition is `NOWAIT`; contention returns the typed `lock_busy` resume
  result rather than waiting without bound. Receipt deletion remains bounded.
- Migration SQL is canonically executed with CRLF normalized to LF. Checksum
  verification remains byte-policy strict: the published LF checksum also
  accepts the same file encoded with CRLF, while lone/extra CR bytes and all
  substantive changes still fail.
- Package smoke now requires migration 0073 and `docs/coordination.md` in the
  packed artifact. The intentional package-manifest addition is preserved.

## Migration integrity

- New `0073_coordination_bounded_discovery_and_locking.sql` SHA-256:
  `b2f96e35511e563cc9890d871d3910d70a3d99856e233f4da9b151405ef72e7b`.
- Published 0072 is newly pinned at
  `9e763a73e16e16ed8b37c9d7c6654f56f62ae96ef62eb9b004ad2b325cd1d4a9`.
- Published migrations 0054 through 0072 are byte-identical to the reviewed
  input and match their recorded SHA-256 values. No published migration was
  rewritten.
- Full LF and CRLF chains, custom-schema installation, reruns, role grants, and
  0072 tamper rejection passed in the 57-test migration/ACL matrix.

## Accepted validation receipts

Every accepted run used one Vitest worker/no file parallelism where applicable,
`NODE_OPTIONS=--max-old-space-size=384`, `MemoryMax=768M`, and
`MemorySwapMax=128M`. Observed swap peak was 0 B in every run.

| Invocation ID or unit | Result | Runtime | Peak | Evidence |
|---|---:|---:|---:|---|
| `42ce545878264c1983dbdfa85a8d404e` | expected RED | recorded by wrapper | 256 KiB | eight genuine review failures with passing controls |
| `3ad41ddcb47e46fda8ebf8e80192ce50` | expected RED | recorded by wrapper | 324 KiB | real shared-scope contention timeout |
| `4002f4dd68a7431280814a9db49649ea` | pass | recorded by wrapper | 328 KiB | focused review remediation 8/8 |
| `1612da54bfd147d585824950f2760beb` | pass | 33.406 s | 604 KiB | dedicated DB coordination/offboarding 36/36 |
| `cfc977ce78344019829032a7264aecaa` | pass | recorded by wrapper | 328 KiB | migration/custom-schema/rerun/grant matrix 57/57 |
| `81376d0c5b2149ebab5d3e2961a0dcc9` | pass | recorded by wrapper | 584 KiB | corrected adjacent expectations 2/2 |
| `890b7a708810469085823498bb96c3ea` | pass | recorded by wrapper | 0 B reported | dedicated coordination harness 4/4 |
| `b82543c67b4f45518671eda1cc2123f3` | pass | recorded by wrapper | 320 KiB | dedicated REST lock routes 2/2 |
| `f9c1fddcdba94cacaaa5b4a0a3ecf186` | pass | 23.251 s | 328 KiB | dedicated REST/MCP parity 63/63 |
| `ca01c8a83ec649d09d312087051f13e4` | pass | 5.813 s | 264 KiB | final TypeScript build |
| `987d1105a47d4f25bb1a0fad5e1f49e8` | pass | 12.549 s | 512 KiB | packed CLI install/runtime smoke |
| `92496d1f10404f09a867138005735d95` | pass | 7.223 s | 332 KiB | `npm pack --dry-run --json`, 297 entries |

The focused production test calls the actual four-argument function under
`plan_cache_mode=force_generic_plan` with at least 50,000 clean completed rows
plus dirty rows. It asserts returned rows, fewer than 2,000 shared buffers, and
an observed scan of the pending-progress partial index. The same dedicated run
also covers stable cursors across reactivation and later mutation, multi-batch
progress, complete success, live-lease resume, direct SQL detached-usage
contention, and two principals sharing a scope.

## Excluded receipts

- `8cf7bdf11f86436ab9e3204662a0af15`: wrapper lost its working directory before
  tests; setup only.
- `56402467e54449db838f8b1cefd070e5`: invalid fixture violated a constraint
  before the contention behavior; setup only, then corrected in RED.
- `720310f17d464b519aac076d5f7683cb`: initial GREEN had an inadequate plan
  assertion which revealed that a helper configuration hid planner inlining;
  implementation and test were corrected and rerun against production SQL.
- `0127f2f3c66f4f85997edd4c8afef4d9`: one custom-schema regression in the first
  migrator run; corrected, then covered by the 57/57 matrix.
- `a131d859abe94b10acb4025d616a85ee`: two stale adjacent expectations; source
  behavior was correct and the corrected tests passed separately.
- `c0fbbcfc09bd41b1b36c01271e4d9c29` and
  `b19570b890b04fcbac21004e79b18519`: broad shared-database runs were
  contaminated by role/schema state and setup races. They are not acceptance
  evidence.
- `696c0d26405847efb10ad9be29d8bda5`,
  `0becbdd73a2a491897c7e31b4f5ff503`, and
  `93e979b49d5f4ec299523b6d051a5caa`: dedicated API/MCP commands constructed an
  invalid database URL before hooks. The corrected invocation is the accepted
  63/63 run above.

No shared or contaminated database result is used for acceptance. No hosted
Windows runner or independent reviewer was invoked. The CRLF contract is
covered by converting the complete migration chain in the test fixture and
executing that chain, not by source-text proxy. Final commit/tree, protected
file parity, and clean status are reported after commit.

## Second-review addendum

The fresh review of input HEAD `03c50646b106d29fea671d5bac109b436d73ff9f`
produced tests/docs RED `d72e15ae4df0b80d0ffe459fdf30b882df729bd9`
(tree `dff66697c0f0a558bf681755974878d738f9f45e`). Forward migrations
0074 and 0075 add explicit mixed-version contention refusal, lifecycle-indexed
repair discovery, stored-CRLF repair, and a concurrent-index/restartable
backfill. The migrator verifies pinned bytes before pending SQL and defers the
published 0073 bulk backfill to 0075 without changing 0054 through 0073.

Accepted second-review receipts include: focused RED 1 control/3 failures;
focused remediation and real 0064-CRLF/reconnected backfill 6/6; exact-head
two-session contention and mixed-version refusal 6/6; migrator fresh, upgrade,
CRLF, checksum, custom-schema, and grant coverage 44/44; independent
contention 10/10; REST/MCP/offboarding/CLI adjacency 128 passed/1 intentional
skip; production `force_generic_plan` with 50,000 clean/reactivated rows 1/1;
TypeScript build; packed CLI install/runtime smoke; and npm pack dry-run.

Excluded second-review receipts are the expected RED run, implementation
iterations that exposed and corrected `max(uuid)`, stale version constraints,
and old direct-SQL test negotiation, plus a whole-suite run invalidated by
shared test-database bloat and two unrelated sync-role retirement failures.
Those two failures reproduce in their isolated rotation-security file and no
rotation, identity, workflow, lockfile, or grant-script production source was
changed by this remediation. They are residual repository/test-environment
risks, not acceptance evidence for issue 7.

## Final upgrade/scale remediation addendum (2026-10-08)

This addendum supersedes the residual-risk statement immediately above. The
full rotation-security file now passes on the final implementation, and the
previous 40/42 result has a demonstrated fixture-state cause.

### Frozen commits and trees

- Required starting HEAD: `1a3390b3e85fe85c4ae2955d0bba4de1dea00a8a`
  (tree `427ddacbbeeb834ce6a062f610898e06d14ff361`).
- Merge base: `7bfedb7a00ae5f2b28dd349324bbf4f7cd197874`.
- Deterministic tests/docs RED:
  `afda9c2351af7a7e7f4810be704625ac887160ff`
  (tree `c233af2f5247c72781be642621514cfcc1d70473`).
- GREEN implementation:
  `be9996d363bb4565368c35d8c2e70fe0443af48f`
  (tree `70899cf0bc98657fe9301155cc94f919e9eca7b2`).

The GREEN implementation adds only forward migrations 0078 and 0079. It does
not alter package-lock, workflows, generic runners, package manifest behavior,
or migrations 0054-0077. The latter range is byte-identical to starting HEAD;
`git diff` over the 24 exact paths is empty. New migration SHA-256 values are:

- 0078: `39d21c91e36bb67698c593a6d9929982c0f3138eee6575e4008a929c6853a120`
- 0079: `147497bac862bfc7f25123cd3f655550c2c6c4c574a3519fa2a98dd62828d85a`

### Grounded fixes

- 0078 creates the concurrent legacy-incomplete partial index. 0079 gives all
  eligible, legacy-incomplete, and dirty branches explicit lower and upper UUID
  range bounds for NULL, shallow, and targeted generic plans.
- The current client resolves a schema-version marker in the exact schema that
  owns its resolved `principals` relation before privacy repair or non-dry-run
  offboarding. Schemas stopped at 0073 and 0075 refuse with `CONFLICT` before
  changing audit or lifecycle state. 0079 can only follow ledgered 0077, whose
  restartable v5 reconciliation must already have completed.
- Dirty-marker NOWAIT contention leaves completed v3 work intact. Detached
  receipt purge first checks for expired rows and uses `SKIP LOCKED`, preserving
  bounded truthful progress between different principals sharing the detached
  usage row.
- Published 0074/0076 bytes remain pinned; the packaged migrator executes exact
  CRLF-pair-only runtime repairs. Lone CR data survives in owner-owned prefixed
  functions, while foreign-owner, co-tenant, and extension members remain out
  of scope.
- Documentation now states the owner bypass honestly: only separate non-owner
  runtime roles receive the database old-client guard; a single owner role has
  no such boundary.

### Stale-role cause and recovery evidence

The leaked `continuum_retired_collision_1791366571420` generation was a test
fixture leak, not a failed retirement primitive or grant profile. The fixture
created cluster-wide roles and inserted retired history before entering its
`try`. Its old cleanup deleted retired history only by the pre-rebind OID; once
the registry referred to the recreated LOGIN generation, that deletion missed
the row and subsequent teardown aborted, while `resetData` deliberately did not
clear the installation-wide retired registries. That stale live-name/OID row
then made later rebinds fail closed. Both grant scripts pass in the final fresh
42/42 file; neither is the source of the leak.

The corrected fixture encloses creation, grants, registry insertion, rename,
recreation, rebind, and verification in `try/finally`; cleanup removes active,
retired, and unresolved entries by role name and known OID before dropping every
still-existing role. A fresh isolated proof covers retire, verify, rebind,
old-role removal, preserved-provenance rebind, and stale retired-registry
recovery. The exact leaked test roles and one exact retired row were removed
from the local test cluster after evidence capture; they are reproducible test
artifacts, not recoverable tenant data.

### Accepted bounded evidence

Every command used `MemoryMax=768M`, `MemorySwapMax=128M`, a 1,200-second hard
cap, and one Vitest worker/no file parallelism where applicable. Every accepted
run reported 0 B swap peak.

| Invocation | Result | Runtime | Memory peak | Accepted evidence |
|---|---:|---:|---:|---|
| `333fdc6f664443a19acc589c709ed53e` | expected RED: 55 pass / 7 fail | 2m15.770s | 328 KiB | final deterministic RED, including full fresh rotation 42/42 |
| `de97fb8b706d4fab91609874da36f5b3` | 1 pass / 9 skipped | 2.24s | 256 KiB | detached two-session contention control |
| `cfe98fabe4f448709db4e24c4b1a29f2` | 20/20 | 30.558s | 324 KiB | final static + PostgreSQL core proof, exact production four-argument plans over 50,000 rows |
| `247c7a58a9b5403fb42faca9b89a6f54` | 42/42 | 26.914s | 404 KiB | complete final rotation-security file |
| `66e0bf89a343493ba7dfe82c97b63324` | 44/44 | 47.575s | 256 KiB | fresh/upgrade/custom-schema/CRLF/checksum migrator matrix |
| `06d0c39f21fc41a2ab5d9e07099f588d` | 39/39 | 55.353s | 320 KiB | coordination storage and role/grant ACL matrix |
| `5061bd90873b4dafad7d1f6a4f5c8530` | 6/6 | 8.835s | 472 KiB | exact-head lock-order and offboarding races |
| `f0ce4f9d82774605b67baf3690828805` | 54/54 | 58.477s | 664 KiB | adjacent coordination/offboarding services |
| `452953c9ac9941da8d9900514b3e6043` | 94/94 | 28.853s | 256 KiB | REST/MCP malformed input, parity, offboarding routes, and CLI exits |
| `3841654464f842968455dc19827bdf9c` | pass | 5.979s | 512 KiB | TypeScript build |
| `2b6ef821a7da4863b83da9ead6431a60` | pass | 12.032s | 668 KiB | packed CLI install/runtime smoke including 0078/0079 |
| `8ec43435ca1d46a485d2ae2d1ed70e43` | pass, 303 entries | 8.717s | 312 KiB | `npm pack --dry-run --json` |

The final plan proof forces generic plans through the production four-argument
wrapper for NULL cursor, shallow cursor, and targeted legacy lookup. It asserts
the exact row counts, fewer than 2,000 shared buffers including first-call plan
compilation, and increased scan counters for both eligible and legacy partial
indexes. The fixed cap is independent of the 50,000-row backlog size.

### Excluded and superseded evidence

- `e1b917ce4b5549299fe9eae89c85575d` is root-cause evidence only: it reproduced
  40/42 against the contaminated cluster before exact leaked-role cleanup.
- `70dcb21c7d7d4da0b07cf42ff6c7f547` is an earlier RED (53 pass / 9 fail),
  superseded by the committed deterministic RED.
- `64bfbe80b050408b87643521c73ad167` and
  `f95e193493a5413491dfbf9e73d44377` are setup-only shell/cwd failures.
- `78936baf107c400f81ef05c6d2662a85` ran from `/home/fuego` and discovered
  three worktrees; none of its 30 cwd failures is acceptance evidence.
- `d2db2da5cfae4aa1a20bce609198de1b`,
  `92b74093af8e40a59c7df31f9914ae82`,
  `77db9f1458534f10a4560748299f1c4e`,
  `6e4fa9d5670547c9971630de55442104`,
  `448c7d7949464c5292ebfb8e1aadd575`, and
  `573097c6a0014ee08b885c9bcba62da1` are implementation/diagnostic iterations
  that exposed the missing directive terminators, lone-CR runtime rewrite, and
  an over-tight first-call buffer threshold. They are superseded by the final
  20/20 proof.
- `c78d31c789ce4a97a6305fc0222e807d` is excluded as a whole because adjacent
  expectations had not yet been advanced to 0078/0079 and one pooled-session
  race used an unstable PID. Its corrected subsets are accepted above.
- `28d750d77b534fa18f454c07ce804dae` exposed cross-schema marker resolution and
  is superseded by the schema-local final core proof.

No unbounded full suite, external publication, independent Claude review,
push, PR mutation, merge, deploy, rebase/reset, branch deletion, archive, or
remote mutation was performed.
