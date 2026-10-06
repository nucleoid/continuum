export type ScopeKind = 'org' | 'team' | 'project' | 'user' | 'role';
export type MemoryType = 'fact' | 'decision' | 'context' | 'playbook' | 'relationship';
export type MemoryState = 'live' | 'stale' | 'archived' | 'promoted';
export type PrincipalKind = 'user' | 'service';
export type MembershipRole = 'reader' | 'writer' | 'admin';
export type AuditAction = 'read' | 'write' | 'promote' | 'archive' | 'verify';

export interface TagVocabulary {
  scopeKind: ScopeKind;
  tag: string;
  description: string;
  createdBy: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScopeRef {
  kind: ScopeKind;
  name: string;
}

export interface Scope {
  id: string;
  kind: ScopeKind;
  name: string;
  createdAt: Date;
}

export interface Principal {
  id: string;
  externalId: string;
  kind: PrincipalKind;
  displayName: string;
  createdAt: Date;
}

export interface Memory {
  id: string;
  scopeId: string;
  type: MemoryType;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  tags: string[];
  authorId: string;
  source: string;
  sourceRef: string | null;
  state: MemoryState;
  supersedesId: string | null;
  promotedToId: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  lastVerified: Date | null;
}

export interface CaptureInput {
  scope: ScopeRef;
  type: MemoryType;
  title: string;
  body: string;
  tags?: string[];
  source: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallInput {
  query: string;
  scopes?: string[];
  types?: MemoryType[];
  limit?: number;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  excerpt: string;
  bodyTruncated: boolean;
}
