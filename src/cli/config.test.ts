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
    expect(resolveConfig({ apiUrl: 'https://flag.test/', token: 'flag-token' }, env, null))
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

  });

  it('treats a selected profile as an atomic host and credential boundary', () => {
    expect(() => resolveConfig({}, { WORK_TOKEN: 'profile-token' }, {
      defaultProfile: 'work', profiles: { work: { tokenEnv: 'WORK_TOKEN' } },
    })).toThrow(/apiUrl/i);
    expect(() => resolveConfig({}, {
      CONTINUUM_API_URL: 'https://env.test', WORK_TOKEN: 'profile-token',
    }, {
      defaultProfile: 'work', profiles: { work: { tokenEnv: 'WORK_TOKEN' } },
    })).toThrow(/apiUrl/i);

    expect(() => resolveConfig({}, { CONTINUUM_TOKEN: 'env-token' }, {
      defaultProfile: 'work', profiles: { work: { apiUrl: 'https://profile.test' } },
    })).toThrow(/tokenEnv/i);
    expect(() => resolveConfig({ token: 'flag-token' }, {}, {
      defaultProfile: 'work',
      profiles: { work: { apiUrl: 'https://profile.test', tokenEnv: 'WORK_TOKEN' } },
    })).toThrow(/cannot be combined/i);
    expect(() => resolveConfig({ apiUrl: 'https://flag.test' }, { WORK_TOKEN: 'profile-token' }, {
      defaultProfile: 'work',
      profiles: { work: { apiUrl: 'https://profile.test', tokenEnv: 'WORK_TOKEN' } },
    })).toThrow(/cannot be combined/i);
  });

  it('validates config and profile objects and uses own profile properties', () => {
    expect(() => resolveConfig({}, {}, { profiles: null as never })).toThrow(/profiles.*object/i);
    expect(() => resolveConfig({}, {}, {
      profiles: { broken: null as never }, defaultProfile: 'broken',
    })).toThrow(/profile.*object/i);
    expect(() => resolveConfig({}, {}, {
      profiles: {}, defaultProfile: 'constructor',
    })).toThrow(/unknown profile/i);
  });

  it('rejects an explicitly named missing config file', async () => {
    const missing = join(tmpdir(), `continuum-missing-config-${process.pid}.json`);
    await expect(readConfigFile(missing, true)).rejects.toMatchObject({ exitCode: 2 });
  });
});
