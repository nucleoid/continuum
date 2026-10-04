/** The fixed pgvector typmod used by the v0 storage schema. */
export const STORAGE_EMBEDDING_DIM = 768;

export function assertEmbeddingProviderDimension(
  provider: { readonly dim: number },
): void {
  if (!Number.isInteger(provider.dim) || provider.dim !== STORAGE_EMBEDDING_DIM) {
    throw new Error(
      `Embedding provider dimension must be ${STORAGE_EMBEDDING_DIM} to match database vector(${STORAGE_EMBEDDING_DIM})`,
    );
  }
}

export function assertEmbeddingVectorDimension(
  vector: number[],
  provider: { readonly dim: number },
): void {
  assertEmbeddingProviderDimension(provider);
  if (vector.length !== provider.dim) {
    throw new Error(
      `Embedding vector dimension ${vector.length} does not match configured provider dimension ${provider.dim}`,
    );
  }
}
