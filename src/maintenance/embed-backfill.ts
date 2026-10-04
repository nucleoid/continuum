import type pg from 'pg';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import {
  asEmbeddingRouter,
  type EmbeddingRouting,
} from '../embeddings/router.js';
import { memoryEmbeddingText } from '../embeddings/text.js';
import { LIFECYCLE_PRINCIPAL_ID } from '../lifecycle/principal.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import type { ScopeKind, ScopeRef } from '../types.js';

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_MAX_ERRORS = 25;
const MAX_BATCH_SIZE = 1_000;

interface Candidate {
  id: string;
  title: string;
  body: string;
  scope: ScopeRef;
}

export interface EmbeddingBackfillOptions {
  batchSize?: number;
  maxRows?: number;
  cursor?: string;
  scope?: ScopeRef;
  providerId?: string;
  dryRun?: boolean;
  countOnly?: boolean;
  maxRetries?: number;
  retryBaseMs?: number;
  maxErrors?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export interface EmbeddingBackfillReport {
  scanned: number;
  eligible: number;
  embedded: number;
  failed: number;
  providers: number;
  completed: boolean;
  cursor: string | null;
  dryRun: boolean;
  countOnly: boolean;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function scopeKey(scope: ScopeRef | undefined): string {
  if (!scope) return '';
  return scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`;
}

function sameProvider(left: EmbeddingProvider | null, right: EmbeddingProvider): boolean {
  return left?.id === right.id && left.dim === right.dim;
}

function validateVectors(vectors: number[][], expected: number, provider: EmbeddingProvider): void {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error('Embedding provider returned unexpected cardinality');
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== provider.dim
      || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Embedding provider returned an invalid vector');
    }
  }
}

async function checkpoint(
  client: pg.PoolClient,
  provider: EmbeddingProvider,
  filter: string,
  cursor: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO embedding_backfill_checkpoints (provider, dim, scope_filter, cursor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, dim, scope_filter) DO UPDATE
       SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [provider.id, provider.dim, filter, cursor],
  );
}

async function storeBatch(
  client: pg.PoolClient,
  provider: EmbeddingProvider,
  items: Candidate[],
  vectors: number[][],
): Promise<void> {
  await client.query('BEGIN');
  try {
    for (let index = 0; index < items.length; index += 1) {
      await storeMemoryEmbeddingVector(client, items[index]!.id, vectors[index]!, provider);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function auditFailure(
  client: pg.PoolClient,
  provider: EmbeddingProvider,
  item: Candidate,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (principal_id, action, memory_id, scope_id, metadata)
     SELECT $1, 'write', m.id, m.scope_id, $3::jsonb
       FROM memories m WHERE m.id = $2`,
    [
      LIFECYCLE_PRINCIPAL_ID,
      item.id,
      JSON.stringify({
        operation: 'embedding_backfill',
        embedded: false,
        embedding_error_code: 'EMBEDDING_FAILED',
        provider: provider.id,
        dim: provider.dim,
      }),
    ],
  );
}

async function runProvider(
  pool: pg.Pool,
  routing: EmbeddingRouting,
  provider: EmbeddingProvider,
  options: Required<Pick<EmbeddingBackfillOptions,
    'batchSize' | 'maxRows' | 'dryRun' | 'countOnly' | 'maxRetries'
    | 'retryBaseMs' | 'maxErrors' | 'sleep' | 'random'>>
    & Pick<EmbeddingBackfillOptions, 'cursor' | 'scope'>,
): Promise<Omit<EmbeddingBackfillReport, 'providers' | 'dryRun' | 'countOnly'>> {
  const router = asEmbeddingRouter(routing);
  const client = await pool.connect();
  const filter = scopeKey(options.scope);
  const lockName = `continuum:embed-backfill:${provider.id}:${provider.dim}:${filter}`;
  let locked = false;
  let cursor: string | null = options.cursor ?? null;
  let scanned = 0;
  let eligible = 0;
  let embedded = 0;
  let failed = 0;
  let completed = false;

  try {
    if (!options.dryRun && !options.countOnly) {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockName],
      );
      if (lock.rows[0]?.locked !== true) throw new Error('Embedding backfill is already running for this provider');
      locked = true;
      if (!options.cursor) {
        const saved = await client.query<{ cursor: string | null }>(
          `SELECT cursor FROM embedding_backfill_checkpoints
            WHERE provider = $1 AND dim = $2 AND scope_filter = $3`,
          [provider.id, provider.dim, filter],
        );
        cursor = saved.rows[0]?.cursor ?? null;
      }
    }

