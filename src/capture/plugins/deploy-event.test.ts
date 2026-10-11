import { describe, expect, it } from 'vitest';
import { deployEventPlugin, type DeployEventPayload } from './deploy-event.js';

function deploy(overrides: Partial<DeployEventPayload> = {}): DeployEventPayload {
  return {
    project: 'booking-engine',
    environment: 'prod',
    version: 'v1.42.0',
    status: 'success',
    commit: 'abc1234',
    pr: 4421,
    url: 'https://dev.azure.com/exampleorg/_build/results?buildId=99812',
    actor: 'scott-exampleorg',
    startedAt: '2026-06-03T01:10:00Z',
    finishedAt: '2026-06-03T01:18:00Z',
    ...overrides,
  };
}

describe('deploy-event plugin', () => {
  it('emits a project-scoped fact memory for a successful prod deploy', () => {
    const out = deployEventPlugin.transform(deploy());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.scope).toEqual({ kind: 'project', name: 'booking-engine' });
    expect(m.type).toBe('fact');
    expect(m.title).toBe('v1.42.0 deployed on prod');
    expect(m.tags).toEqual(['deploy']);
    expect(m.source).toBe('deploy-event');
    expect(m.sourceRef).toBe('https://dev.azure.com/exampleorg/_build/results?buildId=99812');
  });

  it('records all deploy metadata in the metadata block', () => {
    const out = deployEventPlugin.transform(deploy());
    expect(out[0].metadata).toMatchObject({
      project: 'booking-engine',
      environment: 'prod',
      version: 'v1.42.0',
      status: 'success',
      commit: 'abc1234',
      pr: 4421,
      actor: 'scott-exampleorg',
    });
  });

  it('emits the failure verb when status is failure', () => {
    const out = deployEventPlugin.transform(deploy({ status: 'failure' }));
    expect(out[0].title).toBe('v1.42.0 failed to deploy on prod');
    expect(out[0].body).toContain('v1.42.0 failed to deploy on prod.');
    expect(out[0].tags).toEqual(['deploy']);
  });

  it('emits the rollback verb when status is rollback', () => {
    const out = deployEventPlugin.transform(deploy({ status: 'rollback' }));
    expect(out[0].title).toBe('v1.42.0 rolled back on prod');
    expect(out[0].tags).toEqual(['deploy']);
  });

  it('omits optional fields cleanly when they are missing', () => {
    const out = deployEventPlugin.transform({
      project: 'booking-engine',
      environment: 'staging',
      version: 'v1.43.0-rc1',
      status: 'success',
    });
    expect(out[0].body).not.toContain('PR:');
    expect(out[0].body).not.toContain('Commit:');
    expect(out[0].sourceRef).toBeUndefined();
  });

  it('appends notes when provided', () => {
    const out = deployEventPlugin.transform(deploy({ notes: 'Manual approval by Security Reviewer.' }));
    expect(out[0].body).toContain('Manual approval by Security Reviewer.');
  });
});
