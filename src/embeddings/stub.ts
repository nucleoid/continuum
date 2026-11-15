import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './provider.js';
import { embeddingTarget, MEMORY_EMBEDDING_INPUT_TRANSFORM } from './target.js';

// Deterministic stub: derives a unit-length 768-d vector from the SHA-256 of
// the input text. Same text => same vector; different texts => different.
// For tests only. Do not use in production.
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'stub:sha256';
  readonly local = true;
  get target() { return this.dim === 768 ? embeddingTarget({ space: { provider: this.id, model: 'sha256', profile: 'synthetic-sha256-v1', dim: 768, inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM }, endpoint: 'http://fixture.invalid/sha256', local: true }) : undefined; }
  readonly dim: number;

  constructor(dim = 768) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const out = new Float64Array(this.dim);
    let seed = createHash('sha256').update(text).digest();
    let idx = 0;
    while (idx < this.dim) {
      for (let i = 0; i < seed.length && idx < this.dim; i += 2) {
        const hi = seed[i] ?? 0;
        const lo = seed[i + 1] ?? 0;
        out[idx++] = ((hi << 8) | lo) / 65535 - 0.5;
      }
      seed = createHash('sha256').update(seed).digest();
    }
    // L2 normalise for cosine compatibility.
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(out, (v) => v / norm);
  }
}
