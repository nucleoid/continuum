import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiClient, CliError } from './http.js';
import { readConfigFile, resolveConfig, type FileConfig } from './config.js';
import { humanText, jsonDocument, table } from './output.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_TYPES = new Set(['fact', 'decision', 'context', 'playbook', 'relationship']);
const AUDIT_ACTIONS = new Set(['read', 'write', 'promote', 'archive', 'verify']);
const STDIN_IDLE_TIMEOUT_MS = 30_000;
const STDIN_OVERALL_TIMEOUT_MS = 120_000;

export async function readBoundedStdin(
  stream: AsyncIterable<Uint8Array | string>,
  options: { idleTimeoutMs?: number; overallTimeoutMs?: number } = {},
): Promise<string> {
  const idleTimeoutMs = options.idleTimeoutMs ?? STDIN_IDLE_TIMEOUT_MS;
  const overallTimeoutMs = options.overallTimeoutMs ?? STDIN_OVERALL_TIMEOUT_MS;
  const deadline = Date.now() + overallTimeoutMs;
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CliError('Standard input timed out', 2);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CliError('Standard input timed out', 2)),
          Math.min(idleTimeoutMs, remaining),
        );
      });
      let result: IteratorResult<Uint8Array | string>;
      try {
        result = await Promise.race([iterator.next(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) break;
      const buffer = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
      size += buffer.byteLength;
      if (size > MAX_INPUT_BYTES) throw new CliError('Standard input exceeds 1 MiB', 2);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    const destroy = (stream as { destroy?: () => void }).destroy;
    if (typeof destroy === 'function') {
      try { destroy.call(stream); } catch { /* best-effort stream termination */ }
    }
    try {
      const cleanup = iterator.return?.();
      if (cleanup) void Promise.resolve(cleanup).catch(() => undefined);
    } catch { /* best-effort iterator cleanup */ }
    throw error;
  }
}

export interface CliDependencies {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  readConfig(path?: string, required?: boolean): Promise<FileConfig | null>;
  statFile(path: string): Promise<{ size: number; isFile(): boolean }>;
  readFile(path: string): Promise<string | Uint8Array>;
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}

const defaults: CliDependencies = {
  env: process.env,
  fetch: globalThis.fetch,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  async readStdin() { return readBoundedStdin(process.stdin); },
  readConfig: readConfigFile,
  statFile: stat,
  readFile,
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  now: () => new Date(),
};

const commonOptions = {
  'api-url': { type: 'string' as const },
  token: { type: 'string' as const },
  profile: { type: 'string' as const },
  config: { type: 'string' as const },
  timeout: { type: 'string' as const },
  json: { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, default: false },
};

function usage(): string {
  return `Usage: continuum <command> [options]\n\nCommands:\n  capture     Capture a memory\n  recall      Recall memories\n  audit       Query the audit log\n  scopes      List or manage scope memberships\n  promote     Promote a memory\n  verify      Verify or mark a memory stale\n  agents-md   Render an AGENTS.md bundle\n\nGlobal options:\n  --api-url URL  --token TOKEN  --profile NAME  --config FILE\n  --timeout MS   --json\n`;
}

function requireString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new CliError(`${name} is required`, 2);
  return value;
}

function integer(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError(`${name} must be an integer`, 2);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`${name} must be between ${min} and ${max}`, 2);
  }
  return parsed;
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new CliError('Comma-separated option cannot be empty', 2);
  return values;
}

function scopeRef(value: string): { kind: 'org' | 'team' | 'project' | 'user' | 'role'; name: string } {
  if (value === 'org') return { kind: 'org', name: '' };
  const match = /^(team|project|user|role):(.+)$/.exec(value);
  if (!match) throw new CliError(`Invalid scope: ${value}`, 2);
  return { kind: match[1] as 'team' | 'project' | 'user' | 'role', name: match[2] };
}

function cleanInput(value: string): string {
  return value.replace(/\r?\n$/, '');
}

