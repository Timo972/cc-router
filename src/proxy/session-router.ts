import type { AccountLease } from "./token-pool.js";
import { TokenPool } from "./token-pool.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_SESSION_ID_BYTES = 256;

export type RouteReason = "sticky" | "new-session" | "unscoped" | "failover";
export type ScopedRouteReason = Exclude<RouteReason, "unscoped">;

export interface UnscopedRoutedAccountLease extends AccountLease {
  readonly reason: "unscoped";
  readonly sessionId?: never;
  readonly bindingGeneration?: never;
}

export interface ScopedRoutedAccountLease extends AccountLease {
  readonly reason: ScopedRouteReason;
  readonly sessionId: string;
  readonly bindingGeneration: number;
}

export type RoutedAccountLease = UnscopedRoutedAccountLease | ScopedRoutedAccountLease;

export interface SessionRouterOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

interface SessionBinding {
  accountId: string;
  lastSeen: number;
  generation: number;
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
  private nextBindingGeneration = 1;

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
      return this.wrapUnscoped(this.pool.acquireBest(this.activeSessionCounts));
    }

    const existing = this.bindings.get(sessionId);
    if (existing) {
      const stickyLease = this.pool.tryAcquire(existing.accountId);
      if (stickyLease) {
        existing.lastSeen = now;
        return this.wrapScoped(stickyLease, "sticky", sessionId, existing.generation);
      }
      this.removeBinding(sessionId);
    }

    const lease = this.pool.acquireBest(this.activeSessionCounts);
    const binding = this.insertBinding(sessionId, lease.account.id, now);
    return this.wrapScoped(
      lease,
      existing ? "failover" : "new-session",
      sessionId,
      binding.generation,
    );
  }

  /**
   * Remove a binding only if it still belongs to the expected account. This
   * protects a new failover binding from a late response on the old account.
   */
  invalidate(
    sessionHeader: unknown,
    expectedAccountId?: string,
    expectedGeneration?: number,
  ): boolean {
    const sessionId = normalizeSessionId(sessionHeader);
    if (!sessionId) return false;
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    if (expectedAccountId !== undefined && binding.accountId !== expectedAccountId) {
      return false;
    }
    if (expectedGeneration !== undefined && binding.generation !== expectedGeneration) {
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
    this.sweepExpiredBindings(this.now());
    return this.getRawActiveSessionCount(accountId);
  }

  getBindingCount(): number {
    this.sweepExpiredBindings(this.now());
    return this.bindings.size;
  }

  /** Sweep once and expose only aggregate account IDs/counts. */
  getActiveSessionCountsSnapshot(): ReadonlyMap<string, number> {
    this.sweepExpiredBindings(this.now());
    return new Map(this.activeSessionCounts);
  }

  private wrapUnscoped(lease: AccountLease): UnscopedRoutedAccountLease {
    return {
      account: lease.account,
      fallback: lease.fallback,
      release: lease.release,
      reason: "unscoped",
    };
  }

  private wrapScoped(
    lease: AccountLease,
    reason: ScopedRouteReason,
    sessionId: string,
    bindingGeneration: number,
  ): ScopedRoutedAccountLease {
    return {
      account: lease.account,
      fallback: lease.fallback,
      release: lease.release,
      reason,
      sessionId,
      bindingGeneration,
    };
  }

  private insertBinding(
    sessionId: string,
    accountId: string,
    lastSeen: number,
  ): SessionBinding {
    if (this.bindings.size >= this.maxEntries) this.evictLeastRecentlyUsed();
    const binding = {
      accountId,
      lastSeen,
      generation: this.nextBindingGeneration++,
    };
    this.bindings.set(sessionId, binding);
    this.activeSessionCounts.set(accountId, this.getRawActiveSessionCount(accountId) + 1);
    return binding;
  }

  private removeBinding(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    this.bindings.delete(sessionId);

    const remaining = this.getRawActiveSessionCount(binding.accountId) - 1;
    if (remaining <= 0) this.activeSessionCounts.delete(binding.accountId);
    else this.activeSessionCounts.set(binding.accountId, remaining);
    return true;
  }

  private getRawActiveSessionCount(accountId: string): number {
    return this.activeSessionCounts.get(accountId) ?? 0;
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
