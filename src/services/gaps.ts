import type pg from 'pg';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { CaptureInput, Principal } from '../types.js';
import { record } from '../audit/log.js';
import {
  isGapCurrentlyResolved,
  selectGapCandidates,
  type GapCandidate,
} from '../storage/gaps.js';
import { requireOrgAdmin } from './access.js';
import { asServiceError, ServiceError } from './errors.js';
import { MAX_GAP_CLUSTER_CANDIDATES } from '../insights/gaps.js';
import { getScope } from '../storage/scopes.js';

export interface GapOptions {
  sinceDays: number;
  limit: number;
  minFrequency: number;
  threshold: number;
  candidateLimit: number;
  scanLimit: number;
  maxQueryChars: number;
  embeddingTimeoutMs?: number;
  now?: Date;
  transport?: 'rest' | 'mcp';
}

export interface KnowledgeGap {
  representative: string;
  variants: string[];
  frequency: number;
  distinctPrincipals: number;
  firstSeen: string;
  lastSeen: string;
  score: number;
  resolution: {
    status: 'resolved' | 'unresolved';
    scopeFidelity: 'exact' | 'unknown';
  };
  capture: CaptureInput;
}

export interface GapReport {
  generatedAt: string;
  window: { since: string; days: number };
  parameters: {
    limit: number;
    minFrequency: number;
    similarityThreshold: number;
    candidateLimit: number;
    scanLimit: number;
    maxQueryChars: number;
    embeddingTimeoutMs: number;
  };
  candidateCount: number;
  truncated: boolean;
  semanticClustering: boolean;
  embedding: {
    status: 'not-requested' | 'succeeded' | 'partial' | 'degraded';
    attemptedGroups: number;
    succeededGroups: number;
    failedGroups: number;
    skippedCandidates: number;
    providers: Array<{ provider: string; dim: number; status: 'succeeded' | 'failed' }>;
  };
  scopeFidelity: 'exact' | 'unknown';
  gaps: KnowledgeGap[];
}

interface Cluster {
  members: GapCandidate[];
}

interface CandidateEmbeddingGroup {
  provider: EmbeddingProvider;
  candidates: GapCandidate[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function vectorNorm(vector: readonly number[]): number {
  let squared = 0;
  for (const value of vector) squared += value ** 2;
  return Math.sqrt(squared);
}

function cosine(
  a: readonly number[], b: readonly number[], aNorm: number, bNorm: number,
): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return aNorm > 0 && bNorm > 0 ? dot / (aNorm * bNorm) : -1;
}

function semanticClusters(candidates: GapCandidate[], vectors: number[][], threshold: number): Cluster[] {
  const parent = candidates.map((_value, index) => index);
  const norms = vectors.map(vectorNorm);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== value) {
      const next = parent[value]!;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (cosine(
        vectors[left] ?? [], vectors[right] ?? [], norms[left] ?? 0, norms[right] ?? 0,
      ) < threshold) continue;
      const a = find(left); const b = find(right);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, GapCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), candidate]);
  });
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, members]) => ({ members }));
}

function exactClusters(candidates: GapCandidate[]): Cluster[] {
  return candidates.map((candidate) => ({ members: [candidate] }));
}

