import type { Account, AccountUsageSnapshot } from "../../proxy/types.js";
import {
  annotateActiveSpan,
  recordSafeLog,
  recordUnexpectedException,
  withTelemetrySpan,
} from "../../telemetry/facade.js";
import { fetchAnthropicUsage, type UsageFetchResult } from "./usage.js";

const SUCCESS_REFRESH_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const DEFAULT_STARTUP_STAGGER_MS = 250;
const MAX_CONCURRENT_REFRESHES = 2;
const RECONCILE_INTERVAL_MS = 60_000;

export interface UsageAccountPool {
  getAll(): Account[];
  findById(id: string): Account | null;
}

export interface AnthropicUsageRefresherOptions {
  fetchUsage?: (account: Account) => Promise<UsageFetchResult>;
  now?: () => number;
  startupStaggerMs?: number;
  maxConcurrent?: number;
}

/**
 * Schedules bounded usage refreshes without becoming a source of routing or
 * health traffic. Account identity, rather than ID alone, owns both work and
 * result application so an account replacement cannot receive stale data.
 */
export class AnthropicUsageRefresher {
  private readonly fetchUsage: (account: Account) => Promise<UsageFetchResult>;
  private readonly now: () => number;
  private readonly startupStaggerMs: number;
  private readonly maxConcurrent: number;
  private readonly timers = new Map<Account, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<Account, Promise<UsageFetchResult>>();
  private readonly resolvers = new Map<Account, (result: UsageFetchResult) => void>();
  private readonly queued = new Set<Account>();
  private readonly failures = new Map<Account, number>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private active = 0;
  private started = false;
  private stopped = false;

