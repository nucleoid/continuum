/** Operational reference data only. No caller text, source IDs or raw errors. */
export type BudgetReason = 'budget_exhausted' | 'capability_unavailable' | 'pricing_unavailable'
  | 'deadline' | 'cancelled' | 'provider_failed' | 'invalid_response' | 'policy_denied' | 'stale_attempt' | 'credentials_unavailable';
export type UsageProvenance = 'measured' | 'provider-reported' | 'estimated' | 'unknown';
export interface BudgetReceipt {
  event: 'reserved' | 'settled' | 'skipped';
  reason?: BudgetReason;
  elapsedMs: number;
  provenance?: UsageProvenance;
}
const reasons = new Set<BudgetReason>(['budget_exhausted', 'capability_unavailable', 'pricing_unavailable',
  'deadline', 'cancelled', 'provider_failed', 'invalid_response', 'policy_denied', 'stale_attempt', 'credentials_unavailable']);
const provenances = new Set<UsageProvenance>(['measured', 'provider-reported', 'estimated', 'unknown']);
export const FAILURE_RECEIPT_BYTES = 512;
export const MAX_RECEIPT_BYTES = 4096;

export class BudgetReceipts {
  private readonly entries: Readonly<BudgetReceipt>[] = [];
  private bytes = 2;
  private failure?: Readonly<BudgetReceipt>;
  constructor(readonly maxBytes: number) {}
  add(receipt: BudgetReceipt): void {
    // Project a fixed schema even for untyped in-process callers.
    const entry = Object.freeze({
      event: (['reserved', 'settled', 'skipped'] as const).includes(receipt.event) ? receipt.event : 'skipped' as const,
      elapsedMs: Number.isSafeInteger(receipt.elapsedMs) && receipt.elapsedMs >= 0 ? receipt.elapsedMs : 0,
      ...(receipt.reason && reasons.has(receipt.reason) ? { reason: receipt.reason } : {}),
      ...(receipt.provenance && provenances.has(receipt.provenance) ? { provenance: receipt.provenance } : {}),
    });
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.entries.length < 31 && this.bytes + size <= this.maxBytes - FAILURE_RECEIPT_BYTES) {
      this.entries.push(entry); this.bytes += size;
    } else if (entry.event === 'skipped') this.failure = entry;
  }
  snapshot(): readonly Readonly<BudgetReceipt>[] {
    return Object.freeze([...this.entries, ...(this.failure ? [this.failure] : [])]);
  }
}
