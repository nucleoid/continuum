import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { isDirectEntrypoint } from '../api/entrypoint.js';
import { cliFailure } from '../identity/cli-errors.js';
import { ServiceError } from '../services/errors.js';
import { applicationSchemaFromEnv, requireEmbeddingQueueReady } from '../storage/provider-lifecycle.js';
import { SqlEmbeddingJobStore } from '../storage/embedding-jobs.js';
import { EMBEDDING_WORKER_DEFAULTS } from '../storage/embedding-jobs-model.js';
import { EmbeddingJobWorker, type EmbeddingWorkerTarget } from './embedding-jobs.js';

/** Explicit trusted composition supplies qualified request/token/price adapters.
 * No built-in model, hosted key, cost schedule or tokenizer is guessed here. */
export interface EmbeddingWorkerComposition {
  createEmbeddingWorkerTargets(env: Readonly<NodeJS.ProcessEnv>): Promise<ReadonlyArray<EmbeddingWorkerTarget>> | ReadonlyArray<EmbeddingWorkerTarget>;
}
export function createEmbeddingWorkerPool(connectionString: string, schema: string): pg.Pool {
  const options: pg.PoolConfig & { verify: (client: pg.PoolClient, done: (error?: Error) => void) => void } = {
    connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    verify(client, done) {
      void client.query("SELECT pg_catalog.set_config('search_path',$1,FALSE)", ['"' + schema.replaceAll('"','""') + '"'])
        .then(() => client.query(`SELECT pg_catalog.set_config('statement_timeout',
          CASE WHEN setting::int BETWEEN 1 AND 5000 THEN setting||'ms' ELSE '5000ms' END,FALSE)
          FROM pg_catalog.pg_settings WHERE name='statement_timeout'`))
        .then(() => client.query(`SELECT pg_catalog.set_config('lock_timeout',
          CASE WHEN setting::int BETWEEN 1 AND 1000 THEN setting||'ms' ELSE '1000ms' END,FALSE)
          FROM pg_catalog.pg_settings WHERE name='lock_timeout'`))
        .then(() => done(), () => done(new Error('Embedding database initialization failed')));
    },
  };
  const pool = new pg.Pool(options);
  pool.on('error', () => process.stderr.write('{"event":"embedding_database_unavailable"}\n'));
  return pool;
}

export async function runEmbeddingWorkerCli(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: continuum-embed-worker\nRequires CONTINUUM_EMBEDDING_WORKER_DATABASE_URL and an absolute CONTINUUM_EMBEDDING_WORKER_COMPOSITION module.\n');
    return 0;
  }
  if (args.length) throw new ServiceError('INVALID_INPUT', 'Embedding worker accepts only --help');
  const connection = env.CONTINUUM_EMBEDDING_WORKER_DATABASE_URL;
  const modulePath = env.CONTINUUM_EMBEDDING_WORKER_COMPOSITION;
  if (!connection || !modulePath || !isAbsolute(modulePath)) throw new ServiceError('INVALID_INPUT',
    'Embedding worker requires a dedicated database connection and an absolute trusted composition module');
  const schema = applicationSchemaFromEnv(env);
  const composition = await import(pathToFileURL(modulePath).href) as EmbeddingWorkerComposition;
  if (typeof composition.createEmbeddingWorkerTargets !== 'function') throw new ServiceError('INVALID_INPUT', 'Embedding composition export is unavailable');
  const entries = await composition.createEmbeddingWorkerTargets(Object.freeze({ ...env }));
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16
    || new Set(entries.map(entry => entry.provider.id)).size !== entries.length) throw new ServiceError('INVALID_INPUT', 'Embedding composition requires 1 to 16 distinct approved providers');
  const pool = createEmbeddingWorkerPool(connection, schema);
  const workers: EmbeddingJobWorker[] = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let active: Promise<void>[] = [];
  try {
    await requireEmbeddingQueueReady(pool, { expectedSchema: schema });
    const store = new SqlEmbeddingJobStore(pool);
    for (const entry of entries) {
      const ready = (await pool.query<{ ready: boolean }>('SELECT continuum_embedding_worker_config($1,$2,$3) AS ready',
        [entry.target, entry.policy, entry.profile])).rows[0].ready;
      if (!ready) throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Embedding worker binding or approved configuration is unavailable');
      workers.push(new EmbeddingJobWorker(store, [entry], randomUUID()));
    }
    // Separate provider workers preserve healthy-provider progress while one
    // retained callback drains. They share only this dedicated two-client pool.
    active = workers.map(worker => (async () => {
      while (!controller.signal.aborted) {
        try { await worker.poll(); } catch { process.stderr.write('{"event":"embedding_poll_unavailable"}\n'); }
        if (controller.signal.aborted) break;
        await new Promise<void>(resolve => {
          const abort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, EMBEDDING_WORKER_DEFAULTS.pollMs);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
    })());
    await new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
      if (controller.signal.aborted) resolve();
    });
    const stopped = await Promise.all(workers.map(worker => worker.stop()));
    if (stopped.some(result => !result.settled)) {
      process.stderr.write('{"event":"embedding_shutdown_unsettled","settled":false}\n');
      return 1;
    }
    await Promise.all(active);
    return 0;
  } finally {
    controller.abort(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await Promise.all(workers.map(worker => worker.stop()));
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([pool.end(), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
export async function embeddingWorkerMain(): Promise<void> {
  try { process.exit(await runEmbeddingWorkerCli()); }
  catch (error) { process.stderr.write(`${cliFailure('continuum_embedding_worker_failed', error)}\n`); process.exit(1); }
}
if (isDirectEntrypoint(import.meta.url)) void embeddingWorkerMain();
