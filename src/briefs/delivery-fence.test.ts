import { randomUUID } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import { briefFixture,syntheticBrief } from './test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal,refreshBrief } from '../services/briefs.js';
import { processBrief } from '../workers/briefs.js';
import { Budget,BudgetError } from '../pipeline/budget.js';

it('fences source-dependent freshness and coverage when an empty brief expires during its read audit',async () => {
  const profile=syntheticBrief(async (_wire,caps) => {
    caps.signal.throwIfAborted();const value={ claims: [] };return { value,response: value };
  });
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const memory=await createMemory(f.app,{ scopeId: f.projectId,scopeKind: 'project',authorId: actor.id,
      type: 'decision',title: 'Empty synthesis',body: 'SOURCE STILL AFFECTS COVERAGE',source: 'manual' });
    await f.owner.query("UPDATE memories SET expires_at=clock_timestamp()+interval '4 seconds' WHERE id=$1",[memory.id]);
    await refreshBrief(f.app,actor,{ project: f.projectName,mode: 'full',dryRun: false,idempotencyKey: 'empty-coverage' });
    expect(await processBrief(f.worker,randomUUID(),f.profile)).toBe('processed');
    expect(await briefForPrincipal(f.app,actor,f.projectName)).toMatchObject({ blocks: [],fresh: true,coverage: 'complete' });
    const before=(await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n;
    await f.owner.query(`CREATE FUNCTION parent_brief_coverage_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.metadata->>'operation'='brief_read' THEN
          PERFORM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (SELECT expires_at FROM memories
            WHERE id='${memory.id}'::uuid)-clock_timestamp()))+0.05);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER parent_brief_coverage_expiry BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION parent_brief_coverage_expiry()`);
    await expect(briefForPrincipal(f.app,actor,f.projectName)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n).toBe(before);
    await f.owner.query('DROP TRIGGER parent_brief_coverage_expiry ON audit_log;DROP FUNCTION parent_brief_coverage_expiry()');
    expect(await briefForPrincipal(f.app,actor,f.projectName)).toMatchObject({ blocks: [],fresh: false,coverage: 'unknown',cutoff: null });
  },profile);
},120000);

it('reports a final delivery deadline as unavailable and rolls back the real read audit',async () => {
  await briefFixture(async f => {
    const actor=(await getPrincipal(f.app,f.actorId))!;
    const before=(await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n;
    try {
      await expect(briefForPrincipal(f.app,actor,f.projectName,{ validateResult: () => {
        vi.spyOn(Budget.prototype,'assertLive').mockImplementationOnce(() => { throw new BudgetError('deadline'); });
      } })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    } finally { vi.restoreAllMocks(); }
    expect((await f.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='brief_read'")).rows[0].n).toBe(before);
  });
},120000);
