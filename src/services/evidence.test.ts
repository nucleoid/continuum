import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { EvidencePayloadRegistry } from '../evidence/model.js';
import { registerEvidence, readEvidence } from './evidence.js';
import { createMemory } from '../storage/memories.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { getPrincipal } from '../storage/principals.js';
import { offboardPrincipal } from './offboarding.js';
import { prepareAgentsMdForPrincipal } from './agents-md.js';
import { requireEvidenceReady } from '../storage/provider-lifecycle.js';

it('preserves current authority, source-only generator bytes and physical offboarding of every managed copy', async () => {
  await standupProducerFixture(async f => {
    const owners = new EvidencePayloadRegistry();
    for (const kind of ['source-document-version','derived-observation','history','cache','trace','managed-export','queued-payload'] as const) owners.register(kind, () => true);
    const project = await createScope(f.owner, { kind: 'project', name: randomUUID() });
    await addMembership(f.owner, f.actorId, project.id, 'writer');
    await addMembership(f.owner, f.adminId, project.id, 'writer');
    const source = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Owned source', body: 'Secret source body', source: 'manual' });
    const sourceVersion = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actorId, source.id])).rows[0].id;
    const actor = (await getPrincipal(f.owner, f.actorId))!;
    const before = await prepareAgentsMdForPrincipal(f.app, actor, { project: project.name });
    let parent = sourceVersion;
    const versions = [sourceVersion];
    for (const kind of ['derived-observation','history','cache','trace','managed-export','queued-payload'] as const) {
      parent = await registerEvidence(f.app, f.actorId, { nodeId: randomUUID(), expectedCurrent: null, scopeId: project.id, kind,
        parents: [{ versionId: parent, kind: 'derivation' }], identity: { transform: 'fake-v1', model: 'none', prompt: 'none', schema: 'v1' },
        payload: `Private derivative ${kind}` }, owners);
      versions.push(parent);
    }
    expect(await readEvidence(f.app, f.actorId, parent, owners)).toContain('Private derivative');
    const after = await prepareAgentsMdForPrincipal(f.app, actor, { project: project.name });
    expect(after.markdown).toBe(before.markdown); expect(after.etag).toBe(before.etag);
    expect(after.markdown).not.toContain('Private derivative');
    await expect(readEvidence(f.app, f.actorId, parent, new EvidencePayloadRegistry())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.operator.query("SELECT continuum_operator_evidence_policy($1,$2,'local-only','not-required',NULL,NULL)", [f.adminId, source.id]);
    await expect(readEvidence(f.app, f.actorId, parent, owners)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const independent=await createMemory(f.app,{scopeId:project.id,scopeKind:'project',authorId:f.actorId,type:'decision',
      title:'Independent project source',body:'Independent project evidence',source:'manual'});
    const surviving=(await f.app.query('SELECT continuum_evidence_source($1,$2) AS id',[f.actorId,independent.id])).rows[0].id;
    const node=(await f.owner.query('SELECT root_id FROM evidence_versions WHERE id=$1',[parent])).rows[0].root_id;
    const repaired=await registerEvidence(f.app,f.actorId,{nodeId:node,expectedCurrent:parent,scopeId:project.id,kind:'queued-payload',
      parents:[{versionId:surviving,kind:'derivation'}],identity:{transform:'repair-v2',model:'none',prompt:'none',schema:'v1'},
      payload:'Fresh shared wording from independent project evidence'},owners);
    await requireEvidenceReady(f.app);
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    let result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    for (let attempt = 0; !result.complete && attempt < 40; attempt++) result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    expect(result.complete).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads WHERE version_id=ANY($1::uuid[])', [versions])).rows[0].n).toBe(0);
    expect((await f.owner.query("SELECT count(*)::int AS n FROM evidence_state WHERE version_id=ANY($1::uuid[]) AND state<>'erased'", [versions])).rows[0].n).toBe(0);
    expect(await readEvidence(f.app,f.adminId,repaired,owners)).toBe('Fresh shared wording from independent project evidence');
    const receipt = (await f.owner.query("SELECT metadata FROM audit_log WHERE metadata->>'operation'='principal_evidence_privacy_repaired' LIMIT 1")).rows[0].metadata;
    await expect(f.app.query('INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES($1,\'archive\',$2,$3)', [f.adminId,f.scopeId,receipt])).rejects.toMatchObject({ code: '42501' });
    expect((await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId })).alreadyOffboarded).toBe(true);
  });
}, 120_000);

