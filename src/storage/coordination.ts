import type pg from 'pg';
import type { Scope, ScopeRef } from '../types.js';
import type { CoordinationOperation } from '../coordination/model.js';
import {
  RECEIPT_CLEANUP_BATCH,
  RECEIPT_QUOTA,
  RESOURCE_QUOTA,
} from '../coordination/model.js';

const UTC = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export class CoordinationStorageError extends Error {
  constructor(readonly kind: 'RESOURCE_QUOTA' | 'RECEIPT_QUOTA' | 'FENCING_EXHAUSTED') {
    super(kind);
    this.name = 'CoordinationStorageError';
  }
}

export class CoordinationCancelledError extends Error {
  constructor() {
    super('coordination request cancelled');
    this.name = 'CoordinationCancelledError';
  }
}

export class CoordinationDependencyError extends Error {
  constructor(cause: unknown) {
    super('coordination dependency unavailable', { cause });
    this.name = 'CoordinationDependencyError';
  }
}

export interface ReceiptRow {
  operation: CoordinationOperation;
  requestId: string;
  payloadHash: string;
  outcome: 'acquired' | 'contended' | 'renewed' | 'released';
  scopeId: string;
  resource: string;
  leaseId: string | null;
  runId: string | null;
  fencingToken: string | null;
  expiresAt: string | null;
  serverTime: string;
  retryAfterSeconds: number | null;
}

export interface LeaseDiscovery {
  leaseId: string;
  scopeId: string;
  resource: string;
}

