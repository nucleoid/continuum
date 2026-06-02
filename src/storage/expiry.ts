import type { MemoryType, ScopeKind } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeExpiry(
  type: MemoryType,
  scopeKind: ScopeKind,
  now: Date = new Date(),
): Date | null {
  switch (type) {
    case 'decision':
    case 'playbook':
      return null;
    case 'fact':
      return new Date(now.getTime() + 90 * DAY_MS);
    case 'relationship':
      return new Date(now.getTime() + 180 * DAY_MS);
    case 'context': {
      const days = scopeKind === 'user' ? 14 : 60;
      return new Date(now.getTime() + days * DAY_MS);
    }
  }
}
