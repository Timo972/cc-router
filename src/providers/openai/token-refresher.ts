import type { ProviderAccount } from "../types.js";
import { decodeOpenAIPlan } from "./usage.js";
import {
  annotateActiveSpan,
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
  withTelemetrySpan,
} from "../../telemetry/facade.js";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<boolean>>();
const refreshControllers = new Map<string, AbortController>();
const rawRefreshOwners = new Map<string, RefreshLifecycle | undefined>();
const ownedRefreshLocks = new Set<Promise<boolean>>();
const ownedRefreshOwners = new Map<Promise<boolean>, RefreshLifecycle | undefined>();

interface RefreshLifecycle {
  stopping: boolean;
  settled: boolean;
}

let activeRefreshLifecycle: RefreshLifecycle | undefined;

/**
 * Accounts whose most recently rotated credentials have NOT been confirmed
 * on disk. Identity-keyed (by object reference, not `account.id`) so a
 * deleted-then-re-added account can never inherit another object's dirty
 * state just because it reused the same id, and a `WeakSet` so an account
 * that's later removed from the pool can't leak here.
 */
const pendingCredentialWrites = new WeakSet<OpenAISubscriptionAccount>();

/** True when `account` has a rotated credential that has not yet been durably persisted. */
export function hasPendingCredentialWrite(account: OpenAISubscriptionAccount): boolean {
  return pendingCredentialWrites.has(account);
}

/**
 * Record that every account in `accounts` has reached disk.
 *
 * A whole-pool write makes all of them durable, not just whichever account
 * prompted it — and those writes do not all come from a refresh. Adding,
 * patching, or deleting an account rewrites the same file from the same live
 * array, so a rotation that failed to persist earlier is on disk once any of
 * those succeed. Without this, health keeps reporting `credentialsPendingWrite`
 * for an account whose credentials are already saved, and later requests keep
 * retrying a write that has already landed.
 *
 * Call it only after the write has actually returned.
 */
export function markOpenAICredentialsPersisted(accounts: OpenAISubscriptionAccount[]): void {
  for (const account of accounts) pendingCredentialWrites.delete(account);
}

/**
 * Centralizes every write of the account pool to disk so every caller shares
 * the same durability bookkeeping: on success, clears the account's pending
 * flag; on a throw (e.g. disk full, a bad custom `--accounts` path), (re)sets
 * it and logs, but never propagates — the caller's fresh in-memory token
 * remains usable even though it isn't on disk yet.
 *
 * Residual risk: if the process crashes before any retry of a dirty account
 * succeeds, the rotated refresh token is lost from disk — and since OpenAI
 * already invalidated the old one, that forces re-authentication. The retry
 * cadence (the very next request via `prepareOpenAIAccountForRequest`, or at
 * worst the refresh loop's next ≤5-minute tick) bounds how long that window
 * stays open, but does not close it.
 */
function persistCredentials(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): boolean {
  try {
    saveAccounts(allAccounts);
    markOpenAICredentialsPersisted(allAccounts);
    pendingCredentialWrites.delete(account);
    return true;
  } catch (error) {
    pendingCredentialWrites.add(account);
    console.error(error);
    return false;
  }
}

interface OpenAIRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export type OpenAISubscriptionAccount = ProviderAccount & {
  provider: "openai_subscription";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
};

/**
 * Runtime health-tracking fields that live on `OpenAIAccount` (see
 * `account-state.ts`) but are not part of the persisted `OpenAISubscriptionAccount`
 * shape. The refresh loop is handed the live `OpenAIAccount[]` array from the pool
 * (typed here as `OpenAISubscriptionAccount[]` for the persisted-account API), so
 * these fields are present at runtime even though the static type doesn't declare
 * them. They're optional here and only written when already present, so refresher
 * unit tests that construct bare `OpenAISubscriptionAccount` fixtures are unaffected.
 */
