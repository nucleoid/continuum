import type pg from 'pg';
import type { Principal } from '../types.js';
import { extractionOperation } from '../storage/extraction.js';
import type { Queryable } from '../storage/queryable.js';
import { ServiceError } from './errors.js';
import type { ExtractionStatus } from '../extraction/model.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(value: string) { if (!uuid.test(value)) throw new ServiceError('INVALID_INPUT', 'Invalid extraction identity'); }
function safe(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ServiceError('FORBIDDEN', 'Extraction unavailable');
  if (code === '23514' || code === 'P0002') throw new ServiceError('CONFLICT', 'Extraction original policy or allowance unavailable');
  throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Extraction dependency unavailable');
}
/** Used inside capture's caller-owned transaction. Required audit commits with
 * capture and enqueue, including webhook attribution and replay reservation. */
export async function captureExtractionStatus(client: Queryable, actor: string, memory: string): Promise<ExtractionStatus> {
  const value = (await client.query<{ result: ExtractionStatus }>('SELECT continuum_extraction_capture_status($1,$2) AS result', [actor, memory])).rows[0].result;
  return { status: value.status, ...(value.runId ? { runId: value.runId } : {}) };
}
export async function extractionForPrincipal(pool: pg.Pool, principal: Principal, memory: string, includeAssertions = false): Promise<ExtractionStatus & Record<string, unknown>> {
  identity(memory);
  try { return await extractionOperation(pool, 'SELECT continuum_extraction_status($1,$2,$3) AS result', [principal.id, memory, includeAssertions]); }
  catch (error) { return safe(error); }
}
export async function configureExtraction(pool: pg.Pool, principal: Principal, scope: string, profile: string, sources: string[], enabled: boolean) {
  identity(scope);
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(profile) || !Array.isArray(sources) || sources.length < 1 || sources.length > 6
    || sources.some(s => !['manual','github-pr','github-branch','ado-workitem','deploy-event','terminal-summary'].includes(s))
    || new Set(sources).size !== sources.length || typeof enabled !== 'boolean') throw new ServiceError('INVALID_INPUT', 'Invalid extraction configuration');
  try { return await extractionOperation(pool, 'SELECT continuum_extraction_configure($1,$2,$3,$4,$5) AS result', [principal.id, scope, profile, sources, enabled]); }
  catch (error) { return safe(error); }
}
export async function retryExtraction(pool: pg.Pool, principal: Principal, memory: string) {
  identity(memory);
  try { return await extractionOperation(pool, 'SELECT continuum_extraction_retry($1,$2) AS result', [principal.id, memory]); }
  catch (error) { return safe(error); }
}
