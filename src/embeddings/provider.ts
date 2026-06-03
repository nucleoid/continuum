export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const NULL_EMBEDDING_PROVIDER: EmbeddingProvider | null = null;
