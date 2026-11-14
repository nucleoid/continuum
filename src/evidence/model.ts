import type { EvidenceArtifactKind, EvidencePolicy } from './policy.js';

export const EVIDENCE_LIMITS = Object.freeze({ parents: 64, roots: 256, depth: 16, payloadBytes: 1_048_576, page: 100, maxPage: 1000 });
export type ManagedEvidenceKind = Exclude<EvidenceArtifactKind, 'connector-evidence' | 'connector-receipt'>;
export type EvidenceEdgeKind = 'source' | 'assertion' | 'derivation' | 'copy';
export interface EvidenceParent { versionId: string; kind: EvidenceEdgeKind }
export interface EvidenceRegistration {
  nodeId: string;
  expectedCurrent: string | null;
  scopeId: string;
  kind: Exclude<ManagedEvidenceKind, 'source-document-version'>;
  parents: readonly EvidenceParent[];
  identity: { transform: string; model: string; prompt: string; schema: string };
  payload: string;
}
/** Metadata only. Resolved under locks by the current owned transaction. */
export interface EvidenceEnvelope {
  now: number; kind: ManagedEvidenceKind; scopeId: string; expiresAt: number | null;
  policies: EvidencePolicy[]; bytes: number;
}

/** Trusted composition declares payload ownership. All managed bytes, including
 * caches, history, traces, exports and queued snapshots, live in the same
 * erasable payload table. No callbacks, credentials or contributed registry. */
export class EvidencePayloadRegistry {
  private readonly validators = new Map<ManagedEvidenceKind, (payload: string) => boolean>();
  register(kind: ManagedEvidenceKind, validate: (payload: string) => boolean): void {
    if (!['source-document-version', 'extracted-assertion', 'derived-observation', 'brief-section-version', 'history', 'cache', 'trace', 'managed-export', 'queued-payload'].includes(kind)
      || this.validators.has(kind)) throw new TypeError('Unsupported or duplicate evidence payload owner');
    this.validators.set(kind, validate);
  }
  supports(kind: ManagedEvidenceKind): boolean { return this.validators.has(kind); }
  accepts(kind: ManagedEvidenceKind, payload: string): boolean {
    return Buffer.byteLength(payload, 'utf8') <= EVIDENCE_LIMITS.payloadBytes && this.validators.get(kind)?.(payload) === true;
  }
}
