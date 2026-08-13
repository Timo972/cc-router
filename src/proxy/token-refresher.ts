import type { Account, RefreshResponse } from "./types.js";
import { writeAnthropicAccountsPreservingOtherProviders, serialize } from "../config/manager.js";
import { logRefresh } from "./logger.js";
import { stats } from "./stats.js";
import {
  annotateActiveSpan,
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
  withTelemetrySpan,
} from "../telemetry/facade.js";

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
const rawRefreshControllers = new Map<Account, AbortController>();
const ownedRefreshLocks = new Map<Account, Promise<boolean>>();
const rawRefreshOwners = new Map<Account, RefreshLifecycle | undefined>();
const ownedRefreshOwners = new Map<Account, RefreshLifecycle | undefined>();

interface RefreshLifecycle {
  stopping: boolean;
  settled: boolean;
}

let activeRefreshLifecycle: RefreshLifecycle | undefined;

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

export async function refreshAccountToken(account: Account, signal?: AbortSignal): Promise<boolean> {
  // A deletion reservation rejects every new caller, including callers that
  // would otherwise attach themselves to already-running raw refresh work.
  if (isReservedForDeletion(account)) return false;
  if (activeRefreshLifecycle?.stopping) return false;

  // Deduplicate concurrent refresh calls for the same account
  const existing = rawRefreshLocks.get(account);
  if (existing) {
    const unlink = linkAbortSignal(signal, rawRefreshControllers.get(account));
    try {
      return await existing;
    } finally {
      unlink();
    }
  }

  const controller = new AbortController();
  const owner = activeRefreshLifecycle;
  const unlink = linkAbortSignal(signal, controller);
  const promise = withTelemetrySpan("oauth.refresh", { provider: "anthropic" }, () => _doRefresh(account, controller.signal));
  rawRefreshLocks.set(account, promise);
  rawRefreshControllers.set(account, controller);
  rawRefreshOwners.set(account, owner);
  try {
    return await promise;
  } finally {
    if (rawRefreshLocks.get(account) === promise) rawRefreshLocks.delete(account);
    if (rawRefreshControllers.get(account) === controller) rawRefreshControllers.delete(account);
    if (rawRefreshOwners.get(account) === owner) rawRefreshOwners.delete(account);
    unlink();
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
  isCurrent?: () => boolean;
}

async function performOwnedRefresh(
  account: Account,
  pool: AccountOwnershipView,
  options: RefreshAccountIfCurrentOptions,
): Promise<boolean> {
  if (pool.findById(account.id) !== account) return false;
  if (options.isCurrent && !options.isCurrent()) return false;

  if (pendingDurability.has(account)) {
    (options.persist ?? saveAccounts)(pool.getAll());
    pendingDurability.delete(account);
    return true;
  }

  const ok = await (options.refresh ?? refreshAccountToken)(account);
  if (!ok) return false;
  pendingDurability.add(account);
  if (pool.findById(account.id) !== account || (options.isCurrent && !options.isCurrent())) return false;
  try {
    (options.persist ?? saveAccounts)(pool.getAll());
  } catch (error) {
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
  if (activeRefreshLifecycle?.stopping) return Promise.resolve(false);

  const existing = ownedRefreshLocks.get(account);
  if (existing) return existing;

  const owner = activeRefreshLifecycle;
  let operation!: Promise<boolean>;
  operation = (async () => {
    try {
      return await performOwnedRefresh(account, pool, options);
    } finally {
      if (ownedRefreshLocks.get(account) === operation) {
        ownedRefreshLocks.delete(account);
        ownedRefreshOwners.delete(account);
      }
    }
  })();
  ownedRefreshLocks.set(account, operation);
  ownedRefreshOwners.set(account, owner);
  return operation;
}

async function _doRefresh(account: Account, signal?: AbortSignal): Promise<boolean> {
  const startedAt = Date.now();
  let receivedSuccessfulResponse = false;
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
      signal,
    });
    signal?.throwIfAborted();

    if (!res.ok) {
      const body = await res.text();
      const outcome = res.status === 429 ? "rate_limited" : "upstream_error";
      annotateActiveSpan("oauth.refresh", {
        httpStatusCode: res.status,
        outcome,
        operationDurationMs: Date.now() - startedAt,
      });
      recordSafeLog({
        operation: "oauth.refresh",
        provider: "anthropic",
        reason: refreshHttpReason(res.status),
        outcome,
        httpStatusCode: res.status,
        operationDurationMs: Date.now() - startedAt,
        severity: "warn",
      });
      logRefresh(account.id, false);
      console.error(`  Status: ${res.status} — ${body}`);
      account.consecutiveErrors++;
      account.healthy = false;
      return false;
    }

    receivedSuccessfulResponse = true;
    const data: RefreshResponse = await res.json() as RefreshResponse;
    signal?.throwIfAborted();

    // CRITICAL: refresh_token ROTATES — save the new one immediately or lose access permanently
    account.tokens.accessToken = data.access_token;
    account.tokens.refreshToken = data.refresh_token;
    account.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    account.tokens.scopes = data.scope.split(" ");
    account.healthy = true;
    account.consecutiveErrors = 0;
    account.lastRefresh = Date.now();
    annotateActiveSpan("oauth.refresh", {
      outcome: "complete",
      operationDurationMs: Date.now() - startedAt,
    });

    stats.totalRefreshes++;
    stats.addLog({ ts: Date.now(), accountId: account.id, model: "-", type: "refresh" });

    const expiresInMin = Math.round(data.expires_in / 60);
    logRefresh(account.id, true, expiresInMin);
    return true;
  } catch (err) {
    if (signal?.aborted) return false;
    const expectedReason = classifyExpectedRuntimeFailure(err);
    const reason = expectedReason ?? (receivedSuccessfulResponse ? "unexpected_response_shape" : "other");
    const outcome = reason === "timeout" ? "timeout" : "upstream_error";
    recordSafeLog({
      operation: "oauth.refresh",
      provider: "anthropic",
      reason,
      outcome,
      operationDurationMs: Date.now() - startedAt,
      severity: "error",
    });
    annotateActiveSpan("oauth.refresh", {
      outcome,
      operationDurationMs: Date.now() - startedAt,
    });
    if (!expectedReason) {
      recordUnexpectedException(err, {
        category: "runtime",
        reason: "other",
        operation: "oauth.refresh",
        provider: "anthropic",
      });
    }
    logRefresh(account.id, false);
    if (expectedReason) console.error(`  Error:`, err);
    account.consecutiveErrors++;
    account.healthy = false;
    return false;
  }
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController | undefined,
): () => void {
  if (!signal || !controller) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function refreshHttpReason(status: number): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
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
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  shouldContinue?: () => boolean;
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
    if (options.signal?.aborted || (options.shouldContinue && !options.shouldContinue())) return;
    if (!needsRefresh(account)) continue;
    try {
      await refreshAccountIfCurrent(account, ownershipView, {
        persist: options.persist,
        refresh: current => refreshAccountToken(current, options.signal),
        isCurrent: options.isCurrent,
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
export interface RefreshLoopOptions extends RefreshAccountsOnceOptions {}

export function startRefreshLoop(
  accounts: Account[],
  options: RefreshLoopOptions = {},
): (deadlineMs?: number) => Promise<void> {
  if (activeRefreshLifecycle && !activeRefreshLifecycle.settled) {
    throw new Error("Anthropic refresh loop is already running");
  }
  const lifecycle: RefreshLifecycle = { stopping: false, settled: false };
  activeRefreshLifecycle = lifecycle;
  let stopped = false;
  let activePass: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  const startPass = (): void => {
    if (stopped || activePass || activeRefreshLifecycle !== lifecycle) return;
    const controller = new AbortController();
    activeController = controller;
    let operation!: Promise<void>;
    operation = refreshAccountsOnce(accounts, {
      ...options,
      signal: controller.signal,
      isCurrent: () => activeRefreshLifecycle === lifecycle,
      shouldContinue: () => !stopped && activeRefreshLifecycle === lifecycle,
    })
      .finally(() => {
        if (activePass === operation) activePass = undefined;
        if (activeController === controller) activeController = undefined;
      });
    activePass = operation;
  };

  // Run immediately on startup (catches already-expired tokens)
  startPass();

  const timer = setInterval(startPass, CHECK_INTERVAL_MS);
  let stopPromise: Promise<void> | undefined;
  return (deadlineMs = 500) => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      lifecycle.stopping = true;
      clearInterval(timer);
      const active = Promise.allSettled([
        ...(activePass ? [activePass] : []),
        ...[...rawRefreshLocks].filter(([account]) => rawRefreshOwners.get(account) === lifecycle).map(([, promise]) => promise),
        ...[...ownedRefreshLocks].filter(([account]) => ownedRefreshOwners.get(account) === lifecycle).map(([, promise]) => promise),
      ]).then(() => undefined);
      try {
        await drainRefreshPassWithin(active, deadlineMs, () => {
          activeController?.abort();
          for (const [account, controller] of rawRefreshControllers) {
            if (rawRefreshOwners.get(account) !== lifecycle) continue;
            controller.abort();
            rawRefreshLocks.delete(account);
            rawRefreshControllers.delete(account);
            rawRefreshOwners.delete(account);
          }
          for (const [account] of ownedRefreshLocks) {
            if (ownedRefreshOwners.get(account) !== lifecycle) continue;
            ownedRefreshLocks.delete(account);
            ownedRefreshOwners.delete(account);
          }
        });
      } finally {
        lifecycle.settled = true;
      }
    })();
    return stopPromise;
  };
}

async function drainRefreshPassWithin(
  active: Promise<void>,
  deadlineMs: number,
  abort: () => void,
): Promise<void> {
  const bounded = Number.isFinite(deadlineMs) ? Math.max(0, Math.min(10_000, Math.floor(deadlineMs))) : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    active.then(() => false, () => false),
    new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), bounded); }),
  ]);
  if (!timedOut) {
    clearTimeout(timer);
    return;
  }
  abort();
  await Promise.race([
    active.then(() => undefined, () => undefined),
    new Promise<void>(resolve => setTimeout(resolve, Math.min(25, bounded))),
  ]);
}
