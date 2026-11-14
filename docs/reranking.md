# Optional recall reranking

Reranking is a server-owned stage before recall's final limit. It is disabled
unless a custom composition passes a `Reranking` configuration to `createApp`,
`buildMcpServer`, or the last argument of `recallForPrincipal`. The low-level
`recall()` wrapper retains hybrid final-cut behavior. No environment variable,
REST/MCP field, contributed metadata, default endpoint or bundled vendor SDK
selects a reranker. There is no schema migration, reindex or hosted probe.

## Admission and ordering

Each retrieval arm retains `min(finalLimit * 5, 100)` overfetch. The optional
profile's distinct `candidateLimit`, from 1 through 100, caps the fused,
deduplicated union before hydration. Its shared candidate/hydration allowance
and the existing remote read budget can tighten that cap. If wider hydration
cannot fit, recall uses the original top-limit pool and skips reranking. An
oversized required pool still fails before a successful delivery audit; there
is no oversized-best-item exception. A requested final limit larger than the
configured candidate cap also uses hybrid fallback.

Current enabled identity, effective memberships, Entra freshness, source state,
original expiry and exact source/root generations gate enrollment and hydration.
Migration 0093 lazily enrolls bounded source versions using its existing audited
capability. Its locked SQL envelopes feed issue 26's pure intersection policy.
The exclusive autocommit authority adapter is never used inside a transaction.
Each owned Pool retains at most 100 source/version identity pairs to avoid
re-enrolling unchanged snapshots. No payload, envelope or permission is cached.
Every hit passes the same current locked SQL gate; changed versions resolve
again through the existing source capability. Exact admitted versions remain
fixed through inference and cannot be replaced by a newer cache entry.
There is no derivative, advisory-relation, coordination or personal-activity
table join. Source body text remains reference data.

Only request-local opaque aliases, authorized titles and existing bounded
excerpts reach the adapter. It receives no memory/version UUID, tags, arbitrary
metadata, source locator, principal credential or transport object. All inputs
must pass current provider disclosure policy together. One incompatible local-only
or external policy skips the whole optional comparison. Embedding scope routes
that explicitly require local processing also prohibit a hosted reranker.

The adapter executes after the database transaction commits. Current locked
authority is checked again immediately before dispatch, after adapter work, and
in the final selection/audit transaction. Changed/expired/revoked versions are
omitted; refill uses only the already admitted pool. Invalidated scores restore
the complete eligible hybrid order. Required final-output checks precede the
audit. That audit contains only delivered identities, in delivered order, with
`score` and optional `rerank_score`. Source enrollment and disclosure admission
have separate audit records. Auditing is not atomic proof of network receipt.

Require exactly one finite score per admitted alias, no duplicates, unknown
aliases, missing scores or changed revision. Order is descending rerank score,
then original fusion rank, then ID. The public `score` remains reciprocal-rank
fusion. REST adds optional `rerankScore`; MCP adds `rerank_score` to its unchanged
result array. `diagnostics.reranking` (MCP `_meta.diagnostics.reranking`) contains
only `status: used` or `status: fallback` plus a bounded shared-budget reason.
No denied identifiers, hidden counts, source text or raw errors appear there.

## Complete accounting and cancellation

`RerankingAdapter` extends `BudgetAdapter`. Its serializer projects the complete
real wire envelope, including prompts, model/protocol wrappers and output caps.
The adapter sends those exact serialized bytes, enforces its response-body limit
during reading, and declares compatible exact/conservative token accounting and
versioned integer pricing. Real tokenizers, prices and credentials are never
guessed. Serialization, calls, tokens, spend, output and retained bytes use the
existing shared `Budget` and `runBudgetedStage`; there is no second accountant.

The runner preserves conservative final-output allowance and up to one second
of the remaining lifetime for final selection/audit. These reservations are not
a promise that a slow required database operation will finish. REST/MCP count
their complete actual response envelopes before success audit, in addition to
the conservative service projection. Configured embedding/enrichment adapters
must also support the shared budget, or their optional work skips safely.

