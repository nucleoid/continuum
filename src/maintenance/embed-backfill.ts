import type pg from 'pg';
import {
  EmbeddingProviderError,
  isEmbeddingItemError,
  type EmbeddingProvider,
} from '../embeddings/provider.js';
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
const DEFAULT_MAX_ERRORS = 25;
const MAX_BATCH_SIZE = 1_000;
const MAX_DIAGNOSTIC_PROBES = 64;

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
  maxErrors?: number;
  retryFailures?: boolean;
  noWrap?: boolean;
  markFailed?: string;
}

export interface EmbeddingBackfillProviderReport {
  provider: string;
  dim: number;
  scanned: number;
  eligible: number;
  embedded: number;
  failed: number;
  failuresCleared: number;
  completed: boolean;
  cursor: string | null;
  unresolvedIds: string[];
  errorCode?: string;
}

export interface EmbeddingBackfillReport {
  scanned: number;
  eligible: number;
  embedded: number;
  failed: number;
  failuresCleared: number;
  providers: number;
  completed: boolean;
  cursor: string | null;
  dryRun: boolean;
  countOnly: boolean;
  providerReports: EmbeddingBackfillProviderReport[];
  errorCodes: string[];
  unresolvedIds: string[];
}

type ProviderRunResult = Pick<EmbeddingBackfillReport,
  'scanned' | 'eligible' | 'embedded' | 'failed' | 'failuresCleared'
  | 'completed' | 'cursor' | 'unresolvedIds'>;

class PartialInvalidVectorsError extends Error {
  constructor(readonly items: Candidate[]) {
    super('Embedding provider returned some invalid vectors');
    this.name = 'PartialInvalidVectorsError';
  }
}

class ProviderRunError extends Error {
  constructor(
    readonly code: string,
    readonly report: ProviderRunResult,
    cause: unknown,
  ) {
    super('Embedding provider backfill failed', { cause });
    this.name = 'ProviderRunError';
  }
}

