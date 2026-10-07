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
