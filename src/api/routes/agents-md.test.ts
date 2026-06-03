import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import request from 'supertest';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createApp } from '../server.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope, getScopeByRef } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';

describe('GET /api/v0/agents-md', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    app = createApp(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seed() {
    const me = await createPrincipal(pool, {
      externalId: 'entra:user:bundle',
      kind: 'user',
      displayName: 'Bundle User',
    });
    const author = await createPrincipal(pool, {
      externalId: 'svc:author',
      kind: 'service',
      displayName: 'Author',
    });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const team = await createScope(pool, { kind: 'team', name: 'payments' });
    const project = await createScope(pool, { kind: 'project', name: 'booking-engine' });
    const secretTeam = await createScope(pool, { kind: 'team', name: 'secret-team' });
    const role = await createScope(pool, { kind: 'role', name: 'security' });

    await addMembership(pool, me.id, team.id, 'reader');
    await addMembership(pool, me.id, project.id, 'reader');
    await addMembership(pool, me.id, role.id, 'reader');
    await addMembership(pool, author.id, org.id, 'writer');
    await addMembership(pool, author.id, team.id, 'writer');
    await addMembership(pool, author.id, project.id, 'writer');
    await addMembership(pool, author.id, secretTeam.id, 'writer');
    await addMembership(pool, author.id, role.id, 'writer');

    await createMemory(pool, {
      scopeId: org.id,
      scopeKind: 'org',
      type: 'decision',
      title: 'We use ADO not Jira',
      body: 'Example Travel Group uses Azure DevOps for all work tracking.',
      authorId: author.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: team.id,
      scopeKind: 'team',
      type: 'playbook',
      title: 'Payments on-call runbook',
      body: 'Step 1: check the dashboard. Step 2: page the lead.',
      authorId: author.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: project.id,
      scopeKind: 'project',
      type: 'fact',
      title: 'Booking-engine deploy host',
      body: 'Deploys go to aks-booking-prod via the booking-cd pipeline.',
      authorId: author.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: secretTeam.id,
      scopeKind: 'team',
      type: 'fact',
      title: 'Secret pricing',
      body: 'Internal pricing rules nobody else should see.',
      authorId: author.id,
      source: 'manual',
    });
    await createMemory(pool, {
      scopeId: role.id,
      scopeKind: 'role',
      type: 'decision',
      title: 'Security review SLA',
      body: 'All API changes get a 48h review window.',
      authorId: author.id,
      source: 'manual',
    });
    // Context memory in the project scope; should be EXCLUDED from AGENTS.md.
    await createMemory(pool, {
      scopeId: project.id,
      scopeKind: 'project',
      type: 'context',
      title: 'Yesterday I was looking at routing',
      body: 'Personal note, low signal.',
      authorId: author.id,
      source: 'manual',
    });
  }

  it('always includes org and the principal role scopes, with no project/team', async () => {
    await seed();
    const res = await request(app)
      .get('/api/v0/agents-md')
      .set('Authorization', 'Bearer entra:user:bundle');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text).toContain('## org');
    expect(res.text).toContain('We use ADO not Jira');
    expect(res.text).toContain('## role:security');
    expect(res.text).toContain('Security review SLA');
    expect(res.text).not.toContain('## team:payments');
    expect(res.text).not.toContain('## project:booking-engine');
  });

  it('includes the requested project and team when accessible', async () => {
    await seed();
    const res = await request(app)
      .get('/api/v0/agents-md?project=booking-engine&team=payments')
      .set('Authorization', 'Bearer entra:user:bundle');
    expect(res.status).toBe(200);
    expect(res.text).toContain('## team:payments');
    expect(res.text).toContain('Payments on-call runbook');
    expect(res.text).toContain('## project:booking-engine');
    expect(res.text).toContain('Booking-engine deploy host');
  });

  it('silently omits requested scopes the caller cannot read', async () => {
    await seed();
    const res = await request(app)
      .get('/api/v0/agents-md?team=secret-team')
      .set('Authorization', 'Bearer entra:user:bundle');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('## team:secret-team');
    expect(res.text).not.toContain('Secret pricing');
  });

  it('omits context memories from the bundle', async () => {
    await seed();
    const res = await request(app)
      .get('/api/v0/agents-md?project=booking-engine')
      .set('Authorization', 'Bearer entra:user:bundle');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Yesterday I was looking at routing');
  });

  it('writes an audit entry tagged as the agents-md view', async () => {
    await seed();
    await request(app)
      .get('/api/v0/agents-md?project=booking-engine')
      .set('Authorization', 'Bearer entra:user:bundle');
    const { rows } = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE action = 'read' AND metadata->>'view' = 'agents-md'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.project).toBe('booking-engine');
  });
});
