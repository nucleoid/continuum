import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readConfigFile, resolveConfig } from './config.js';

describe('CLI config', () => {
  it('uses flags, then the selected profile, then environment, then defaults', () => {
    const file = {
      defaultProfile: 'work',
      profiles: { work: { apiUrl: 'https://profile.test/', tokenEnv: 'WORK_TOKEN' } },
    };
    const env = {
      CONTINUUM_API_URL: 'https://env.test', CONTINUUM_TOKEN: 'env-token',
      WORK_TOKEN: 'profile-token',
    };
    expect(resolveConfig({}, env, file)).toMatchObject({
      apiUrl: 'https://profile.test', token: 'profile-token', profile: 'work',
    });
    expect(resolveConfig({ apiUrl: 'https://flag.test/', token: 'flag-token' }, env, file))
      .toMatchObject({ apiUrl: 'https://flag.test', token: 'flag-token' });
    expect(resolveConfig({}, env, null)).toMatchObject({
      apiUrl: 'https://env.test', token: 'env-token',
    });
  });

  it('rejects token values in profile files', () => {
    expect(() => resolveConfig({}, {}, {
      profiles: { unsafe: { apiUrl: 'https://example.test', token: 'secret' } },
    })).toThrow(/token values/i);
  });

  it('does not fall back to the generic token when a profile tokenEnv is absent', () => {
    expect(() => resolveConfig({}, { CONTINUUM_TOKEN: 'wrong-host-token' }, {
      defaultProfile: 'work',
      profiles: { work: { apiUrl: 'https://work.test', tokenEnv: 'WORK_TOKEN' } },
    })).toThrow(/bearer token is required/i);

    expect(resolveConfig({ token: 'explicit' }, { CONTINUUM_TOKEN: 'wrong-host-token' }, {
      defaultProfile: 'work',
      profiles: { work: { apiUrl: 'https://work.test', tokenEnv: 'WORK_TOKEN' } },
    })).toMatchObject({ token: 'explicit', apiUrl: 'https://work.test' });
  });

  it('rejects an explicitly named missing config file', async () => {
    const missing = join(tmpdir(), `continuum-missing-config-${process.pid}.json`);
    await expect(readConfigFile(missing, true)).rejects.toMatchObject({ exitCode: 2 });
  });
});
