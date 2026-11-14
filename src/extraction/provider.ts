import { createHash } from 'node:crypto';
import { checkedProfile, boundedJson, type BudgetAdapter, type BudgetProfile } from '../pipeline/budget.js';
import type { ExtractionChunk } from './chunking.js';
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA, type ExtractionOutput } from './model.js';

export interface ExtractionInput {
  schema: typeof EXTRACTION_SCHEMA;
  prompt: typeof EXTRACTION_PROMPT;
  referenceData: { trust: 'untrusted'; sourceVersion: string; chunk: ExtractionChunk };
}
export interface ExtractionProfile {
  id: string; version: string; adapter: BudgetAdapter<ExtractionInput, ExtractionOutput>;
  budget: BudgetProfile; chunkBytes: number; maxChunks: number;
}
/** Implementations are installed by trusted local composition, never by memory
 * text, request fields or a model response. Registration alone grants no SQL authority. */
export class ExtractionRegistry {
  private readonly entries = new Map<string, Readonly<ExtractionProfile>>();
  register(input: ExtractionProfile): void {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(input.id) || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(input.version)
      || this.entries.size >= 32 || this.entries.has(input.id) || !Number.isInteger(input.chunkBytes) || input.chunkBytes < 4 || input.chunkBytes > 65_536
      || !Number.isInteger(input.maxChunks) || input.maxChunks < 1 || input.maxChunks > 64
      || input.maxChunks > input.budget.limits.calls
      || input.budget.overallMs > 20_000 || input.adapter.timeoutMs > 15_000) throw new TypeError('Invalid extraction profile');
    this.entries.set(input.id, Object.freeze({ ...input, budget: checkedProfile(input.budget) }));
  }
  get(id: string): Readonly<ExtractionProfile> | undefined { return this.entries.get(id); }
  ids(): string[] { return [...this.entries.keys()].sort(); }
}
export function extractionDescriptor(profile: Readonly<ExtractionProfile>) {
  const adapter = profile.adapter;
  const descriptor = { id: profile.id, version: profile.version, model: adapter.model, adapter: adapter.id,
    adapterProfile: adapter.profile, locality: adapter.local ? 'local' : 'hosted', schema: EXTRACTION_SCHEMA,
    prompt: EXTRACTION_PROMPT, chunkBytes: profile.chunkBytes, maxChunks: profile.maxChunks,
    budget: profile.budget, responseBodyBytes: adapter.responseBodyBytes, outputTokens: adapter.outputTokens,
    reasoningTokens: adapter.reasoningTokens, completionTokens: adapter.completionTokens,
    accounting: adapter.tokens ? { kind: adapter.tokens.kind, validationId: adapter.tokens.validationId,
      model: adapter.tokens.model, profile: adapter.tokens.profile, overheadTokens: adapter.tokens.overheadTokens } : null,
    price: adapter.price ?? null };
  return { ...descriptor, hash: createHash('sha256').update(boundedJson(descriptor, 16_384)).digest('hex') };
}
