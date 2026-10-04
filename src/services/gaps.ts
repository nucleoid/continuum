import type pg from 'pg';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { CaptureInput, Principal } from '../types.js';
import { record } from '../audit/log.js';
import {
  isGapCurrentlyResolved,
  selectGapCandidates,
  type GapCandidate,
} from '../storage/gaps.js';
import { requireOrgAdmin } from './access.js';
import { asServiceError } from './errors.js';

export interface GapOptions {
  sinceDays: number;
  limit: number;
  minFrequency: number;
  threshold: number;
  candidateLimit: number;
  scanLimit: number;
  maxQueryChars: number;
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
  };
  candidateCount: number;
  truncated: boolean;
  semanticClustering: boolean;
  scopeFidelity: 'exact' | 'unknown';
  gaps: KnowledgeGap[];
}

interface Cluster {
  members: GapCandidate[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0; let an = 0; let bn = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    an += (a[i] ?? 0) ** 2;
    bn += (b[i] ?? 0) ** 2;
  }
  return an > 0 && bn > 0 ? dot / Math.sqrt(an * bn) : -1;
}

function semanticClusters(candidates: GapCandidate[], vectors: number[][], threshold: number): Cluster[] {
  const parent = candidates.map((_value, index) => index);
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
      if (cosine(vectors[left] ?? [], vectors[right] ?? []) < threshold) continue;
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

function mergedCluster(cluster: Cluster) {
  const principalKeys = new Set(cluster.members.flatMap((member) => member.principalKeys));
  const variants = [...new Set(cluster.members.flatMap((member) => member.variants))]
    .sort(compareText).slice(0, 5);
  const frequency = cluster.members.reduce((sum, member) => sum + member.frequency, 0);
  const firstSeen = new Date(Math.min(...cluster.members.map((member) => member.firstSeen.getTime())));
  const lastSeen = new Date(Math.max(...cluster.members.map((member) => member.lastSeen.getTime())));
  const representative = cluster.members[0]!;
  const fidelity = cluster.members.every((member) => member.scopeFidelity === 'exact')
    ? 'exact' as const : 'unknown' as const;
  return {
    representative: representative.representative,
    variants,
    frequency,
    distinctPrincipals: principalKeys.size,
    firstSeen,
    lastSeen,
    score: frequency * principalKeys.size,
    scopeIds: [...new Set(cluster.members.flatMap((member) => member.scopeIds))].sort(),
    scopeFidelity: fidelity,
  };
}

export async function getKnowledgeGaps(
  pool: pg.Pool,
  provider: EmbeddingProvider | null,
  principal: Principal,
  options: GapOptions,
): Promise<GapReport> {
  try {
    await requireOrgAdmin(pool, principal.id);
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - options.sinceDays * 86_400_000);
    const selection = await selectGapCandidates(pool, {
      since,
      scanLimit: options.scanLimit,
      candidateLimit: options.candidateLimit,
      maxQueryChars: options.maxQueryChars,
    });
    const candidates = selection.candidates.filter((item) => item.frequency >= options.minFrequency);
    let clusters = exactClusters(candidates);
    let semanticClustering = false;
    if (provider && candidates.length > 0) {
      try {
        const vectors = await provider.embed(candidates.map((item) => item.representative));
        const dimensions = vectors[0]?.length ?? 0;
        if (
          vectors.length !== candidates.length
          || dimensions === 0
          || vectors.some((vector) =>
            vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
        ) throw new Error('invalid embedding result');
        clusters = semanticClusters(candidates, vectors, options.threshold);
        semanticClustering = true;
      } catch {
        clusters = exactClusters(candidates);
      }
    }

    const merged = clusters.map(mergedCluster)
      .sort((a, b) => b.score - a.score
        || b.lastSeen.getTime() - a.lastSeen.getTime()
        || compareText(a.representative, b.representative))
      .slice(0, options.limit);
    const gaps: KnowledgeGap[] = [];
    for (const gap of merged) {
      const resolved = await isGapCurrentlyResolved(
        pool, gap.representative, gap.scopeFidelity === 'exact' ? gap.scopeIds : [],
      );
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
          title: `Knowledge gap: ${gap.representative}`.slice(0, 500),
          body: 'Document the answer to this recurring question.',
          tags: ['knowledge-gap'],
          source: 'manual',
          metadata: { insight: 'knowledge-gap' },
        },
      });
    }

    const scopeFidelity = gaps.length > 0
      && gaps.every((gap) => gap.resolution.scopeFidelity === 'exact')
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
      },
      candidateCount: candidates.length,
      truncated: selection.truncated || merged.length < clusters.length,
      semanticClustering,
      scopeFidelity,
      gaps,
    };
    await record(pool, {
      principalId: principal.id,
      action: 'read',
      metadata: {
        view: 'insights-gaps', transport: options.transport,
        resultCount: gaps.length, semanticClustering,
      },
    });
    return report;
  } catch (error) {
    throw asServiceError(error);
  }
}