it('erases shared copies of personal derivatives even when every source is shared', async () => {
  await standupProducerFixture(async f => {
    const owners = new EvidencePayloadRegistry();
    for (const kind of ['source-document-version', 'derived-observation', 'cache', 'history', 'managed-export'] as const) owners.register(kind, () => true);
    const project = await createScope(f.owner, { kind: 'project', name: randomUUID() });
    await addMembership(f.owner, f.actorId, project.id, 'writer');
    await addMembership(f.owner, f.adminId, project.id, 'writer');
    const source = await createMemory(f.app, { scopeId: project.id, scopeKind: 'project', authorId: f.actorId,
      type: 'decision', title: 'Shared source', body: 'Shared reference', source: 'manual' });
    const sourceVersion = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actorId, source.id])).rows[0].id;
    const personal = await registerEvidence(f.app, f.actorId, { nodeId: randomUUID(), expectedCurrent: null, scopeId: f.scopeId,
      kind: 'derived-observation', parents: [{ versionId: sourceVersion, kind: 'derivation' }],
      identity: { transform: 'v1', model: 'none', prompt: 'none', schema: 'v1' }, payload: 'Personal conclusion' }, owners);
    const copies = [];
    for (const kind of ['cache', 'history', 'managed-export'] as const) copies.push(await registerEvidence(f.app, f.actorId, {
      nodeId: randomUUID(), expectedCurrent: null, scopeId: project.id, kind, parents: [{ versionId: personal, kind: 'copy' }],
      identity: { transform: 'copy-v1', model: 'none', prompt: 'none', schema: 'v1' }, payload: 'Copy of personal conclusion' }, owners));
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    const held = await f.app.connect();
    try {
      await held.query('BEGIN');
      const late = (await held.query('SELECT continuum_evidence_register($1,$2,NULL,$3,$4,$5,$6,$7) AS id',
        [f.actorId, randomUUID(), project.id, 'cache', JSON.stringify([{versionId:personal,kind:'copy'}]),
          {transform:'late-copy-v1',model:'none',prompt:'none',schema:'v1'}, 'Concurrent personal copy'])).rows[0].id;
      copies.push(late);
      await expect(offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 }))
        .rejects.toMatchObject({code:'55P03'});
      expect((await f.owner.query('SELECT continuum_evidence_scope_is_erased($1) AS clean', [f.scopeId])).rows[0].clean).toBe(false);
      await held.query('COMMIT');
    } finally { await held.query('ROLLBACK'); held.release(); }
    let result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    for (let i = 0; !result.complete && i < 40; i++) result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    expect(result.complete).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads WHERE version_id=ANY($1::uuid[])', [[personal, ...copies]])).rows[0].n).toBe(0);
    expect(await readEvidence(f.app, f.adminId, sourceVersion, owners)).toContain('Shared reference');
  });
}, 120_000);

it('keeps locked residual evidence incomplete and repairs a dirty completed receipt from physical rows', async () => {
  await standupProducerFixture(async f => {
    const source = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Erase me', body: 'Payload', source: 'manual' });
    const version = (await f.app.query('SELECT continuum_evidence_source($1,$2) AS id', [f.actorId, source.id])).rows[0].id;
    const original = (await f.owner.query('SELECT * FROM evidence_payloads WHERE version_id=$1', [version])).rows[0];
    const admin = (await getPrincipal(f.owner, f.adminId))!;
    const holder = await f.owner.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT * FROM evidence_state WHERE version_id=$1 FOR UPDATE', [version]);
      const result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
      expect(result.complete).toBe(false);
      expect((await holder.query('SELECT continuum_evidence_scope_is_erased($1) AS clean', [f.scopeId])).rows[0].clean).toBe(false);
      await holder.query('ROLLBACK');
    } finally { holder.release(); }
    let result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    for (let i = 0; !result.complete && i < 40; i++) result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    expect(result.complete).toBe(true);
    // Owner-injected residual simulates dirty restore/old copy after completion.
    await f.owner.query('INSERT INTO evidence_payloads VALUES($1,$2,$3)', [version,original.payload,original.content_hash]);
    expect((await f.owner.query('SELECT continuum_evidence_scope_is_erased($1) AS clean', [f.scopeId])).rows[0].clean).toBe(false);
    result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    expect(result.alreadyOffboarded).toBe(false);
    for (let i = 0; !result.complete && i < 40; i++) result = await offboardPrincipal(f.operator, admin, f.actorId, { confirmationScopeId: f.scopeId, batchSize: 1 });
    expect(result.complete).toBe(true);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM evidence_payloads WHERE version_id=$1', [version])).rows[0].n).toBe(0);
  });
}, 120_000);
