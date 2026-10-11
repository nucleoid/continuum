import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';

const count = 100_000;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const triggerModes: Record<string, string> = {
  O: 'ENABLE', D: 'DISABLE', R: 'ENABLE REPLICA', A: 'ENABLE ALWAYS',
};

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

describe('production legacy cleanup at current-lease scale', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); await resetData(pool); }, 120_000);
  afterAll(async () => pool?.end());

  it('completes actual cleanup for 100k current leases under its production budgets without altering generations', async () => {
    const nonce = randomUUID();
    const principal = await createPrincipal(pool, {
      externalId: `legacy-cleanup-scale:${nonce}`, kind: 'service', displayName: 'Legacy scale owner',
    });
    const scope = await createScope(pool, { kind: 'project', name: `legacy-cleanup-scale-${nonce}` });
    const client = await pool.connect();
    let discard = false;
    try {
      // Trusted historical import: preserve an existing over-cap snapshot.
      // All CHECK/FK constraints remain enabled; trigger changes and counters
      // commit atomically, including the exact prior trigger modes.
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '120s'; SET LOCAL lock_timeout = '1s'");
      const triggers = await client.query<{ relation: string; tgname: string; tgenabled: string }>(
        `SELECT relation.relname AS relation, trigger.tgname, trigger.tgenabled
           FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
          WHERE trigger.tgrelid IN ('coordination_resources'::regclass, 'coordination_leases'::regclass)
            AND NOT trigger.tgisinternal ORDER BY relation.relname, trigger.tgname`,
      );
      await client.query('ALTER TABLE coordination_resources DISABLE TRIGGER USER');
      await client.query('ALTER TABLE coordination_leases DISABLE TRIGGER USER');
      await client.query(
        `INSERT INTO coordination_resources(scope_id, resource, fencing_token, current_lease_id, created_at)
         SELECT $1, 'legacy-current-' || n, 1, md5($2 || ':lease:' || n)::uuid,
                clock_timestamp() - interval '3 days'
           FROM generate_series(1, $3::integer) n`, [scope.id, nonce, count],
      );
      await client.query(
        `WITH snapshot AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO coordination_leases(lease_id, scope_id, resource, principal_id, run_id,
                                        fencing_token, acquired_at, expires_at, cleanup_eligible_at)
         SELECT md5($3 || ':lease:' || n)::uuid, $1, 'legacy-current-' || n, $2,
                md5($3 || ':run:' || n)::uuid, 1,
                snapshot.at, snapshot.at + interval '15 minutes', NULL
           FROM generate_series(1, $4::integer) n CROSS JOIN snapshot`, [scope.id, principal.id, nonce, count],
      );
      await client.query(
        `INSERT INTO coordination_scope_usage(scope_id, resource_count) VALUES($1, $2)
         ON CONFLICT(scope_id) DO UPDATE SET resource_count = EXCLUDED.resource_count`, [scope.id, count],
      );
      await client.query(
        'INSERT INTO coordination_principal_usage(principal_id) VALUES($1) ON CONFLICT DO NOTHING',
        [principal.id],
      );
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const trigger of triggers.rows) {
        const mode = triggerModes[trigger.tgenabled];
        if (!mode) throw new Error('unexpected fixture trigger mode');
        await client.query(`ALTER TABLE ${quote(trigger.relation)} ${mode} TRIGGER ${quote(trigger.tgname)}`);
      }
      await client.query('COMMIT');
      await client.query('ANALYZE coordination_leases; ANALYZE coordination_resources');

      const indexes = await client.query<{ index_name: string; valid: boolean }>(
        `SELECT indexrelid::regclass::text AS index_name, indisvalid AS valid FROM pg_index
          WHERE indexrelid IN ('coordination_leases_cleanup_pending_idx'::regclass,
                              'coordination_resources_current_lease_idx'::regclass)`,
      );
      expect(indexes.rows).toHaveLength(2);
      expect(indexes.rows.every((index) => index.valid)).toBe(true);
      const definition = (await client.query<{ body: string }>(
        "SELECT pg_get_functiondef('continuum_backfill_coordination_cleanup(integer)'::regprocedure) AS body",
      )).rows[0].body;
      // Explain the exact installed final predicate, in addition to the real
      // function. EXPLAIN's outer Result node reports nested function buffers
      // but does not expose its internal PL/pgSQL plan nodes.
      const remaining = definition.match(/SELECT EXISTS \(([\s\S]*?)\) INTO remaining;/)?.[1];
      expect(remaining).toBeDefined();
      expect(remaining).toContain('lease.cleanup_eligible_at IS NULL');
      expect(remaining).toContain('resource.current_lease_id = lease.lease_id');

      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s'; SET LOCAL plan_cache_mode = force_generic_plan");
      await client.query(
        `INSERT INTO coordination_migration_progress(name, last_lease_id, rows_processed, completed_at)
         VALUES('issue7-cleanup-eligibility', NULL, 0, NULL)
         ON CONFLICT(name) DO UPDATE SET last_lease_id = NULL, rows_processed = 0, completed_at = NULL`,
      );
      const functionPlan = (await client.query(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT continuum_backfill_coordination_cleanup($1)', [1000],
      )).rows[0]['QUERY PLAN'][0];
      expect((await client.query(
        `SELECT completed_at IS NOT NULL AS complete, rows_processed::text, last_lease_id
           FROM coordination_migration_progress WHERE name = 'issue7-cleanup-eligibility'`,
      )).rows[0]).toEqual({ complete: true, rows_processed: '0', last_lease_id: null });
      // Reset real progress again so the asserted return cannot be a completed
      // state shortcut, even if that optimization is added later.
      await client.query(
        "UPDATE coordination_migration_progress SET last_lease_id = NULL, rows_processed = 0, completed_at = NULL WHERE name = 'issue7-cleanup-eligibility'",
      );
      expect((await client.query('SELECT continuum_backfill_coordination_cleanup($1) AS complete', [1000]))
        .rows[0].complete).toBe(true);
      const predicatePlan = (await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT EXISTS (${remaining}) AS remaining`,
      )).rows[0]['QUERY PLAN'][0];
      expect(nodes(predicatePlan.Plan).some((node) => node['Relation Name'] === 'coordination_leases')).toBe(true);
      expect(nodes(predicatePlan.Plan).some((node) => node['Relation Name'] === 'coordination_resources')).toBe(true);
      await client.query('COMMIT');

      expect((await client.query(
        `SELECT count(*)::int AS leases,
                count(*) FILTER(WHERE cleanup_eligible_at IS NULL)::int AS untouched
           FROM coordination_leases WHERE scope_id = $1`, [scope.id],
      )).rows[0]).toEqual({ leases: count, untouched: count });
      expect((await client.query(
        `SELECT count(*)::int AS resources,
                count(*) FILTER(WHERE lease.lease_id IS NULL OR lease.scope_id <> resource.scope_id
                  OR lease.resource <> resource.resource OR lease.fencing_token <> 1 OR resource.fencing_token <> 1
                  OR resource.current_lease_id <> md5($2 || ':lease:' || split_part(resource.resource, '-', 3))::uuid)::int AS changed
           FROM coordination_resources resource LEFT JOIN coordination_leases lease
             ON lease.lease_id = resource.current_lease_id WHERE resource.scope_id = $1`, [scope.id, nonce],
      )).rows[0]).toEqual({ resources: count, changed: 0 });
      expect((await client.query('SELECT resource_count FROM coordination_scope_usage WHERE scope_id = $1', [scope.id]))
        .rows[0].resource_count).toBe(count);
      for (const [label, plan] of [['actual-helper', functionPlan], ['installed-final-predicate', predicatePlan]] as const) {
        const root = plan.Plan as PlanNode;
        console.info('legacy-cleanup-scale-metrics', JSON.stringify({
          label, currentLeases: count, executionMs: plan['Execution Time'], planningMs: plan['Planning Time'],
          sharedHits: root['Shared Hit Blocks'] ?? 0, sharedReads: root['Shared Read Blocks'] ?? 0,
          tempReads: root['Temp Read Blocks'] ?? 0, tempWrites: root['Temp Written Blocks'] ?? 0,
          nodes: nodes(root).map((node) => ({ type: node['Node Type'], join: node['Join Type'],
            relation: node['Relation Name'], index: node['Index Name'], rows: node['Actual Rows'],
            loops: node['Actual Loops'], removed: node['Rows Removed by Filter'] })),
          indexes: indexes.rows,
        }));
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }, 240_000);
});