async function routeCandidatesForEmbedding(
  pool: pg.Pool,
  routing: EmbeddingRouting,
  candidates: GapCandidate[],
): Promise<{ groups: CandidateEmbeddingGroup[]; skipped: GapCandidate[] }> {
  const router = asEmbeddingRouter(routing);
  const groups = new Map<string, CandidateEmbeddingGroup>();
  const skipped: GapCandidate[] = [];
  for (const candidate of candidates) {
    // A query can cross a provider boundary only when every originally searched
    // scope is known and resolves to the same provider. Legacy, empty, missing,
    // disabled, local-only-unavailable, and mixed-provider sets stay exact-only.
    if (candidate.scopeFidelity !== 'exact' || candidate.scopeIds.length === 0) {
      skipped.push(candidate);
      continue;
    }
    const scopes = await Promise.all(candidate.scopeIds.map((scopeId) => getScope(pool, scopeId)));
    if (scopes.some((scope) => scope === null)) {
      skipped.push(candidate);
      continue;
    }
    const routes = scopes.map((scope) => router.resolve({
      kind: scope!.kind, name: scope!.name,
    }));
    const first = routes[0]?.provider;
    if (!first || routes.some((route) =>
      !route.provider || route.provider.id !== first.id || route.provider.dim !== first.dim)) {
      skipped.push(candidate);
      continue;
    }
    const key = `${first.id}\u0000${first.dim}`;
    const group = groups.get(key) ?? { provider: first, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], skipped };
}

