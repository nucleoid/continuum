import { vi } from 'vitest';
import { configureReranking, type RerankingAdapter, type RerankingInput } from './provider.js';
import { starterProfile } from '../pipeline/budget.js';

/** Synthetic byte-token protocol, no model-quality or real-tokenizer claim. */
export function testReranking(score: (candidate: RerankingInput['candidates'][number]) => number) {
  const adapter: RerankingAdapter = {
    id: 'local-test', version: 'deterministic-v1', model: 'byte-protocol-v1', profile: 'local-test-v1', local: true,
    timeoutMs: 1000, responseBodyBytes: 8192, enforceableCaps: true, cancellation: 'cooperative',
    outputTokens: 8192, reasoningTokens: 0, completionTokens: 8192,
    tokens: { model: 'byte-protocol-v1', profile: 'local-test-v1', kind: 'exact', validationId: 'utf8-bytes-v1', overheadTokens: 0, count: s => Buffer.byteLength(s) },
    price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
    serialize: (input, caps) => ({ protocol: 'byte-protocol-v1', input, caps }),
    invoke: vi.fn(async serialized => {
      const { input } = JSON.parse(serialized) as { input: RerankingInput };
      const value = { version: 'deterministic-v1', scores: input.candidates.map(c => ({ id: c.id, score: score(c) })) };
      return { value, response: value, usage: { provenance: 'measured' as const, outputTokens: Buffer.byteLength(JSON.stringify(value)), reasoningTokens: 0,
        completionTokens: Buffer.byteLength(JSON.stringify(value)) } };
    }),
  };
  const profile = { ...starterProfile, limits: { ...starterProfile.limits, outputTokens: 8192, completionTokens: 8192 } };
  return { adapter, config: () => configureReranking(adapter, profile, { candidateLimit: 20,
    evidence: { kind: 'local-contract', adapterId: adapter.id, version: adapter.version, model: adapter.model, profile: adapter.profile } }) };
}