function checkedBytes(value: string | Uint8Array, label: string): string {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new CliError(`${label} exceeds 1 MiB`, 2);
  return bytes.toString('utf8');
}

async function readBodyFile(path: string, deps: CliDependencies): Promise<string> {
  let file: { size: number; isFile(): boolean };
  try {
    file = await deps.statFile(path);
  } catch {
    throw new CliError('Unable to read body file', 2);
  }
  if (!file.isFile()) throw new CliError('Body file must be a regular file', 2);
  if (file.size > MAX_INPUT_BYTES) throw new CliError('Body file exceeds 1 MiB', 2);
  try {
    return checkedBytes(await deps.readFile(path), 'Body file');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Unable to read body file', 2);
  }
}

function emit(deps: CliDependencies, json: boolean, value: unknown, human: string): void {
  deps.stdout(json ? jsonDocument(value) : human);
}

function parseSince(value: string, now: Date): string {
  const relative = /^([1-9]\d{0,3})h$/.exec(value);
  if (relative) return new Date(now.getTime() - Number(relative[1]) * 3_600_000).toISOString();
  const instant = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(instant.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CliError('Audit time must be Nh or RFC 3339 with an explicit timezone', 2);
  }
  return value;
}

async function commandCapture(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, scope: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
    body: { type: 'string' }, 'body-file': { type: 'string' }, tags: { type: 'string' },
    source: { type: 'string', default: 'manual' }, 'source-ref': { type: 'string' },
    metadata: { type: 'string' },
  } });
  if (positionals.length) throw new CliError('capture does not accept positional arguments', 2);
  if (values.body !== undefined && values['body-file'] !== undefined) {
    throw new CliError('Capture accepts only one of --body or --body-file', 2);
  }
  let body = values.body;
  if (values['body-file'] !== undefined) {
    body = await readBodyFile(requireString(values['body-file'], '--body-file'), deps);
  } else if (values.body === undefined) {
    if (deps.stdinIsTTY) {
      throw new CliError('Capture requires --body, --body-file, or non-TTY stdin', 2);
    }
    body = checkedBytes(await deps.readStdin(), 'Standard input');
  }
  body = cleanInput(body ?? '');
  if (!body) throw new CliError('Capture body cannot be empty', 2);
  const type = requireString(values.type, '--type');
  if (!MEMORY_TYPES.has(type)) throw new CliError(`Invalid memory type: ${type}`, 2);
  let metadata: Record<string, unknown> | undefined;
  if (values.metadata) {
    try {
      const parsed: unknown = JSON.parse(values.metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      metadata = parsed as Record<string, unknown>;
    } catch { throw new CliError('--metadata must be a JSON object', 2); }
  }
  const result = await client.json('POST', '/capture', {
    scope: scopeRef(requireString(values.scope, '--scope')),
    type,
    title: requireString(values.title, '--title'),
    body,
    ...(csv(values.tags) ? { tags: csv(values.tags) } : {}),
    source: values.source,
    ...(values['source-ref'] ? { sourceRef: values['source-ref'] } : {}),
    ...(metadata ? { metadata } : {}),
  });
  emit(deps, values.json, result, `Captured ${humanText(result.id)}\n`);
}

async function commandRecall(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, scopes: { type: 'string' }, types: { type: 'string' }, limit: { type: 'string' },
  } });
  if (positionals.length !== 1) throw new CliError('recall requires one query argument', 2);
  const types = csv(values.types);
  if (types?.some((type) => !MEMORY_TYPES.has(type))) throw new CliError('Invalid memory type filter', 2);
  const result = await client.json('POST', '/recall', {
    query: positionals[0], ...(csv(values.scopes) ? { scopes: csv(values.scopes) } : {}),
    ...(types ? { types } : {}), ...(integer(values.limit, '--limit', 1, 100) ? { limit: integer(values.limit, '--limit', 1, 100) } : {}),
  });
  emit(deps, values.json, result, table(
    ['ID', 'SCOPE', 'TYPE', 'SCORE', 'TITLE', 'EXCERPT'],
    result.results.map((item: any) => [item.id, item.scope, item.type, item.score, item.title, item.excerpt]),
  ));
}

