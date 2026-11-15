import type pg from 'pg';
import type { ConnectorReceipt } from '../connectors/evidence.js';
import { evidenceTransaction } from './evidence.js';

export interface RepositoryMapping {
  id: string; scopeId: string; connectorId: string; connectorVersion: string;
  repository: string; generation: number; residency: 'any' | 'local-only'; now: number;
}
/** Stable original identities MUST be persisted by durable callers. Retrying a
 * run cannot insert again, replace identities, extend expiry or dispatch twice. */
export interface ConnectorExecution {
  runId: string; workflowId: string; workerId: string; generation: number;
  permissionAttempt: string; queryAttempt: string; deliveryAttempt: string;
}
export async function repositoryMapping(pool: pg.Pool, actor: string, id: string): Promise<RepositoryMapping | null> {
  return evidenceTransaction(pool, async client =>
    (await client.query<{ value: RepositoryMapping | null }>('SELECT continuum_connector_mapping($1,$2) AS value', [actor, id])).rows[0].value);
}
export async function startConnectorRun(pool: pg.Pool, actor: string, mapping: RepositoryMapping, execution: ConnectorExecution): Promise<boolean> {
  return evidenceTransaction(pool, async client => (await client.query<{ value: boolean }>(
    'SELECT continuum_connector_start($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
    [actor, execution.runId, mapping.id, mapping.generation, execution.workflowId, execution.workerId,
      execution.generation, execution.permissionAttempt, execution.queryAttempt, execution.deliveryAttempt])).rows[0].value);
}
export interface ConnectorPermit { runId: string; generation: number; checkedAt: number; validUntil: number; commit: string | null; indexWatermark: string | null }
export async function permitConnector(client: pg.PoolClient, actor: string, permit: ConnectorPermit): Promise<boolean> {
  return (await client.query<{ value: boolean }>('SELECT continuum_connector_permit($1,$2,$3,$4,$5,$6,$7) AS value',
    [actor, permit.runId, permit.generation, new Date(permit.checkedAt), new Date(permit.validUntil), permit.commit, permit.indexWatermark])).rows[0].value;
}
export async function finishConnectorRun(client: pg.PoolClient, actor: string, runId: string, receipt: ConnectorReceipt, content: string): Promise<{ receiptVersion: string; evidenceVersion: string }> {
  return (await client.query('SELECT continuum_connector_finish($1,$2,$3,$4) AS value', [actor, runId, receipt, content])).rows[0].value;
}
export async function connectorDependencies(pool: pg.Pool, actor: string, version: string): Promise<Array<{ runId: string; mapping: RepositoryMapping | null }> | null> {
  return evidenceTransaction(pool, async client =>
    (await client.query('SELECT continuum_connector_dependencies($1,$2) AS value', [actor, version])).rows[0].value);
}
