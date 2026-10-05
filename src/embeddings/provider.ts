export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  /** Explicit data-residency capability. Never infer this from an endpoint URL. */
  readonly local?: boolean;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export type EmbeddingProviderErrorCode =
  | 'EMBEDDING_TIMEOUT'
  | 'EMBEDDING_NETWORK'
  | 'EMBEDDING_AUTH'
  | 'EMBEDDING_RATE_LIMIT'
  | 'EMBEDDING_SERVER'
  | 'EMBEDDING_INVALID_RESPONSE'
  | 'EMBEDDING_FAILED';

export class EmbeddingProviderError extends Error {
  readonly failureScope = 'provider';

  constructor(
    readonly code: EmbeddingProviderErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

/**
 * Providers may use this only when they can attribute a failed batch to input
 * content. Backfill treats every other error as provider-wide.
 */
export class EmbeddingItemError extends Error {
  readonly code = 'EMBEDDING_ITEM_FAILED';
  readonly failureScope = 'item';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'EmbeddingItemError';
  }
}

export function isEmbeddingItemError(error: unknown): error is EmbeddingItemError {
  return error instanceof EmbeddingItemError;
}

export function embeddingProviderHttpError(status: number): EmbeddingProviderError {
  const code: EmbeddingProviderErrorCode = status === 401 || status === 403
    ? 'EMBEDDING_AUTH'
    : status === 429
      ? 'EMBEDDING_RATE_LIMIT'
      : status >= 500
        ? 'EMBEDDING_SERVER'
        : 'EMBEDDING_FAILED';
  return new EmbeddingProviderError(code, `Embedding provider request failed with status ${status}`);
}
