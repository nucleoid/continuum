import type pg from 'pg';
import type { Principal } from '../types.js';
import { asServiceError, dependencyUnavailable, ServiceError } from '../services/errors.js';
import type { CaptureResult } from '../services/capture.js';
import type { Queryable } from './queryable.js';

export interface DeliveryResult {
  replayed: boolean;
  memoryIds: string[];
  captures: CaptureResult[];
}

export async function resolvePrincipalAlias(
  db: Queryable,
  provider: string,
  externalActor: string,
): Promise<Principal | null> {
  const { rows } = await db.query(
    `SELECT p.id, p.external_id, p.kind, p.display_name, p.created_at
       FROM principal_aliases a
       JOIN principals p ON p.id = a.principal_id
      WHERE a.provider = $1 AND a.external_actor = $2
        AND p.disabled_at IS NULL`,
    [provider, externalActor],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at,
  } as Principal;
}

export async function processIngestDelivery(
  pool: pg.Pool,
  pluginId: string,
  deliveryId: string,
  payloadSha256: string,
  capture: (client: pg.PoolClient) => Promise<CaptureResult[]>,
): Promise<DeliveryResult> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw dependencyUnavailable(error);
  }
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ingest_deliveries (plugin_id, delivery_id, payload_sha256, state)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT DO NOTHING
       RETURNING plugin_id`,
      [pluginId, deliveryId, payloadSha256],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await client.query(
        `SELECT state, memory_ids, payload_sha256 FROM ingest_deliveries
          WHERE plugin_id = $1 AND delivery_id = $2
          FOR UPDATE`,
        [pluginId, deliveryId],
      );
      const row = rows[0];
      if (!row || row.state !== 'completed') throw new Error('Incomplete ingest delivery');
      if (row.payload_sha256 !== payloadSha256) {
        throw new ServiceError(
          'CONFLICT',
          'Idempotency key was reused with a different payload',
        );
      }
      await client.query('COMMIT');
      return { replayed: true, memoryIds: row.memory_ids, captures: [] };
    }

    const captures = await capture(client);
    const memoryIds = captures.map((result) => result.memory.id);
    await client.query(
      `UPDATE ingest_deliveries
          SET state = 'completed', memory_ids = $3, completed_at = now()
        WHERE plugin_id = $1 AND delivery_id = $2`,
      [pluginId, deliveryId, memoryIds],
    );
    await client.query('COMMIT');
    return { replayed: false, memoryIds, captures };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    throw asServiceError(error);
  } finally {
    client.release(destroyClient);
  }
}
