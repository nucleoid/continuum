import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiClient, CliError } from './http.js';
import { readConfigFile, resolveConfig, type FileConfig } from './config.js';
import { jsonDocument, table } from './output.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_TYPES = new Set(['fact', 'decision', 'context', 'playbook', 'relationship']);
const AUDIT_ACTIONS = new Set(['read', 'write', 'promote', 'archive', 'verify']);

export interface CliDependencies {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  readConfig(path?: string): Promise<FileConfig | null>;
  readFile(path: string): Promise<string | Uint8Array>;
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}

const defaults: CliDependencies = {
  env: process.env,
  fetch: globalThis.fetch,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  async readStdin() {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_INPUT_BYTES) throw new CliError('Standard input exceeds 1 MiB', 2);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  },
  readConfig: readConfigFile,
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
  const sources = Number(values.body !== undefined) + Number(values['body-file'] !== undefined) + Number(!deps.stdinIsTTY);
  if (sources !== 1) throw new CliError('Capture requires exactly one of --body, --body-file, or non-TTY stdin', 2);
  let body = values.body;
  if (values['body-file']) body = checkedBytes(await deps.readFile(values['body-file']), 'Body file');
  if (!deps.stdinIsTTY) body = cleanInput(checkedBytes(await deps.readStdin(), 'Standard input'));
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
  emit(deps, values.json, result, `Captured ${result.id}\n`);
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
  if (values.since) query.set('since', parseSince(values.since, deps.now()));
  if (values.until) query.set('until', parseSince(values.until, deps.now()));
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
    ? `Granted ${role} on ${scopeLabel} to ${principalId}\n`
    : `Revoked membership on ${scopeLabel} from ${principalId}\n`);
}

async function commandPromote(args: string[], client: ApiClient, deps: CliDependencies) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    ...commonOptions, to: { type: 'string' },
  } });
  if (positionals.length !== 1 || !UUID.test(positionals[0])) throw new CliError('promote requires a memory UUID', 2);
  const result = await client.json('POST', `/memories/${positionals[0]}/promote`, {
    targetScope: scopeRef(requireString(values.to, '--to')),
  });
  emit(deps, values.json, result, `Promoted ${result.sourceId} to ${result.destinationId}\n`);
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
  emit(deps, values.json, result, `Verified ${result.id}: ${result.state}\n`);
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
  try {
    const command = argv[0];
    if (!command || command === '--help' || command === '-h') {
      deps.stdout(usage());
      return 0;
    }
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
    const file = await deps.readConfig(globalString(global.config));
    const config = resolveConfig({
      apiUrl: globalString(global['api-url']), token: globalString(global.token),
      profile: globalString(global.profile), timeoutMs,
    }, deps.env, file);
    const client = new ApiClient({ ...config, fetch: deps.fetch });
    const commands: Record<string, (args: string[], client: ApiClient, deps: CliDependencies) => Promise<void>> = {
      capture: commandCapture, recall: commandRecall, audit: commandAudit, scopes: commandScopes,
      promote: commandPromote, verify: commandVerify, 'agents-md': commandAgentsMd,
    };
    const handler = commands[command];
    if (!handler) throw new CliError(`Unknown command: ${command}`, 2);
    await handler(args, client, deps);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      deps.stderr(`continuum: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof TypeError && error.message.startsWith('Unknown option')) {
      deps.stderr(`continuum: ${error.message}\n`);
      return 2;
    }
    deps.stderr('continuum: unexpected failure\n');
    return 5;
  }
}