    const scopeRows = await client.query<{
      id: string; kind: ScopeKind; name: string;
    }>('SELECT id, kind, name FROM scopes ORDER BY id');
    const routedScopeIds = scopeRows.rows
      .filter((scope) => (!options.scope
        || (scope.kind === options.scope.kind && scope.name === options.scope.name)))
      .filter((scope) => sameProvider(
        router.resolve({ kind: scope.kind, name: scope.name }).provider,
        provider,
      ))
      .map((scope) => scope.id);
    if (routedScopeIds.length === 0) {
      completed = true;
      cursor = null;
      if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, null);
      return { scanned, eligible, embedded, failed, completed, cursor };
    }

    const processItems = async (items: Candidate[]): Promise<void> => {
      if (items.length === 0) return;
      try {
        const vectors = await provider.embed(items.map(memoryEmbeddingText));
        validateVectors(vectors, items.length, provider);
        await storeBatch(client, provider, items, vectors);
        embedded += items.length;
        return;
      } catch (error) {
        if (items.length > 1) {
          const middle = Math.floor(items.length / 2);
          await processItems(items.slice(0, middle));
          await processItems(items.slice(middle));
          return;
        }
        let lastError = error;
        for (let retry = 0; retry < options.maxRetries; retry += 1) {
          const delay = Math.max(1, Math.round(
            options.retryBaseMs * (2 ** retry) * (0.75 + options.random() * 0.5),
          ));
          await options.sleep(delay);
          try {
            const vectors = await provider.embed([memoryEmbeddingText(items[0]!)]);
            validateVectors(vectors, 1, provider);
            await storeBatch(client, provider, items, vectors);
            embedded += 1;
            return;
          } catch (caught) {
            lastError = caught;
          }
        }
        void lastError;
        failed += 1;
        await auditFailure(client, provider, items[0]!);
        if (failed >= options.maxErrors) {
          throw new Error('Embedding backfill exceeded its error budget');
        }
      }
    };

    while (eligible < options.maxRows || options.countOnly) {
      const params: unknown[] = [cursor, provider.id, provider.dim, routedScopeIds];
      params.push(Math.max(100, options.batchSize * 4));
      const limitIndex = params.length;
      const rows = await client.query<{
        id: string; title: string; body: string; kind: ScopeKind; name: string;
      }>(
        `SELECT m.id, m.title, m.body, s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE ($1::uuid IS NULL OR m.id > $1::uuid)
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > now())
            AND m.scope_id = ANY($4::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM memory_embeddings e
               WHERE e.memory_id = m.id AND e.provider = $2 AND e.dim = $3
            )
          ORDER BY m.id
          LIMIT $${limitIndex}`,
        params,
      );
      if (rows.rows.length === 0) {
        completed = true;
        cursor = null;
        if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, null);
        break;
      }

      const batch: Candidate[] = [];
      for (const row of rows.rows) {
        scanned += 1;
        cursor = row.id;
        const candidate: Candidate = {
          id: row.id, title: row.title, body: row.body,
          scope: { kind: row.kind, name: row.name },
        };
        if (!sameProvider(router.resolve(candidate.scope).provider, provider)) continue;
        eligible += 1;
        if (!options.dryRun && !options.countOnly) batch.push(candidate);
        if (batch.length >= options.batchSize) {
          await processItems(batch.splice(0));
          await checkpoint(client, provider, filter, cursor);
        }
        if (!options.countOnly && eligible >= options.maxRows) break;
      }
      if (batch.length > 0) await processItems(batch);
      if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, cursor);
      if (!options.countOnly && eligible >= options.maxRows) break;
    }

    return { scanned, eligible, embedded, failed, completed, cursor };
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName])
        .catch(() => undefined);
    }
    client.release();
  }
}

export async function runEmbeddingBackfill(
  pool: pg.Pool,
  routing: EmbeddingRouting,
  options: EmbeddingBackfillOptions = {},
): Promise<EmbeddingBackfillReport> {
  const batchSize = integer(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = integer(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, 1_000_000);
  const maxRetries = integer(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'maxRetries', 0, 10);
  const retryBaseMs = integer(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'retryBaseMs', 1, 60_000);
  const maxErrors = integer(options.maxErrors ?? DEFAULT_MAX_ERRORS, 'maxErrors', 1, 10_000);
  if (options.dryRun && options.countOnly) throw new Error('dryRun and countOnly are mutually exclusive');
  if (options.cursor && !options.providerId) throw new Error('cursor requires providerId');
  const router = asEmbeddingRouter(routing);
  const providers = router.providers().filter((provider) =>
    options.providerId === undefined || provider.id === options.providerId);
  if (router.providers().length === 0) {
    throw new Error('No embedding providers are configured');
  }
  if (options.providerId !== undefined && providers.length === 0) {
    throw new Error('Requested embedding provider is not configured');
  }
  const report: EmbeddingBackfillReport = {
    scanned: 0, eligible: 0, embedded: 0, failed: 0,
    providers: providers.length, completed: true, cursor: null,
    dryRun: options.dryRun ?? false, countOnly: options.countOnly ?? false,
  };
  let remaining = maxRows;
  for (const provider of providers) {
    if (remaining <= 0 && !options.countOnly) {
      report.completed = false;
      break;
    }
    const result = await runProvider(pool, routing, provider, {
      batchSize,
      maxRows: options.countOnly ? maxRows : remaining,
      dryRun: options.dryRun ?? false,
      countOnly: options.countOnly ?? false,
      maxRetries,
      retryBaseMs,
      maxErrors,
      sleep: options.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      random: options.random ?? Math.random,
      cursor: options.cursor,
      scope: options.scope,
    });
    report.scanned += result.scanned;
    report.eligible += result.eligible;
    report.embedded += result.embedded;
    report.failed += result.failed;
    report.completed &&= result.completed;
    report.cursor = result.cursor;
    remaining -= result.eligible;
  }
  return report;
}
