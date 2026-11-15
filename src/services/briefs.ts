import type pg from 'pg';
import { z } from 'zod';
import type { Principal } from '../types.js';
import { Budget, BudgetError, starterProfile } from '../pipeline/budget.js';
import { evidenceTransaction } from '../storage/evidence.js';
import { ServiceError } from './errors.js';

export interface BriefOptions { signal?: AbortSignal; validateResult?: (value: Record<string, unknown>, budget: Budget) => void }
const uuid = z.string().uuid();
const project = z.string().min(1).max(500);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError('INVALID_INPUT', 'Invalid brief input');
  return result.data;
}
function safe(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  if (error instanceof BudgetError || (error as { code?: string }).code === '54000') throw new ServiceError('PAYLOAD_TOO_LARGE', 'Brief result exceeds the response limit');
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ServiceError('FORBIDDEN', 'Brief unavailable');
  if (code === '23514' || code === 'P0002') throw new ServiceError('CONFLICT', 'Brief current policy or original allowance unavailable');
  throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'Brief dependency unavailable');
}
async function operation(pool: pg.Pool, principal: Principal, sql: string, values: unknown[], options: BriefOptions = {}, read = true) {
  const budget = new Budget(starterProfile);
  try {
    return await evidenceTransaction(pool, async client => {
      options.signal?.throwIfAborted();
      let result = (await client.query<{ result: Record<string, unknown> }>(sql, values)).rows[0].result;
      if (sql.includes('continuum_brief_refresh')) result = (await client.query<{ result: Record<string, unknown> }>(
        'SELECT continuum_brief_result($1,$2) AS result', [principal.id, result.runId])).rows[0].result;
      // Complete library output and the actual transport projection must pass
      // before the transaction can commit its required delivery/write audit.
      budget.serializeOutput(result);
      options.validateResult?.(result, budget);
      options.signal?.throwIfAborted();
      if (read || result.result !== undefined) await client.query(`INSERT INTO audit_log(principal_id,action,scope_id,metadata)
        VALUES($1,'read',$2,'{"operation":"brief_read"}')`, [principal.id, result.scopeId ?? null]);
      const check = async (value: Record<string, unknown>): Promise<void> => {
        if (typeof value.version === 'string' && Array.isArray(value.blocks)) {
          const valid=(await client.query<{ valid: boolean }>('SELECT continuum_brief_delivery($1,$2,$3) AS valid',
            [principal.id,value.version,value.blocks.map(b=>(b as { id: string }).id)])).rows[0].valid;
          if (!valid) throw new ServiceError('CONFLICT','Brief current source authority unavailable');
        }
        if (Array.isArray(value.items)) for (const item of value.items) await check(item as Record<string,unknown>);
        if (value.result) await check(value.result as Record<string,unknown>);
      };
      await check(result);
      options.signal?.throwIfAborted(); budget.assertLive();
      return result;
    });
  } catch (error) { return safe(error); }
}
export function briefForPrincipal(pool: pg.Pool, principal: Principal, name: string, options?: BriefOptions) {
  return operation(pool, principal, 'SELECT continuum_brief_read($1,$2) AS result', [principal.id, parse(project, name)], options);
}
export function briefHistoryForPrincipal(pool: pg.Pool, principal: Principal, definition: string, input: { cursor?: string; limit?: number } = {}, options?: BriefOptions) {
  const id = parse(uuid, definition), cursor = input.cursor === undefined ? null : parse(uuid, input.cursor);
  const limit = parse(z.number().int().min(1).max(10), input.limit ?? 3);
  return operation(pool, principal, 'SELECT continuum_brief_history($1,$2,$3,$4) AS result', [principal.id, id, cursor, limit], options);
}
export function refreshBrief(pool: pg.Pool, principal: Principal, value: unknown, options?: BriefOptions) {
  const input = parse(z.object({ project, mode: z.enum(['full','delta']), dryRun: z.boolean(), idempotencyKey: z.string().min(1).max(128) }).strict(), value);
  return operation(pool, principal, 'SELECT continuum_brief_refresh($1,$2,$3,$4,$5) AS result',
    [principal.id, input.project, input.mode, input.dryRun, input.idempotencyKey], options, false);
}
export function configureBrief(pool: pg.Pool, principal: Principal, scope: string, profile: string, enabled: boolean, options?: BriefOptions) {
  const input = parse(z.object({ scope: uuid, profile: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), enabled: z.boolean() }).strict(), { scope, profile, enabled });
  return operation(pool, principal, 'SELECT continuum_brief_configure($1,$2,$3,$4) AS result', [principal.id, input.scope, input.profile, input.enabled], options, false);
}
