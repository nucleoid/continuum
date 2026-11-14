import pg from 'pg';
import type { EvidenceEnvelope, EvidenceRegistration } from '../evidence/model.js';

/** Owned, exclusive READ COMMITTED transaction. Never the #26 autocommit adapter. */
export async function evidenceTransaction<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (pool instanceof pg.Client || typeof (pool as unknown as pg.PoolClient).release === 'function') throw new TypeError('Evidence requires an owned Pool');
  const client = await pool.connect(); let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(`SELECT pg_catalog.set_config('statement_timeout',CASE WHEN setting::bigint BETWEEN 1 AND 5000 THEN setting||'ms' ELSE '5000ms' END,TRUE) FROM pg_catalog.pg_settings WHERE name='statement_timeout'`);
    await client.query(`SELECT pg_catalog.set_config('lock_timeout',CASE WHEN setting::bigint BETWEEN 1 AND 1000 THEN setting||'ms' ELSE '1000ms' END,TRUE) FROM pg_catalog.pg_settings WHERE name='lock_timeout'`);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
export async function registerEvidenceVersion(client: pg.PoolClient, actor: string, input: EvidenceRegistration): Promise<string> {
  return (await client.query<{ id: string }>('SELECT continuum_evidence_register($1,$2,$3,$4,$5,$6,$7,$8) AS id',
    [actor, input.nodeId, input.expectedCurrent, input.scopeId, input.kind, JSON.stringify(input.parents), input.identity, input.payload])).rows[0].id;
}
export async function evidenceEnvelope(client: pg.PoolClient, actor: string, version: string): Promise<EvidenceEnvelope | null> {
  return (await client.query<{ result: EvidenceEnvelope | null }>('SELECT continuum_evidence_envelope($1,$2) AS result', [actor, version])).rows[0].result;
}
export async function evidencePayload(client: pg.PoolClient, actor: string, version: string, locality: 'local' | 'hosted' | null): Promise<string | null> {
  return (await client.query<{ result: string | null }>('SELECT continuum_evidence_payload($1,$2,$3) AS result', [actor, version, locality])).rows[0].result;
}