type OpenAIRuntimeHealthFields = {
  healthy?: boolean;
  consecutiveErrors?: number;
  lastRefresh?: number;
  rateLimits?: { plan?: string };
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(
  account: OpenAISubscriptionAccount,
  signal?: AbortSignal,
): Promise<boolean> {
  if (activeRefreshLifecycle?.stopping) return false;
  const existing = refreshLocks.get(account.id);
  if (existing) {
    const unlink = linkAbortSignal(signal, refreshControllers.get(account.id));
    try {
      return await existing;
    } finally {
      unlink();
    }
  }

  const controller = new AbortController();
  const owner = activeRefreshLifecycle;
  const unlink = linkAbortSignal(signal, controller);
  const promise = withTelemetrySpan(
    "oauth.refresh",
    { provider: "openai" },
    () => doRefresh(account, controller.signal),
  );
  refreshLocks.set(account.id, promise);
  refreshControllers.set(account.id, controller);
  rawRefreshOwners.set(account.id, owner);
  try {
    return await promise;
  } finally {
    if (refreshLocks.get(account.id) === promise) refreshLocks.delete(account.id);
    if (refreshControllers.get(account.id) === controller) refreshControllers.delete(account.id);
    if (rawRefreshOwners.get(account.id) === owner) rawRefreshOwners.delete(account.id);
    unlink();
  }
}

export async function prepareOpenAIAccountForRequest(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): Promise<boolean> {
  if (!needsOpenAIRefresh(account)) {
    // No refresh due, but a previous rotation from this account never made it
    // to disk (e.g. a transient disk-full). This is the retry path: piggyback
    // on this otherwise-idle request to flush the still-current in-memory
    // token, without blocking or failing the request either way.
    if (hasPendingCredentialWrite(account)) persistCredentials(account, allAccounts, saveAccounts);
    return true;
  }

  // The refreshed token is already live in memory, so a persistence failure
  // must not fail this request — it only means the new token isn't on disk
  // yet. `persistCredentials` marks the account dirty so the write is retried
  // (here, or by the refresh loop) instead of silently losing the rotation.
  return refreshAndPersistOpenAIAccount(account, allAccounts, saveAccounts);
}

/**
 * Refreshes `account`'s token if needed and persists the pool. Used both by
 * `prepareOpenAIAccountForRequest`'s refresh-due branch and by callers that
 * want to force a refresh outside of that gate (e.g. reacting to an upstream
 * 401). Always returns the refresh outcome — a persistence failure never
 * turns a successful refresh into a `false` result.
 */
export async function refreshAndPersistOpenAIAccount(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): Promise<boolean> {
  if (activeRefreshLifecycle?.stopping) return false;
  const owner = activeRefreshLifecycle;
  let operation!: Promise<boolean>;
  operation = (async () => {
    try {
      const ok = await refreshOpenAISubscriptionToken(account);
      if (ok) persistCredentials(account, allAccounts, saveAccounts);
      return ok;
    } finally {
      ownedRefreshLocks.delete(operation);
      ownedRefreshOwners.delete(operation);
    }
  })();
  ownedRefreshLocks.add(operation);
  ownedRefreshOwners.set(operation, owner);
  return operation;
}

export function startOpenAIRefreshLoop(
  accounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): (deadlineMs?: number) => Promise<void> {
  if (activeRefreshLifecycle && !activeRefreshLifecycle.settled) {
    throw new Error("OpenAI refresh loop is already running");
  }
  const lifecycle: RefreshLifecycle = { stopping: false, settled: false };
  activeRefreshLifecycle = lifecycle;
  let stopped = false;
  let activePass: Promise<void> | undefined;
  let activeController: AbortController | undefined;

  const check = async (signal: AbortSignal) => {
    for (const account of accounts) {
      if (stopped || signal.aborted || activeRefreshLifecycle !== lifecycle) return;
      // One account's refresh throwing must not skip every account after it
      // in this tick — isolate failures per-account.
      try {
        await prepareOpenAIAccountForRequest(account, accounts, saveAccounts);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const startPass = (): void => {
    if (stopped || activePass || activeRefreshLifecycle !== lifecycle) return;
    const controller = new AbortController();
    activeController = controller;
    let operation!: Promise<void>;
    operation = check(controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (activePass === operation) activePass = undefined;
        if (activeController === controller) activeController = undefined;
      });
    activePass = operation;
  };

  const timer = setInterval(startPass, CHECK_INTERVAL_MS);
  queueMicrotask(startPass);

  let stopPromise: Promise<void> | undefined;
  return (deadlineMs = 500) => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      lifecycle.stopping = true;
      clearInterval(timer);
      const active = Promise.allSettled([
        ...(activePass ? [activePass] : []),
        ...[...refreshLocks].filter(([id]) => rawRefreshOwners.get(id) === lifecycle).map(([, promise]) => promise),
        ...[...ownedRefreshLocks].filter(promise => ownedRefreshOwners.get(promise) === lifecycle),
      ]).then(() => undefined);
      try {
        await drainRefreshPassWithin(active, deadlineMs, () => {
          activeController?.abort();
          for (const [id, controller] of refreshControllers) {
            if (rawRefreshOwners.get(id) !== lifecycle) continue;
            controller.abort();
            refreshLocks.delete(id);
            refreshControllers.delete(id);
            rawRefreshOwners.delete(id);
          }
          for (const operation of ownedRefreshLocks) {
            if (ownedRefreshOwners.get(operation) !== lifecycle) continue;
            ownedRefreshLocks.delete(operation);
            ownedRefreshOwners.delete(operation);
          }
        });
      } finally {
        lifecycle.settled = true;
        if (activeRefreshLifecycle === lifecycle) activeRefreshLifecycle = undefined;
      }
    })();
    return stopPromise;
  };
}

