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

function githubIdentity(user: { id: number }): { authority: string; externalId: string } | null {
  return Number.isSafeInteger(user.id) && user.id > 0
    ? { authority: 'github', externalId: String(user.id) }
    : null;
}

export const githubBranchPlugin: CapturePlugin<GitHubBranchEvent> = {
  id: 'github-branch',

  actorIdentity(event) {
    return githubIdentity(event.sender);
  },

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    if (event.ref_type !== 'branch') return [];

    const actor = event.sender.login;
    const identity = githubIdentity(event.sender);
    const userScopeName = (identity ? ctx.resolveUserScope?.(identity) : null) ?? actor;
    const actorPrincipalId = identity
      ? ctx.resolveActorPrincipalId?.(identity) ?? null
      : null;

    const lines = [
      `Branch ${event.ref} created in ${event.repository.full_name}.`,
      `Base: ${event.master_branch ?? 'unknown'}`,
      `Author: ${actor}`,
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
          ...(actorPrincipalId ? { actor_principal_id: actorPrincipalId } : {}),
          ...(actorPrincipalId ? { thread_owner_principal_id: actorPrincipalId } : {}),
          thread_key: `github-branch:${event.repository.full_name}:${event.ref}`,
          closes_thread_keys: [],
        },
      },
    ];
  },
};