export interface CurrentLeaseRow {
  leaseId: string;
  principalId: string;
  runId: string;
  fencingToken: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface ReceiptInsert {
  principalId: string;
  operation: CoordinationOperation;
  requestId: string;
  payloadHash: string;
  outcome: ReceiptRow['outcome'];
  scopeId: string;
  resource: string;
  leaseId?: string | null;
  runId?: string | null;
  fencingToken?: string | null;
  expiresAt?: string | null;
  serverTime: string;
  retryAfterSeconds?: number | null;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CoordinationCancelledError();
}

export async function withCoordinationTransaction<T>(
  pool: pg.Pool,
  signal: AbortSignal | undefined,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  checkCancelled(signal);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new CoordinationDependencyError(error);
  }
  let destroy = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    checkCancelled(signal);
    const result = await work(client);
    checkCancelled(signal);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

export async function resolveScope(
  client: pg.PoolClient,
  ref: ScopeRef,
): Promise<Scope | null> {
  const result = await client.query(
    `SELECT id, kind, name, created_at
       FROM scopes WHERE kind = $1 AND name = $2`,
    [ref.kind, ref.name],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id as string,
    kind: row.kind,
    name: row.name as string,
    createdAt: row.created_at as Date,
  } : null;
}

export async function lockCoordinationAuthorization(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  const candidates = await client.query(
    `SELECT m.source_kind
       FROM scope_memberships m
       JOIN principals p ON p.id = m.principal_id
      WHERE m.principal_id = $1 AND m.scope_id = $2
        AND m.active AND m.role IN ('writer', 'admin')
        AND p.disabled_at IS NULL
      ORDER BY m.source_kind, m.source_id
      FOR SHARE OF m, p`,
    [principalId, scopeId],
  );
  if (!candidates.rowCount) return false;
  if (candidates.rows.some((row) => row.source_kind === 'entra')) {
    await client.query(
      'SELECT singleton FROM entra_sync_state WHERE singleton FOR SHARE',
    );
  }
  return coordinationAuthorizationIsCurrent(client, principalId, scopeId);
}

export async function coordinationAuthorizationIsCurrent(
  client: pg.PoolClient,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  const result = await client.query<{ authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM scope_memberships m
         JOIN principals p ON p.id = m.principal_id
        WHERE m.principal_id = $1 AND m.scope_id = $2
          AND m.active AND m.role IN ('writer', 'admin')
          AND p.disabled_at IS NULL
          AND (
            m.source_kind <> 'entra'
            OR EXISTS (
              SELECT 1 FROM entra_sync_state e
               WHERE e.singleton
                 AND clock_timestamp() < e.last_success_at + e.max_staleness
            )
          )
     ) AS authorized`,
    [principalId, scopeId],
  );
  return result.rows[0]?.authorized === true;
}

export async function preparePrincipalReceipts(
  client: pg.PoolClient,
  principalId: string,
): Promise<number> {
  await client.query(
    `INSERT INTO coordination_principal_usage (principal_id)
     VALUES ($1) ON CONFLICT (principal_id) DO NOTHING`,
    [principalId],
  );
  const deleted = await client.query<{ count: number }>(
    `WITH doomed AS (
       SELECT principal_id, operation, request_id
         FROM coordination_operation_receipts
        WHERE principal_id = $1 AND retain_until <= clock_timestamp()
        ORDER BY retain_until, operation, request_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), removed AS (
       DELETE FROM coordination_operation_receipts r
       USING doomed d
       WHERE r.principal_id = d.principal_id
         AND r.operation = d.operation
         AND r.request_id = d.request_id
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM removed`,
    [principalId, RECEIPT_CLEANUP_BATCH],
  );
  const removed = deleted.rows[0]?.count ?? 0;
  await client.query(
    'SELECT receipt_count FROM coordination_principal_usage WHERE principal_id = $1 FOR UPDATE',
    [principalId],
  );
  if (removed > 0) {
    await client.query(
      `UPDATE coordination_principal_usage
          SET receipt_count = receipt_count - $2, updated_at = clock_timestamp()
        WHERE principal_id = $1`,
      [principalId, removed],
    );
  }
  await client.query(
    `DELETE FROM coordination_leases l
      WHERE l.lease_id IN (
        SELECT candidate.lease_id
          FROM coordination_leases candidate
         WHERE candidate.principal_id = $1
           AND (candidate.released_at IS NOT NULL OR candidate.expires_at <= clock_timestamp())
           AND COALESCE(candidate.released_at, candidate.expires_at)
               <= clock_timestamp() - interval '24 hours'
           AND NOT EXISTS (
             SELECT 1 FROM coordination_resources r
              WHERE r.current_lease_id = candidate.lease_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM coordination_operation_receipts receipt
              WHERE receipt.lease_id = candidate.lease_id
           )
         ORDER BY COALESCE(candidate.released_at, candidate.expires_at), candidate.lease_id
         LIMIT $2
      )`,
    [principalId, RECEIPT_CLEANUP_BATCH],
  );
  const usage = await client.query<{ receipt_count: number }>(
    'SELECT receipt_count FROM coordination_principal_usage WHERE principal_id = $1',
    [principalId],
  );
  return usage.rows[0]?.receipt_count ?? 0;
}

function receiptFromRow(row: Record<string, unknown>): ReceiptRow {
  return {
    operation: row.operation as CoordinationOperation,
    requestId: row.request_id as string,
    payloadHash: row.payload_hash as string,
    outcome: row.outcome as ReceiptRow['outcome'],
    scopeId: row.scope_id as string,
    resource: row.resource as string,
    leaseId: row.lease_id as string | null,
    runId: row.run_id as string | null,
    fencingToken: row.fencing_token as string | null,
    expiresAt: row.expires_at as string | null,
    serverTime: row.server_time as string,
    retryAfterSeconds: row.retry_after_seconds as number | null,
  };
}

const RECEIPT_COLUMNS = `
  operation, request_id, encode(payload_hash, 'hex') AS payload_hash, outcome,
  scope_id, resource, lease_id, run_id,
  fencing_token::text AS fencing_token,
  CASE WHEN expires_at IS NULL THEN NULL
       ELSE to_char(expires_at AT TIME ZONE 'UTC', '${UTC}') END AS expires_at,
  to_char(server_time AT TIME ZONE 'UTC', '${UTC}') AS server_time,
  retry_after_seconds`;

export async function getReceipt(
  client: pg.PoolClient,
  principalId: string,
  operation: CoordinationOperation,
  requestId: string,
): Promise<ReceiptRow | null> {
  const result = await client.query(
    `SELECT ${RECEIPT_COLUMNS}
       FROM coordination_operation_receipts
      WHERE principal_id = $1 AND operation = $2 AND request_id = $3
        AND retain_until > clock_timestamp()
      FOR UPDATE`,
    [principalId, operation, requestId],
  );
  return result.rows[0] ? receiptFromRow(result.rows[0]) : null;
}

export async function discoverLease(
  client: pg.PoolClient,
  leaseId: string,
): Promise<LeaseDiscovery | null> {
  const result = await client.query(
    `SELECT lease_id, scope_id, resource
       FROM coordination_leases WHERE lease_id = $1`,
    [leaseId],
  );
  const row = result.rows[0];
  return row ? {
    leaseId: row.lease_id as string,
    scopeId: row.scope_id as string,
    resource: row.resource as string,
  } : null;
}

export async function discoverReceipt(
  client: pg.PoolClient,
  principalId: string,
  operation: CoordinationOperation,
  requestId: string,
): Promise<Pick<ReceiptRow, 'scopeId' | 'resource' | 'leaseId'> | null> {
  const result = await client.query(
    `SELECT scope_id, resource, lease_id
       FROM coordination_operation_receipts
      WHERE principal_id = $1 AND operation = $2 AND request_id = $3
        AND retain_until > clock_timestamp()`,
    [principalId, operation, requestId],
  );
  const row = result.rows[0];
  return row ? {
    scopeId: row.scope_id as string,
    resource: row.resource as string,
    leaseId: row.lease_id as string | null,
  } : null;
}

export async function insertReceipt(
  client: pg.PoolClient,
  input: ReceiptInsert,
): Promise<void> {
  const usage = await client.query<{ receipt_count: number }>(
    'SELECT receipt_count FROM coordination_principal_usage WHERE principal_id = $1 FOR UPDATE',
    [input.principalId],
  );
  if ((usage.rows[0]?.receipt_count ?? 0) >= RECEIPT_QUOTA) {
    throw new CoordinationStorageError('RECEIPT_QUOTA');
  }
  await client.query(
    `INSERT INTO coordination_operation_receipts (
       principal_id, operation, request_id, payload_hash, outcome,
       scope_id, resource, lease_id, run_id, fencing_token,
       expires_at, server_time, retry_after_seconds, retain_until
     ) VALUES (
       $1, $2, $3, decode($4, 'hex'), $5,
       $6, $7, $8, $9, $10::bigint,
       $11::timestamptz, $12::timestamptz, $13,
       $12::timestamptz + interval '24 hours'
     )`,
    [
      input.principalId, input.operation, input.requestId, input.payloadHash,
      input.outcome, input.scopeId, input.resource, input.leaseId ?? null,
      input.runId ?? null, input.fencingToken ?? null, input.expiresAt ?? null,
      input.serverTime, input.retryAfterSeconds ?? null,
    ],
  );
  await client.query(
    `UPDATE coordination_principal_usage
        SET receipt_count = receipt_count + 1, updated_at = clock_timestamp()
      WHERE principal_id = $1`,
    [input.principalId],
  );
}

export async function ensureAndLockResource(
  client: pg.PoolClient,
  scopeId: string,
  resource: string,
): Promise<void> {
  const existing = await client.query(
    `SELECT 1 FROM coordination_resources
      WHERE scope_id = $1 AND resource = $2 FOR UPDATE`,
    [scopeId, resource],
  );
  if (existing.rowCount) return;

  await client.query(
    `INSERT INTO coordination_scope_usage (scope_id)
     VALUES ($1) ON CONFLICT (scope_id) DO NOTHING`,
    [scopeId],
  );
  const usage = await client.query<{ resource_count: number }>(
    'SELECT resource_count FROM coordination_scope_usage WHERE scope_id = $1 FOR UPDATE',
    [scopeId],
  );
  const raced = await client.query(
    `SELECT 1 FROM coordination_resources
      WHERE scope_id = $1 AND resource = $2 FOR UPDATE`,
    [scopeId, resource],
  );
  if (raced.rowCount) return;
  if ((usage.rows[0]?.resource_count ?? 0) >= RESOURCE_QUOTA) {
    throw new CoordinationStorageError('RESOURCE_QUOTA');
  }
  await client.query(
    `INSERT INTO coordination_resources (scope_id, resource)
     VALUES ($1, $2)`,
    [scopeId, resource],
  );
  await client.query(
    `UPDATE coordination_scope_usage
        SET resource_count = resource_count + 1, updated_at = clock_timestamp()
      WHERE scope_id = $1`,
    [scopeId],
  );
  await client.query(
    `SELECT 1 FROM coordination_resources
      WHERE scope_id = $1 AND resource = $2 FOR UPDATE`,
    [scopeId, resource],
  );
}

export async function lockExistingResource(
  client: pg.PoolClient,
  scopeId: string,
  resource: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM coordination_resources
      WHERE scope_id = $1 AND resource = $2 FOR UPDATE`,
    [scopeId, resource],
  );
  return Boolean(result.rowCount);
}

export async function sampleServerTime(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{ server_time: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', '${UTC}') AS server_time`,
  );
  return result.rows[0]!.server_time;
}

export async function getCurrentLease(
  client: pg.PoolClient,
  scopeId: string,
  resource: string,
  serverTime: string,
): Promise<CurrentLeaseRow | null> {
  const result = await client.query(
    `SELECT l.lease_id, l.principal_id, l.run_id, l.fencing_token::text AS fencing_token,
            to_char(l.expires_at AT TIME ZONE 'UTC', '${UTC}') AS expires_at,
            CASE WHEN l.released_at IS NULL THEN NULL
                 ELSE to_char(l.released_at AT TIME ZONE 'UTC', '${UTC}') END AS released_at
       FROM coordination_resources r
       JOIN coordination_leases l ON l.lease_id = r.current_lease_id
      WHERE r.scope_id = $1 AND r.resource = $2
        AND l.released_at IS NULL AND l.expires_at > $3::timestamptz
      FOR UPDATE OF l`,
    [scopeId, resource, serverTime],
  );
  const row = result.rows[0];
  return row ? {
    leaseId: row.lease_id as string,
    principalId: row.principal_id as string,
    runId: row.run_id as string,
    fencingToken: row.fencing_token as string,
    expiresAt: row.expires_at as string,
    releasedAt: row.released_at as string | null,
  } : null;
}

export async function contentionRetryAfter(
  client: pg.PoolClient,
  expiresAt: string,
  serverTime: string,
): Promise<number> {
  const result = await client.query<{ seconds: number }>(
    `SELECT greatest(0, ceil(extract(epoch FROM
       ($1::timestamptz - $2::timestamptz))))::int AS seconds`,
    [expiresAt, serverTime],
  );
  return result.rows[0]?.seconds ?? 0;
}

export async function createLeaseGeneration(
  client: pg.PoolClient,
  input: {
    leaseId: string;
    scopeId: string;
    resource: string;
    principalId: string;
    runId: string;
    ttlSeconds: number;
    serverTime: string;
  },
): Promise<{ fencingToken: string; expiresAt: string }> {
  const next = await client.query<{ fencing_token: string }>(
    `UPDATE coordination_resources
        SET fencing_token = fencing_token + 1, updated_at = clock_timestamp()
      WHERE scope_id = $1 AND resource = $2
        AND fencing_token < 9223372036854775807
      RETURNING fencing_token::text AS fencing_token`,
    [input.scopeId, input.resource],
  );
  const fencingToken = next.rows[0]?.fencing_token;
  if (!fencingToken) throw new CoordinationStorageError('FENCING_EXHAUSTED');
  const inserted = await client.query<{ expires_at: string }>(
    `INSERT INTO coordination_leases (
       lease_id, scope_id, resource, principal_id, run_id, fencing_token,
       acquired_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::bigint,
       $7::timestamptz, $7::timestamptz + make_interval(secs => $8)
     )
     RETURNING to_char(expires_at AT TIME ZONE 'UTC', '${UTC}') AS expires_at`,
    [
      input.leaseId, input.scopeId, input.resource, input.principalId,
      input.runId, fencingToken, input.serverTime, input.ttlSeconds,
    ],
  );
  await client.query(
    `UPDATE coordination_resources
        SET current_lease_id = $3, updated_at = clock_timestamp()
      WHERE scope_id = $1 AND resource = $2`,
    [input.scopeId, input.resource, input.leaseId],
  );
  return { fencingToken, expiresAt: inserted.rows[0]!.expires_at };
}

export async function renewLeaseGeneration(
  client: pg.PoolClient,
  leaseId: string,
  ttlSeconds: number,
  serverTime: string,
): Promise<string> {
  const result = await client.query<{ expires_at: string }>(
    `UPDATE coordination_leases
        SET expires_at = $2::timestamptz + make_interval(secs => $3)
      WHERE lease_id = $1
      RETURNING to_char(expires_at AT TIME ZONE 'UTC', '${UTC}') AS expires_at`,
    [leaseId, serverTime, ttlSeconds],
  );
  return result.rows[0]!.expires_at;
}

export async function releaseLeaseGeneration(
  client: pg.PoolClient,
  scopeId: string,
  resource: string,
  leaseId: string,
  serverTime: string,
): Promise<void> {
  await client.query(
    `UPDATE coordination_leases SET released_at = $2::timestamptz
      WHERE lease_id = $1 AND released_at IS NULL`,
    [leaseId, serverTime],
  );
  await client.query(
    `UPDATE coordination_resources
        SET current_lease_id = NULL, updated_at = clock_timestamp()
      WHERE scope_id = $1 AND resource = $2 AND current_lease_id = $3`,
    [scopeId, resource, leaseId],
  );
}

export async function inspectCurrentLease(
  client: pg.PoolClient,
  scopeId: string,
  resource: string,
  serverTime: string,
): Promise<CurrentLeaseRow | null> {
  const result = await client.query(
    `SELECT l.lease_id, l.principal_id, l.run_id, l.fencing_token::text AS fencing_token,
            to_char(l.expires_at AT TIME ZONE 'UTC', '${UTC}') AS expires_at,
            NULL::text AS released_at
       FROM coordination_resources r
       JOIN coordination_leases l ON l.lease_id = r.current_lease_id
      WHERE r.scope_id = $1 AND r.resource = $2
        AND l.released_at IS NULL AND l.expires_at > $3::timestamptz`,
    [scopeId, resource, serverTime],
  );
  const row = result.rows[0];
  return row ? {
    leaseId: row.lease_id as string,
    principalId: row.principal_id as string,
    runId: row.run_id as string,
    fencingToken: row.fencing_token as string,
    expiresAt: row.expires_at as string,
    releasedAt: null,
  } : null;
}
