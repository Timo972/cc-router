import type { Account, RefreshResponse } from "./types.js";
import { writeAnthropicAccountsPreservingOtherProviders, serialize } from "../config/manager.js";
import { logRefresh } from "./logger.js";
import { stats } from "./stats.js";

/**
 * Official Claude Code CLI client_id for the OAuth PKCE flow.
 * Source: extracted from Claude Code auth flow.
 * Update this if Anthropic changes it in a future Claude Code version.
 */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Primary OAuth token endpoint.
 * Alternative: https://claude.ai/v1/oauth/token
 */
const TOKEN_ENDPOINT = "https://claude.ai/v1/oauth/token";

/** Refresh 10 minutes before expiry */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** Check every 5 minutes */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Exact-object locks prevent stale account incarnations from sharing work. */
const rawRefreshLocks = new Map<Account, Promise<boolean>>();
const ownedRefreshLocks = new Map<Account, Promise<boolean>>();

/** A count is required because concurrent deletion attempts may reserve the same object. */
const deletionReservations = new Map<Account, number>();

/** Rotated credentials that still need to be durably written must not rotate again. */
const pendingDurability = new WeakSet<Account>();

function isReservedForDeletion(account: Account): boolean {
  return (deletionReservations.get(account) ?? 0) > 0;
}

export function needsRefresh(account: Account): boolean {
  return ownedRefreshLocks.has(account) ||
    pendingDurability.has(account) ||
    (account.tokens.expiresAt - Date.now()) < REFRESH_BUFFER_MS;
}

export async function refreshAccountToken(account: Account): Promise<boolean> {
  // A deletion reservation rejects every new caller, including callers that
  // would otherwise attach themselves to already-running raw refresh work.
  if (isReservedForDeletion(account)) return false;

  // Deduplicate concurrent refresh calls for the same account
  const existing = rawRefreshLocks.get(account);
  if (existing) return existing;

  const promise = _doRefresh(account);
  rawRefreshLocks.set(account, promise);
  try {
    return await promise;
  } finally {
    if (rawRefreshLocks.get(account) === promise) rawRefreshLocks.delete(account);
  }
}

/** Wait for refresh work owned by this exact account incarnation, if any. */
export async function waitForAccountRefresh(account: Account): Promise<void> {
  const activeRefresh = rawRefreshLocks.get(account);
  const activeOwnedRefresh = ownedRefreshLocks.get(account);
  await Promise.allSettled(
    [activeRefresh, activeOwnedRefresh].filter(
      (promise): promise is Promise<boolean> => promise !== undefined,
    ),
  );
}

/**
 * Prevent new refreshes for an exact account object and wait for all work that
 * started before the reservation, including owned persistence, to settle.
 */
export async function reserveAccountForDeletion(account: Account): Promise<() => void> {
  deletionReservations.set(account, (deletionReservations.get(account) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (deletionReservations.get(account) ?? 1) - 1;
    if (remaining > 0) deletionReservations.set(account, remaining);
    else deletionReservations.delete(account);
  };

  try {
    await waitForAccountRefresh(account);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export interface AccountOwnershipView {
  findById(id: string): Account | null;
  getAll(): Account[];
}

export interface RefreshAccountIfCurrentOptions {
  refresh?: (account: Account) => Promise<boolean>;
  persist?: (accounts: Account[]) => void;
}

async function performOwnedRefresh(
  account: Account,
  pool: AccountOwnershipView,
  options: RefreshAccountIfCurrentOptions,
): Promise<boolean> {
  if (pool.findById(account.id) !== account) return false;

  if (pendingDurability.has(account)) {
    (options.persist ?? saveAccounts)(pool.getAll());
    pendingDurability.delete(account);
    return true;
  }

  const ok = await (options.refresh ?? refreshAccountToken)(account);
  if (!ok || pool.findById(account.id) !== account) return false;
  try {
    (options.persist ?? saveAccounts)(pool.getAll());
  } catch (error) {
    pendingDurability.add(account);
    throw error;
  }
  pendingDurability.delete(account);
  return true;
}

/**
 * Refresh and persist only while the pool still owns this exact object.
 * Production callers for the same object coalesce through persistence.
 */
export function refreshAccountIfCurrent(
  account: Account,
  pool: AccountOwnershipView,
  options: RefreshAccountIfCurrentOptions = {},
): Promise<boolean> {
  if (isReservedForDeletion(account)) return Promise.resolve(false);

  const existing = ownedRefreshLocks.get(account);
  if (existing) return existing;

  let operation!: Promise<boolean>;
  operation = (async () => {
    try {
      return await performOwnedRefresh(account, pool, options);
    } finally {
      if (ownedRefreshLocks.get(account) === operation) {
        ownedRefreshLocks.delete(account);
      }
    }
  })();
  ownedRefreshLocks.set(account, operation);
  return operation;
}

async function _doRefresh(account: Account): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.tokens.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      logRefresh(account.id, false);
      console.error(`  Status: ${res.status} — ${body}`);
      account.consecutiveErrors++;
      account.healthy = false;
      return false;
    }

    const data: RefreshResponse = await res.json() as RefreshResponse;

    // CRITICAL: refresh_token ROTATES — save the new one immediately or lose access permanently
    account.tokens.accessToken = data.access_token;
    account.tokens.refreshToken = data.refresh_token;
    account.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    account.tokens.scopes = data.scope.split(" ");
    account.healthy = true;
    account.consecutiveErrors = 0;
    account.lastRefresh = Date.now();

    stats.totalRefreshes++;
    stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "refresh" });

    const expiresInMin = Math.round(data.expires_in / 60);
    logRefresh(account.id, true, expiresInMin);
    return true;
  } catch (err) {
    logRefresh(account.id, false);
    console.error(`  Error:`, err);
    account.consecutiveErrors++;
    account.healthy = false;
    return false;
  }
}

/**
 * Persist all accounts to disk.
 * Uses atomic write (tmp + rename) to prevent corruption if process dies mid-write.
 * Must be called after every successful refresh since refresh_token ROTATES.
 */
export function saveAccounts(accounts: Account[]): void {
  writeAnthropicAccountsPreservingOtherProviders(serialize(accounts));
}

export interface RefreshAccountsOnceOptions {
  persist?: (accounts: Account[]) => void;
  onError?: (error: unknown) => void;
}

/** Run one ownership-aware scheduled refresh pass. */
export async function refreshAccountsOnce(
  accounts: Account[],
  options: RefreshAccountsOnceOptions = {},
): Promise<void> {
  const ownershipView: AccountOwnershipView = {
    findById: id => accounts.find(account => account.id === id) ?? null,
    getAll: () => accounts,
  };

  for (const account of [...accounts]) {
    if (!needsRefresh(account)) continue;
    try {
      await refreshAccountIfCurrent(account, ownershipView, {
        persist: options.persist,
      });
    } catch (error) {
      (options.onError ?? console.error)(error);
    }
  }
}

/**
 * Background refresh loop: checks every 5 minutes and refreshes any
 * token expiring within the REFRESH_BUFFER_MS window.
 */
export function startRefreshLoop(accounts: Account[]): void {
  const check = () => refreshAccountsOnce(accounts);

  // Run immediately on startup (catches already-expired tokens)
  check().catch(console.error);

  setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
}
