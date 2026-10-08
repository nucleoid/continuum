import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runMigrations } from './migrator.js';

const root = process.cwd();
const preserved = new Map([
  ['0054_coordination_leases.sql', 'c69b96b7e8f64ce9d64da71b5026a2e8896cdcf6efb7a52107ca6ab062e7619a'],
  ['0055_coordination_review_remediation.sql', '478d40c2367f3fa900984767e18110fe5aa377aadcda1387225dc5dea87176fd'],
  ['0056_coordination_final_remediation.sql', '034df4cf096603fc895247f05246ca442b604d0df7dc05596e4c7b43af683c27'],
  ['0057_coordination_privacy_race_remediation.sql', '7e8d0bbc1f733d76a55c5d9835280880f4254d951d7db41351b4b4ed01d8b3e3'],
  ['0058_coordination_online_prep.sql', '56850725814e6385e1c3c5253aeecce6060f2feafe96003de7f19861ede550bf'],
  ['0059_coordination_bounded_privacy.sql', '5973bed68dd895df4d49e8603a72e232d696625eff815a89cb00365d7bf35d25'],
  ['0060_coordination_online_finish.sql', '97d3c881c44f950a7264ca93b5d0abb0f07a2ee26df14f07316dbbd7190048a7'],
  ['0061_coordination_forward_security_repair.sql', 'b8cf3529afd40b40ca1b05262bb5425a76cd1def64078cb83ceacbd2b4a4692f'],
  ['0062_coordination_forward_online_finish.sql', '8b6de993de4b3e571461368e48ee184eee2be3276bb6091d45f17e2e600fc77f'],
  ['0063_coordination_final_privacy_repair.sql', '4e6c13b689cd1ba6d14c37aa58701d6e430c890cdd6dd97aedb5c6c1c5292716'],
  ['0064_coordination_final_online_indexes.sql', '4c7ba440652d6fabf94017140e6b7d240f157ba109984438a31dc0ca14ad2109'],
  ['0065_coordination_review_remediation.sql', '7b7d0ab26646f7770c8ab93899b6698a39872fc149af3d39e0c869547f0d5030'],
  ['0066_coordination_upgrade_privacy_repair.sql', '48223c50b0e39434446f6bebd7d625e51786b4606a70dadce44832b6b65d8bb2'],
  ['0067_coordination_rollout_repair.sql', '8f868cbe1bbe19684c0857ef8b110fb55d2565059b3862f1f1585ba893d53fe3'],
  ['0068_coordination_production_repair.sql', 'b9488db55b8392f9a2d7eb4061dd190e69f3fba9ae230ca8ecee9696706ce390'],
  ['0069_coordination_independent_review.sql', '77847f54221ddc24ca5dc2d1ba43efce19e0c2beb4c599147a23621cb54de9bf'],
  ['0070_coordination_linkable_audit_index.sql', 'f234e2e1a564a7216fb4ae79e042f7c6d41540cccc2a9304267fc8cfd022cf97'],
  ['0071_coordination_review_completion.sql', '16b4784899e6467c57032b332cc56660c4cfd3c3492296f640f2f232b7de1670'],
  ['0072_coordination_final_review_remediation.sql', '9e763a73e16e16ed8b37c9d7c6654f56f62ae96ef62eb9b004ad2b325cd1d4a9'],
  ['0073_coordination_bounded_discovery_and_locking.sql', 'b2f96e35511e563cc9890d871d3910d70a3d99856e233f4da9b151405ef72e7b'],
]);

