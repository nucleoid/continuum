# Issue 7 final review remediation receipt

Date: 2026-10-07 UTC

## Repository identity and sequencing

- Repository: `nucleoid/continuum` (`R_kgDOU9y0tQ`)
- Branch: `feature/7-coordination-leases`
- Reviewed input HEAD: `5b3f2fc97fdc516680f97e3de191b0183a78e309`
- Reviewed input tree: `139c4ba175b0afd47721e216309dab578e989666`
- Merge base: `7bfedb7a00ae5f2b28dd349324bbf4f7cd197874`
- Tests/docs-only RED: `1cb73c27c833b980a5b11d45311f709b87bdec0f`
  (tree `ce1ea1980db874e8086b20e2296265051a09cd91`)
- GREEN commit and tree are reported after the commit because a commit cannot
  contain its own hash.
- No reset, rebase, force, squash, dependency, workflow, package-manifest,
  lockfile, push, PR, merge, deployment, visibility, or external-review action
  was performed.

RED was committed before production or migration implementation. Its fresh
PostgreSQL run compiled and produced 19 passing tests and six genuine failures:
0069 checksum/forward chain, multi-page CLI discovery, blocking offboard CLI,
detached quota progress, linkable-key plan, and upgraded grant preservation.
An earlier shared-schema run was discarded because its migration ledger claimed
0069 while its constraint still allowed only privacy versions 1 through 2.

## Migrations

- `0070_coordination_linkable_audit_index.sql`:
  `f234e2e1a564a7216fb4ae79e042f7c6d41540cccc2a9304267fc8cfd022cf97`
- `0071_coordination_review_completion.sql`:
  `16b4784899e6467c57032b332cc56660c4cfd3c3492296f640f2f232b7de1670`
- Published `0069_coordination_independent_review.sql` is newly enforced at
  `77847f54221ddc24ca5dc2d1ba43efce19e0c2beb4c599147a23621cb54de9bf`.
- Migrations 0054 through 0069 are byte-identical to the reviewed input. Their
  SHA-256 values remain the published values in `src/storage/migrator.ts`.

## Verification results

- Focused GREEN, fresh schema: 25/25.
- Production query/function, linkable index, 20,000-row completed audit
  history, create trigger, completion predicate, real CLI paging, blocking CLI,
  quota saturation, and Entra repair/direct-scrub concurrency: 12/12.
- Broad coordination/offboarding/storage matrix: 191/200; nine failures were
  stale migration inventories, a stale CLI source assertion, and a test helper
  that hardcoded `public` while the run used an isolated schema. Corrected
  subset: 52/52. Unaffected passing evidence from the broad run is retained.
- API/MCP/harness matrix: 92/95; three harness setup hooks timed out after the
  long serial process and left a partial reset. Isolated fresh-schema harness:
  4/4.
- Final candidate-source verification: 150/150 across remediation, migrator,
  upgraded/custom-schema/rerun ACL, fresh role grants, admin CLI, API, and MCP.
- TypeScript build passed. Packed CLI smoke passed. `npm pack --dry-run --json`
  passed with 295 entries.
- `git diff --check` passed before RED and before the final candidate run.

Principal validation commands (all were wrapped by
`CONTINUUM_WALL_SECONDS=... artifacts/continuum-bounded-run.sh bash -lc`):