async function commandAudit(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, since: { type: 'string' }, until: { type: 'string' }, action: { type: 'string' },
    principal: { type: 'string' }, scope: { type: 'string' }, memory: { type: 'string' },
    limit: { type: 'string' }, offset: { type: 'string' },
  } });
  if (positionals.length) throw new CliError('audit does not accept positional arguments', 2);
  if (values.action && !AUDIT_ACTIONS.has(values.action)) throw new CliError('Invalid audit action', 2);
  const query = new URLSearchParams();
  const now = values.since || values.until ? deps.now() : undefined;
  if (values.since) query.set('since', parseSince(values.since, now!));
  if (values.until) query.set('until', parseSince(values.until, now!));
  if (values.action) query.set('action', values.action);
  if (values.principal) query.set('principalId', values.principal);
  if (values.scope) query.set('scopeId', values.scope);
  if (values.memory) query.set('memoryId', values.memory);
  const limit = integer(values.limit, '--limit', 1, 500);
  const offset = integer(values.offset, '--offset', 0, 1_000_000);
  if (limit !== undefined) query.set('limit', String(limit));
  if (offset !== undefined) query.set('offset', String(offset));
  const result = await client.json('GET', `/audit?${query}`);
  emit(deps, values.json, result, table(
    ['ID', 'AT', 'ACTION', 'PRINCIPAL', 'MEMORY', 'SCOPE'],
    result.entries.map((item: any) => [item.id, item.at, item.action, item.principalId, item.memoryId, item.scopeId]),
  ));
}

async function listScopes(client: ApiClient, manage = false): Promise<any> {
  return client.json('GET', manage ? '/scopes?manage=true' : '/scopes');
}

async function commandScopes(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: commonOptions });
  const action = positionals[0] ?? 'list';
  if (action === 'list' && positionals.length === 1 || action === 'list' && positionals.length === 0) {
    const result = await listScopes(client);
    emit(deps, values.json, result, table(
      ['ID', 'SCOPE', 'ROLE'], result.scopes.map((item: any) => [item.id, item.scope, item.role]),
    ));
    return;
  }
  if (action !== 'grant' && action !== 'revoke') throw new CliError('scopes expects list, grant, or revoke', 2);
  const expected = action === 'grant' ? 4 : 3;
  if (positionals.length !== expected) {
    throw new CliError(`scopes ${action} has invalid arguments`, 2);
  }
  const [, principalId, scopeLabel, role] = positionals;
  if (!UUID.test(principalId)) throw new CliError('Principal must be a UUID', 2);
  if (action === 'grant' && !['reader', 'writer', 'admin'].includes(role)) throw new CliError('Invalid membership role', 2);
  const scopes = await listScopes(client, true);
  const scope = scopes.scopes.find((item: any) => item.scope === scopeLabel);
  if (!scope) throw new CliError(`Scope is not visible: ${scopeLabel}`, 4);
  const path = `/scopes/${scope.id}/members/${principalId}`;
  const result = action === 'grant'
    ? await client.json('PUT', path, { role })
    : await client.json('DELETE', path);
  emit(deps, values.json, result, action === 'grant'
    ? `Granted ${humanText(role)} on ${humanText(scopeLabel)} to ${humanText(principalId)}\n`
    : `Revoked membership on ${humanText(scopeLabel)} from ${humanText(principalId)}\n`);
}

