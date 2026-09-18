import { createHash } from "node:crypto";
import { fetchAccountInfo, type AccountInfoSource, type AccountInfoFetchOptions } from "../providers/account-info-fetch.js";
import { sanitizeAccountInfo, type AccountInfo } from "../providers/account-info.js";
import { canReadProfile } from "../providers/anthropic/scopes.js";

const TTL_MS = 5 * 60_000;
const RETRY_MS = 60_000;
interface Entry { fingerprint: string; attemptedAt?: number; info?: AccountInfo }
const key = (account: AccountInfoSource) => `${account.provider}:${account.id}`;
const fingerprint = (account: AccountInfoSource) => createHash("sha256").update(account.accessToken).digest("hex");
const unavailable = (): AccountInfo => ({ accountType: "unknown", fetchStatus: "unavailable" });

/** Ephemeral private metadata, isolated from persisted credentials and routing state. */
export class AccountInfoCache {
  private entries = new Map<string, Entry>();
  private inFlight?: Promise<void>;
  private pendingForced?: Promise<void>;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly fetchInfo: (account: AccountInfoSource, options: AccountInfoFetchOptions) => Promise<AccountInfo | undefined>;

  constructor(
    private readonly accounts: () => AccountInfoSource[],
    options: { now?: () => number; fetchInfo?: (account: AccountInfoSource, options: AccountInfoFetchOptions) => Promise<AccountInfo | undefined> } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetchInfo = options.fetchInfo ?? fetchAccountInfo;
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, RETRY_MS);
    this.timer.unref();
  }

  get(account: AccountInfoSource): AccountInfo {
    const entry = this.entries.get(key(account));
    if (!entry || entry.fingerprint !== fingerprint(account) || !entry.info) return unavailable();
    const info = sanitizeAccountInfo(entry.info)!;
    if (!info.fetchedAt || this.now() - info.fetchedAt >= TTL_MS || account.expiresAt <= this.now()) info.fetchStatus = "stale";
    return info;
  }

  refresh(force = false): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.inFlight) {
      if (!force) return this.inFlight;
      // A token refresh or account addition may have happened after the active
      // pass took its snapshot. One queued pass observes the current sources.
      this.pendingForced ??= this.inFlight.then(() => {
        this.pendingForced = undefined;
        return this.refresh(true);
      });
      return this.pendingForced;
    }
    const operation = this.run(force).catch(() => {
      // Storage may disappear during a refresh. Do not report credential errors.
    }).finally(() => { if (this.inFlight === operation) this.inFlight = undefined; });
    this.inFlight = operation;
    return operation;
  }

  private async run(force: boolean): Promise<void> {
    const accounts = this.accounts();
    const liveKeys = new Set(accounts.map(key));
    for (const id of this.entries.keys()) if (!liveKeys.has(id)) this.entries.delete(id);
    const queue = accounts.filter(account => {
      const id = key(account);
      const digest = fingerprint(account);
      let entry = this.entries.get(id);
      if (entry?.fingerprint !== digest) {
        entry = { fingerprint: digest };
        this.entries.set(id, entry);
      }
      const ttl = entry.info?.fetchStatus === "fresh" ? TTL_MS : RETRY_MS;
      // An inference-only Claude credential cannot read the profile endpoint;
      // fetching would only ever produce a 403. Other providers are never gated.
      return this.canFetch(account)
        && (force || entry.attemptedAt === undefined || this.now() - entry.attemptedAt >= ttl);
    });
    const worker = async () => {
      while (!this.controller.signal.aborted) {
        const account = queue.shift();
        if (!account) break;
        await this.fetchOne(account);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  /**
   * Refresh one account's metadata now, leaving every other account alone.
   * The per-account refresh endpoint uses this: a whole-cache `refresh(true)`
   * from one dashboard keypress would hit every provider's profile endpoint
   * for the entire fleet. Unknown, disabled, expired and inference-only
   * accounts are skipped exactly as the scheduled pass skips them.
   */
  async refreshOne(target: { id: string; provider: AccountInfoSource["provider"] }): Promise<void> {
    if (this.controller.signal.aborted) return;
    const account = this.accounts().find(row => row.id === target.id && row.provider === target.provider);
    if (!account || !this.canFetch(account)) return;
    const id = key(account);
    const digest = fingerprint(account);
    if (this.entries.get(id)?.fingerprint !== digest) this.entries.set(id, { fingerprint: digest });
    await this.fetchOne(account);
  }

  /** Eligibility shared by the scheduled pass and `refreshOne`. */
  private canFetch(account: AccountInfoSource): boolean {
    // An inference-only Claude credential cannot read the profile endpoint;
    // fetching would only ever produce a 403. Other providers are never gated.
    return account.enabled !== false && account.expiresAt > this.now()
      && (account.provider !== "anthropic_subscription" || canReadProfile(account.scopes));
  }

  private async fetchOne(account: AccountInfoSource): Promise<void> {
    // Re-check presence/credentials before network I/O after time spent queued.
    const current = this.accounts().find(row => key(row) === key(account));
    if (!current || current.enabled === false || current.expiresAt <= this.now() || fingerprint(current) !== fingerprint(account)) return;
    const entry = this.entries.get(key(account));
    if (!entry) return;
    entry.attemptedAt = this.now();
    let info: AccountInfo | undefined;
    try { info = await this.fetchInfo(account, { signal: this.controller.signal, now: this.now }); } catch { /* best effort */ }
    const latest = this.accounts().find(row => key(row) === key(account));
    if (this.controller.signal.aborted || !latest || fingerprint(latest) !== entry.fingerprint) return;
    const safe = sanitizeAccountInfo(info);
    if (safe && (safe.fetchStatus === "fresh" || !entry.info)) entry.info = safe;
    else if (entry.info) entry.info = { ...entry.info, fetchStatus: "stale" };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    this.entries.clear();
  }
}
