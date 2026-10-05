export type ExitCode = 2 | 3 | 4 | 5;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: ExitCode) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiClientOptions {
  apiUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 512;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function statusExit(status: number): ExitCode {
  if (status === 401 || status === 403) return 3;
  if (status === 404 || status === 409) return 4;
  if (status >= 400 && status < 500) return 2;
  return 5;
}

export class ApiClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async json(method: string, path: string, body?: unknown): Promise<any> {
    const text = await this.request(method, path, body);
    try { return JSON.parse(text); } catch { throw new CliError('Server returned invalid JSON', 5); }
  }

  async text(method: string, path: string): Promise<string> {
    return this.request(method, path);
  }

  private async request(method: string, path: string, body?: unknown): Promise<string> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
      throw new CliError('Request body exceeds 1 MiB', 2);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CliError('Request timed out', 5));
      }, this.options.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(`${this.options.apiUrl}/api/v0${path}`, {
          method,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: 'application/json, text/markdown',
            ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(serialized === undefined ? {} : { body: serialized }),
        }),
        timedOut,
      ]);
      const declaredHeader = response.headers.get('content-length');
      if (declaredHeader !== null && /^\d+$/.test(declaredHeader)) {
        const declared = Number(declaredHeader);
        if (Number.isSafeInteger(declared) && declared > this.maxResponseBytes) {
          controller.abort();
          await response.body?.cancel().catch(() => undefined);
          throw new CliError('Server response exceeds the size limit', 5);
        }
      }
      const bytes = await this.readResponse(response, controller, timedOut);
      const text = new TextDecoder().decode(bytes);
      if (!response.ok) throw this.responseError(response, text);
      return text;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        controller.signal.aborted ? 'Request timed out' : 'Unable to reach Continuum API',
        5,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readResponse(
    response: Response,
    controller: AbortController,
    timedOut: Promise<never>,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new CliError('Server response exceeds the size limit', 5);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CliError) {
        if (controller.signal.aborted) await reader.cancel().catch(() => undefined);
        throw error;
      }
      throw new CliError(
        controller.signal.aborted ? 'Request timed out' : 'Unable to read Continuum API response',
        5,
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private responseError(response: Response, text: string): CliError {
    let message = `Continuum API returned HTTP ${response.status}`;
    let bodyRequestId: unknown;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; requestId?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
      bodyRequestId = parsed.requestId;
    } catch { /* retain deterministic status message */ }
    const requestIdCandidate = response.headers.get('x-request-id') ?? bodyRequestId;
    const requestId = typeof requestIdCandidate === 'string'
      && REQUEST_ID_PATTERN.test(requestIdCandidate)
      ? requestIdCandidate
      : undefined;
    const redacted = this.redact(message)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, MAX_ERROR_DETAIL_CHARS);
    const detail = requestId === undefined
      ? redacted
      : `${redacted} (request ID: ${this.redact(requestId)})`;
    return new CliError(detail, statusExit(response.status));
  }

  private redact(value: string): string {
    return this.options.token.length === 0
      ? value
      : value.split(this.options.token).join('[REDACTED]');
  }
}
