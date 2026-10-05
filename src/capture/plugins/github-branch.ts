import type { CaptureInput } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export interface GitHubBranchEvent {
  ref: string;
  ref_type: 'branch' | 'tag';
  master_branch?: string;
  repository: {
    full_name: string;
    name: string;
    html_url: string;
  };
  sender: { id: number; login: string };
}

export const githubBranchPlugin: CapturePlugin<GitHubBranchEvent> = {
  id: 'github-branch',

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    if (event.ref_type !== 'branch') return [];

    const actor = String(event.sender.id);
    const actorLogin = event.sender.login;
    const userScopeName = ctx.resolveUserScope?.(actor) ?? actor;
    const actorPrincipalId = ctx.resolveActorPrincipalId?.(actor) ?? null;

    const lines = [
      `Branch ${event.ref} created in ${event.repository.full_name}.`,
      `Base: ${event.master_branch ?? 'unknown'}`,
      `Author: ${actorLogin}`,
    ];

    return [
      {
        scope: { kind: 'user', name: userScopeName },
        type: 'context',
        title: `Started branch ${event.ref} (${event.repository.name})`,
        body: lines.join('\n'),
        tags: ['branch', 'github'],
        source: 'github-branch',
        sourceRef: `${event.repository.html_url}/tree/${event.ref}`,
        metadata: {
          repo: event.repository.full_name,
          ref: event.ref,
          base: event.master_branch ?? null,
          actor,
          actorLogin,
          ...(actorPrincipalId ? { actor_principal_id: actorPrincipalId } : {}),
          thread_key: `github-branch:${event.repository.full_name}:${event.ref}`,
          closes_thread_keys: [],
        },
      },
    ];
  },
};
