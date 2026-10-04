export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  /** Explicit data-residency capability. Never infer this from an endpoint URL. */
  readonly local?: boolean;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}
