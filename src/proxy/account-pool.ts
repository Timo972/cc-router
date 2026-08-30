import type { RouteContext } from "./types.js";

/** Minimal account shape every pool implementation must expose. */
export interface PoolAccount {
  readonly id: string;
}

export interface AccountLease<TAccount extends PoolAccount = PoolAccount> {
  readonly account: TAccount;
  /** True when user caps were bypassed because every eligible account was capped. */
  readonly fallback: boolean;
  release(): void;
}

/** The contract SessionRouter needs from a provider pool. */
export interface AccountPool<TAccount extends PoolAccount = PoolAccount> {
  acquireBest(
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): AccountLease<TAccount>;
  tryAcquire(accountId: string, context?: RouteContext): AccountLease<TAccount> | null;
}

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

export class NoEligibleAccountError extends Error {
  readonly reason: "rate_limited" | "unavailable";
  readonly retryAtMs?: number;
  readonly blockedAccounts: number;

  constructor(
    reason: "rate_limited" | "unavailable",
    blockedAccounts: number,
    retryAtMs?: number,
  ) {
    super("no account is currently eligible for routing");
    this.name = "NoEligibleAccountError";
    this.reason = reason;
    this.blockedAccounts = blockedAccounts;
    if (retryAtMs !== undefined) this.retryAtMs = retryAtMs;
  }
}
