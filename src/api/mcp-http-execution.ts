import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { asEmbeddingRouter, type EmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
/** Request-local cancellation checks preserve rollback and never interrupt a successful commit retroactively. */
export function remoteExecutionContext(pool: pg.Pool, routing: EmbeddingRouting) {
  const signals = new AsyncLocalStorage<AbortSignal>();
  const check = (args: unknown[]) => {
    const query = args[0];
    const text = typeof query === 'string' ? query : (query as { text?: string })?.text;
    if (!/^\s*ROLLBACK(?:\s|$)/i.test(text ?? '')) signals.getStore()?.throwIfAborted();
  };
  const wrapClient = (client: pg.PoolClient) => new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'query') return (...args: unknown[]) => { check(args); return Reflect.apply(value, target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const guarded = new Proxy(pool, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property);
      if (property === 'query') return (...args: unknown[]) => { check(args); return Reflect.apply(value, receiver, args); };
      if (property === 'connect') return (...args: unknown[]) => {
        signals.getStore()?.throwIfAborted();
        if (typeof args[0] === 'function') {
          const callback = args[0] as (error: Error | undefined, client?: pg.PoolClient, release?: unknown) => void;
          return Reflect.apply(value, target, [(error: Error | undefined, client?: pg.PoolClient, release?: unknown) =>
            callback(error, client && wrapClient(client), release)]);
        }
        return (Reflect.apply(value, target, args) as Promise<pg.PoolClient>).then(wrapClient);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const router = asEmbeddingRouter(routing);
  const providers = new WeakMap<EmbeddingProvider, EmbeddingProvider>();
  const wrapProvider = (provider: EmbeddingProvider): EmbeddingProvider => {
    let wrapped = providers.get(provider);
    if (!wrapped) {
      wrapped = new Proxy(provider, { get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'embed') return (texts: string[], options?: { signal?: AbortSignal }) => {
          const request = signals.getStore(); request?.throwIfAborted();
          const signal = request && options?.signal ? AbortSignal.any([request, options.signal]) : request ?? options?.signal;
          return target.embed(texts, { ...options, signal });
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } }); providers.set(provider, wrapped);
    }
    return wrapped;
  };
  const guardedRouting: EmbeddingRouter = {
    resolve(scope) { const route = router.resolve(scope); return { ...route, provider: route.provider && wrapProvider(route.provider) }; },
    providers() { return router.providers().map(wrapProvider); },
  };
  return { pool: guarded, routing: guardedRouting, run<T>(signal: AbortSignal, execute: () => T): T { return signals.run(signal, execute); } };
}
