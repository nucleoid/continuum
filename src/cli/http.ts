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
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiUrl}/api/v0${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/json, text/markdown',
          ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
    } catch (error) {
      const message = controller.signal.aborted ? 'Request timed out' : 'Unable to reach Continuum API';
      throw new CliError(message, 5);
    } finally {
      clearTimeout(timer);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      throw new CliError('Server response exceeds the size limit', 5);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new CliError('Server response exceeds the size limit', 5);
    }
    const text = new TextDecoder().decode(bytes);
    if (!response.ok) {
      let message = `Continuum API returned HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch { /* retain deterministic status message */ }
      const redacted = this.options.token.length === 0
        ? message
        : message.split(this.options.token).join('[REDACTED]');
      throw new CliError(redacted.replace(/[\u0000-\u001f\u007f]/g, ' '), statusExit(response.status));
    }
    return text;
  }
}