Timeout, capacity saturation, unavailable capabilities/credentials/pricing,
policy denial, invalid output, adapter failure and durable settlement rejection
fall back as a whole. Client cancellation suppresses delivery. Abort-ignoring
calls retain issue 28's process-wide admission and byte fences until actual
settlement; replacing a configuration or budget cannot release those slots or
apply late scores. Use bounded shutdown and verify process exit when strict
cutoff is required. See [pipeline budgets](pipeline-budgets.md) for durable
original workflow/attempt/owner/generation identities. Requeue, timeout or lost
identities never authorizes resetting allowance. This feature adds no scheduler.

## Callable local composition

This deterministic example needs no hosted account. Its byte-token protocol is
only a local contract demonstration, not a model tokenizer or quality claim.
After the normal APP/schema/authentication startup gates, pass the configuration
to either supported transport builder:

```js
import { configureReranking, starterProfile } from '@continuum/core';
import { createApp } from '@continuum/core/dist/api/server.js';
import { buildMcpServer } from '@continuum/core/dist/api/mcp.js';

const adapter = {
  id: 'local-overlap', version: 'overlap-v1', purpose: 'deterministic',
  model: 'byte-protocol-v1', profile: 'overlap-v1', local: true,
  credentials: 'not-required', timeoutMs: 100, responseBodyBytes: 4096,
  outputTokens: 2048, reasoningTokens: 0, completionTokens: 2048,
  enforceableCaps: true, cancellation: 'cooperative',
  tokens: { kind: 'exact', model: 'byte-protocol-v1', profile: 'overlap-v1',
    validationId: 'utf8-bytes-v1', overheadTokens: 0,
    count: text => Buffer.byteLength(text) },
  price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1,
    inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
  serialize: (input, caps) => ({ protocol: 'byte-protocol-v1', input, caps }),
  async invoke(serialized, { signal, responseBodyBytes }) {
    signal.throwIfAborted();
    const { input } = JSON.parse(serialized);
    const terms = input.query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const value = { version: 'overlap-v1', scores: input.candidates.map(c => ({
      id: c.id, score: terms.filter(t => `${c.title} ${c.excerpt}`.toLowerCase().includes(t)).length,
    })) };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > responseBodyBytes || bytes > 2048) throw new Error('Output bound');
    return { value, response: value, usage: { provenance: 'measured',
      outputTokens: bytes, reasoningTokens: 0, completionTokens: bytes } };
  },
};
const reranking = configureReranking(adapter, starterProfile, {
  candidateLimit: 20,
  evidence: { kind: 'local-contract', adapterId: adapter.id, version: adapter.version,
    model: adapter.model, profile: adapter.profile },
});
const app = createApp(pool, { authenticator, reranking });
const mcp = buildMcpServer({ pool, principal, embeddingProvider: null, reranking });
```

Builders do not replace startup, credential revalidation or bounded shutdown.
The configuration snapshots capabilities and binds adapter methods. Arbitrary
in-process implementations remain trusted code, not a JavaScript sandbox.

## Real adapter qualification and rollback

`purpose: model`, including a local model, requires `operator-qualified` evidence
matching exact adapter ID, immutable algorithm/model/prompt revision, model and
profile, with the reviewed report SHA-256 and an explicit current provider-authority
resolver. Its timestamps use the supplied PostgreSQL clock domain; deny unknown
or revoked authority. The resolver cannot grant missing source or residency access.
The report reference is an operator attestation, not runtime proof of review.
Never manufacture an approval from a validation string or synthetic stub result.

Qualification uses the agreed [evaluation methodology](memory-evaluation.md),
paired relevance/coverage/abstention/leakage results, latency, identical bounded
work/spend caps, exact serialization/token capability validation, seeds, uncertainty
and source/version/profile provenance. The separately versioned
`evals/reranking-v1.json` ablations exercise all frozen ranking cases, five measured
observations and one warmup with seeded rotating modes. The local overlap/SHA
results are mechanism evidence only. They do not satisfy a real model gate,
cross-head acceptance or normalized storage evidence. Frozen v1 inputs and gates
remain unchanged. No real model, paid experiment or deployment is enabled here.

Remove the injected configuration to restore legacy hybrid selection. No new
secret, permission, reauthentication, migration, backfill or reindex is needed.
Drain existing optional calls or confirm process exit; preserve conservative
accounting and the already-required 0092/0093 authority contracts. AGENTS.md stays
independent deterministic source selection: no reranker calls, scores, receipts
or prose affect bytes, hashes, ETags or freshness.
