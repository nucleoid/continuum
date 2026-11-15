import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { briefDescriptor } from './provider.js';
import { briefFixture } from './test-helpers.js';
import { configureBrief, refreshBrief } from '../services/briefs.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { processBrief } from '../workers/briefs.js';

it.each(['project', 'profile'])('replays original work after %s disablement while refusing new work and lost authority', async target => {
  await briefFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    await createMemory(f.app, { scopeId: f.projectId, scopeKind: 'project', authorId: actor.id,
      type: 'decision', title: 'Replay source', body: 'Original recorded work.', source: 'manual' });
    const input = { project: f.projectName, mode: 'full', dryRun: false, idempotencyKey: randomUUID() };
    const original = await refreshBrief(f.app, actor, input);
    expect(await processBrief(f.worker, randomUUID(), f.profile)).toBe('processed');
    const accounting = async () => (await f.owner.query(`SELECT j.workflow_id,j.attempt_id,w.used,w.deadline_at
      FROM brief_runs j JOIN pipeline_budget_workflows w ON w.id=j.workflow_id WHERE j.id=$1`, [original.runId])).rows[0];
    const before = await accounting();
    if (target === 'project') await configureBrief(f.app, actor, f.projectId, f.profile.id, false);
    else await f.operator.query('SELECT continuum_operator_install_brief_profile($1,$2,FALSE)',
      [f.adminId, briefDescriptor(f.profile)]);
    const replay = await refreshBrief(f.app, actor, input);
    expect(replay).toMatchObject({ runId: original.runId, status: 'complete' });
    expect(await accounting()).toEqual(before);
    await expect(refreshBrief(f.app, actor, { ...input, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(refreshBrief(f.app, actor, { ...input, dryRun: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_runs')).rows[0].n).toBe(1);
    await f.owner.query('UPDATE scope_memberships SET active=FALSE WHERE principal_id=$1 AND scope_id=$2',
      [actor.id, f.projectId]);
    await expect(refreshBrief(f.app, actor, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
}, 120_000);
