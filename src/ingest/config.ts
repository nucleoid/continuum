export type IngestPluginId =
  | 'github-pr'
  | 'github-branch'
  | 'ado-workitem'
  | 'deploy-event'
  | 'terminal-summary';

export type IngestAuth =
  | { kind: 'github-hmac'; secret: string; event: 'pull_request' | 'create' }
  | { kind: 'ado-basic'; username: string; password: string }
  | { kind: 'bearer' };

export interface IngestPluginConfig {
  enabled: true;
  principalExternalId: string;
  auth: IngestAuth;
  activityNamespace?: string;
}

export interface IngestConfig {
  plugins: Partial<Record<IngestPluginId, IngestPluginConfig>>;
}

const SPECS: Array<{
  id: IngestPluginId;
  prefix: string;
  auth: IngestAuth['kind'];
  event?: 'pull_request' | 'create';
}> = [
  { id: 'github-pr', prefix: 'CONTINUUM_INGEST_GITHUB_PR', auth: 'github-hmac', event: 'pull_request' },
  { id: 'github-branch', prefix: 'CONTINUUM_INGEST_GITHUB_BRANCH', auth: 'github-hmac', event: 'create' },
  { id: 'ado-workitem', prefix: 'CONTINUUM_INGEST_ADO_WORKITEM', auth: 'ado-basic' },
  { id: 'deploy-event', prefix: 'CONTINUUM_INGEST_DEPLOY_EVENT', auth: 'bearer' },
  { id: 'terminal-summary', prefix: 'CONTINUUM_INGEST_TERMINAL_SUMMARY', auth: 'bearer' },
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when ingestion is enabled`);
  return value;
}

const ACTIVITY_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function defaultActivityNamespace(id: IngestPluginId): string {
  if (id === 'github-pr' || id === 'github-branch') return 'github';
  return id;
}

export function validateIngestConfig(config: IngestConfig): void {
  for (const [id, plugin] of Object.entries(config.plugins)) {
    if (!plugin) continue;
    const namespace = plugin.activityNamespace ?? defaultActivityNamespace(id as IngestPluginId);
    if (!ACTIVITY_NAMESPACE.test(namespace)) {
      throw new Error(`${id} activity namespace must match ${ACTIVITY_NAMESPACE}`);
    }
  }
  const githubPr = config.plugins['github-pr'];
  const githubBranch = config.plugins['github-branch'];
  if (githubPr && githubBranch) {
    const prNamespace = githubPr.activityNamespace ?? defaultActivityNamespace('github-pr');
    const branchNamespace = githubBranch.activityNamespace ?? defaultActivityNamespace('github-branch');
    if (prNamespace !== branchNamespace) {
      throw new Error('GitHub PR and branch ingestion must use the same activity namespace');
    }
  }
}

export function ingestConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const plugins: IngestConfig['plugins'] = {};
  for (const spec of SPECS) {
    const rawEnabled = env[`${spec.prefix}_ENABLED`];
    if (rawEnabled === undefined || rawEnabled === '' || rawEnabled.toLowerCase() === 'false') continue;
    if (rawEnabled.toLowerCase() !== 'true') {
      throw new Error(`${spec.prefix}_ENABLED must be true or false`);
    }
    const principalExternalId = required(env, `${spec.prefix}_PRINCIPAL`);
    let auth: IngestAuth;
    if (spec.auth === 'github-hmac') {
      auth = {
        kind: 'github-hmac',
        secret: required(env, `${spec.prefix}_SECRET`),
        event: spec.event!,
      };
    } else if (spec.auth === 'ado-basic') {
      auth = {
        kind: 'ado-basic',
        username: required(env, `${spec.prefix}_USERNAME`),
        password: required(env, `${spec.prefix}_PASSWORD`),
      };
    } else {
      auth = { kind: 'bearer' };
    }
    const activityNamespace = env[`${spec.prefix}_ACTIVITY_NAMESPACE`]?.trim() || undefined;
    plugins[spec.id] = {
      enabled: true,
      principalExternalId,
      auth,
      ...(activityNamespace ? { activityNamespace } : {}),
    };
  }
  const config = { plugins };
  validateIngestConfig(config);
  return config;
}
