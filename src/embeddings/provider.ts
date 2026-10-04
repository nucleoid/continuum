export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}
