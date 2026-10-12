import { expect, it } from 'vitest';
import { quoteStandupIdentifier, standupProducerFixture } from '../standup/test-helpers.js';

for (const historical of [false, true]) {
  it(`keeps a producer namespace bound to its original source family ${historical ? 'after revocation' : 'while active'}`, async () => {
    await standupProducerFixture(async (value) => {
      if (historical) await value.operator.query(
        'SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,NULL::uuid,$3::text,$4::text)',
        [value.adminId, value.producerRole, value.namespace, 'github']);
      const appRole = (await value.app.query('SELECT session_user AS role')).rows[0].role;
      await expect(value.operator.query(
        'SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,$3::uuid,$4::text,$5::text)',
        [value.adminId, appRole, value.producerId, value.namespace, 'terminal-summary']))
        .rejects.toMatchObject({ code: '23514' });
      expect((await value.owner.query('SELECT source_family FROM standup_producer_bindings WHERE authority=$1',
        [value.namespace])).rows.every((row) => row.source_family === 'github')).toBe(true);
    });
  }, 180_000);
}

it('denies producer context after privileged role attributes drift', async () => {
  await standupProducerFixture(async (value) => {
    expect((await value.producer.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context)
      .toMatchObject({ principal_id: value.producerId });
    try {
      await value.owner.query(`ALTER ROLE ${quoteStandupIdentifier(value.producerRole)} CREATEROLE`);
      expect((await value.producer.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context).toBeNull();
    } finally {
      await value.owner.query(`ALTER ROLE ${quoteStandupIdentifier(value.producerRole)} NOCREATEROLE`);
    }
  });
}, 180_000);

it('denies producer context after a role membership edge appears', async () => {
  await standupProducerFixture(async (value) => {
    const appRole = (await value.app.query('SELECT session_user AS role')).rows[0].role;
    try {
      await value.owner.query(`GRANT ${quoteStandupIdentifier(appRole)} TO ${quoteStandupIdentifier(value.producerRole)}`);
      expect((await value.producer.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context).toBeNull();
    } finally {
      await value.owner.query(`REVOKE ${quoteStandupIdentifier(appRole)} FROM ${quoteStandupIdentifier(value.producerRole)}`);
    }
  });
}, 180_000);

it('revokes a stored producer binding despite privileged role drift and rejects an absent binding', async () => {
  await standupProducerFixture(async (value) => {
    try {
      await value.owner.query(`ALTER ROLE ${quoteStandupIdentifier(value.producerRole)} CREATEROLE`);
      const revoked = await value.operator.query(
        'SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,NULL::uuid,$3::text,$4::text) AS binding',
        [value.adminId, value.producerRole, value.namespace, 'github']);
      expect(revoked.rows[0].binding).toEqual(expect.any(String));
      expect((await value.producer.query('SELECT continuum_standup_producer_context() AS context')).rows[0].context).toBeNull();
      await expect(value.operator.query(
        'SELECT continuum_operator_bind_standup_producer($1::uuid,$2::name,NULL::uuid,$3::text,$4::text)',
        [value.adminId, value.producerRole, value.namespace, 'github']))
        .rejects.toMatchObject({ code: '23514' });
    } finally {
      await value.owner.query(`ALTER ROLE ${quoteStandupIdentifier(value.producerRole)} NOCREATEROLE`);
    }
  });
}, 180_000);