async function doRefresh(account: OpenAISubscriptionAccount, signal?: AbortSignal): Promise<boolean> {
  const startedAt = Date.now();
  let receivedSuccessfulResponse = false;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
    signal?.throwIfAborted();

    const outcome = res.ok ? "complete" : res.status === 429 ? "rate_limited" : "upstream_error";
    annotateActiveSpan("oauth.refresh", {
      httpStatusCode: res.status,
      outcome,
      operationDurationMs: Date.now() - startedAt,
    });
    if (!res.ok) {
      recordSafeLog({
        operation: "oauth.refresh",
        provider: "openai",
        reason: refreshHttpReason(res.status),
        outcome,
        httpStatusCode: res.status,
        operationDurationMs: Date.now() - startedAt,
        severity: "warn",
      });
      return false;
    }

    receivedSuccessfulResponse = true;
    const data = await res.json() as OpenAIRefreshResponse;
    signal?.throwIfAborted();

    // A 200 with an unusable payload is a failed refresh, not a successful one.
    if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
      throw new TypeError("Unexpected OpenAI refresh response shape");
    }
    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new TypeError("Unexpected OpenAI refresh response shape");
    }
    const expiresAt = Date.now() + data.expires_in * 1000;
    if (!Number.isFinite(expiresAt)) throw new TypeError("Unexpected OpenAI refresh response shape");

    account.accessToken = data.access_token;
    account.refreshToken = data.refresh_token ?? account.refreshToken;
    account.expiresAt = expiresAt;

    // A successful refresh recovers an account the pool previously excluded.
    const runtime = account as OpenAISubscriptionAccount & OpenAIRuntimeHealthFields;
    if (runtime.healthy !== undefined) runtime.healthy = true;
    if (runtime.consecutiveErrors !== undefined) runtime.consecutiveErrors = 0;
    if (runtime.lastRefresh !== undefined) runtime.lastRefresh = Date.now();

    if (runtime.rateLimits) {
      const plan = decodeOpenAIPlan(account.accessToken);
      if (plan) runtime.rateLimits.plan = plan;
    }

    return true;
  } catch (error) {
    // Network failure (or malformed response body) must resolve to `false`,
    // exactly like a non-ok HTTP response — never propagate as a rejection.
    if (signal?.aborted) return false;
    const expectedReason = classifyExpectedRuntimeFailure(error);
    const reason = expectedReason ?? (receivedSuccessfulResponse ? "unexpected_response_shape" : "other");
    const outcome = reason === "timeout" ? "timeout" : "upstream_error";
    annotateActiveSpan("oauth.refresh", {
      outcome,
      operationDurationMs: Date.now() - startedAt,
    });
    recordSafeLog({
      operation: "oauth.refresh",
      provider: "openai",
      reason,
      outcome,
      operationDurationMs: Date.now() - startedAt,
      severity: "error",
    });
    if (!expectedReason) {
      recordUnexpectedException(error, {
        category: "runtime",
        reason: "other",
        operation: "oauth.refresh",
        provider: "openai",
      });
    }
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

function refreshHttpReason(status: number): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
}
