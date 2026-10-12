# Issue 3 local validation

This receipt records local validation for [issue 3](https://github.com/nucleoid/continuum/issues/3) and [PR 10](https://github.com/nucleoid/continuum/pull/10). It does not record deployment or completion of the combined handoff.

## Validated source

- Source: `a59d0efaa4a3094642d20b5aab54e6706735fe39`.
- Dependency base: `4b6f15bf752aaf6c047a79707e9251ad5f2054e6`.
- Published migrations `0001` through `0088` remain unchanged. Only `0089_promotion_outbox.sql` is added.
- Migration 0089 normalized source SHA-256: `034fff0c1f04c67d5b9e6e5bab5500e7c0b93b4b9baef5351c8e095fef7dc6ff`.

## Executed validation

The complete fresh local run passed: **173 files, 1,749 passing tests and two existing psql-dependent skips**, 1,751 tests total. It completed in **2,877.26 seconds**, exited zero and reported no OOM or unhandled errors. Build, fresh migrations through 0089, package validation, installed CLI checks and compiled entrypoint smokes also passed.

Containment used a 768 MiB container memory limit, 128 MiB swap allowance, 384 MiB Node heap, one test worker and a finite 3,600-second outer wall. The separate 52-test affected gate passed; it is component evidence rather than a replacement for the complete run.

Coverage includes real APP/OP profile upgrade and regrant, canonical callback-ID registry, REST/MCP parity, immutable bounded enrichment, deterministic AGENTS generator parity, exact lease-generation ownership, paid outcome recovery, server-bounded SQL, post-lock eligibility, disabled-destination exclusion and approved resumable outbox erasure. Consumer callbacks remain at least once; downstream copies cannot be retracted by database cleanup.

Seven completed Claude reports form the conditionally approved source review chain: five portions plus the e3 and a59 corrections. The portions did not all review one identical head. Approval covers source only, with Low test-cleanup diagnostic and hook-budget residuals; it is not a production guarantee. A separate nonauthor native review covered 69 source paths before this receipt; it is recorded separately from Claude review. This new receipt was not included in those earlier approvals.

Receipt-only head `95d6838` also passed build, packaging, installed CLI and compiled entrypoint checks, plus eight cleanup-helper tests (2.53 seconds, exit zero, no OOM).

## Rollout and remaining gates

Follow the [extension rollout guide](../extensions.md): quiesce old producers, offboarding processes and every worker replica; migrate as owner with database TEMPORARY privilege; explicitly regrant APP then OP profiles; configure canonical webhook IDs, then start matching binaries and require their exact-profile and outbox-readiness startup checks to pass. No deployment is claimed.

Fresh receipt-head CI, PR merge and fresh master CI remain pending. Standup, README reconciliation, final combined documentation and issue 16 completion also remain pending.

The historical 3.22 GB incident's trigger is unknown. The transient cleanup session's backend type is unknown. These observations do not establish a product root cause, downstream erasure or exactly-once delivery.
