import type { EmbeddingProvider } from './provider.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from './hosted.js';
import {
  EmbeddingRegistry,
  ScopeEmbeddingRouter,
  staticEmbeddingRouter,
  type EmbeddingRouter,
  type EmbeddingRoutingConfig,
} from './router.js';
import { STORAGE_EMBEDDING_DIM } from '../storage/schema.js';
import type { ScopeKind } from '../types.js';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  MAX_EMBEDDING_TIMEOUT_MS,
  validateEmbeddingTimeout,
} from './timeout.js';

function embeddingDimension(env: NodeJS.ProcessEnv): number {
  const configured = env.CONTINUUM_EMBEDDING_DIM ?? String(STORAGE_EMBEDDING_DIM);
  const dim = Number(configured);
  if (!Number.isInteger(dim) || dim <= 0 || dim !== STORAGE_EMBEDDING_DIM) {
    throw new Error(
      `CONTINUUM_EMBEDDING_DIM must be ${STORAGE_EMBEDDING_DIM} to match database vector(${STORAGE_EMBEDDING_DIM})`,
    );
  }
  return dim;
}

function embeddingTimeout(env: NodeJS.ProcessEnv): number {
  const configured = env.CONTINUUM_EMBEDDING_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_EMBEDDING_TIMEOUT_MS;
  return validateEmbeddingTimeout(Number(configured));
}

function positiveIntegerSetting(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum?: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

export function makeEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | null {
  const kind = env.CONTINUUM_EMBEDDING_PROVIDER?.toLowerCase();
  if (!kind || kind === 'none' || kind === 'noop') return null;
  if (kind === 'ollama') {
    const baseUrl = env.CONTINUUM_OLLAMA_URL ?? 'http://localhost:11434';
    const model = env.CONTINUUM_EMBEDDING_MODEL ?? 'nomic-embed-text';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
      throw new Error('CONTINUUM_EMBEDDING_MODEL is invalid');
    }
    try {
      const endpoint = new URL(baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password) throw new Error('unsafe endpoint');
    } catch {
      throw new Error('CONTINUUM_OLLAMA_URL must be an HTTP URL without credentials');
    }
    const dim = embeddingDimension(env);
    const batchSize = positiveIntegerSetting(
      env.CONTINUUM_EMBEDDING_BATCH_SIZE, 32, 'CONTINUUM_EMBEDDING_BATCH_SIZE', 1_000,
    );
    return new OllamaEmbeddingProvider({
      baseUrl, model, dim, timeoutMs: embeddingTimeout(env), batchSize,
    });
  }
  throw new Error(`Unknown CONTINUUM_EMBEDDING_PROVIDER: ${kind}`);
}

