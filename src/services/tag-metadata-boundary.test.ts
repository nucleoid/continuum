import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { promoteMemory } from '../storage/promote.js';
import { getScopeByRef } from '../storage/scopes.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';
import { captureMemory } from './capture.js';

const protectedKeys = [
  'continuum_legacy_tags', 'continuum_legacy_metadata', 'continuum_tag_migration',
  'continuum_tag_rollback_compat', 'continuum_migration_conflicts',
] as const;
const cases = protectedKeys.flatMap((key) => [
  { key, tags: [] as string[], label: 'empty' },
  { key, tags: ['branch'], label: 'known' },
]);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe('controlled tag provenance boundary', () => {
  let owner: pg.Pool;
  let application: pg.Pool;
  const role = `tag_boundary_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  beforeEach(async () => {
    owner ??= await makeTestPool();
    await resetData(owner);
    if (application) return;
    const schema = (await owner.query('SELECT pg_catalog.current_schema() AS schema')).rows[0].schema as string;
    const password = randomUUID();
    await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
    const source = await readFile(path.join(process.cwd(), 'scripts/grant-application-role.sql'), 'utf8');
    const sql = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
      .replaceAll(':"continuum_schema"', quote(schema)).replaceAll(":'continuum_schema'", `'${schema.replaceAll("'", "''")}'`)
      .replaceAll(':"continuum_app_role"', quote(role)).replaceAll(":'continuum_app_role'", `'${role}'`);
    const grant = await owner.connect();
    let discard = false;
    try { await grant.query(sql); }
    catch (error) { try { await grant.query('ROLLBACK'); } catch { discard = true; } throw error; }
    finally { grant.release(discard); }
    const base = (owner as unknown as { options: PoolConfig }).options;
    const url = new URL(base.connectionString!);
    url.username = role; url.password = password;
    application = new pg.Pool({ connectionString: url.toString(), ssl: base.ssl, max: 1,
      options: `${base.options ?? ''} -c statement_timeout=5000 -c lock_timeout=1000` });
    expect((await application.query('SELECT current_user AS role')).rows[0].role).toBe(role);
  }, 30_000);

  afterAll(async () => {
    await application?.end();
    if (owner) {
      await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)', [role]);
      await owner.query(`DROP OWNED BY ${quote(role)}; DROP ROLE IF EXISTS ${quote(role)}`);
      await owner.end();
    }
  });

  async function fixture() {
    const principal = await createPrincipal(owner, { externalId: `tag-writer:${randomUUID()}`, kind: 'user', displayName: 'Writer' });
    const scope = await createScope(owner, { kind: 'project', name: `tag-boundary:${randomUUID()}` });
    await addMembership(owner, principal.id, scope.id, 'writer');
    return { principal, scope };
  }
  async function effects() {
    return (await owner.query(`SELECT
      (SELECT count(*)::int FROM memories) AS memories,
      (SELECT count(*)::int FROM audit_log) AS audits,
      (SELECT count(*)::int FROM memory_embeddings) AS embeddings`)).rows[0];
  }

  it.each(cases)('service rejects caller $key provenance with $label tags before all side effects', async ({ key, tags }) => {
    const { principal, scope } = await fixture();
    const before = await effects();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0) as number[]));
    await expect(captureMemory(owner, { id: 'test:tag-boundary', dim: 768, local: true, embed }, principal, {
      scope: { kind: scope.kind, name: scope.name }, type: 'fact', title: 'Provenance attempt', body: 'Valid capture body',
      source: 'manual', tags, metadata: { [key]: { version: 99, forged: true } },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(embed).not.toHaveBeenCalled();
    expect(await effects()).toEqual(before);
  });

  it.each(cases)('real application SQL rejects caller $key provenance on INSERT with $label tags', async ({ key, tags }) => {
    const { principal, scope } = await fixture();
    const before = await effects();
    await expect(application.query(
      `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags,metadata)
       VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Provenance attempt','Valid body',$2::uuid,'manual',$3::text[],$4::jsonb)`,
      [scope.id, principal.id, tags, JSON.stringify({ [key]: { version: 99, forged: true } })],
    )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
    expect(await effects()).toEqual(before);
  });

  it.each(protectedKeys)('real application SQL rejects metadata-only introduction of %s', async (key) => {
    const { principal, scope } = await fixture();
    const memory = await createMemory(owner, { scopeId: scope.id, scopeKind: scope.kind,
      authorId: principal.id, type: 'fact', title: 'Existing row', body: 'Ordinary body', source: 'manual', metadata: { ordinary: true } });
    await expect(application.query('UPDATE memories SET metadata=$2::jsonb WHERE id=$1::uuid',
      [memory.id, JSON.stringify({ ordinary: true, [key]: { forged: true } })],
    )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
    expect((await owner.query('SELECT metadata FROM memories WHERE id=$1', [memory.id])).rows[0].metadata).toEqual({ ordinary: true });
  });

  it('retains the existing related-metadata rejection control', async () => {
    const { principal, scope } = await fixture();
    await expect(captureMemory(owner, undefined, principal, { scope: { kind: scope.kind, name: scope.name },
      type: 'fact', title: 'Related attempt', body: 'Valid body', source: 'manual', metadata: { related: [] } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('compatibility quarantines real application legacy writes without accepting caller provenance', async () => {
    const { principal, scope } = await fixture();
    const enable = await readFile(path.join(process.cwd(), 'scripts/enable-tag-legacy-writer-compat.sql'), 'utf8');
    const restore = await readFile(path.join(process.cwd(), 'scripts/restore-tag-strict-enforcement.sql'), 'utf8');
    const installedBoundary = await owner.query(
      `SELECT proname,prosecdef,proconfig,proacl::text FROM pg_catalog.pg_proc
        WHERE pronamespace=pg_catalog.current_schema()::regnamespace
          AND proname IN ('continuum_check_tag_provenance','continuum_finish_tag_promotion','enforce_memory_tag_vocabulary')
        ORDER BY proname`,
    );
    await owner.query(enable);
    try {
      const inserted = await application.query(
        `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags,metadata)
         VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Legacy writer','Ordinary body',$2::uuid,'manual',
           ARRAY['Branch','private-state'], '{"ordinary":true}'::jsonb)
         RETURNING tags,metadata`, [scope.id, principal.id],
      );
      expect(inserted.rows[0]).toMatchObject({ tags: ['branch'], metadata: {
        ordinary: true, continuum_legacy_tags: ['private-state'],
        continuum_tag_rollback_compat: { version: 1, original_tags: ['Branch', 'private-state'] },
      } });
      for (const key of protectedKeys) {
        await expect(application.query(
          `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags,metadata)
           VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Forged','Ordinary body',$2::uuid,'manual','{}'::text[],$3::jsonb)`,
          [scope.id, principal.id, JSON.stringify({ [key]: { forged: true } })],
        )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
      }
      await expect(application.query('UPDATE continuum_tag_write_policy SET legacy_compat=FALSE'))
        .rejects.toMatchObject({ code: '42501' });
    } finally {
      await owner.query(restore);
    }
    expect((await owner.query(
      `SELECT proname,prosecdef,proconfig,proacl::text FROM pg_catalog.pg_proc
        WHERE pronamespace=pg_catalog.current_schema()::regnamespace
          AND proname IN ('continuum_check_tag_provenance','continuum_finish_tag_promotion','enforce_memory_tag_vocabulary')
        ORDER BY proname`,
    )).rows).toEqual(installedBoundary.rows);
  });

  it('strict restoration retains the actual application 32-tag bound', async () => {
    const { principal, scope } = await fixture();
    await owner.query(await readFile(path.join(process.cwd(), 'scripts/restore-tag-strict-enforcement.sql'), 'utf8'));
    const tags = Array.from({ length: 33 }, (_, index) => `limit-${index}`);
    await owner.query(
      `INSERT INTO tag_vocabularies(scope_kind,tag,created_by)
       SELECT 'project',tag,$1::uuid FROM unnest($2::text[]) requested(tag)`, [principal.id, tags],
    );
    await expect(application.query(
      `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags)
       VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Too many','Ordinary body',$2::uuid,'manual',$3::text[])`,
      [scope.id, principal.id, tags],
    )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tags_controlled_vocabulary' });
  });

  it('real application promotion carries owner-imported provenance with reciprocal committed lineage', async () => {
    const { principal, scope } = await fixture();
    const destination = await createScope(owner, { kind: 'team', name: `tag-destination:${randomUUID()}` });
    await addMembership(owner, principal.id, destination.id, 'writer');
    const metadata = { continuum_legacy_tags: ['private-state'],
      continuum_tag_migration: { version: 1, original_tags: ['Branch', 'private-state'] } };
    const source = await createMemory(owner, { scopeId: scope.id, scopeKind: scope.kind,
      authorId: principal.id, type: 'fact', title: 'Historical source', body: 'Ordinary body',
      source: 'manual', tags: ['branch'], metadata });
    const result = await promoteMemory(application, principal.id, source.id,
      { kind: destination.kind, name: destination.name });
    expect(result.source).toMatchObject({ state: 'promoted', promotedToId: result.destination.id });
    expect(result.destination.metadata).toEqual({ ...metadata, promoted_from: source.id });
    await expect(application.query('UPDATE memories SET metadata=$2::jsonb WHERE id=$1::uuid',
      [result.destination.id, JSON.stringify({ ...metadata, promoted_from: randomUUID() })],
    )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
  });

  it('real application cannot copy provenance without committing the source reciprocal pointer', async () => {
    const { principal, scope } = await fixture();
    const destination = await createScope(owner, { kind: 'team', name: `tag-forgery:${randomUUID()}` });
    const metadata = { continuum_legacy_tags: ['private-state'] };
    const source = await createMemory(owner, { scopeId: scope.id, scopeKind: scope.kind,
      authorId: principal.id, type: 'fact', title: 'Historical source', body: 'Ordinary body',
      source: 'manual', tags: ['branch'], metadata });
    const before = await effects();
    await expect(application.query(
      `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags,metadata)
       VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Copied','Ordinary body',$2::uuid,
         'promote:manual',ARRAY['branch'],$3::jsonb)`,
      [destination.id, principal.id, JSON.stringify({ ...metadata, promoted_from: source.id })],
    )).rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
    expect(await effects()).toEqual(before);
    expect((await owner.query('SELECT state,promoted_to_id FROM memories WHERE id=$1::uuid', [source.id])).rows)
      .toEqual([{ state: 'live', promoted_to_id: null }]);
  });

  it('a bound operator canonically erases protected history that the application cannot remove', async () => {
    const actor = await createPrincipal(owner, { externalId: randomUUID(), kind: 'user', displayName: 'Administrator' });
    const target = await createPrincipal(owner, { externalId: randomUUID(), kind: 'user', displayName: 'Private author' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    const owned = await createScope(owner, { kind: 'user', name: `tag-erasure:${randomUUID()}` });
    await addMembership(owner, actor.id, org.id, 'admin');
    await addMembership(owner, target.id, owned.id, 'writer');
    await mapOwnedUserScope(owner, actor, target.id, owned.id);
    const memory = await createMemory(owner, { scopeId: owned.id, scopeKind: 'user',
      authorId: target.id, type: 'fact', title: 'Private history', body: 'Private body', source: 'manual',
      tags: ['session'], metadata: { continuum_legacy_tags: ['private-state'],
        continuum_tag_migration: { version: 1, original_tags: ['session', 'private-state'] } } });
    const shared = await createScope(owner, { kind: 'team', name: `tag-survivor:${randomUUID()}` });
    await addMembership(owner, target.id, shared.id, 'writer');
    const promoted = await promoteMemory(application, target.id, memory.id,
      { kind: shared.kind, name: shared.name });
    await expect(application.query('UPDATE memories SET metadata=\'{}\'::jsonb WHERE id=$1::uuid', [memory.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });

    const operatorRole = `tag_erasure_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const password = randomUUID();
    let operator: pg.Pool | undefined;
    await owner.query(`CREATE ROLE ${quote(operatorRole)} LOGIN PASSWORD '${password}'`);
    try {
      const schema = String((await owner.query('SELECT pg_catalog.current_schema() AS schema')).rows[0].schema);
      for (const filename of ['grant-application-role.sql', 'grant-operator-role.sql']) {
        let sql = (await readFile(path.join(process.cwd(), 'scripts', filename), 'utf8'))
          .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n');
        for (const [name, value] of Object.entries({ continuum_schema: schema, continuum_app_role: operatorRole,
          continuum_operator_role: operatorRole, continuum_principal_id: actor.id })) {
          sql = sql.replaceAll(':"' + name + '"', quote(value))
            .replaceAll(":'" + name + "'", "'" + value.replaceAll("'", "''") + "'");
        }
        const client = await owner.connect();
        let discard = false;
        try { await client.query(sql); }
        catch (error) { try { await client.query('ROLLBACK'); } catch { discard = true; } throw error; }
        finally { client.release(discard); }
      }
      const base = (owner as unknown as { options: PoolConfig }).options;
      const url = new URL(base.connectionString!);
      url.username = operatorRole; url.password = password;
      operator = new pg.Pool({ connectionString: url.toString(), ssl: base.ssl, max: 1,
        options: `${base.options ?? ''} -c statement_timeout=30000 -c lock_timeout=1000` });
      let result = await offboardPrincipal(operator, actor, target.id,
        { confirmationScopeId: owned.id, batchSize: 100 });
      for (let attempt = 0; attempt < 10 && !result.complete; attempt++) {
        result = await offboardPrincipal(operator, actor, target.id,
          { confirmationScopeId: owned.id, batchSize: 100 });
      }
      expect(result.complete).toBe(true);
      expect((await owner.query('SELECT metadata,tags,type,title,body,state FROM memories WHERE id=$1::uuid', [memory.id])).rows)
        .toEqual([{ metadata: {}, tags: [], type: 'context', title: '[erased]', body: '[erased]', state: 'archived' }]);
      const changed = await application.query(
        `UPDATE memories SET metadata=metadata||'{"ordinary_note":"after-erasure"}'::jsonb
          WHERE id=$1::uuid RETURNING metadata`, [promoted.destination.id],
      );
      expect(changed.rows[0].metadata).toEqual({ ...promoted.destination.metadata, ordinary_note: 'after-erasure' });
    } finally {
      await operator?.end();
      await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)', [operatorRole]);
      await owner.query(`DROP OWNED BY ${quote(operatorRole)}; DROP ROLE ${quote(operatorRole)}`);
    }
  }, 60_000);

  it('compatibility rejects tags-only creation of protected receipts with unbound caller promotion linkage', async () => {
    const { principal, scope } = await fixture();
    const marker = randomUUID();
    const inserted = await application.query(
      `INSERT INTO memories(id,scope_id,type,title,body,author_id,source,tags,metadata)
       VALUES(pg_catalog.gen_random_uuid(),$1::uuid,'fact','Ordinary row','Ordinary body',$2::uuid,
         'manual',ARRAY['branch'],$3::jsonb) RETURNING id`,
      [scope.id, principal.id, JSON.stringify({ ordinary: true, promoted_from: marker })],
    );
    const id = inserted.rows[0].id;
    await owner.query(await readFile(path.join(process.cwd(), 'scripts/enable-tag-legacy-writer-compat.sql'), 'utf8'));
    try {
      await expect(application.query('UPDATE memories SET tags=ARRAY[\'private-state\'] WHERE id=$1::uuid', [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'memories_tag_provenance' });
      expect((await owner.query('SELECT tags,metadata FROM memories WHERE id=$1::uuid', [id])).rows)
        .toEqual([{ tags: ['branch'], metadata: { ordinary: true, promoted_from: marker } }]);
    } finally {
      await owner.query(await readFile(path.join(process.cwd(), 'scripts/restore-tag-strict-enforcement.sql'), 'utf8'));
    }
  });
});
