const SUCCESS_REFRESH_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const DEFAULT_STARTUP_STAGGER_MS = 250;
const MAX_CONCURRENT_REFRESHES = 2;
const RECONCILE_INTERVAL_MS = 60_000;

export interface RefreshableAccountPool<TAccount extends { id: string }> {
  getAll(): TAccount[];
  findById(id: string): TAccount | null;
}

export interface UsageRefresherHooks<TAccount extends { id: string }, TResult extends { ok: boolean }> {
  /** Fetch this account's usage. Must not throw for expected failures — the
   *  scheduler treats a throw like `cancelledResult()`. */
  fetchUsage(account: TAccount): Promise<TResult>;
  /** Apply a settled result to the account — both success and failure shapes.
   *  Called only while the account object is still the pool's current one. */
  applyResult(account: TAccount, result: TResult): void;
  /** The result handed to waiters when a refresh is cancelled without running
   *  (refresher stopped, or the account left the pool). */
  cancelledResult(): TResult;
  now?: () => number;
  startupStaggerMs?: number;
  maxConcurrent?: number;
}

/**
 * Schedules bounded usage refreshes without becoming a source of routing or
 * health traffic. Account identity, rather than ID alone, owns both work and
 * result application so an account replacement cannot receive stale data.
 * Provider-agnostic: what "usage" is and how a result lands on the account
 * comes in through the hooks (see AnthropicUsageRefresher /
 * OpenAIUsageRefresher).
 */
export class UsageRefresher<TAccount extends { id: string }, TResult extends { ok: boolean }> {
  private readonly now: () => number;
  private readonly startupStaggerMs: number;
  private readonly maxConcurrent: number;
  private readonly timers = new Map<TAccount, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<TAccount, Promise<TResult>>();
  private readonly resolvers = new Map<TAccount, (result: TResult) => void>();
  private readonly queued = new Set<TAccount>();
  private readonly failures = new Map<TAccount, number>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private active = 0;
  private started = false;
  private stopped = false;

  constructor(
    private readonly pool: RefreshableAccountPool<TAccount>,
    private readonly hooks: UsageRefresherHooks<TAccount, TResult>,
  ) {
    this.now = hooks.now ?? Date.now;
    this.startupStaggerMs = Math.max(0, hooks.startupStaggerMs ?? DEFAULT_STARTUP_STAGGER_MS);
    this.maxConcurrent = Math.max(1, Math.floor(hooks.maxConcurrent ?? MAX_CONCURRENT_REFRESHES));
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
      this.resolvers.get(account)?.(this.hooks.cancelledResult());
      this.resolvers.delete(account);
      this.inFlight.delete(account);
    }
    this.queued.clear();
  }

  /** Join or initiate the one usage refresh owned by this exact account object. */
  refreshNow(account: TAccount): Promise<TResult> {
    const existing = this.inFlight.get(account);
    if (existing) return existing;
    if (this.stopped) return Promise.resolve(this.hooks.cancelledResult());

    const scheduled = this.timers.get(account);
    if (scheduled) {
      clearTimeout(scheduled);
      this.timers.delete(account);
    }

    let resolve!: (result: TResult) => void;
    const pending = new Promise<TResult>(done => { resolve = done; });
    this.inFlight.set(account, pending);
    this.resolvers.set(account, resolve);
    this.queued.add(account);
    this.runQueued();
    return pending;
  }

  /** Start a refresh after any request that was already in flight at call time. */
  refreshAfterCurrent(account: TAccount): Promise<TResult> {
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
        this.resolvers.get(account)?.(this.hooks.cancelledResult());
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

  private schedule(account: TAccount, delayMs: number): void {
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
      const account = this.queued.values().next().value as TAccount | undefined;
      if (!account) return;
      this.queued.delete(account);
      if (this.pool.findById(account.id) !== account) {
        this.resolvers.get(account)?.(this.hooks.cancelledResult());
        this.resolvers.delete(account);
        this.inFlight.delete(account);
        continue;
      }
      this.startRequest(account);
    }
  }

  private startRequest(account: TAccount): void {
    this.active++;
    const operation = this.inFlight.get(account);
    const resolve = this.resolvers.get(account);
    if (!operation || !resolve) {
      this.active--;
      return;
    }
    void (async () => {
      let result: TResult;
      try {
        result = await this.hooks.fetchUsage(account);
      } catch {
        result = this.hooks.cancelledResult();
      }

      if (this.pool.findById(account.id) === account) {
        if (result.ok) this.failures.delete(account);
        else this.failures.set(account, (this.failures.get(account) ?? 0) + 1);
        this.hooks.applyResult(account, result);
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

  private nextDelay(account: TAccount, result: TResult): number {
    if (result.ok) return SUCCESS_REFRESH_MS;
    const failures = this.failures.get(account) ?? 1;
    return FAILURE_BACKOFF_MS[Math.min(failures - 1, FAILURE_BACKOFF_MS.length - 1)];
  }
}
