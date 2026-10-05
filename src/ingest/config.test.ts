import { describe, expect, it } from 'vitest';
import { ingestConfigFromEnv } from './config.js';

describe('ingest configuration', () => {
  it('keeps every plugin disabled by default', () => {
    expect(ingestConfigFromEnv({})).toEqual({ plugins: {} });
  });

  it('fails startup when an enabled plugin lacks credentials or principal mapping', () => {
    expect(() => ingestConfigFromEnv({
      CONTINUUM_INGEST_GITHUB_PR_ENABLED: 'true',
    })).toThrow(/PRINCIPAL/);
    expect(() => ingestConfigFromEnv({
      CONTINUUM_INGEST_GITHUB_PR_ENABLED: 'true',
      CONTINUUM_INGEST_GITHUB_PR_PRINCIPAL: 'service:github',
    })).toThrow(/SECRET/);
    expect(() => ingestConfigFromEnv({
      CONTINUUM_INGEST_DEPLOY_EVENT_ENABLED: 'sometimes',
    })).toThrow(/true or false/);
  });

  it('loads enabled plugins without exposing or transforming credentials', () => {
    expect(ingestConfigFromEnv({
      CONTINUUM_INGEST_ADO_WORKITEM_ENABLED: 'true',
      CONTINUUM_INGEST_ADO_WORKITEM_PRINCIPAL: 'service:ado',
      CONTINUUM_INGEST_ADO_WORKITEM_USERNAME: 'hook-user',
      CONTINUUM_INGEST_ADO_WORKITEM_PASSWORD: 'hook-password',
    })).toEqual({ plugins: { 'ado-workitem': {
      enabled: true,
      principalExternalId: 'service:ado',
      auth: { kind: 'ado-basic', username: 'hook-user', password: 'hook-password' },
    } } });
  });

  it('uses one explicit GitHub activity namespace across split service principals', () => {
    const common = {
      CONTINUUM_INGEST_GITHUB_PR_ENABLED: 'true',
      CONTINUUM_INGEST_GITHUB_PR_PRINCIPAL: 'service:github-pr',
      CONTINUUM_INGEST_GITHUB_PR_SECRET: 'pr-secret',
      CONTINUUM_INGEST_GITHUB_BRANCH_ENABLED: 'true',
      CONTINUUM_INGEST_GITHUB_BRANCH_PRINCIPAL: 'service:github-branch',
      CONTINUUM_INGEST_GITHUB_BRANCH_SECRET: 'branch-secret',
    };
    expect(ingestConfigFromEnv(common).plugins['github-pr']?.activityNamespace)
      .toBeUndefined();
    expect(() => ingestConfigFromEnv({
      ...common,
      CONTINUUM_INGEST_GITHUB_PR_ACTIVITY_NAMESPACE: 'github.prod',
      CONTINUUM_INGEST_GITHUB_BRANCH_ACTIVITY_NAMESPACE: 'github.other',
    })).toThrow(/same activity namespace/);
    expect(() => ingestConfigFromEnv({
      ...common,
      CONTINUUM_INGEST_GITHUB_PR_ACTIVITY_NAMESPACE: 'GitHub Invalid',
    })).toThrow(/activity namespace/);
  });
});
