import type { EmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearchRelatedMemories } from '../storage/embeddings.js';
import type { Queryable } from '../storage/queryable.js';
import type { MemoryType } from '../types.js';

export const DEFAULT_RELATION_THRESHOLD = 0.92;
export const MAX_CAPTURE_RELATIONS = 5;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type CaptureRelation = 'possible-duplicate' | 'possible-conflict';

export interface RelatedMemory {
  id: string;
  similarity: number;
  relation: CaptureRelation;
  provider: string;
  threshold: number;
  detectedAt: string;
}

export function safeRelationProviderId(providerId: string): string {
  return SAFE_PROVIDER_ID.test(providerId) ? providerId : 'configured';
}

interface RelationInput {
  type: MemoryType;
  title: string;
  body: string;
}

function normalizeExact(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

export function classifyRelation(
  incoming: RelationInput,
  existing: RelationInput,
): CaptureRelation {
  const exact = normalizeExact(incoming.title) === normalizeExact(existing.title)
    && normalizeExact(incoming.body) === normalizeExact(existing.body);
  if (exact) return 'possible-duplicate';
  if (incoming.type === existing.type
    && (incoming.type === 'fact' || incoming.type === 'decision')) {
    return 'possible-conflict';
  }
  return 'possible-duplicate';
}

export function validateRelationThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Relation threshold must be between 0 and 1');
  }
  return value;
}

export function relationThresholdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CONTINUUM_RELATION_THRESHOLD;
  if (raw === undefined) return DEFAULT_RELATION_THRESHOLD;
  const normalized = raw.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) {
    throw new Error('CONTINUUM_RELATION_THRESHOLD must be a number between 0 and 1');
  }
  const parsed = Number(normalized);
  try {
    return validateRelationThreshold(parsed);
  } catch {
    throw new Error('CONTINUUM_RELATION_THRESHOLD must be a number between 0 and 1');
  }
}

export async function detectRelatedMemories(
  queryable: Queryable,
  vector: number[],
  scopeIds: string[],
  provider: Pick<EmbeddingProvider, 'id' | 'dim'>,
  incoming: RelationInput,
  excludeMemoryId: string,
  threshold = DEFAULT_RELATION_THRESHOLD,
  now: () => Date = () => new Date(),
): Promise<RelatedMemory[]> {
  const validatedThreshold = validateRelationThreshold(threshold);
  const hits = await vectorSearchRelatedMemories(
    queryable,
    vector,
    scopeIds,
    provider,
    { threshold: validatedThreshold, excludeMemoryId, limit: MAX_CAPTURE_RELATIONS },
  );
  const detectedAt = now().toISOString();
  return hits.map((hit) => ({
    id: hit.id,
    similarity: Math.max(-1, Math.min(1, 1 - hit.distance)),
    relation: classifyRelation(incoming, hit),
    provider: safeRelationProviderId(provider.id),
    threshold: validatedThreshold,
    detectedAt,
  }));
}
