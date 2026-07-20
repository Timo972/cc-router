import type { AccountLease } from "./token-pool.js";
import { TokenPool } from "./token-pool.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_SESSION_ID_BYTES = 256;

export type RouteReason = "sticky" | "new-session" | "unscoped" | "failover";

export interface RoutedAccountLease extends AccountLease {
  readonly reason: RouteReason;
  readonly sessionId?: string;
}

export interface SessionRouterOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

interface SessionBinding {
  accountId: string;
  lastSeen: number;
}

/**
 * Normalize Claude Code's session header without retaining malformed or
 * unexpectedly large values. Arrays are rejected rather than choosing one
 * value because a session must have exactly one unambiguous identity.
 */
export function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (Buffer.byteLength(normalized, "utf8") > MAX_SESSION_ID_BYTES) return undefined;
  return normalized;
}

/**
 * In-memory session affinity for Claude requests. Bindings and their counts
 * are intentionally process-local and are never exposed for persistence or
 * diagnostics.
 */
export class SessionRouter {
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly activeSessionCounts = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly pool: TokenPool,
    options: SessionRouterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("session binding TTL must be a positive finite number");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError("session binding capacity must be a positive integer");
    }
  }

  acquire(sessionHeader: unknown): RoutedAccountLease {
    const sessionId = normalizeSessionId(sessionHeader);
    const now = this.now();
    this.sweepExpiredBindings(now);

    if (!sessionId) {
      return this.wrap(this.pool.acquireBest(this.activeSessionCounts), "unscoped");
    }

    const existing = this.bindings.get(sessionId);
    if (existing) {
      const stickyLease = this.pool.tryAcquire(existing.accountId);
      if (stickyLease) {
        existing.lastSeen = now;
        return this.wrap(stickyLease, "sticky", sessionId);
      }
      this.removeBinding(sessionId);
    }

    const lease = this.pool.acquireBest(this.activeSessionCounts);
    this.insertBinding(sessionId, lease.account.id, now);
    return this.wrap(lease, existing ? "failover" : "new-session", sessionId);
  }

  /**
   * Remove a binding only if it still belongs to the expected account. This
   * protects a new failover binding from a late response on the old account.
   */
  invalidate(sessionHeader: unknown, expectedAccountId?: string): boolean {
    const sessionId = normalizeSessionId(sessionHeader);
    if (!sessionId) return false;
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    if (expectedAccountId !== undefined && binding.accountId !== expectedAccountId) {
      return false;
    }
    return this.removeBinding(sessionId);
  }

  invalidateAccount(accountId: string): number {
    let removed = 0;
    for (const [sessionId, binding] of this.bindings) {
      if (binding.accountId !== accountId) continue;
      if (this.removeBinding(sessionId)) removed++;
    }
    return removed;
  }

  getActiveSessionCount(accountId: string): number {
    return this.activeSessionCounts.get(accountId) ?? 0;
  }

  getBindingCount(): number {
    return this.bindings.size;
  }

  private wrap(
    lease: AccountLease,
    reason: RouteReason,
    sessionId?: string,
  ): RoutedAccountLease {
    return {
      account: lease.account,
      fallback: lease.fallback,
      release: lease.release,
      reason,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  private insertBinding(sessionId: string, accountId: string, lastSeen: number): void {
    if (this.bindings.size >= this.maxEntries) this.evictLeastRecentlyUsed();
    this.bindings.set(sessionId, { accountId, lastSeen });
    this.activeSessionCounts.set(accountId, this.getActiveSessionCount(accountId) + 1);
  }

  private removeBinding(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    this.bindings.delete(sessionId);

    const remaining = this.getActiveSessionCount(binding.accountId) - 1;
    if (remaining <= 0) this.activeSessionCounts.delete(binding.accountId);
    else this.activeSessionCounts.set(binding.accountId, remaining);
    return true;
  }

  private sweepExpiredBindings(now: number): void {
    for (const [sessionId, binding] of this.bindings) {
      if (now - binding.lastSeen >= this.ttlMs) this.removeBinding(sessionId);
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldestSessionId: string | undefined;
    let oldestLastSeen = Infinity;

    // Map iteration order is insertion order, so equal timestamps retain the
    // first entry as the deterministic eviction candidate.
    for (const [sessionId, binding] of this.bindings) {
      if (binding.lastSeen < oldestLastSeen) {
        oldestSessionId = sessionId;
        oldestLastSeen = binding.lastSeen;
      }
    }

    if (oldestSessionId !== undefined) this.removeBinding(oldestSessionId);
  }
}
