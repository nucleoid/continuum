import { expect, it } from 'vitest';
import { standupConsumerFixture } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { requireEvidenceReady } from '../storage/provider-lifecycle.js';
import { consumerTemplateEnabled } from './test-helpers.js';

it('isolates consumer data and LOGINs and cleans a failed case without relabelling migration lineage', async () => {
  const failure = new Error('Intentional consumer failure');
  let previous: { database: string; schema: string; role: string; actor: string; lineage: string } | undefined;
  await expect(standupConsumerFixture(async f => {
    const identity = (await f.owner.query(`SELECT current_database() AS database,current_schema() AS schema,
      md5((SELECT jsonb_agg(to_jsonb(e) ORDER BY attempt_id) FROM _continuum_migration_execution e)::text) AS lineage`)).rows[0];
    expect(identity.database).toBe(decodeURIComponent(new URL(f.connectionString).pathname.slice(1)));
    const role = (await f.producer.query('SELECT session_user AS role')).rows[0].role;
    previous = { ...identity, role, actor: f.actorId };
    await requireEvidenceReady(f.app, { expectedSchema: identity.schema });
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Isolated consumer', body: 'Never enter the next fixture.', source: 'manual' });
    throw failure;
  })).rejects.toBe(failure);
  expect(previous).toBeDefined();
  await standupConsumerFixture(async f => {
    const identity = (await f.owner.query(`SELECT current_database() AS database,current_schema() AS schema,
      md5((SELECT jsonb_agg(to_jsonb(e) ORDER BY attempt_id) FROM _continuum_migration_execution e)::text) AS lineage`)).rows[0];
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memories')).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM principals WHERE id=$1', [previous!.actor])).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [previous!.role])).rows[0].n).toBe(0);
    expect(f.actorId).not.toBe(previous!.actor);
    await requireEvidenceReady(f.app, { expectedSchema: identity.schema });
    if (consumerTemplateEnabled()) {
      expect(identity.database).not.toBe(previous!.database);
      expect(identity.schema).toBe(previous!.schema);
      expect(identity.lineage).toBe(previous!.lineage);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [previous!.database])).rows[0].n).toBe(0);
    } else {
      expect(identity.database).toBe(previous!.database);
      expect(identity.schema).not.toBe(previous!.schema);
    }
  });
}, 120000);
