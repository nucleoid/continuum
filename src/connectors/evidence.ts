import { z } from 'zod';
import { boundedJson, type BudgetAdapter } from '../pipeline/budget.js';

export const REPOSITORY_EVIDENCE_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 65536,
  receiptBytes: 8192, results: 20, authorityMs: 5000 });
export const repositoryEvidenceClasses = ['repository-brief', 'indexed-symbol', 'source-code', 'file-context', 'flow', 'contract-impact'] as const;
export type RepositoryEvidenceClass = typeof repositoryEvidenceClasses[number];
const opaque = z.string().regex(/^[a-zA-Z0-9_.:/-]{1,128}$/);
const commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable();
export const repositoryRequestSchema = z.object({ repository: opaque, evidenceClass: z.enum(repositoryEvidenceClasses),
  query: z.string().max(4096), commit, maxResults: z.number().int().min(1).max(REPOSITORY_EVIDENCE_LIMITS.results) }).strict();
export type RepositoryEvidenceRequest = z.infer<typeof repositoryRequestSchema>;
const itemSchema = z.object({ id: opaque, repository: opaque, kind: z.enum(['indexed', 'vcs', 'history']),
  text: z.string().max(REPOSITORY_EVIDENCE_LIMITS.responseBytes), locator: z.string().max(512),
  commit, indexWatermark: opaque.nullable() }).strict();
export const repositoryResponseSchema = z.object({ items: z.array(itemSchema).max(REPOSITORY_EVIDENCE_LIMITS.results),
  truncated: z.boolean() }).strict();
export type RepositoryEvidenceResponse = z.infer<typeof repositoryResponseSchema>;
/** Independently verified delegated permission, never an assertion from query output.
 * validForMs is conservative from the database time sampled BEFORE the probe.
 * The transport accounts for upstream clock uncertainty or returns unknown. */
export const repositoryAuthoritySchema = z.object({ decision: z.enum(['allow', 'deny', 'unknown']), repository: opaque,
  principalId: z.string().uuid(), validForMs: z.number().int().min(1).max(REPOSITORY_EVIDENCE_LIMITS.authorityMs),
  commit, indexWatermark: opaque.nullable() }).strict();
export type RepositoryAuthority = z.infer<typeof repositoryAuthoritySchema>;
export interface RepositoryPermissionRequest { repository: string; principalId: string }
export interface RepositoryEvidenceSession {
  permission: BudgetAdapter<RepositoryPermissionRequest, RepositoryAuthority>;
  query: BudgetAdapter<RepositoryEvidenceRequest, RepositoryEvidenceResponse>;
}
export interface RepositoryEvidenceConnector {
  id: string;
  version: string;
  classes: readonly RepositoryEvidenceClass[];
  /** An opaque transport-owned object is closed over by adapters. It MUST NOT be
   * projected by either serializer. It is never a bearer or model input field. */
  open(authorizationContext: object): RepositoryEvidenceSession;
}
export type ConnectorOutcome = 'complete' | 'denied' | 'unavailable' | 'stale' | 'budget' | 'timeout';
export interface ConnectorReceipt {
  schema: 'repository-evidence-v1'; outcome: ConnectorOutcome; evidenceClass: RepositoryEvidenceClass;
  freshness: 'exact' | 'unknown' | 'stale'; commit: string | null; indexWatermark: string | null;
  truncated: boolean;
}
export function validateRepositoryEvidence(value: unknown, request: RepositoryEvidenceRequest): value is RepositoryEvidenceResponse {
  try {
    boundedJson(value, REPOSITORY_EVIDENCE_LIMITS.responseBytes);
    const parsed = repositoryResponseSchema.parse(value);
    return parsed.items.length <= request.maxResults && parsed.items.every(item => item.repository === request.repository
      && (request.commit === null || (item.commit === request.commit && item.kind !== 'history')));
  } catch { return false; }
}