describe('issue 7 second independent review remediation', () => {
  it('keeps every published coordination migration through 0073 byte-identical', async () => {
    for (const [name, expected] of preserved) {
      const bytes = await readFile(join(root, 'migrations', name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(expected);
    }
  });

  it('ships only forward online repair migrations after 0073', async () => {
    const files = (await readdir(join(root, 'migrations'))).sort();
    expect(files).toEqual(expect.arrayContaining([
      '0074_coordination_compatibility_and_upgrade_repair.sql',
      '0075_coordination_online_repair_finish.sql',
    ]));
    const repair = await readFile(join(root, 'migrations/0074_coordination_compatibility_and_upgrade_repair.sql'), 'utf8');
    const finish = await readFile(join(root, 'migrations/0075_coordination_online_repair_finish.sql'), 'utf8');
    expect(repair).toMatch(/client_coordination_privacy_version/i);
    expect(repair).toMatch(/repair_eligible/i);
    expect(repair).toMatch(/chr\(13\).*chr\(10\)|E'\\r\\n'/is);
    expect(repair).toMatch(/lock_not_available[\s\S]*refresh_coordination_privacy_dirty/i);
    expect(finish.trimStart()).toMatch(/^-- continuum:no-transaction/);
    expect(finish).toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(finish).toMatch(/backfill-coordination-v4/i);
  });

  it('requires pending checksum enforcement, explicit client negotiation, and bounded locks', async () => {
    const migrator = await readFile(join(root, 'src/storage/migrator.ts'), 'utf8');
    const service = await readFile(join(root, 'src/services/offboarding.ts'), 'utf8');
    expect(migrator).toMatch(/verifyPublishedMigration[^]*for \(const file of files\)/i);
    expect(migrator).toMatch(/0073_coordination_bounded_discovery_and_locking\.sql['"],\s*\n\s*['"][0-9a-f]{64}/);
    expect(service).toMatch(/SET LOCAL continuum\.client_coordination_privacy_version/i);
    expect(service).toMatch(/pg_try_advisory_xact_lock/i);
    expect(service).toMatch(/FOR UPDATE NOWAIT/i);
    expect(service).toMatch(/55P03[\s\S]*lock_busy|lock_busy[\s\S]*55P03/i);
  });

  it('rejects a tampered pinned migration before fresh execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-pending-pin-'));
    await writeFile(
      join(directory, '0073_coordination_bounded_discovery_and_locking.sql'),
      Buffer.concat([
        await readFile(join(root, 'migrations/0073_coordination_bounded_discovery_and_locking.sql')),
        Buffer.from('\n-- pending tamper\n'),
      ]),
    );
    const admin = new pg.Pool({
      connectionString: process.env.CONTINUUM_TEST_DATABASE_URL
        ?? 'postgres://continuum:continuum@localhost:5433/continuum',
    });
    const schema = `pending_pin_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      ...(admin as unknown as { options: pg.PoolConfig }).options,
      options: `-c search_path=${schema},public`, max: 1,
    });
    try {
      await expect(runMigrations(pool, directory)).rejects.toThrow(
        /0073.*modified|0073.*checksum|published migration/i,
      );
      expect((await pool.query(
        `SELECT to_regclass(format('%I.coordination_privacy_dirty_principals',
          current_schema())) AS relation`,
      )).rows).toEqual([{ relation: null }]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('documents drain, rollback refusal, exact status reasons, and truthful resume fields', async () => {
    const coordination = await readFile(join(root, 'docs/coordination.md'), 'utf8');
    const offboarding = await readFile(join(root, 'docs/offboarding.md'), 'utf8');
    const cli = await readFile(join(root, 'docs/cli.md'), 'utf8');
    const combined = `${coordination}\n${offboarding}\n${cli}`;
    expect(combined).toMatch(/0074[\s\S]*0075/i);
    expect(combined).toMatch(/drain[\s\S]*pre-0074|pre-0074[\s\S]*drain/i);
    expect(combined).toMatch(/rollback[\s\S]*refus/i);
    expect(cli).toMatch(/no_progress[\s\S]*status 2|status 2[\s\S]*no_progress/i);
    expect(cli).toMatch(/detached_quota[\s\S]*lock_busy[\s\S]*status 3|status 3[\s\S]*detached_quota[\s\S]*lock_busy/i);
    expect(cli).toMatch(/resumeRecommended/i);
  });

  it('repairs function bodies stored as CRLF by a real 0064 database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-pre0065-crlf-'));
    const migrations = join(root, 'migrations');
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql'))) {
      await writeFile(join(directory, name), await readFile(join(migrations, name)));
    }
    const admin = new pg.Pool({
      connectionString: process.env.CONTINUUM_TEST_DATABASE_URL
        ?? 'postgres://continuum:continuum@localhost:5433/continuum',
    });
    const schema = `pre0065_crlf_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      ...(admin as unknown as { options: pg.PoolConfig }).options,
      options: `-c search_path=${schema},public`, max: 1,
    });
    try {
      const through0064 = await mkdtemp(join(tmpdir(), 'continuum-through0064-'));
      for (const name of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql')
          && name <= '0064_coordination_final_online_indexes.sql')) {
        await writeFile(join(through0064, name), await readFile(join(migrations, name)));
      }
      await runMigrations(pool, through0064);
      const definition = String((await pool.query(
        `SELECT pg_get_functiondef(
          'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'::regprocedure
        ) AS definition`,
      )).rows[0].definition).replaceAll(/(?<!\r)\n/g, '\r\n');
      await pool.query(definition);
      expect((await pool.query(
        `SELECT position(chr(13) IN prosrc) > 0 AS stored_crlf
           FROM pg_proc
          WHERE oid = 'continuum_operator_scrub_coordination_principal(uuid,uuid,uuid,integer)'::regprocedure`,
      )).rows).toEqual([{ stored_crlf: true }]);
      await runMigrations(pool, directory);
      expect((await pool.query(
        `SELECT count(*)::int AS remaining
           FROM pg_proc
          WHERE pronamespace = quote_ident(current_schema())::regnamespace
            AND position(chr(13) IN prosrc) > 0`,
      )).rows).toEqual([{ remaining: 0 }]);
      await pool.query(
        `INSERT INTO principals (id, external_id, kind, display_name, disabled_at)
         SELECT ('51000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                'restart:' || n, 'user', 'Restart candidate', clock_timestamp()
           FROM generate_series(1, 2001) n`,
      );
      await pool.query(
        `INSERT INTO coordination_principal_privacy_progress
           (principal_id, detached_principal_id, privacy_version, completed_at)
         SELECT ('51000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                '00000000-0000-4000-8000-000000000012', 2, NULL
           FROM generate_series(1, 2001) n`,
      );
      await pool.query(
        `UPDATE coordination_principal_privacy_progress
            SET repair_eligible = NULL
          WHERE principal_id::text LIKE '51000000-%';
         UPDATE coordination_v4_backfill_state
            SET last_principal_id = NULL, completed = FALSE`,
      );
      expect((await pool.query(
        `SELECT continuum_backfill_coordination_v4(1000) AS completed`,
      )).rows).toEqual([{ completed: false }]);
      const resumed = new pg.Pool({
        ...(admin as unknown as { options: pg.PoolConfig }).options,
        options: `-c search_path=${schema},public`, max: 1,
      });
      try {
        expect((await resumed.query(
          `SELECT continuum_backfill_coordination_v4(1000) AS completed`,
        )).rows).toEqual([{ completed: false }]);
        expect((await resumed.query(
          `SELECT continuum_backfill_coordination_v4(1000) AS completed`,
        )).rows).toEqual([{ completed: true }]);
      } finally {
        await resumed.end();
      }
      expect((await pool.query(
        `SELECT count(*)::int AS remaining
           FROM coordination_principal_privacy_progress
          WHERE principal_id::text LIKE '51000000-%'
            AND repair_eligible IS NULL`,
      )).rows).toEqual([{ remaining: 0 }]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
