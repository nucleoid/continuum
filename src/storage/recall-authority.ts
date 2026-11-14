import type pg from 'pg';
import type { EvidenceEnvelope } from '../evidence/model.js';
import { MEMORY_READ_BUDGET_BYTES_SQL } from './memory-reads.js';

export async function recallAuthorityMetadata(client: pg.PoolClient, actor: string, ids: string[], scopeIds: string[]) {
  return (await client.query<{ id: string; bytes: string }>(
    `SELECT m.id, ${MEMORY_READ_BUDGET_BYTES_SQL} AS bytes FROM memories m JOIN scopes s ON s.id=m.scope_id
     WHERE m.id=ANY($1::uuid[]) AND m.scope_id=ANY($2::uuid[]) AND m.state='live'
     AND (m.expires_at IS NULL OR m.expires_at>pg_catalog.clock_timestamp())
     AND EXISTS(SELECT 1 FROM principals p WHERE p.id=$3 AND p.disabled_at IS NULL)
     AND (s.kind='org' OR EXISTS(SELECT 1 FROM scope_memberships sm WHERE sm.scope_id=m.scope_id AND sm.principal_id=$3
       AND sm.active AND continuum_membership_is_effective(sm.active,sm.source_kind))) ORDER BY m.id FOR UPDATE OF m`,
    [ids, scopeIds, actor])).rows;
}
interface SourceAdmission { id: string; version: string; envelope: EvidenceEnvelope | null }

/** Bounded batch, using the existing audited APP capabilities. A denied source
 * rolls back the batch before bounded individual isolation, never a new grant. */
export async function enrollRecallSources(client: pg.PoolClient, actor: string, ids: string[], known: ReadonlyMap<string, string>): Promise<SourceAdmission[]> {
  if (!ids.length) return [];
  const requested = new Map(ids.filter(id => known.has(id)).map(id => [id, known.get(id)!]));
  const cached = await currentRecallEnvelopes(client, actor, requested);
  // A cached identity is never an allow. Current locked SQL must still authorize
  // the exact immutable version. Mutated, erased or denied versions refresh via
  // the original source capability, which rechecks rather than relabels them.
  const admitted = cached.filter(r => r.envelope !== null).map(r => ({ ...r, version: requested.get(r.id)! }));
  const available = new Set(admitted.map(r => r.id));
  ids = ids.filter(id => !available.has(id));
  if (!ids.length) return admitted;
  const enroll = async (batch: string[]) => (await client.query<SourceAdmission>(
    `WITH versions AS MATERIALIZED (SELECT id, continuum_evidence_source($1,id) AS version
       FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) ordered)
     SELECT id,version,continuum_evidence_envelope($1,version) AS envelope FROM versions ORDER BY id`, [actor, batch])).rows;
  const attempt = async (batch: string[]): Promise<SourceAdmission[] | null> => {
    await client.query('SAVEPOINT reranking_sources');
    try { const result = await enroll(batch); await client.query('RELEASE SAVEPOINT reranking_sources'); return result; }
    catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT reranking_sources'); await client.query('RELEASE SAVEPOINT reranking_sources');
      if (!['23514', '42501'].includes(String((error as { code?: string }).code))) throw error;
      return null;
    }
  };
  const result = await attempt(ids);
  if (result) return [...admitted, ...result];
  const individual: SourceAdmission[] = [];
  for (const id of ids) individual.push(...await attempt([id]) ?? []);
  return [...admitted, ...individual];
}

export async function currentRecallEnvelopes(client: pg.PoolClient, actor: string, versions: ReadonlyMap<string, string>) {
  const ordered = [...versions].sort(([a], [b]) => a.localeCompare(b));
  if (!ordered.length) return [];
  return (await client.query<{ id: string; envelope: EvidenceEnvelope | null }>(
    `SELECT selected.id,continuum_evidence_envelope($1,selected.version) AS envelope
       FROM (SELECT * FROM unnest($2::uuid[],$3::uuid[]) AS inputs(id,version) ORDER BY id) selected
       JOIN memories m ON m.id=selected.id WHERE m.state='live'
       AND (m.expires_at IS NULL OR m.expires_at>pg_catalog.clock_timestamp()) ORDER BY selected.id`,
    [actor, ordered.map(([id]) => id), ordered.map(([, version]) => version)])).rows;
}
