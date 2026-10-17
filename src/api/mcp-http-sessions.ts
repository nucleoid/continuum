import { createHmac, randomBytes } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../types.js';
interface Limits {
  sessions: number; principalSessions: number; calls: number; principalCalls: number;
  outputBytes?: number; idleMs: number; lifetimeMs: number; messageRate: number; messageBurst: number;
  proxyRate?: number; proxyBurst?: number; proxyInitializeRate?: number; proxyInitializeBurst?: number; unsettledGraceMs?: number; buckets: number; peerRate: number; peerBurst: number; peers: number; streams: number;
}
interface Bucket { tokens: number; updated: number }
const retainedExecutions = new Map<string, number>();
let retainedCalls = 0;
let retainedResponseBytes = 0;
const cancelledFences = new Map<symbol, number>();
export type ExecutionRelease = (() => void) & { markUnsettled(deadline?: number): void };
export class McpHttpSessions {
  private readonly key = randomBytes(32);
  private readonly principals = new Map<string, number>();
  private readonly executing = retainedExecutions;
  private readonly buckets = new Map<string, Bucket>();
  private readonly peers = new Map<string, Bucket>();
  private reservations = 0;
  private streams = 0;
  constructor(readonly limits: Limits, private readonly now: () => number = Date.now) {}
  binding(auth: Pick<AuthenticatedPrincipal, 'principal' | 'credential' | 'allowedSource'> | {
    principal: { id: string; kind: string }; credential: string; allowedSource?: string;
  }, credential: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([
      auth.principal.id, auth.principal.kind, auth.credential, credential, auth.allowedSource ?? null,
    ])).digest('hex');
  }
  credentialTag(credential: string): string { return createHmac('sha256', this.key).update(credential).digest('hex'); }
  correlation(id: string): string { return createHmac('sha256', this.key).update(id).digest('hex').slice(0, 24); }
  private reserveCounter(map: Map<string, number>, principal: string, max: number): (() => void) | undefined {
    if ((map.get(principal) ?? 0) >= max) return;
    map.set(principal, (map.get(principal) ?? 0) + 1);
    let active = true;
    return () => { if (!active) return; active = false;
      const next = map.get(principal)! - 1;
      if (next) map.set(principal, next); else map.delete(principal);
    };
  }
  reserve(principal: string): (() => void) | undefined {
    if (this.reservations >= this.limits.sessions) return;
    const release = this.reserveCounter(this.principals, principal, this.limits.principalSessions);
    if (!release) return;
    this.reservations++;
    let active = true;
    return () => { if (!active) return; active = false; this.reservations--; release(); };
  }
  reserveCall(principal: string): ExecutionRelease | undefined {
    if (retainedCalls >= this.limits.calls) return;
    const release = this.reserveCounter(this.executing, principal, this.limits.principalCalls);
    if (!release) return;
    retainedCalls++;
    let active = true;
    const fence = Symbol();
    const releaseExecution = () => { if (!active) return; active = false;
      retainedCalls--; cancelledFences.delete(fence); release(); };
    releaseExecution.markUnsettled = (deadline = this.now()) => { if (!active || cancelledFences.has(fence)) return; cancelledFences.set(fence, deadline + (this.limits.unsettledGraceMs ?? 5000)); };
    return releaseExecution;
  }
  reserveResponse(bytes: number): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || retainedResponseBytes + bytes > (this.limits.outputBytes ?? 1048576)) return;
    retainedResponseBytes += bytes;
    let active = true;
    return () => { if (!active) return; active = false; retainedResponseBytes -= bytes; };
  }
  reserveStream(): (() => void) | undefined {
    if (this.streams >= this.limits.streams) return;
    this.streams++;
    let active = true;
    return () => { if (!active) return; active = false; this.streams--; };
  }
  private take(map: Map<string, Bucket>, key: string, count: number, rate: number, burst: number, cap: number, consume = true): boolean {
    const now = this.now();
    // Eviction only after a full refill preserves the original admission history.
    for (const [id, bucket] of map) if (now - bucket.updated >= burst * 60_000 / rate) map.delete(id);
    let bucket = map.get(key);
    if (!bucket) {
      if (map.size >= cap) return false;
      bucket = { tokens: burst, updated: now }; map.set(key, bucket);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.updated) * rate / 60_000);
    bucket.updated = now;
    if (count > bucket.tokens) return false;
    if (consume) bucket.tokens -= count; return true;
  }
  admit(key: string, count: number): boolean {
    return this.take(this.buckets, key, count, this.limits.messageRate, this.limits.messageBurst, this.limits.buckets);
  }
  admitAll(entries: ReadonlyArray<readonly [key: string, count: number]>): boolean {
    const now = this.now();
    const { messageRate: rate, messageBurst: burst, buckets: cap } = this.limits;
    // Expired buckets no longer carry admission history and may be reclaimed before the atomic probe.
    for (const [id, bucket] of this.buckets) if (now - bucket.updated >= burst * 60_000 / rate) this.buckets.delete(id);
    const counts = new Map<string, number>();
    for (const [key, count] of entries) counts.set(key, (counts.get(key) ?? 0) + count);
    let missing = 0;
    for (const key of counts.keys()) if (!this.buckets.has(key)) missing++;
    if (this.buckets.size + missing > cap) return false;
    const admitted = new Map<string, Bucket>();
    for (const [key, count] of counts) {
      const current = this.buckets.get(key);
      const tokens = current
        ? Math.min(burst, current.tokens + Math.max(0, now - current.updated) * rate / 60_000)
        : burst;
      if (count > tokens) return false;
      admitted.set(key, { tokens: tokens - count, updated: now });
    }
    for (const [key, bucket] of admitted) this.buckets.set(key, bucket);
    return true;
  }
  admitPeer(peer: string): boolean {
    return this.take(this.peers, peer, 1, this.limits.peerRate, this.limits.peerBurst, this.limits.peers);
  }
  admitProxy(peer: string): boolean {
    return this.take(this.peers, `proxy:${peer}`, 1, this.limits.proxyRate ?? 6000,
      this.limits.proxyBurst ?? 1000, this.limits.peers);
  }
  proxyAvailable(peer: string): boolean {
    return this.take(this.peers, `proxy:${peer}`, 1, this.limits.proxyRate ?? 6000, this.limits.proxyBurst ?? 1000, this.limits.peers, false);
  }
  admitProxyInitialize(peer: string): boolean {
    return this.take(this.peers, `initialize:${peer}`, 1, this.limits.proxyInitializeRate ?? 6, this.limits.proxyInitializeBurst ?? 2, this.limits.peers);
  }
  clear(): void { this.buckets.clear(); this.peers.clear(); }
  isHealthy(): boolean { return [...cancelledFences.values()].filter((deadline) => this.now() >= deadline).length < this.limits.calls; }
  get unsettled(): number { return retainedCalls; }
}