class BackfillControlError extends Error {
  readonly code = 'BACKFILL_ERROR_BUDGET';
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

function validVector(vector: unknown, provider: EmbeddingProvider): vector is number[] {
  return Array.isArray(vector) && vector.length === provider.dim
    && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
}

function validateVectors(vectors: number[][], expected: number, provider: EmbeddingProvider): void {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new EmbeddingProviderError(
      'EMBEDDING_INVALID_RESPONSE', 'Embedding provider returned unexpected cardinality',
    );
  }
  for (const vector of vectors) {
    if (!validVector(vector, provider)) {
      throw new EmbeddingProviderError(
        'EMBEDDING_INVALID_RESPONSE', 'Embedding provider returned an invalid vector',
      );
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
): Promise<number> {
  let stored = 0;
  await client.query('BEGIN');
  try {
    for (let index = 0; index < items.length; index += 1) {
      if (await storeMemoryEmbeddingVector(client, items[index]!.id, vectors[index]!, provider)) {
        stored += 1;
        await client.query(
          `DELETE FROM embedding_backfill_failures
            WHERE memory_id = $1 AND provider = $2 AND dim = $3
              AND disposition = 'suspect'`,
          [items[index]!.id, provider.id, provider.dim],
        );
      }
    }
    await client.query('COMMIT');
    return stored;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function recordFailure(
  client: pg.PoolClient,
  provider: EmbeddingProvider,
  item: Candidate,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO embedding_backfill_failures
         (memory_id, provider, dim, disposition, reason)
       VALUES ($1, $2, $3, 'durable', 'EMBEDDING_ITEM_FAILED')
       ON CONFLICT (memory_id, provider, dim) DO UPDATE
         SET disposition = 'durable', reason = 'EMBEDDING_ITEM_FAILED', failed_at = now()`,
      [item.id, provider.id, provider.dim],
    );
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function recordSuspect(
  client: pg.PoolClient,
  provider: EmbeddingProvider,
  item: Candidate,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO embedding_backfill_failures
       (memory_id, provider, dim, disposition, reason)
     VALUES ($1, $2, $3, 'suspect', $4)
     ON CONFLICT (memory_id, provider, dim) DO UPDATE
       SET disposition = CASE
             WHEN embedding_backfill_failures.disposition = 'durable' THEN 'durable'
             ELSE 'suspect'
           END,
           reason = CASE
             WHEN embedding_backfill_failures.disposition = 'durable'
               THEN embedding_backfill_failures.reason
             ELSE EXCLUDED.reason
           END,
           failed_at = now()`,
    [item.id, provider.id, provider.dim, reason],
  );
}

async function runProvider(
  pool: pg.Pool,
  routing: EmbeddingRouting,
  provider: EmbeddingProvider,
  options: Required<Pick<EmbeddingBackfillOptions,
    'batchSize' | 'maxRows' | 'dryRun' | 'countOnly' | 'maxErrors'>>
    & Pick<EmbeddingBackfillOptions,
      'cursor' | 'scope' | 'retryFailures' | 'noWrap' | 'markFailed'>,
): Promise<ProviderRunResult> {
  const router = asEmbeddingRouter(routing);
  const client = await pool.connect();
  const filter = scopeKey(options.scope);
  // Scope-filtered and unfiltered runs overlap, so they must share one provider lock.
  const lockName = `continuum:embed-backfill:${provider.id}:${provider.dim}`;
  let locked = false;
  let destroyClient = false;
  let cursor: string | null = options.cursor ?? null;
  let wrapCursor = cursor !== null && !options.noWrap;
  let wrapBoundary = cursor;
  let wrapped = false;
  let scanned = 0;
  let eligible = 0;
  let embedded = 0;
  let failed = 0;
  let failuresCleared = 0;
  let completed = false;
  const unresolvedIds = new Set<string>();

  try {
    if (!options.dryRun && !options.countOnly) {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockName],
      );
      if (lock.rows[0]?.locked !== true) throw new Error('Embedding backfill is already running for this provider');
      locked = true;
      if (options.retryFailures) {
        const cleared = await client.query(
          `DELETE FROM embedding_backfill_failures f
            USING memories m, scopes s
           WHERE f.memory_id = m.id
             AND s.id = m.scope_id
             AND f.provider = $1
             AND f.dim = $2
             AND ($3 = '' OR concat(s.kind, CASE WHEN s.kind = 'org' THEN '' ELSE ':' || s.name END) = $3)`,
          [provider.id, provider.dim, filter],
        );
        failuresCleared = cleared.rowCount ?? 0;
      }
      if (!options.cursor) {
        const saved = await client.query<{ cursor: string | null }>(
          `SELECT cursor FROM embedding_backfill_checkpoints
            WHERE provider = $1 AND dim = $2 AND scope_filter = $3`,
          [provider.id, provider.dim, filter],
        );
        cursor = saved.rows[0]?.cursor ?? null;
        wrapCursor = cursor !== null && !options.noWrap;
        wrapBoundary = cursor;
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
      return {
        scanned, eligible, embedded, failed, failuresCleared, completed, cursor,
        unresolvedIds: [],
      };
    }

    if (options.markFailed) {
      const marked = await client.query<{
        id: string; title: string; body: string; kind: ScopeKind; name: string;
      }>(
        `SELECT m.id, m.title, m.body, s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE m.id = $1
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
            AND m.scope_id = ANY($2::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM memory_embeddings e
               WHERE e.memory_id = m.id AND e.provider = $3 AND e.dim = $4
            )
            AND NOT EXISTS (
              SELECT 1 FROM embedding_backfill_failures f
               WHERE f.memory_id = m.id AND f.provider = $3 AND f.dim = $4
                 AND f.disposition = 'durable'
            )`,
        [options.markFailed, routedScopeIds, provider.id, provider.dim],
      );
      const row = marked.rows[0];
      if (!row) throw new Error('markFailed memory is not eligible for this provider');
      const item: Candidate = {
        id: row.id, title: row.title, body: row.body,
        scope: { kind: row.kind, name: row.name },
      };
      if (!sameProvider(router.resolve(item.scope).provider, provider)) {
        throw new Error('markFailed memory is not routed to this provider');
      }
      await recordFailure(client, provider, item);
      failed = 1;
      cursor = item.id;
      await checkpoint(client, provider, filter, cursor);
      return {
        scanned: 1, eligible: 1, embedded, failed, failuresCleared,
        completed: true, cursor, unresolvedIds: [],
      };
    }

    const processItems = async (items: Candidate[]): Promise<boolean> => {
      if (items.length === 0) return true;
      const attempt = async (part: Candidate[]): Promise<void> => {
        let vectors: number[][];
        try {
          vectors = await provider.embed(part.map(memoryEmbeddingText));
          if (!Array.isArray(vectors) || vectors.length !== part.length) {
            validateVectors(vectors, part.length, provider);
          }
          const validItems: Candidate[] = [];
          const validVectors: number[][] = [];
          const invalidItems: Candidate[] = [];
          for (let index = 0; index < part.length; index += 1) {
            const vector = vectors[index];
            if (validVector(vector, provider)) {
              validItems.push(part[index]!);
              validVectors.push(vector);
            } else {
              invalidItems.push(part[index]!);
            }
          }
          if (invalidItems.length > 0 && validItems.length > 0) {
            embedded += await storeBatch(client, provider, validItems, validVectors);
            throw new PartialInvalidVectorsError(invalidItems);
          }
          validateVectors(vectors, part.length, provider);
        } catch (error) {
          if (error instanceof EmbeddingProviderError || isEmbeddingItemError(error)
            || error instanceof PartialInvalidVectorsError) throw error;
          throw new EmbeddingProviderError(
            'EMBEDDING_FAILED', 'Embedding backfill provider failed',
            { cause: error, diagnostic: true },
          );
        }
        // Keep database failures distinct from provider failures. A concurrent archive
        // is a safe no-op and must not recreate derived vectors for tombstoned memory.
        embedded += await storeBatch(client, provider, part, vectors);
      };
      const mark = async (item: Candidate): Promise<boolean> => {
        failed += 1;
        await recordFailure(client, provider, item);
        return failed < options.maxErrors;
      };
      try {
        await attempt(items);
        cursor = items.at(-1)!.id;
        return true;
      } catch (initialError) {
        if (initialError instanceof PartialInvalidVectorsError) {
          const canContinue = await processItems(initialError.items);
          cursor = items.at(-1)!.id;
          return canContinue;
        }
        if (isEmbeddingItemError(initialError)) {
          if (items.length > 1) {
            const middle = Math.floor(items.length / 2);
            if (!await processItems(items.slice(0, middle))) return false;
            return processItems(items.slice(middle));
          }
          const canContinue = await mark(items[0]!);
          cursor = items[0]!.id;
          return canContinue;
        }
        if (!(initialError instanceof EmbeddingProviderError)
          || !['EMBEDDING_SERVER', 'EMBEDDING_INVALID_RESPONSE', 'EMBEDDING_FAILED']
            .includes(initialError.code)
          || initialError.diagnostic === false) throw initialError;
        if (items.length === 1) {
          await recordSuspect(client, provider, items[0]!, initialError.code);
          unresolvedIds.add(items[0]!.id);
          cursor = items[0]!.id;
          return true;
        }

        const ambiguous: Candidate[] = [];
        let successes = 0;
        let canContinue = true;
        let diagnosticProbes = 0;
        const diagnose = async (part: Candidate[]): Promise<void> => {
          diagnosticProbes += 1;
          if (diagnosticProbes > MAX_DIAGNOSTIC_PROBES) throw initialError;
          try {
            await attempt(part);
            successes += part.length;
            return;
          } catch (error) {
            if (isEmbeddingItemError(error)) {
              if (part.length === 1) {
                canContinue &&= await mark(part[0]!);
                return;
              }
              const middle = Math.floor(part.length / 2);
              await diagnose(part.slice(0, middle));
              await diagnose(part.slice(middle));
              return;
            }
            if (error instanceof EmbeddingProviderError
              && ['EMBEDDING_SERVER', 'EMBEDDING_INVALID_RESPONSE', 'EMBEDDING_FAILED']
                .includes(error.code)
              && error.diagnostic !== false) {
              if (part.length === 1) {
                ambiguous.push(part[0]!);
                return;
              }
              const middle = Math.floor(part.length / 2);
              await diagnose(part.slice(0, middle));
              await diagnose(part.slice(middle));
              return;
            }
            throw error;
          }
        };
        const middle = Math.floor(items.length / 2);
        await diagnose(items.slice(0, middle));
        await diagnose(items.slice(middle));
        if (successes === 0 && ambiguous.length > 0) throw initialError;
        for (const item of ambiguous) {
          await recordSuspect(client, provider, item, initialError.code);
          unresolvedIds.add(item.id);
        }
        cursor = items.at(-1)!.id;
        return canContinue;
      }
    };

    while (eligible < options.maxRows || options.countOnly) {
      const params: unknown[] = [
        cursor,
        provider.id,
        provider.dim,
        routedScopeIds,
        wrapped ? wrapBoundary : null,
      ];
      params.push(Math.max(100, options.batchSize * 4));
      const limitIndex = params.length;
      const rows = await client.query<{
        id: string; title: string; body: string; kind: ScopeKind; name: string;
      }>(
        `SELECT m.id, m.title, m.body, s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE ($1::uuid IS NULL OR m.id > $1::uuid)
            AND ($5::uuid IS NULL OR m.id <= $5::uuid)
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
            AND m.scope_id = ANY($4::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM memory_embeddings e
               WHERE e.memory_id = m.id AND e.provider = $2 AND e.dim = $3
            )
            AND NOT EXISTS (
              SELECT 1 FROM embedding_backfill_failures f
               WHERE f.memory_id = m.id
                 AND f.provider = $2
                 AND f.dim = $3
                 AND f.disposition = 'durable'
            )
          ORDER BY m.id
          LIMIT $${limitIndex}`,
        params,
      );
      if (rows.rows.length === 0) {
        if (wrapCursor && !wrapped) {
          cursor = null;
          wrapped = true;
          continue;
        }
        completed = true;
        cursor = null;
        if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, null);
        break;
      }

      const batch: Candidate[] = [];
      for (const row of rows.rows) {
        scanned += 1;
        const candidate: Candidate = {
          id: row.id, title: row.title, body: row.body,
          scope: { kind: row.kind, name: row.name },
        };
        if (!sameProvider(router.resolve(candidate.scope).provider, provider)) {
          cursor = row.id;
          continue;
        }
        eligible += 1;
        if (!options.dryRun && !options.countOnly) batch.push(candidate);
        else cursor = row.id;
        if (batch.length >= options.batchSize) {
          const canContinue = await processItems(batch.splice(0));
          await checkpoint(client, provider, filter, cursor);
          if (!canContinue) {
            throw new BackfillControlError('Embedding backfill exceeded its error budget');
          }
        }
        if (!options.countOnly && eligible >= options.maxRows) break;
      }
      const canContinue = batch.length === 0 || await processItems(batch);
      if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, cursor);
      if (!canContinue) {
        throw new BackfillControlError('Embedding backfill exceeded its error budget');
      }
      if (!options.countOnly && eligible >= options.maxRows) break;
    }

    return {
      scanned, eligible, embedded, failed, failuresCleared,
      completed: completed && unresolvedIds.size === 0,
      cursor,
      unresolvedIds: [...unresolvedIds],
    };
  } catch (error) {
    if (error instanceof EmbeddingProviderError || error instanceof BackfillControlError) {
      throw new ProviderRunError(error.code, {
        scanned, eligible, embedded, failed, failuresCleared,
        completed: false, cursor, unresolvedIds: [...unresolvedIds],
      }, error);
    }
    throw error;
  } finally {
    if (locked) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [lockName],
        );
        destroyClient = unlock.rows[0]?.unlocked !== true;
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

export async function runEmbeddingBackfill(
  pool: pg.Pool,
  routing: EmbeddingRouting,
  options: EmbeddingBackfillOptions = {},
): Promise<EmbeddingBackfillReport> {
  const batchSize = integer(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = integer(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, 1_000_000);
  const maxErrors = integer(options.maxErrors ?? DEFAULT_MAX_ERRORS, 'maxErrors', 1, 10_000);
  if (options.dryRun && options.countOnly) throw new Error('dryRun and countOnly are mutually exclusive');
  if (options.cursor && !options.providerId) throw new Error('cursor requires providerId');
  if (options.noWrap && !options.cursor) throw new Error('noWrap requires cursor');
  if (options.markFailed && !options.providerId) throw new Error('markFailed requires providerId');
  if (options.markFailed && (options.cursor || options.retryFailures
    || options.dryRun || options.countOnly)) {
    throw new Error('markFailed cannot be combined with cursor, retryFailures, dryRun, or countOnly');
  }
  if (options.retryFailures && !options.providerId) throw new Error('retryFailures requires providerId');
  if (options.retryFailures && (options.dryRun || options.countOnly)) {
    throw new Error('retryFailures cannot be used with dryRun or countOnly');
  }
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
    scanned: 0, eligible: 0, embedded: 0, failed: 0, failuresCleared: 0,
    providers: providers.length, completed: true, cursor: null,
    dryRun: options.dryRun ?? false, countOnly: options.countOnly ?? false,
    providerReports: [], errorCodes: [], unresolvedIds: [],
  };
  for (const provider of providers) {
    let result;
    let errorCode: string | undefined;
    try {
      result = await runProvider(pool, routing, provider, {
        batchSize: Math.min(batchSize, provider.batchSize ?? batchSize),
        maxRows,
        dryRun: options.dryRun ?? false,
        countOnly: options.countOnly ?? false,
        maxErrors,
        cursor: options.cursor,
        scope: options.scope,
        retryFailures: options.retryFailures,
        noWrap: options.noWrap,
        markFailed: options.markFailed,
      });
    } catch (error) {
      if (error instanceof ProviderRunError) {
        errorCode = error.code;
        result = error.report;
      } else {
        if (providers.length === 1) throw error;
        errorCode = error instanceof Error && /already running/i.test(error.message)
          ? 'BACKFILL_LOCK'
          : 'BACKFILL_DATABASE';
        result = {
          scanned: 0, eligible: 0, embedded: 0, failed: 0, failuresCleared: 0,
          completed: false, cursor: null, unresolvedIds: [],
        };
      }
      report.errorCodes.push(errorCode);
    }
    report.scanned += result.scanned;
    report.eligible += result.eligible;
    report.embedded += result.embedded;
    report.failed += result.failed;
    report.failuresCleared += result.failuresCleared;
    report.completed &&= result.completed;
    report.unresolvedIds.push(...result.unresolvedIds);
    report.cursor = providers.length === 1 ? result.cursor : null;
    report.providerReports.push({
      provider: provider.id, dim: provider.dim, ...result,
      ...(errorCode ? { errorCode } : {}),
    });
  }
  return report;
}