async function embedWithDeadline(
  provider: EmbeddingProvider,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Knowledge-gap embedding exceeded ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      provider.embed(texts, { signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validateGapWorkBounds(options: GapOptions): void {
  if (!Number.isSafeInteger(options.candidateLimit)
    || options.candidateLimit < 1
    || options.candidateLimit > MAX_GAP_CLUSTER_CANDIDATES) {
    throw new ServiceError(
      'INVALID_INPUT',
      `candidateLimit must be an integer between 1 and ${MAX_GAP_CLUSTER_CANDIDATES}`,
    );
  }
  const timeoutMs = options.embeddingTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new ServiceError('INVALID_INPUT', 'embeddingTimeoutMs must be between 1 and 30000');
  }
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xD800 && last <= 0xDBFF ? truncated.slice(0, -1) : truncated;
}

function mergedCluster(cluster: Cluster) {
  const principalKeys = new Set(cluster.members.flatMap((member) => member.principalKeys));
  const variants = [...new Set(cluster.members.flatMap((member) => member.variants))]
    .sort(compareText).slice(0, 5);
  const frequency = cluster.members.reduce((sum, member) => sum + member.frequency, 0);
  const firstSeen = new Date(Math.min(...cluster.members.map((member) => member.firstSeen.getTime())));
  const lastSeen = new Date(Math.max(...cluster.members.map((member) => member.lastSeen.getTime())));
  const representative = cluster.members[0]!;
  const exactScopeSets = new Set(cluster.members.map((member) =>
    member.scopeFidelity === 'exact' ? JSON.stringify(member.scopeIds) : 'unknown'));
  const fidelity = exactScopeSets.size === 1 && !exactScopeSets.has('unknown')
    ? 'exact' as const : 'unknown' as const;
  return {
    representative: representative.representative,
    variants,
    frequency,
    distinctPrincipals: principalKeys.size,
    firstSeen,
    lastSeen,
    score: frequency * principalKeys.size,
    scopeIds: fidelity === 'exact' ? cluster.members[0]!.scopeIds : [],
    scopeFidelity: fidelity,
  };
}

export async function getKnowledgeGaps(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  principal: Principal,
  options: GapOptions,
): Promise<GapReport> {
  try {
    await requireOrgAdmin(pool, principal.id);
    validateGapWorkBounds(options);
    const embeddingTimeoutMs = options.embeddingTimeoutMs ?? 2_000;
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - options.sinceDays * 86_400_000);
    const selection = await selectGapCandidates(pool, {
      since,
      scanLimit: options.scanLimit,
      candidateLimit: options.candidateLimit,
      maxQueryChars: options.maxQueryChars,
    });
    const candidates = selection.candidates.filter((item) => item.frequency >= options.minFrequency);
    const routed = await routeCandidatesForEmbedding(pool, embeddingRouting, candidates);
    let clusters = exactClusters(routed.skipped);
    let succeededGroups = 0;
    let failedGroups = 0;
    const providerResults: GapReport['embedding']['providers'] = [];
    for (const group of routed.groups) {
      try {
        const vectors = await embedWithDeadline(
          group.provider,
          group.candidates.map((item) => item.representative),
          embeddingTimeoutMs,
        );
        const dimensions = vectors[0]?.length ?? 0;
        if (
          vectors.length !== group.candidates.length
          || dimensions === 0
          || dimensions !== group.provider.dim
          || vectors.some((vector) =>
            vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
        ) throw new Error('invalid embedding result');
        clusters.push(...semanticClusters(group.candidates, vectors, options.threshold));
        succeededGroups += 1;
        providerResults.push({
          provider: group.provider.id, dim: group.provider.dim, status: 'succeeded',
        });
      } catch {
        clusters.push(...exactClusters(group.candidates));
        failedGroups += 1;
        providerResults.push({
          provider: group.provider.id, dim: group.provider.dim, status: 'failed',
        });
      }
    }
    const attemptedGroups = routed.groups.length;
    const embeddingStatus: GapReport['embedding']['status'] = attemptedGroups === 0
      ? 'not-requested'
      : failedGroups > 0
        ? 'degraded'
        : routed.skipped.length > 0 ? 'partial' : 'succeeded';
    const embedding: GapReport['embedding'] = {
      status: embeddingStatus,
      attemptedGroups,
      succeededGroups,
      failedGroups,
      skippedCandidates: routed.skipped.length,
      providers: providerResults,
    };
    const semanticClustering = succeededGroups > 0;

    const merged = clusters.map(mergedCluster)
      .sort((a, b) => b.score - a.score
        || b.lastSeen.getTime() - a.lastSeen.getTime()
        || compareText(a.representative, b.representative))
      .slice(0, options.limit);
    const gaps: KnowledgeGap[] = [];
    for (const gap of merged) {
      // Legacy rows do not identify the scopes searched, so they cannot be
      // safely compared with current memory. Exact empty scope sets likewise
      // represent a search over no scopes and are deterministically unresolved.
      const resolved = gap.scopeFidelity === 'exact' && gap.scopeIds.length > 0
        ? await isGapCurrentlyResolved(pool, gap.representative, gap.scopeIds)
        : false;
      gaps.push({
        representative: gap.representative,
        variants: gap.variants,
        frequency: gap.frequency,
        distinctPrincipals: gap.distinctPrincipals,
        firstSeen: gap.firstSeen.toISOString(),
        lastSeen: gap.lastSeen.toISOString(),
        score: gap.score,
        resolution: { status: resolved ? 'resolved' : 'unresolved', scopeFidelity: gap.scopeFidelity },
        capture: {
          scope: { kind: 'org', name: '' },
          type: 'playbook',
          title: truncateWithoutSplittingSurrogate(`Knowledge gap: ${gap.representative}`, 500),
          body: 'Document the answer to this recurring question.',
          tags: ['knowledge-gap'],
          source: 'manual',
          metadata: { insight: 'knowledge-gap' },
        },
      });
    }

    const scopeFidelity = gaps.every((gap) => gap.resolution.scopeFidelity === 'exact')
      ? 'exact' as const : 'unknown' as const;
    const report: GapReport = {
      generatedAt: now.toISOString(),
      window: { since: since.toISOString(), days: options.sinceDays },
      parameters: {
        limit: options.limit,
        minFrequency: options.minFrequency,
        similarityThreshold: options.threshold,
        candidateLimit: options.candidateLimit,
        scanLimit: options.scanLimit,
        maxQueryChars: options.maxQueryChars,
        embeddingTimeoutMs,
      },
      candidateCount: candidates.length,
      truncated: selection.truncated || merged.length < clusters.length,
      semanticClustering,
      embedding,
      scopeFidelity,
      gaps,
    };
    await record(pool, {
      principalId: principal.id,
      action: 'read',
      metadata: {
        view: 'insights-gaps', transport: options.transport,
        resultCount: gaps.length, semanticClustering, embedding,
      },
    });
    return report;
  } catch (error) {
    throw asServiceError(error);
  }
}
