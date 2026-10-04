import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from './pool.js';

const DATABASE_URL = 'postgres://continuum:pool-secret@localhost:5433/continuum';
const POOL_ENV_VARS = [
  'CONTINUUM_DB_POOL_MAX',
  'CONTINUUM_DB_IDLE_TIMEOUT_MS',
  'CONTINUUM_DB_CONNECTION_TIMEOUT_MS',
] as const;
const CONNECTION_STRING = DATABASE_URL.replace('***', 'pool-secret');

type PoolOptions = {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};

function options(): PoolOptions {
  return (getPool() as unknown as { options: PoolOptions }).options;
}

describe('production pool', () => {
  beforeEach(async () => {
    await closePool();
    process.env.CONTINUUM_DATABASE_URL = CONNECTION_STRING;
    for (const name of POOL_ENV_VARS) delete process.env[name];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    delete process.env.CONTINUUM_DATABASE_URL;
    for (const name of POOL_ENV_VARS) delete process.env[name];
  });

  it('uses bounded defaults and attaches one error listener to the singleton', () => {
    const first = getPool();
    const second = getPool();

    expect(second).toBe(first);
    expect(first.listenerCount('error')).toBe(1);
    expect(options()).toMatchObject({
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('logs an idle-client error without exposing the connection string', () => {
    const error = new Error('synthetic idle client failure');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => getPool().emit('error', error)).not.toThrow();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith('pg pool idle client error', error);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(CONNECTION_STRING);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('pool-secret');
  });

  it('accepts positive-integer pool setting overrides', () => {
    process.env.CONTINUUM_DB_POOL_MAX = '23';
    process.env.CONTINUUM_DB_IDLE_TIMEOUT_MS = '45000';
    process.env.CONTINUUM_DB_CONNECTION_TIMEOUT_MS = '7000';

    expect(options()).toMatchObject({
      max: 23,
      idleTimeoutMillis: 45_000,
      connectionTimeoutMillis: 7_000,
    });
  });

  it.each([
    ['CONTINUUM_DB_POOL_MAX', '0'],
    ['CONTINUUM_DB_POOL_MAX', '-1'],
    ['CONTINUUM_DB_IDLE_TIMEOUT_MS', '1.5'],
    ['CONTINUUM_DB_CONNECTION_TIMEOUT_MS', 'abc'],
    ['CONTINUUM_DB_CONNECTION_TIMEOUT_MS', ''],
    ['CONTINUUM_DB_CONNECTION_TIMEOUT_MS', '9007199254740992'],
  ] as const)('rejects invalid %s value %j at startup', (name, value) => {
    process.env[name] = value;

    expect(() => getPool()).toThrow(`${name} must be a positive integer`);
  });

  it('ends and clears the singleton during cleanup', async () => {
    const first = getPool();
    const end = vi.spyOn(first, 'end');

    await closePool();

    expect(end).toHaveBeenCalledOnce();
    const second = getPool();
    expect(second).not.toBe(first);
    expect(second.listenerCount('error')).toBe(1);
  });
});
