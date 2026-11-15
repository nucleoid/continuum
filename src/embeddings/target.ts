import { createHash } from 'node:crypto';

export const MEMORY_EMBEDDING_INPUT_TRANSFORM = 'memory-title-body-v1';

/** Exact reviewed request semantics, not an inferred model family. A profile
 * change that can affect vectors requires a new provider storage identity. */
export interface EmbeddingVectorSpace {
  provider: string;
  model: string;
  profile: string;
  dim: 768;
  inputTransform: string;
}
export interface EmbeddingTarget {
  readonly space: Readonly<EmbeddingVectorSpace>;
  readonly spaceFingerprint: string;
  readonly configFingerprint: string;
  readonly fingerprint: string;
  readonly local: boolean;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new TypeError('Invalid embedding target identity');
  }
  return value;
}
function exactKeys(value: object, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Unexpected embedding target field');
}

export function embeddingVectorSpace(input: EmbeddingVectorSpace): Readonly<EmbeddingVectorSpace> {
  exactKeys(input, ['provider', 'model', 'profile', 'dim', 'inputTransform']);
  if (input.dim !== 768) throw new TypeError('Embedding targets require 768 dimensions');
  return Object.freeze({ provider: identity(input.provider), model: identity(input.model),
    profile: identity(input.profile), dim: 768, inputTransform: identity(input.inputTransform) });
}
export function embeddingSpaceFingerprint(input: EmbeddingVectorSpace): string {
  return digest(['continuum.embedding-space.v1', embeddingVectorSpace(input)]);
}

/** Accept only an explicit credential-free projection, never provider/env objects.
 * Endpoint is hashed and discarded. Locality is a capability, not URL inference.
 * profile must bind every vector-affecting request option, including task mode. */
export function embeddingTarget(input: { space: EmbeddingVectorSpace; endpoint: string; local: boolean }): EmbeddingTarget {
  exactKeys(input, ['space', 'endpoint', 'local']);
  const space = embeddingVectorSpace(input.space);
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 2048) throw new TypeError('Invalid embedding target endpoint');
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { throw new TypeError('Invalid embedding target endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || typeof input.local !== 'boolean') {
    throw new TypeError('Embedding target endpoint must exclude credentials, query and fragment');
  }
  const spaceFingerprint = embeddingSpaceFingerprint(space);
  const configFingerprint = digest(['continuum.embedding-config.v1', endpoint.href, input.local]);
  return Object.freeze({ space, spaceFingerprint, configFingerprint, local: input.local,
    fingerprint: digest(['continuum.embedding-target.v1', spaceFingerprint, configFingerprint]) });
}

/** Pure comparison only. The immutable mapping must be enforced by durable SQL
 * for every vector reader/writer; this function establishes no registry authority. */
export function assertSameEmbeddingSpace(registered: EmbeddingVectorSpace, proposed: EmbeddingVectorSpace): void {
  if (embeddingSpaceFingerprint(registered) !== embeddingSpaceFingerprint(proposed)) {
    throw new TypeError('Embedding storage identity conflicts with its approved vector space');
  }
}