type ProviderDefinition = {
  alias: string;
  kind: 'ollama' | 'openai' | 'voyage';
  model: string;
  dim: number;
  endpoint?: string;
  timeout_ms?: number;
  batch_size?: number;
  local: boolean;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function providerDefinition(value: unknown): ProviderDefinition {
  const raw = object(value, 'Embedding provider definition');
  if ('apiKey' in raw || 'api_key' in raw || 'secret' in raw || 'token' in raw) {
    throw new Error('Embedding provider definitions must not contain inline credentials');
  }
  const allowed = new Set(['alias', 'kind', 'model', 'dim', 'endpoint', 'timeout_ms', 'batch_size', 'local']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error('Embedding provider definition contains an unknown field');
  }
  if (typeof raw.alias !== 'string' || typeof raw.model !== 'string' || !raw.model) {
    throw new Error('Embedding provider alias and model are required');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(raw.model)) {
    throw new Error('Embedding provider model is invalid');
  }
  if (!['ollama', 'openai', 'voyage'].includes(String(raw.kind))) {
    throw new Error('Embedding provider kind must be ollama, openai, or voyage');
  }
  if (raw.dim !== STORAGE_EMBEDDING_DIM) {
    throw new Error(`Embedding provider dimension must be ${STORAGE_EMBEDDING_DIM} to match database vector(${STORAGE_EMBEDDING_DIM})`);
  }
  if (typeof raw.local !== 'boolean') {
    throw new Error('Embedding provider definitions must explicitly set local');
  }
  if (raw.kind !== 'ollama' && raw.local) {
    throw new Error('Hosted embedding providers cannot be marked local');
  }
  if (raw.endpoint !== undefined && typeof raw.endpoint !== 'string') {
    throw new Error('Embedding provider endpoint must be a string');
  }
  if (typeof raw.endpoint === 'string') {
    try {
      const endpoint = new URL(raw.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password) throw new Error('unsafe endpoint');
      if (raw.kind !== 'ollama' && endpoint.protocol !== 'https:' && !isLoopback(raw.endpoint)) {
        throw new Error('insecure hosted endpoint');
      }
    } catch {
      throw new Error(raw.kind === 'ollama'
        ? 'Embedding provider endpoint must be an HTTP URL without credentials'
        : 'Hosted embedding provider endpoint must use HTTPS (HTTP is allowed only for loopback)');
    }
  }
  if (raw.timeout_ms !== undefined
    && (!Number.isSafeInteger(raw.timeout_ms)
      || (raw.timeout_ms as number) < 1
      || (raw.timeout_ms as number) > MAX_EMBEDDING_TIMEOUT_MS)) {
    throw new Error(`Embedding provider timeout_ms must be between 1 and ${MAX_EMBEDDING_TIMEOUT_MS}`);
  }
  if (raw.batch_size !== undefined
    && (!Number.isSafeInteger(raw.batch_size) || (raw.batch_size as number) <= 0
      || (raw.batch_size as number) > 1_000)) {
    throw new Error('Embedding provider batch_size must be a positive integer at most 1000');
  }
  const definition = raw as ProviderDefinition;
  validateProviderCompatibility(definition);
  return definition;
}

function validateProviderCompatibility(definition: ProviderDefinition): void {
  if (definition.kind === 'voyage') {
    throw new Error(
      `Voyage model ${definition.model} dimension ${definition.dim} is unsupported: `
      + 'Voyage supports 256, 512, 1024, or 2048 dimensions, while v0 storage requires 768',
    );
  }
  if (definition.kind === 'openai') {
    if (definition.model === 'text-embedding-ada-002') {
      throw new Error('OpenAI text-embedding-ada-002 requires dimension 1536; v0 storage requires 768');
    }
    if (!['text-embedding-3-small', 'text-embedding-3-large'].includes(definition.model)) {
      throw new Error(`Unsupported OpenAI embedding model: ${definition.model}`);
    }
  }
}

const SCOPE_KINDS = new Set<ScopeKind>(['org', 'team', 'project', 'user', 'role']);

function routingConfig(value: unknown): EmbeddingRoutingConfig {
  const raw = object(value, 'Embedding routing config');
  if (Object.keys(raw).some((key) => !['default', 'rules'].includes(key))) {
    throw new Error('Embedding routing config contains an unknown field');
  }
  if (typeof raw.default !== 'string' || !Array.isArray(raw.rules)) {
    throw new Error('Embedding routing requires default and rules');
  }
  return {
    default: raw.default,
    rules: raw.rules.map((value) => {
      const rule = object(value, 'Embedding routing rule');
      const match = object(rule.match, 'Embedding routing selector');
      if (Object.keys(rule).some((key) => !['match', 'provider'].includes(key))
        || Object.keys(match).some((key) => !['kind', 'name'].includes(key))) {
        throw new Error('Embedding routing rule contains an unknown field');
      }
      if (!SCOPE_KINDS.has(match.kind as ScopeKind)
        || (match.name !== undefined && typeof match.name !== 'string')
        || typeof rule.provider !== 'string') {
        throw new Error('Embedding routing rule is invalid');
      }
      if (match.name !== undefined
        && ((match.kind === 'org' && match.name !== '')
          || (match.kind !== 'org' && match.name === ''))) {
        throw new Error(match.kind === 'org'
          ? 'Embedding routing org scope name must be empty'
          : `Embedding routing ${String(match.kind)} scope requires a name`);
      }
      return {
        match: { kind: match.kind as ScopeKind, ...(match.name === undefined ? {} : { name: match.name }) },
        provider: rule.provider,
      };
    }),
  };
}

function isLoopback(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch { return false; }
}

function instantiateProvider(
  definition: ProviderDefinition,
  env: NodeJS.ProcessEnv,
): EmbeddingProvider {
  const common = {
    model: definition.model,
    dim: definition.dim,
    ...(definition.endpoint ? { endpoint: definition.endpoint } : {}),
    ...(definition.timeout_ms ? { timeoutMs: definition.timeout_ms } : {}),
  };
  if (definition.kind === 'ollama') {
    const endpoint = definition.endpoint ?? 'http://localhost:11434';
    if (definition.local && !isLoopback(endpoint)) {
      process.emitWarning(`Local Ollama provider ${definition.alias} uses a non-loopback endpoint`);
    }
    const provider = new OllamaEmbeddingProvider({
      baseUrl: endpoint, model: definition.model, dim: definition.dim,
      timeoutMs: definition.timeout_ms ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
      ...(definition.batch_size ? { batchSize: definition.batch_size } : {}),
    });
    Object.defineProperty(provider, 'local', { value: definition.local });
    return provider;
  }
  const keyName = definition.kind === 'openai' ? 'OPENAI_API_KEY' : 'VOYAGE_API_KEY';
  const apiKey = env[keyName];
  if (!apiKey) throw new Error(`${keyName} is required for configured ${definition.kind} provider`);
  return definition.kind === 'openai'
    ? new OpenAIEmbeddingProvider({ ...common, apiKey })
    : new VoyageEmbeddingProvider({ ...common, apiKey });
}

export function makeEmbeddingRouterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingRouter {
  const serialized = env.CONTINUUM_EMBEDDING_CONFIG;
  if (!serialized) return staticEmbeddingRouter(makeEmbeddingProviderFromEnv(env));
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch {
    throw new Error('CONTINUUM_EMBEDDING_CONFIG must be valid JSON');
  }
  const config = object(parsed, 'CONTINUUM_EMBEDDING_CONFIG');
  if (Object.keys(config).some((key) => !['providers', 'routing'].includes(key))) {
    throw new Error('CONTINUUM_EMBEDDING_CONFIG contains an unknown field');
  }
  if (!Array.isArray(config.providers)) {
    throw new Error('CONTINUUM_EMBEDDING_CONFIG providers must be an array');
  }
  const definitions = config.providers.map(providerDefinition);
  const registry = new EmbeddingRegistry(definitions.map((definition) => [
    definition.alias,
    instantiateProvider(definition, env),
  ] as const));
  return new ScopeEmbeddingRouter(registry, routingConfig(config.routing));
}