```text
PGOPTIONS="-c search_path=issue7_red_final_20261007,public" NODE_OPTIONS=--max-old-space-size=384 npx vitest run src/services/coordination-independent-review.test.ts src/storage/coordination-upgrade-acl.test.ts --maxWorkers=1 --no-file-parallelism
PGOPTIONS="-c search_path=issue7_green2_20261007,public" NODE_OPTIONS=--max-old-space-size=384 npx vitest run src/services/coordination-independent-review.test.ts src/storage/coordination-upgrade-acl.test.ts --maxWorkers=1 --no-file-parallelism
PGOPTIONS="-c search_path=issue7_adjfix_20261007,public" NODE_OPTIONS=--max-old-space-size=384 npx vitest run src/storage/migrator.test.ts src/services/offboarding-independent-review-remediation.test.ts src/identity/admin-cli-offboarding.test.ts --maxWorkers=1 --no-file-parallelism
PGOPTIONS="-c search_path=issue7_harness_20261007,public" NODE_OPTIONS=--max-old-space-size=384 npx vitest run src/coordination/harness-contract.test.ts --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--max-old-space-size=384 npm run build
NODE_OPTIONS=--max-old-space-size=384 npm run smoke:cli-package
npm pack --dry-run --json
PGOPTIONS="-c search_path=issue7_finalsource_20261007,public" NODE_OPTIONS=--max-old-space-size=384 npx vitest run src/services/coordination-independent-review.test.ts src/storage/coordination-upgrade-acl.test.ts src/storage/migrator.test.ts src/services/offboarding-independent-review-remediation.test.ts src/identity/admin-cli-offboarding.test.ts src/storage/coordination-role.test.ts src/api/mcp.test.ts src/api/coordination-parity.test.ts --maxWorkers=1 --no-file-parallelism
```

## Bounded invocation ledger

Every launched bounded unit stayed below 768 MiB RAM and used 0 B swap. Entries
marked `header omitted` are retained by exact transient-unit name because the
systemd header did not print an invocation ID; a later journal recovery found
no retained ID. `pre-unit` means shell parsing failed before systemd launched.

