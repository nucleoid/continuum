import type { ScopeKind, ScopeRef } from '../types.js';

const VALID_KINDS: ScopeKind[] = ['org', 'team', 'project', 'user', 'role'];

export function parseScopeString(s: string): ScopeRef {
  if (s === 'org') return { kind: 'org', name: '' };
  const idx = s.indexOf(':');
  if (idx === -1) {
    throw new Error(`Invalid scope string: ${s}`);
  }
  const kind = s.slice(0, idx) as ScopeKind;
  const name = s.slice(idx + 1);
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`Invalid scope kind: ${kind}`);
  }
  if (kind === 'org' && name !== '') {
    throw new Error('org scope cannot have a name');
  }
  if (kind !== 'org' && name === '') {
    throw new Error(`Scope ${kind} requires a name`);
  }
  return { kind, name };
}

export function scopeToString(ref: ScopeRef): string {
  return ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`;
}

const READ_PRIORITY: Record<ScopeKind, number> = {
  user: 0,
  project: 1,
  team: 2,
  role: 3,
  org: 4,
};

export function sortScopesForRead(scopes: ScopeRef[]): ScopeRef[] {
  return [...scopes].sort(
    (a, b) => READ_PRIORITY[a.kind] - READ_PRIORITY[b.kind],
  );
}
