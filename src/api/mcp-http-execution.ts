import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { asEmbeddingRouter, type EmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
/** Request-local cancellation checks preserve rollback and never interrupt a successful commit retroactively. */
export function remoteExecutionContext(pool: pg.Pool, routing: EmbeddingRouting) {
  type Scope = { signal: AbortSignal; pending: Set<Promise<unknown>> };
  const signals = new AsyncLocalStorage<Scope>();
  const inScope = <T>(scope: Scope | undefined, callback: () => T): T =>
    scope ? signals.run(scope, callback) : signals.exit(callback);
  const check = (args: unknown[], scope: Scope | undefined) => {
    const query = args[0];
    const text = typeof query === 'string' ? query : (query as { text?: string })?.text;
    if (!/^\s*ROLLBACK(?:\s|$)/i.test(text ?? '')) scope?.signal.throwIfAborted();
  };
  const wrapClient = (client: pg.PoolClient, scope: Scope | undefined) => {
    let discard = false;
    return new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'query') return (...args: unknown[]) => {
          try { check(args, scope); } catch (error) { discard = true; throw error; }
          return Reflect.apply(value, target, args);
        };
        if (property === 'release') return (error?: Error | boolean) => target.release(discard || error);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const guarded = new Proxy(pool, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property);
      if (property === 'query') return (...args: unknown[]) => {
        const scope = signals.getStore(); check(args, scope);
        const callback = args.at(-1);
        if (typeof callback === 'function') args[args.length - 1] = (...result: unknown[]) =>
          inScope(scope, () => Reflect.apply(callback, undefined, result));
        return Reflect.apply(value, receiver, args);
      };
      if (property === 'connect') return (...args: unknown[]) => {
        // pg-pool can dispatch a waiting callback synchronously from a foreign release.
        // Capture the acquiring scope before queueing, including callback continuations.
        const scope = signals.getStore(); scope?.signal.throwIfAborted();
        if (typeof args[0] === 'function') {
          const callback = args[0] as (error: Error | undefined, client?: pg.PoolClient, release?: unknown) => void;
          return Reflect.apply(value, target, [(error: Error | undefined, client?: pg.PoolClient, release?: unknown) =>
            inScope(scope, () => callback(error, client && wrapClient(client, scope), release))]);
        }
        return (Reflect.apply(value, target, args) as Promise<pg.PoolClient>).then(client => wrapClient(client, scope));
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
          const scope = signals.getStore(); const request = scope?.signal; request?.throwIfAborted();
          const signal = request && options?.signal ? AbortSignal.any([request, options.signal]) : request ?? options?.signal;
          const work = target.embed(texts, { ...options, signal });
          if (scope) { scope.pending.add(work); void work.then(() => scope.pending.delete(work), () => scope.pending.delete(work)); }
          return work;
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
  return { pool: guarded, routing: guardedRouting, async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    const scope = { signal, pending: new Set<Promise<unknown>>() };
    try { return await signals.run(scope, execute); }
    finally { await Promise.allSettled([...scope.pending]); }
  } };
}
