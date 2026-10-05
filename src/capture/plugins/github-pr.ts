import type { CaptureInput } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export interface GitHubPrEvent {
  action: string;
  reviews?: Array<{ user: { login: string } }>;
  pull_request: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state: string;
    merged: boolean;
    merged_at?: string | null;
    merged_by?: { id?: number; login: string } | null;
    user: { id: number; login: string };
    requested_reviewers?: Array<{ login: string }>;
    base: { ref: string };
    head: { ref: string };
  };
  repository: {
    id: number;
    full_name: string;
    name: string;
  };
}

function projectName(repoFullName: string): string {
  const slash = repoFullName.indexOf('/');
  return slash === -1 ? repoFullName : repoFullName.slice(slash + 1);
}

function githubIdentity(user: { id: number }): { authority: string; externalId: string } | null {
  return Number.isSafeInteger(user.id) && user.id > 0
    ? { authority: 'github', externalId: String(user.id) }
    : null;
}

export const githubPrPlugin: CapturePlugin<GitHubPrEvent> = {
  id: 'github-pr',
  trustedActivityMetadata: true,
  activityIdentityAuthority: 'github',

  actorIdentity(event) {
    return githubIdentity(event.pull_request.user);
  },

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    if (event.action !== 'closed' || !event.pull_request.merged) return [];

    const pr = event.pull_request;
    const project = ctx.defaultProjectName ?? projectName(event.repository.full_name);
    const identity = githubIdentity(pr.user);
    const actorPrincipalId = identity
      ? ctx.resolveActorPrincipalId?.(identity) ?? null
      : null;
    const threadPrefix = ctx.activityNamespace ?? 'github';
    const repoKey = `${threadPrefix}:repo:${event.repository.id}`;
    const threadKey = `${repoKey}:pr:${pr.number}`;

    const lines: string[] = [];
    if (pr.body && pr.body.trim()) lines.push(pr.body.trim());
    lines.push('');
    lines.push(`Merged ${pr.head.ref} into ${pr.base.ref}.`);
    if (pr.merged_by) lines.push(`Merged by: ${pr.merged_by.login}`);
    if (pr.merged_at) lines.push(`Merged at: ${pr.merged_at}`);
    lines.push(`Author: ${pr.user.login}`);

    return [
      {
        scope: { kind: 'project', name: project },
        type: 'context',
        title: `PR #${pr.number}: ${pr.title}`,
        body: lines.join('\n').trim(),
        tags: ['pr', 'merged'],
        source: 'github-pr',
        sourceRef: pr.html_url,
        metadata: {
          repo: event.repository.full_name,
          number: pr.number,
          actor: pr.user.login,
          ...(actorPrincipalId ? { actor_principal_id: actorPrincipalId } : {}),
          ...(actorPrincipalId ? { thread_owner_principal_id: actorPrincipalId } : {}),
          merged_by: pr.merged_by?.login ?? null,
          reviewers: [...new Set((event.reviews ?? []).map((review) => review.user.login))],
          requested_reviewers: [
            ...new Set((pr.requested_reviewers ?? []).map((reviewer) => reviewer.login)),
          ],
          thread_key: threadKey,
          closes_thread_keys: [
            threadKey,
            `${repoKey}:branch:${pr.head.ref}`,
          ],
          baseRef: pr.base.ref,
          headRef: pr.head.ref,
          mergedAt: pr.merged_at ?? null,
        },
      },
    ];
  },
};
