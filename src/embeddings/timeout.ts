export const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000;
export const MAX_EMBEDDING_TIMEOUT_MS = 300_000;

export function validateEmbeddingTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EMBEDDING_TIMEOUT_MS) {
    throw new Error(`Embedding timeout must be between 1 and ${MAX_EMBEDDING_TIMEOUT_MS} ms`);
  }
  return timeoutMs;
}

export async function withEmbeddingTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  validateEmbeddingTimeout(timeoutMs);
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Embedding request aborted');
  }
  const controller = new AbortController();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const forward = () => {
    const reason = signal?.reason ?? new Error('Embedding request aborted');
    controller.abort(reason);
    rejectAbort?.(reason);
  };
  signal?.addEventListener('abort', forward, { once: true });
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Embedding request timed out after ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline, aborted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', forward);
  }
}
