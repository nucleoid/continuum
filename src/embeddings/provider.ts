export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
