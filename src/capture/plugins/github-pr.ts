import type { CaptureInput } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export interface GitHubPrEvent {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state: string;
    merged: boolean;
    merged_at?: string | null;
    merged_by?: { id: number; login: string } | null;
    user: { id: number; login: string };
    base: { ref: string };
    head: { ref: string };
  };
  repository: {
    full_name: string;
    name: string;
  };
}

function projectName(repoFullName: string): string {
  const slash = repoFullName.indexOf('/');
  return slash === -1 ? repoFullName : repoFullName.slice(slash + 1);
}

export const githubPrPlugin: CapturePlugin<GitHubPrEvent> = {
  id: 'github-pr',

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    if (event.action !== 'closed' || !event.pull_request.merged) return [];

    const pr = event.pull_request;
    const project = ctx.defaultProjectName ?? projectName(event.repository.full_name);

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
          author: String(pr.user.id),
          authorLogin: pr.user.login,
          mergedBy: pr.merged_by ? String(pr.merged_by.id) : null,
          mergedByLogin: pr.merged_by?.login ?? null,
          baseRef: pr.base.ref,
          headRef: pr.head.ref,
          mergedAt: pr.merged_at ?? null,
        },
      },
    ];
  },
};