| Invocation ID or unit | Result | Runtime | Memory peak | Purpose |
|---|---:|---:|---:|---|
| `751fd80e3af941f0ba2885a16702a9cf` | fail | 31 ms | 576 KiB | preflight used absent `origin/main`; setup contamination |
| `9ec3121dd4a44effaa3ecb4f53e72d1f` | pass | console truncated | console truncated | complete preflight/review/memory read |
| `continuum-bounded-3369079-1791407115574996803` (header omitted) | fail | 12 ms | 1.4 MiB | `rg` unavailable in bounded PATH; setup only |
| `continuum-bounded-3369419-1791407124576464194` (header omitted) | pass | 31 ms | 1.3 MiB | architecture and file map |
| `cfa273a9a6a4459e8143c37f205c17e8` | pass | console truncated | console truncated | architecture/offboarding read |
| `dbc5e53873664af2bd7484a6e7c4d30e` | pass | 18 ms | 324 KiB | service/CLI contracts |
| `9c5eeb47224a4e8a919ad37911bd47f5` | pass | 24 ms | 328 KiB | issue-7 tests/migrator guard |
| `ba7299aac5ec461a8479f6dcba93efe3` | pass | 20 ms | 320 KiB | migration sources and baseline hashes |
| `94aeb6f941be4db4835cdde92f175281` | fail | 666 ms | 324 KiB | unsupported Vitest `--minWorkers`; setup only |
| `c4ac5b332f184239993eb4f0ec2a7eb3` | pass | 23 ms | 288 KiB | quota/concurrency fixture read |
| `ce5567b133a642a485d0646735460666` | pass | 24 ms | 292 KiB | local remediation history read |
| `continuum-bounded-3372286-1791407198323755754` (header omitted) | pass | 35 ms | 1.4 MiB | prior RED/GREEN design read |
| `pre-unit shell parse failure` | fail | n/a | n/a | unmatched quote before wrapper launch |
| `67aab812b935459a997326ada72b1f83` | pass | 21 ms | 480 KiB | receipt schema/ACL harness read |
| `e4361ab8b5654f9ca996c61d7f51a99f` | pass | 14 ms | 324 KiB | existing quota tests read |
| `12f0a0f8bdc34efd86ec96d49b870f62` | pass | 15 ms | 320 KiB | failed patch status verification |
| `3b00b50036dd43e180aa0b5eb7853ccc` | pass | 13 ms | 288 KiB | docs patch point/diff check |
| `19bf0de4e99d4f03b6f46effbe715b81` | fail | 4.914 s | 320 KiB | test syntax error; discarded |
| `59d2e367c45c4f94a2e193819a4dd2c2` | pass | 5.996 s | 696 KiB | corrected test syntax/typecheck |
| `acacad577e3943dc9b9cf86a35b4c194` | fail | 12.652 s | 320 KiB | shared-schema RED; discarded contamination |
| `continuum-bounded-3380700-1791407456245392495` (header omitted) | expected fail | 17.102 s | 752 KiB | fresh-schema RED, 6 genuine failures |
| `b37f6882a7f84d15a1450c228aa78a30` | expected fail | 43.538 s | 256 KiB | final RED, 19 pass/6 fail |
| `72eb06f8eb3844dfa007e6358c724357` | pass | 112 ms | 512 KiB | commit RED |
| `f6fd059aa6d74835a24597c3c87d20de` | pass | 3.563 s | 324 KiB | GREEN typecheck |
| `a670e32762c64c119a1524350acd55a9` | fail | 34.035 s | 288 KiB | initial GREEN, block-reason precedence |
| `5b814a256d6b4e86ad73d5825b8109ba` | pass | 29.532 s | 256 KiB | focused GREEN 25/25 |
| `1f4f5179ea734b0daf94578a9e39804f` | pass | 10.855 s | 324 KiB | exact production predicate evidence 12/12 |
| `18c7fe02fea64c9b80508979b84db13c` | fail | 2m32.484s | 320 KiB | broad adjacent 191/200; stale test expectations |
| `749a5b5f5bcc455e99eb9ca523609ae1` | pass | 16 ms | 324 KiB | inspect adjacent failures |
| `a9c45cc633f549158ef03b255d9436a8` | pass | 5.008 s | 324 KiB | corrected fixture typecheck |
| `c00d757611b148ae87dbe8012f44ac4d` | pass | 10 ms | 324 KiB | stale cutoff search |
| `13a7ab4089ed4ff08e629e25fbd3152a` | pass | 1m22.531s | 580 KiB | corrected adjacent subset 52/52 |
| `054d3659dd3945bc933d593bf1d92fa6` | fail | 54.146 s | 320 KiB | API/MCP 92 pass; harness setup contamination |
| `93cf3b97c292418baab00f25f7cd0682` | pass | 4.336 s | 256 KiB | isolated harness 4/4 |
| `6ea327cba6fd43f88a3d3116ddaf139d` | pass | 21.467 s | 256 KiB | build, packed CLI smoke, pack dry-run |
| `5e53c909b4bd4d96ba538a42eac2fe20` | pass | 36 ms | 324 KiB | diff and historical migration audit |
| `fc6b36f829a54866951fa3d1f65bbc67` | pass | 14 ms | 324 KiB | fresh grant-surface audit |
| `a7148d53b60e4d158ad0b22f6b6484d1` | pass | 1m31.923s | 324 KiB | final candidate-source 150/150 |
| `continuum-bounded-3404230-1791408381039395225` (header omitted) | pass | 26 ms | 1.8 MiB | locate receipt convention/status |
| `d88723c655c742a8bf3db223849e3678` | pass | 21 ms | 328 KiB | bounded-run metadata inspection |
| `b0595c627d474d64919ef00faa24a903` | pass | 1.066 s | 672 KiB | attempted recovery of omitted IDs |
| `3ae48748addd4512846b345f75c8b1f1` | pass | 50 ms | 320 KiB | migration hashes/candidate status |

## Exclusions and residual risk

- No unbounded repository-wide suite was run, as required.
- Hosted Windows validation is parent-owned and was not run here.
- No external reviewer was spawned or contacted.
- PostgreSQL plans are data/statistics dependent. The representative production
  fixture used completed privacy rows and 20,000 retained scrubbed lock-audit
  rows, and verified the exact linkable predicate used
  `audit_log_coordination_privacy_linkable_idx` without scanning those rows.
- The final source verification preceded addition of this receipt only; the
  receipt has no build/runtime effect. Final commit/tree and clean status are
  reported after commit.