async function commandPromote(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, to: { type: 'string' },
  } });
  if (positionals.length !== 1 || !UUID.test(positionals[0])) throw new CliError('promote requires a memory UUID', 2);
  const result = await client.json('POST', `/memories/${positionals[0]}/promote`, {
    targetScope: scopeRef(requireString(values.to, '--to')),
  });
  emit(deps, values.json, result, `Promoted ${humanText(result.sourceId)} to ${humanText(result.destinationId)}\n`);
}

async function commandVerify(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, 'still-true': { type: 'boolean' }, 'no-longer-true': { type: 'boolean' }, note: { type: 'string' },
  } });
  if (positionals.length !== 1 || !UUID.test(positionals[0])) throw new CliError('verify requires a memory UUID', 2);
  if (Boolean(values['still-true']) === Boolean(values['no-longer-true'])) {
    throw new CliError('verify requires exactly one of --still-true or --no-longer-true', 2);
  }
  const result = await client.json('POST', `/memories/${positionals[0]}/verify`, {
    stillTrue: Boolean(values['still-true']), ...(values.note ? { note: values.note } : {}),
  });
  emit(deps, values.json, result, `Verified ${humanText(result.id)}: ${humanText(result.state)}\n`);
}

async function commandAgentsMd(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, project: { type: 'string' }, team: { type: 'string' }, limit: { type: 'string' },
  } });
  if (positionals.length) throw new CliError('agents-md does not accept positional arguments', 2);
  const query = new URLSearchParams();
  if (values.project) query.set('project', values.project);
  if (values.team) query.set('team', values.team);
  const limit = integer(values.limit, '--limit', 1, 200);
  if (limit !== undefined) query.set('limit', String(limit));
  const markdown = await client.text('GET', `/agents-md?${query}`);
  emit(deps, values.json, { markdown }, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}

export async function runCli(argv: string[], dependencies: Partial<CliDependencies> = {}): Promise<number> {
  const deps = { ...defaults, ...dependencies } as CliDependencies;
  const jsonErrors = argv.includes('--json');
  const fail = (message: string, exitCode: 2 | 3 | 4 | 5): number => {
    deps.stderr(jsonErrors
      ? jsonDocument({ error: { message, exitCode } })
      : `continuum: ${humanText(message)}\n`);
    return exitCode;
  };
  try {
    const command = argv[0];
    if (!command || command === '--help' || command === '-h') {
      deps.stdout(usage());
      return 0;
    }
    const commands: Record<string, (args: string[], client: ApiClient, deps: CliDependencies) => Promise<void>> = {
      capture: commandCapture, recall: commandRecall, audit: commandAudit, scopes: commandScopes,
      promote: commandPromote, verify: commandVerify, 'agents-md': commandAgentsMd,
    };
    const handler = commands[command];
    if (!handler) throw new CliError(`Unknown command: ${command}`, 2);
    const args = argv.slice(1);
    const global = parseArgs({ args, allowPositionals: true, strict: false, options: commonOptions }).values;
    if (global.help) {
      deps.stdout(usage());
      return 0;
    }
    const globalString = (value: string | boolean | (string | boolean)[] | undefined): string | undefined =>
      typeof value === 'string' ? value : undefined;
    const timeout = globalString(global.timeout);
    const timeoutMs = timeout === undefined
      ? undefined
      : integer(timeout, '--timeout', 1, 120_000);
    const configPath = globalString(global.config);
    const file = await deps.readConfig(configPath, configPath !== undefined);
    const config = resolveConfig({
      apiUrl: globalString(global['api-url']), token: globalString(global.token),
      profile: globalString(global.profile), timeoutMs,
    }, deps.env, file);
    const client = new ApiClient({ ...config, fetch: deps.fetch });
    await handler(args, client, deps);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      return fail(error.message, error.exitCode);
    }
    if (
      error instanceof TypeError
      && typeof (error as NodeJS.ErrnoException).code === 'string'
      && (error as NodeJS.ErrnoException).code!.startsWith('ERR_PARSE_ARGS_')
    ) {
      return fail(error.message, 2);
    }
    return fail('unexpected failure', 5);
  }
}
