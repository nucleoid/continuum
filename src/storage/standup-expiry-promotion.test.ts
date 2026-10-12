import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { TRUSTED_ACTIVITY_METADATA_KEYS } from '../capture/metadata.js';
import { createMemory } from './memories.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { promoteMemoryWithAudit, verifyMemoryWithAudit } from './promote.js';

it('keeps the earliest trusted expiry through verification and promotion while stripping all nine caller activity keys', async () => {
  await standupProducerFixture(async (value) => {
    const metadata = Object.fromEntries(TRUSTED_ACTIVITY_METADATA_KEYS.map((key) => [key, 'untrusted-caller-value']));
    const source = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user', authorId: value.producerId,
      type: 'fact', title: 'Trusted expiry source', body: 'Source', source: 'github-pr', tags: ['github'], metadata: { ...metadata, note: 'ordinary note' } });
    await value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb)', [source.id,
      { external_actor_id: '42', repository_id: '100', pull_request_number: '14', branch: 'feature/expiry', merged: false }]);
    const shorter = new Date(Date.now() + 60_000);
    await value.producer.query('UPDATE memories SET expires_at=$2::timestamptz WHERE id=$1::uuid', [source.id, shorter]);
    const verified = await verifyMemoryWithAudit(value.app, value.actorId, source.id, true);
    expect(verified.expiresAt!.getTime()).toBe(shorter.getTime());
    const destination = await createScope(value.owner, { kind: 'project', name: 'expiry-project' });
    await addMembership(value.owner, value.actorId, destination.id, 'writer');
    const promoted = await promoteMemoryWithAudit(value.app, value.actorId, source.id, { kind: 'project', name: destination.name });
    expect(promoted.destination.expiresAt!.getTime()).toBeLessThanOrEqual(shorter.getTime());
    expect(promoted.destination.metadata.note).toBe('ordinary note');
    expect(promoted.destination.metadata.promoted_from).toBe(source.id);
    for (const key of TRUSTED_ACTIVITY_METADATA_KEYS) expect(promoted.destination.metadata).not.toHaveProperty(key);
    const attribution = (await value.owner.query(`SELECT actor_principal_id,actor_label,trust_expires_at
      FROM memory_activity_attributions WHERE memory_id=$1::uuid`, [promoted.destination.id])).rows[0];
    expect(attribution.actor_principal_id).toBe(value.actorId);
    expect(attribution.actor_label).toBe('Actual Actor');
    expect(attribution.trust_expires_at.getTime()).toBeLessThanOrEqual(shorter.getTime());
    // Direct UPDATE and verification cannot recover a wider or unlimited expiry.
    await value.app.query('UPDATE memories SET expires_at=NULL WHERE id=$1::uuid', [promoted.destination.id]);
    expect((await value.owner.query('SELECT expires_at FROM memories WHERE id=$1::uuid', [promoted.destination.id])).rows[0].expires_at.getTime())
      .toBeLessThanOrEqual(shorter.getTime());
  });
}, 180_000);


it('rejects fabricated APP promotion content even when it supplies reciprocal links to a real attributed source', async () => {
  await standupProducerFixture(async (value) => {
    const source = await createMemory(value.producer, { scopeId: value.scopeId, scopeKind: 'user', authorId: value.producerId,
      type: 'fact', title: 'Original producer statement', body: 'Original producer body', source: 'github-pr',
      sourceRef: 'https://sources.example/original', tags: ['github'] });
    await expect(value.producer.query('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded', [source.id,
      { external_actor_id: '42', repository_id: '100', pull_request_number: '14', branch: 'feature/canonical', merged: false }]))
      .resolves.toMatchObject({ rows: [{ recorded: true }] });
    const scope = await createScope(value.owner, { kind: 'project', name: 'canonical-promotion' });
    await addMembership(value.owner, value.actorId, scope.id, 'writer');
    async function fabricatedCopy() {
      const client = await value.app.connect();
      try {
        await client.query('BEGIN');
        const destination = (await client.query(`INSERT INTO memories(id,scope_id,type,title,body,author_id,source,source_ref,tags,metadata,expires_at)
          VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Caller forged trusted statement','Caller forged trusted body',
            $2::uuid,'promote:github-pr',$3::text,ARRAY['github'],jsonb_build_object('promoted_from',$4::text),$5::timestamptz) RETURNING id`,
        [scope.id, value.actorId, source.sourceRef, source.id, source.expiresAt])).rows[0].id;
        await client.query("UPDATE memories SET state='promoted',promoted_to_id=$2::uuid WHERE id=$1::uuid", [source.id, destination]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    await expect(fabricatedCopy()).rejects.toMatchObject({ code: '23514' });
    expect((await value.owner.query('SELECT state,promoted_to_id FROM memories WHERE id=$1::uuid', [source.id])).rows)
      .toEqual([{ state: 'live', promoted_to_id: null }]);
    const canonical = await promoteMemoryWithAudit(value.app, value.actorId, source.id, { kind: 'project', name: scope.name });
    expect(canonical.destination.title).toBe(source.title);
    expect(canonical.destination.body).toBe(source.body);
    expect((await value.owner.query('SELECT actor_principal_id FROM memory_activity_attributions WHERE memory_id=$1::uuid', [canonical.destination.id])).rows)
      .toEqual([{ actor_principal_id: value.actorId }]);
  });
}, 180_000);
