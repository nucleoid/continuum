import { expect, it } from 'vitest';
import { standupConsumerFixture as standupProducerFixture } from '../standup/test-helpers.js';

it('installs empty disabled briefs without granting ordinary APP worker authority', async () => {
  await standupProducerFixture(async f => {
    expect((await f.app.query('SELECT continuum_brief_is_ready() AS ready')).rows[0].ready).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_definitions')).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_profiles')).rows[0].n).toBe(0);
    await expect(f.app.query('SELECT continuum_brief_claim($1,$2,$3)', ['synthetic-v1', '00000000-0000-4000-8000-000000000033', {}])).rejects.toMatchObject({ code: '42501' });
    await expect(f.app.query('SELECT continuum_brief_configure($1,$2,$3,TRUE)', [f.actorId, f.scopeId, 'synthetic-v1'])).rejects.toMatchObject({ code: '42501' });
  });
}, 120_000);
