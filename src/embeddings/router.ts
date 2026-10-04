import type { EmbeddingProvider } from './provider.js';
import type { ScopeKind, ScopeRef } from '../types.js';

export type ProviderSelection = string | 'local-only' | 'none';

export interface EmbeddingRoutingRule {
  match: { kind: ScopeKind; name?: string };
  provider: ProviderSelection;
}

export interface EmbeddingRoutingConfig {
  default: ProviderSelection;
  rules?: EmbeddingRoutingRule[];
}

export interface EmbeddingRoute {
  provider: EmbeddingProvider | null;
  alias: string | null;
  policy: 'provider' | 'disabled' | 'local-only-unavailable';
}

export interface EmbeddingRouter {
  resolve(scope: ScopeRef): EmbeddingRoute;
  providers(): EmbeddingProvider[];
}

export type EmbeddingRouting = EmbeddingRouter | EmbeddingProvider | null;

export function asEmbeddingRouter(routing: EmbeddingRouting): EmbeddingRouter {
  return routing && 'resolve' in routing ? routing : staticEmbeddingRouter(routing);
}

export class EmbeddingRegistry {
  private readonly byAlias: Map<string, EmbeddingProvider>;
  private readonly localProvider: EmbeddingProvider | null;

  constructor(entries: Iterable<readonly [string, EmbeddingProvider]>) {
    this.byAlias = new Map();
    const local: EmbeddingProvider[] = [];
    const identities = new Set<string>();
    for (const [alias, provider] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(alias)) {
        throw new Error('Embedding provider alias is invalid');
      }
      if (this.byAlias.has(alias)) throw new Error(`Duplicate embedding provider alias: ${alias}`);
      const identity = `${provider.id}\u0000${provider.dim}`;
      if (identities.has(identity)) throw new Error('Duplicate embedding provider identity');
      identities.add(identity);
      this.byAlias.set(alias, provider);
      if (provider.local === true) local.push(provider);
    }
    if (local.length > 1) {
      throw new Error('local-only routing is ambiguous: configure exactly one local provider');
    }
    this.localProvider = local[0] ?? null;
  }

  get(alias: string): EmbeddingProvider | undefined { return this.byAlias.get(alias); }
  local(): EmbeddingProvider | null { return this.localProvider; }
  values(): EmbeddingProvider[] { return [...new Set(this.byAlias.values())]; }
  aliasOf(provider: EmbeddingProvider): string | null {
    for (const [alias, candidate] of this.byAlias) if (candidate === provider) return alias;
    return null;
  }
}

export class ScopeEmbeddingRouter implements EmbeddingRouter {
  private readonly exact = new Map<string, ProviderSelection>();
  private readonly kinds = new Map<ScopeKind, ProviderSelection>();

  constructor(
    private readonly registry: EmbeddingRegistry,
    private readonly config: EmbeddingRoutingConfig,
  ) {
    this.validateSelection(config.default);
    for (const rule of config.rules ?? []) {
      this.validateSelection(rule.provider);
      if (rule.match.name !== undefined) {
        if (rule.match.name.length === 0 && rule.match.kind !== 'org') {
          throw new Error('Exact embedding routing rule names must not be empty');
        }
        const key = `${rule.match.kind}\u0000${rule.match.name}`;
        if (this.exact.has(key)) throw new Error('Duplicate exact embedding routing rule');
        this.exact.set(key, rule.provider);
      } else {
        if (this.kinds.has(rule.match.kind)) throw new Error('Duplicate kind embedding routing rule');
        this.kinds.set(rule.match.kind, rule.provider);
      }
    }
  }

  resolve(scope: ScopeRef): EmbeddingRoute {
    const selection = this.exact.get(`${scope.kind}\u0000${scope.name}`)
      ?? this.kinds.get(scope.kind)
      ?? this.config.default;
    if (selection === 'none') return { provider: null, alias: null, policy: 'disabled' };
    if (selection === 'local-only') {
      const provider = this.registry.local();
      return provider
        ? { provider, alias: this.registry.aliasOf(provider), policy: 'provider' }
        : { provider: null, alias: null, policy: 'local-only-unavailable' };
    }
    return { provider: this.registry.get(selection)!, alias: selection, policy: 'provider' };
  }

  providers(): EmbeddingProvider[] { return this.registry.values(); }

  private validateSelection(selection: ProviderSelection): void {
    if (selection !== 'none' && selection !== 'local-only' && !this.registry.get(selection)) {
      throw new Error(`Unknown provider alias in embedding routing: ${selection}`);
    }
  }

}

export function staticEmbeddingRouter(provider: EmbeddingProvider | null): EmbeddingRouter {
  return {
    resolve: () => provider
      ? { provider, alias: provider.id, policy: 'provider' }
      : { provider: null, alias: null, policy: 'disabled' },
    providers: () => provider ? [provider] : [],
  };
}
