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

export type EmbeddingHttpProvider = 'openai' | 'voyage' | 'ollama';

const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ITEM_HTTP_STATUSES = new Set([400, 413, 422]);
const ITEM_ERROR_CODES = new Set([
  'context_length_exceeded',
  'input_too_large',
  'max_tokens_per_request',
  'payload_too_large',
  'text_too_long',
]);
const ITEM_MESSAGE = /\b(?:input|text|prompt|request body)\b.{0,80}\b(?:too (?:large|long)|exceeds?|maximum|context length|token limit)\b/i;
const OPENAI_CONTEXT_MESSAGE = /\bmaximum context length\b.{0,160}\b(?:requested|resulted in)\b.{0,80}\btokens?\b/i;
const VOYAGE_REQUEST_TOKEN_MESSAGE = /\b(?:total number of tokens|tokens? in the batch)\b.{0,120}\b(?:exceeds?|maximum|max allowed)\b.{0,80}\b(?:tokens? per request|request token limit)\b/i;

async function boundedErrorBody(response: Response): Promise<unknown> {
  const body = response.body;
  if (!body) return null;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_BODY_BYTES) {
    await body.cancel().catch(() => undefined);
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 512 ? value : null;
}

function isExplicitItemFailure(provider: EmbeddingHttpProvider, body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const root = body as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root;
  const code = stringField(nested.code)?.toLowerCase() ?? null;
  if (code && ITEM_ERROR_CODES.has(code)) return true;

  if (provider === 'openai') {
    const parameter = stringField(nested.param)?.toLowerCase() ?? null;
    const message = stringField(nested.message);
    return parameter === 'input'
      || parameter?.startsWith('input[') === true
      || (message !== null && OPENAI_CONTEXT_MESSAGE.test(message));
  }

  const message = provider === 'voyage'
    ? stringField(root.detail) ?? stringField(nested.message)
    : stringField(root.error) ?? stringField(nested.message);
  return message !== null && (ITEM_MESSAGE.test(message)
    || (provider === 'voyage' && VOYAGE_REQUEST_TOKEN_MESSAGE.test(message)));
}

export async function embeddingProviderHttpError(
  response: Response,
  provider: EmbeddingHttpProvider,
): Promise<EmbeddingProviderError | EmbeddingItemError> {
  const status = response.status;
  if (ITEM_HTTP_STATUSES.has(status)) {
    const body = await boundedErrorBody(response);
    if (isExplicitItemFailure(provider, body)) {
      return new EmbeddingItemError(`Embedding provider rejected input with status ${status}`);
    }
  }
  const code: EmbeddingProviderErrorCode = status === 401 || status === 403
    ? 'EMBEDDING_AUTH'
    : status === 429
      ? 'EMBEDDING_RATE_LIMIT'
      : status >= 500
        ? 'EMBEDDING_SERVER'
        : 'EMBEDDING_FAILED';
  return new EmbeddingProviderError(code, `Embedding provider request failed with status ${status}`);
}
