import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

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
});