  constructor(
    private readonly pool: UsageAccountPool,
    options: AnthropicUsageRefresherOptions = {},
  ) {
    this.fetchUsage = options.fetchUsage ?? fetchAnthropicUsage;
    this.now = options.now ?? Date.now;
    this.startupStaggerMs = Math.max(0, options.startupStaggerMs ?? DEFAULT_STARTUP_STAGGER_MS);
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? MAX_CONCURRENT_REFRESHES));
  }

  /** Begin staggered startup work for the accounts currently in the pool. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.reconcile(true);
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
  }

  /** Cancel scheduled work. In-flight calls may settle, but cannot reschedule. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const account of this.queued) {
      this.resolvers.get(account)?.({ ok: false, reason: "network" });
      this.resolvers.delete(account);
      this.inFlight.delete(account);
    }
    this.queued.clear();
  }

  /** Join or initiate the one usage refresh owned by this exact account object. */
  refreshNow(account: Account): Promise<UsageFetchResult> {
    const existing = this.inFlight.get(account);
    if (existing) return existing;
    if (this.stopped) return Promise.resolve({ ok: false, reason: "network" });

    const scheduled = this.timers.get(account);
    if (scheduled) {
      clearTimeout(scheduled);
      this.timers.delete(account);
    }

    let resolve!: (result: UsageFetchResult) => void;
    const pending = new Promise<UsageFetchResult>(done => { resolve = done; });
    this.inFlight.set(account, pending);
    this.resolvers.set(account, resolve);
    this.queued.add(account);
    this.runQueued();
    return pending;
  }

  /** Start a refresh after any request that was already in flight at call time. */
  refreshAfterCurrent(account: Account): Promise<UsageFetchResult> {
    const existing = this.inFlight.get(account);
    return existing
      ? existing.then(() => this.refreshNow(account))
      : this.refreshNow(account);
  }

  private reconcile(startup = false): void {
    if (!this.started) return;
    const accounts = this.pool.getAll();
    const current = new Set(accounts);

    for (const [account, timer] of this.timers) {
      if (!current.has(account)) {
        clearTimeout(timer);
        this.timers.delete(account);
      }
    }
    for (const account of [...this.queued]) {
      if (!current.has(account)) {
        this.queued.delete(account);
        this.resolvers.get(account)?.({ ok: false, reason: "network" });
        this.resolvers.delete(account);
        this.inFlight.delete(account);
      }
    }
    for (const account of this.failures.keys()) {
      if (!current.has(account)) this.failures.delete(account);
    }

    accounts.forEach((account, index) => {
      if (!this.timers.has(account) && !this.inFlight.has(account) && !this.queued.has(account)) {
        if (startup) this.schedule(account, index * this.startupStaggerMs);
        else void this.refreshNow(account);
      }
    });
  }

  private schedule(account: Account, delayMs: number): void {
    if (!this.started || this.pool.findById(account.id) !== account) return;
    const timer = setTimeout(() => {
      this.timers.delete(account);
      this.reconcile();
      void this.refreshNow(account);
    }, delayMs);
    this.timers.set(account, timer);
  }

  private runQueued(): void {
    while (this.active < this.maxConcurrent) {
      const account = this.queued.values().next().value as Account | undefined;
      if (!account) return;
      this.queued.delete(account);
      if (this.pool.findById(account.id) !== account) {
        this.resolvers.get(account)?.({ ok: false, reason: "network" });
        this.resolvers.delete(account);
        this.inFlight.delete(account);
        continue;
      }
      this.startRequest(account);
    }
  }

  private startRequest(account: Account): void {
    this.active++;
    const operation = this.inFlight.get(account);
    const resolve = this.resolvers.get(account);
    if (!operation || !resolve) {
      this.active--;
      return;
    }
    void (async () => {
      const startedAt = this.now();
      const result = await withTelemetrySpan("provider.usage_refresh", {
        provider: "anthropic",
        accountPoolSize: this.pool.getAll().length,
        concurrency: this.active,
      }, async (): Promise<UsageFetchResult> => {
        try {
          const fetched = await this.fetchUsage(account);
          const duration = Math.max(0, this.now() - startedAt);
          const outcome = usageOutcome(fetched);
          annotateActiveSpan("provider.usage_refresh", {
            outcome,
            httpStatusCode: fetched.ok ? undefined : fetched.status,
            operationDurationMs: duration,
          });
          if (!fetched.ok) {
            recordSafeLog({
              operation: "provider.usage_refresh",
              provider: "anthropic",
              reason: usageReason(fetched),
              outcome,
              httpStatusCode: fetched.status,
              accountPoolSize: this.pool.getAll().length,
              concurrency: this.active,
              operationDurationMs: duration,
              severity: "warn",
            });
          }
          return fetched;
        } catch (error) {
          const duration = Math.max(0, this.now() - startedAt);
          annotateActiveSpan("provider.usage_refresh", {
            outcome: "upstream_error",
            operationDurationMs: duration,
          });
          recordSafeLog({
            operation: "provider.usage_refresh",
            provider: "anthropic",
            reason: "other",
            outcome: "upstream_error",
            accountPoolSize: this.pool.getAll().length,
            concurrency: this.active,
            operationDurationMs: duration,
            severity: "error",
          });
          recordUnexpectedException(error, {
            category: "runtime",
            reason: "other",
            operation: "provider.usage_refresh",
            provider: "anthropic",
          });
          return { ok: false, reason: "network" };
        }
      });

      if (this.pool.findById(account.id) === account) {
        this.apply(account, result);
        if (this.started) this.schedule(account, this.nextDelay(account, result));
      }
      if (this.inFlight.get(account) === operation) this.inFlight.delete(account);
      this.resolvers.delete(account);
      this.active--;
      resolve(result);
      this.reconcile();
      this.runQueued();
    })();
  }

  private apply(account: Account, result: UsageFetchResult): void {
    if (result.ok) {
      this.failures.delete(account);
      account.rateLimits = { ...account.rateLimits, usage: result.snapshot };
      return;
    }

    this.failures.set(account, (this.failures.get(account) ?? 0) + 1);
    const prior = account.rateLimits.usage;
    const usage: AccountUsageSnapshot = prior
      ? { ...prior, fetchStatus: "stale" }
      : { modelLimits: [], fetchedAt: this.now(), fetchStatus: "unavailable" };
    account.rateLimits = { ...account.rateLimits, usage };
  }

  private nextDelay(account: Account, result: UsageFetchResult): number {
    if (result.ok) return SUCCESS_REFRESH_MS;
    const failures = this.failures.get(account) ?? 1;
    return FAILURE_BACKOFF_MS[Math.min(failures - 1, FAILURE_BACKOFF_MS.length - 1)];
  }
}

function usageOutcome(result: UsageFetchResult): "complete" | "rate_limited" | "timeout" | "upstream_error" {
  if (result.ok) return "complete";
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "http" && result.status === 429) return "rate_limited";
  return "upstream_error";
}

function usageReason(result: Exclude<UsageFetchResult, { ok: true }>): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" | "timeout" | "network_failure" | "unexpected_response_shape" {
  if (result.reason === "timeout") return "timeout";
  if (result.reason === "network") return "network_failure";
  if (result.reason === "invalid_json" || result.reason === "invalid_schema") {
    return "unexpected_response_shape";
  }
  if (result.status === 401) return "unauthorized";
  if (result.status === 403) return "forbidden";
  if (result.status === 429) return "rate_limited";
  return (result.status ?? 500) >= 500 ? "upstream_5xx" : "upstream_4xx";
}
