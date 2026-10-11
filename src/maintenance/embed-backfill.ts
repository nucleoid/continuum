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
const MAX_AMBIGUOUS_DIAGNOSTIC_FAILURES = 8;
const MAX_REPORTED_UNRESOLVED_IDS = 25;
const MAX_HYDRATED_TEXT_BYTES = 4 * 1024 * 1024;

interface CandidateRef {
  id: string;
  textBytes: number;
  scope: ScopeRef;
}

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
  unresolvedCount: number;
  unresolvedTruncated: boolean;
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
  unresolvedCount: number;
  unresolvedTruncated: boolean;
}

type ProviderRunResult = Pick<EmbeddingBackfillReport,
  'scanned' | 'eligible' | 'embedded' | 'failed' | 'failuresCleared'
  | 'completed' | 'cursor' | 'unresolvedIds' | 'unresolvedCount' | 'unresolvedTruncated'>;

class PartialInvalidVectorsError extends Error {
  constructor(readonly items: Candidate[], readonly validCount: number) {
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
  item: Pick<Candidate, 'id'>,
  reason = 'EMBEDDING_ITEM_FAILED',
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO embedding_backfill_failures
         (memory_id, provider, dim, disposition, reason)
       VALUES ($1, $2, $3, 'durable', $4)
       ON CONFLICT (memory_id, provider, dim) DO UPDATE
         SET disposition = 'durable', reason = EXCLUDED.reason, failed_at = now()`,
      [item.id, provider.id, provider.dim, reason],
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
          embedding_error_code: reason === 'EMBEDDING_ITEM_FAILED'
            ? 'EMBEDDING_FAILED'
            : reason,
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
  let originalTimeouts: { statement: string; lock: string } | undefined;
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
  let unresolvedCount = 0;
  let checkpointCap: string | null | undefined;
  let activeBatchUnsafeIds: Set<string> | null = null;
  const safeCursor = (): string | null => checkpointCap !== undefined ? checkpointCap : cursor;
  const addUnresolved = (id: string): void => {
    unresolvedCount += 1;
    activeBatchUnsafeIds?.add(id);
    if (unresolvedIds.size < MAX_REPORTED_UNRESOLVED_IDS) unresolvedIds.add(id);
  };

  try {
    const settings = (await client.query<{ statement: string; lock: string; statement_ms: string; lock_ms: string }>(
      `SELECT pg_catalog.current_setting('statement_timeout') AS statement,
              pg_catalog.current_setting('lock_timeout') AS lock,
              (SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement_ms,
              (SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock_ms`,
    )).rows[0];
    if (!settings) throw new Error('Backfill SQL deadline configuration is unavailable');
    originalTimeouts = settings;
    await client.query(
      `SELECT pg_catalog.set_config('statement_timeout',
         CASE WHEN $1::bigint BETWEEN 1 AND 5000 THEN $1 ELSE '5000' END || 'ms',FALSE),
       pg_catalog.set_config('lock_timeout',
         CASE WHEN $2::bigint BETWEEN 1 AND 1000 THEN $2 ELSE '1000' END || 'ms',FALSE)`,
      [settings.statement_ms, settings.lock_ms],
    );
    if (!options.dryRun && !options.countOnly) {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1::text, 0::bigint)) AS locked',
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
      if (options.markFailed) {
        throw new Error('markFailed memory is not eligible for this provider');
      }
      completed = true;
      cursor = null;
      if (!options.dryRun && !options.countOnly) await checkpoint(client, provider, filter, null);
      return {
        scanned, eligible, embedded, failed, failuresCleared, completed, cursor,
        unresolvedIds: [], unresolvedCount: 0, unresolvedTruncated: false,
      };
    }

    if (options.markFailed) {
      const marked = await client.query<{
        id: string; kind: ScopeKind; name: string;
      }>(
        `SELECT m.id, s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE m.id = $1
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
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
      if (!sameProvider(router.resolve({ kind: row.kind, name: row.name }).provider, provider)) {
        throw new Error('markFailed memory is not routed to this provider');
      }
      await recordFailure(client, provider, { id: row.id });
      failed = 1;
      return {
        scanned: 1, eligible: 1, embedded, failed, failuresCleared,
        completed: false, cursor, unresolvedIds: [],
        unresolvedCount: 0, unresolvedTruncated: false,
      };
    }

    const runStartedAt = !options.dryRun && !options.countOnly
      ? (await client.query<{ started_at: Date }>(
        'SELECT pg_catalog.clock_timestamp() AS started_at',
      )).rows[0]!.started_at
      : null;

    const hydrate = async (refs: CandidateRef[]): Promise<{
      items: Candidate[];
      oversizedIds: Set<string>;
      deferredIds: Set<string>;
    }> => {
      if (refs.length === 0) return { items: [], oversizedIds: new Set(), deferredIds: new Set() };
      const hydrated = await client.query<{
        id: string; title: string | null; body: string | null;
        text_bytes: string; kind: ScopeKind; name: string;
      }>(
        `WITH sizes AS MATERIALIZED (
           SELECT m.id,octet_length(m.title)+octet_length(m.body) AS text_bytes,
                s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE m.id = ANY($1::uuid[])
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM memory_embeddings e
               WHERE e.memory_id = m.id AND e.provider = $2 AND e.dim = $3
            )
            AND NOT EXISTS (
              SELECT 1 FROM embedding_backfill_failures f
               WHERE f.memory_id = m.id AND f.provider = $2 AND f.dim = $3
                 AND f.disposition = 'durable'
            )
         ), admitted AS MATERIALIZED (
           SELECT sizes.*,sum(CASE WHEN text_bytes<=$4 THEN text_bytes ELSE 0 END)
             OVER(ORDER BY id) AS running_bytes FROM sizes
         )
         SELECT admitted.id,admitted.text_bytes,admitted.kind,admitted.name,
           CASE WHEN admitted.text_bytes<=$4 AND running_bytes<=$4 THEN m.title END AS title,
           CASE WHEN admitted.text_bytes<=$4 AND running_bytes<=$4 THEN m.body END AS body
           FROM admitted JOIN memories m ON m.id=admitted.id ORDER BY admitted.id`,
        [refs.map((ref) => ref.id), provider.id, provider.dim, MAX_HYDRATED_TEXT_BYTES],
      );
      const byId = new Map(hydrated.rows.map((row) => [row.id, row]));
      const oversizedIds = new Set(hydrated.rows
        .filter((row) => Number(row.text_bytes) > MAX_HYDRATED_TEXT_BYTES)
        .map((row) => row.id));
      const deferredIds = new Set(hydrated.rows
        .filter((row) => !oversizedIds.has(row.id) && (row.title === null || row.body === null))
        .map((row) => row.id));
      const items = refs.flatMap((ref) => {
        const row = byId.get(ref.id);
        if (!row || row.title === null || row.body === null) return [];
        const candidate: Candidate = {
          id: row.id, title: row.title, body: row.body,
          scope: { kind: row.kind, name: row.name },
        };
        return sameProvider(router.resolve(candidate.scope).provider, provider)
          ? [candidate]
          : [];
      });
      return { items, oversizedIds, deferredIds };
    };

    const mark = async (
      item: Pick<Candidate, 'id'>,
      reason = 'EMBEDDING_ITEM_FAILED',
    ): Promise<boolean> => {
      await recordFailure(client, provider, item, reason);
      failed += 1;
      cursor = item.id;
      return failed < options.maxErrors;
    };

    const recordInvalidSuspects = async (
      items: Candidate[],
      reason: string,
    ): Promise<void> => {
      if (items.length === 0) return;
      const stored = await client.query<{ memory_id: string }>(
        `SELECT memory_id FROM memory_embeddings
          WHERE memory_id = ANY($1::uuid[]) AND provider = $2 AND dim = $3`,
        [items.map((item) => item.id), provider.id, provider.dim],
      );
      const storedIds = new Set(stored.rows.map((row) => row.memory_id));
      for (const item of items) {
        if (storedIds.has(item.id)) continue;
        await recordSuspect(client, provider, item, reason);
        addUnresolved(item.id);
      }
    };

    const processItems = async (items: Candidate[]): Promise<boolean> => {
      if (items.length === 0) return true;
      const attempt = async (part: Candidate[]): Promise<void> => {
        let vectors: number[][];
        let validItems: Candidate[] = [];
        let validVectors: number[][] = [];
        let invalidItems: Candidate[] = [];
        try {
          vectors = await provider.embed(part.map(memoryEmbeddingText));
          if (!Array.isArray(vectors) || vectors.length !== part.length) {
            validateVectors(vectors, part.length, provider);
          }
          for (let index = 0; index < part.length; index += 1) {
            const vector = vectors[index];
            if (validVector(vector, provider)) {
              validItems.push(part[index]!);
              validVectors.push(vector);
            } else {
              invalidItems.push(part[index]!);
            }
          }
          if (invalidItems.length === 0 || validItems.length === 0) {
            validateVectors(vectors, part.length, provider);
          }
        } catch (error) {
          if (error instanceof EmbeddingProviderError || isEmbeddingItemError(error)
            || error instanceof PartialInvalidVectorsError) throw error;
          throw new EmbeddingProviderError(
            'EMBEDDING_FAILED', 'Embedding backfill provider failed',
            { cause: error, diagnostic: true },
          );
        }
        if (invalidItems.length > 0) {
          embedded += await storeBatch(client, provider, validItems, validVectors);
          throw new PartialInvalidVectorsError(invalidItems, validItems.length);
        }
        // Keep database failures distinct from provider failures. A concurrent archive
        // is a safe no-op and must not recreate derived vectors for tombstoned memory.
        embedded += await storeBatch(client, provider, part, vectors);
      };
      try {
        await attempt(items);
        cursor = items.at(-1)!.id;
        return true;
      } catch (initialError) {
        if (initialError instanceof PartialInvalidVectorsError) {
          try {
            const canContinue = await processItems(initialError.items);
            if (canContinue) cursor = items.at(-1)!.id;
            return canContinue;
          } catch (error) {
            if (!(error instanceof EmbeddingProviderError)
              || error.code !== 'EMBEDDING_INVALID_RESPONSE'
              || error.diagnostic === false) throw error;
            await recordInvalidSuspects(initialError.items, error.code);
            return true;
          }
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
          throw initialError;
        }

        const ambiguous: Candidate[] = [];
        let successes = 0;
        let canContinue = true;
        let diagnosticProbes = 0;
        let ambiguousFailures = 0;
        const diagnose = async (part: Candidate[]): Promise<void> => {
          if (!canContinue) return;
          diagnosticProbes += 1;
          if (diagnosticProbes > MAX_DIAGNOSTIC_PROBES) throw initialError;
          try {
            await attempt(part);
            successes += part.length;
            cursor = part.at(-1)!.id;
            return;
          } catch (error) {
            if (error instanceof PartialInvalidVectorsError) {
              successes += error.validCount;
              await diagnose(error.items);
              return;
            }
            if (isEmbeddingItemError(error)) {
              if (part.length === 1) {
                canContinue = await mark(part[0]!);
                return;
              }
              const middle = Math.floor(part.length / 2);
              await diagnose(part.slice(0, middle));
              if (!canContinue) return;
              await diagnose(part.slice(middle));
              return;
            }
            if (error instanceof EmbeddingProviderError
              && ['EMBEDDING_SERVER', 'EMBEDDING_INVALID_RESPONSE', 'EMBEDDING_FAILED']
                .includes(error.code)
              && error.diagnostic !== false) {
              ambiguousFailures += 1;
              if (ambiguousFailures > MAX_AMBIGUOUS_DIAGNOSTIC_FAILURES) throw initialError;
              if (part.length === 1) {
                ambiguous.push(part[0]!);
                activeBatchUnsafeIds?.add(part[0]!.id);
                return;
              }
              const middle = Math.floor(part.length / 2);
              await diagnose(part.slice(0, middle));
              if (!canContinue) return;
              await diagnose(part.slice(middle));
              return;
            }
            throw error;
          }
        };
        const finalizeAmbiguous = async (): Promise<boolean> => {
          if (successes === 0 || ambiguous.length === 0) return false;
          for (const item of ambiguous) {
            await recordSuspect(client, provider, item, initialError.code);
            addUnresolved(item.id);
          }
          return true;
        };
        const middle = Math.floor(items.length / 2);
        await diagnose(items.slice(0, middle));
        if (!canContinue) {
          await finalizeAmbiguous();
          return false;
        }
        await diagnose(items.slice(middle));
        if (!canContinue) {
          await finalizeAmbiguous();
          return false;
        }
        if (successes === 0 && ambiguous.length > 0) throw initialError;
        await finalizeAmbiguous();
        cursor = items.at(-1)!.id;
        return canContinue;
      }
    };

    const processRefs = async (refs: CandidateRef[]): Promise<boolean> => {
      if (refs.length === 0) return true;
      const cursorBeforeBatch = cursor;
      const batchUnsafeIds = new Set<string>();
      activeBatchUnsafeIds = batchUnsafeIds;
      try {
        let remaining = refs;
        while (remaining.length > 0) {
          const { items, oversizedIds, deferredIds } = await hydrate(remaining);
          const byId = new Map(items.map((item) => [item.id, item]));
          let pending: Candidate[] = [];
          let canContinue = true;
          const flush = async (): Promise<void> => {
            if (pending.length === 0 || !canContinue) return;
            canContinue = await processItems(pending);
            pending = [];
          };
          const firstDeferred = remaining.findIndex((ref) => deferredIds.has(ref.id));
          const admittedPrefix = firstDeferred < 0 ? remaining : remaining.slice(0, firstDeferred);
          for (const ref of admittedPrefix) {
            if (oversizedIds.has(ref.id)) {
              await flush();
              if (!canContinue) break;
              canContinue = await mark(ref, 'EMBEDDING_INPUT_TOO_LARGE');
              if (!canContinue) break;
              continue;
            }
            const item = byId.get(ref.id);
            if (item) pending.push(item);
          }
          await flush();
          if (!canContinue) return false;
          if (firstDeferred === 0) throw new Error('Hydration admission made no bounded progress');
          cursor = admittedPrefix.at(-1)!.id;
          remaining = firstDeferred < 0 ? [] : remaining.slice(firstDeferred);
        }
        return true;
      } finally {
        if (batchUnsafeIds.size > 0 && checkpointCap === undefined) {
          const first = refs.findIndex((ref) => batchUnsafeIds.has(ref.id));
          checkpointCap = first <= 0 ? cursorBeforeBatch : refs[first - 1]!.id;
        }
        activeBatchUnsafeIds = null;
      }
    };

    while (eligible < options.maxRows || options.countOnly) {
      const params: unknown[] = [
        cursor,
        provider.id,
        provider.dim,
        routedScopeIds,
        wrapped ? wrapBoundary : null,
        runStartedAt,
      ];
      params.push(Math.max(100, options.batchSize * 4));
      const limitIndex = params.length;
      const rows = await client.query<{
        id: string; text_bytes: string; kind: ScopeKind; name: string;
      }>(
        `SELECT m.id,
                octet_length(m.title) + octet_length(m.body) AS text_bytes,
                s.kind, s.name
           FROM memories m
           JOIN scopes s ON s.id = m.scope_id
          WHERE ($1::uuid IS NULL OR m.id > $1::uuid)
            AND ($5::uuid IS NULL OR m.id <= $5::uuid)
            AND m.state = 'live'
            AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.clock_timestamp())
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
                 AND (f.disposition = 'durable'
                   OR (f.disposition = 'suspect' AND f.failed_at >= $6))
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
        completed = unresolvedCount === 0;
        if (completed) cursor = null;
        if (!options.dryRun && !options.countOnly) {
          await checkpoint(client, provider, filter, safeCursor());
        }
        break;
      }

      const batch: CandidateRef[] = [];
      let batchTextBytes = 0;
      for (const row of rows.rows) {
        scanned += 1;
        const candidate: CandidateRef = {
          id: row.id, textBytes: Number(row.text_bytes),
          scope: { kind: row.kind, name: row.name },
        };
        if (!sameProvider(router.resolve(candidate.scope).provider, provider)) {
          cursor = row.id;
          continue;
        }
        eligible += 1;
        if (!options.dryRun && !options.countOnly) {
          if (candidate.textBytes > MAX_HYDRATED_TEXT_BYTES) {
            const pendingContinues = batch.length === 0 || await processRefs(batch.splice(0));
            batchTextBytes = 0;
            if (!pendingContinues) {
              await checkpoint(client, provider, filter, safeCursor());
              throw new BackfillControlError('Embedding backfill exceeded its error budget');
            }
            const canContinue = await mark(candidate, 'EMBEDDING_INPUT_TOO_LARGE');
            await checkpoint(client, provider, filter, safeCursor());
            if (!canContinue) {
              throw new BackfillControlError('Embedding backfill exceeded its error budget');
            }
            if (!options.countOnly && eligible >= options.maxRows) break;
            continue;
          }
          if (batch.length > 0 && batchTextBytes + candidate.textBytes > MAX_HYDRATED_TEXT_BYTES) {
            const canContinue = await processRefs(batch.splice(0));
            batchTextBytes = 0;
            await checkpoint(client, provider, filter, safeCursor());
            if (!canContinue) {
              throw new BackfillControlError('Embedding backfill exceeded its error budget');
            }
          }
          batch.push(candidate);
          batchTextBytes += candidate.textBytes;
        } else cursor = row.id;
        if (batch.length >= options.batchSize) {
          const canContinue = await processRefs(batch.splice(0));
          batchTextBytes = 0;
          await checkpoint(client, provider, filter, safeCursor());
          if (!canContinue) {
            throw new BackfillControlError('Embedding backfill exceeded its error budget');
          }
        }
        if (!options.countOnly && eligible >= options.maxRows) break;
      }
      const canContinue = batch.length === 0 || await processRefs(batch);
      if (!options.dryRun && !options.countOnly) {
        await checkpoint(client, provider, filter, safeCursor());
      }
      if (!canContinue) {
        throw new BackfillControlError('Embedding backfill exceeded its error budget');
      }
      if (!options.countOnly && eligible >= options.maxRows) break;
    }

    return {
      scanned, eligible, embedded, failed, failuresCleared,
      completed: completed && unresolvedCount === 0,
      cursor: safeCursor(),
      unresolvedIds: [...unresolvedIds],
      unresolvedCount,
      unresolvedTruncated: unresolvedCount > unresolvedIds.size,
    };
  } catch (error) {
    if (error instanceof EmbeddingProviderError || error instanceof BackfillControlError
      || (!(error instanceof Error) || !/already running/i.test(error.message))) {
      const code = error instanceof EmbeddingProviderError || error instanceof BackfillControlError
        ? error.code
        : 'BACKFILL_STORE';
      throw new ProviderRunError(code, {
        scanned, eligible, embedded, failed, failuresCleared,
        completed: false, cursor: safeCursor(), unresolvedIds: [...unresolvedIds],
        unresolvedCount, unresolvedTruncated: unresolvedCount > unresolvedIds.size,
      }, error);
    }
    throw error;
  } finally {
    if (locked && !destroyClient) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0::bigint)) AS unlocked',
          [lockName],
        );
        destroyClient ||= unlock.rows[0]?.unlocked !== true;
      } catch {
        destroyClient = true;
      }
    }
    if (originalTimeouts && !destroyClient) {
      try {
        await client.query("SELECT pg_catalog.set_config('statement_timeout',$1,FALSE), pg_catalog.set_config('lock_timeout',$2,FALSE)",
          [originalTimeouts.statement, originalTimeouts.lock]);
      } catch { destroyClient = true; }
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
    unresolvedCount: 0, unresolvedTruncated: false,
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
          unresolvedCount: 0, unresolvedTruncated: false,
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
    report.unresolvedCount += result.unresolvedCount;
    for (const id of result.unresolvedIds) {
      if (report.unresolvedIds.length < MAX_REPORTED_UNRESOLVED_IDS) report.unresolvedIds.push(id);
      else report.unresolvedTruncated = true;
    }
    report.unresolvedTruncated ||= result.unresolvedTruncated;
    report.cursor = providers.length === 1 ? result.cursor : null;
    report.providerReports.push({
      provider: provider.id, dim: provider.dim, ...result,
      ...(errorCode ? { errorCode } : {}),
    });
  }
  return report;
}
