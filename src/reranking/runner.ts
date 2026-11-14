import { boundedJson, runBudgetedStage, type Budget, type DurableAttempt } from '../pipeline/budget.js';
import type { BudgetReason } from '../pipeline/receipts.js';
import type { Reranking, RerankingInput, RerankingOutput } from './provider.js';

export type RerankingDiagnostic = { status: 'used' } | { status: 'fallback'; reason: BudgetReason };
export type RerankingOutcome = { status: 'used'; scores: Map<string, number> } | { status: 'fallback'; reason: BudgetReason };

function validate(value: unknown, input: RerankingInput, version: string, maxBytes: number): RerankingOutput {
  const output = JSON.parse(boundedJson(value, maxBytes)) as RerankingOutput;
  if (!output || Object.keys(output).sort().join(',') !== 'scores,version' || output.version !== version
    || !Array.isArray(output.scores) || output.scores.length !== input.candidates.length) throw new TypeError();
  const remaining = new Set(input.candidates.map(candidate => candidate.id));
  for (const score of output.scores) {
    if (!score || Object.keys(score).sort().join(',') !== 'id,score' || !remaining.delete(score.id)
      || typeof score.score !== 'number' || !Number.isFinite(score.score)) throw new TypeError();
  }
  if (remaining.size) throw new TypeError();
  return output;
}

/** Uses the shared accounting and retained-execution fences, including on rejection.
 * No retry or fresh child allowance is created on any fallback. */
export async function runReranking(config: Reranking, budget: Budget, input: RerankingInput,
  authorize: () => Promise<boolean>, finalOutputBytes: number,
  options: { signal?: AbortSignal; durable?: DurableAttempt } = {}): Promise<RerankingOutcome> {
  if (config.adapter.responseBodyBytes + finalOutputBytes > budget.available('outputBytes')) {
    return { status: 'fallback', reason: 'budget_exhausted' };
  }
  let invalid = false;
  try {
    const transportMs = budget.remainingMs(budget.profile.overallMs) - Math.min(1000, Math.floor(budget.profile.overallMs / 4));
    if (transportMs < 1) return { status: 'fallback', reason: 'deadline' };
    const outcome = await runBudgetedStage(budget, { ...config.adapter,
      async invoke(serialized, context) {
        const result = await config.adapter.invoke(serialized, context);
        try {
          const value = validate(result.value, input, config.adapter.version, context.responseBodyBytes);
          // Validate the real response too, before any refund/publication decision.
          boundedJson(result.response, context.responseBodyBytes);
          return { ...result, value };
        } catch { invalid = true; throw new TypeError('Invalid reranking response'); }
      },
    }, input, { ...options, authorize, transportMs });
    if (outcome.status === 'skipped') return { status: 'fallback', reason: invalid ? 'invalid_response' : outcome.reason };
    return { status: 'used', scores: new Map(outcome.value.scores.map(score => [score.id, score.score])) };
  } catch {
    // Durable settlement can itself reject. It never establishes a refund or a
    // safe second attempt. Preserve conservative shared accounting and fallback.
    return { status: 'fallback', reason: 'provider_failed' };
  }
}
