import type { ProviderAccount } from "../types.js";
import { decodeOpenAIPlan } from "./usage.js";
import { createHeaderDeadline } from "../../proxy/transport-timing.js";
import { logError } from "../../proxy/logger.js";
import {
  createCorrelationId,
  formatTransportDiagnostic,
  safeCauseCode,
} from "../../proxy/transport-diagnostics.js";
import { DEFAULT_CLIENT_ID } from "./device-oauth.js";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const OPENAI_REFRESH_TIMEOUT_MS = 15_000;

const refreshLocks = new WeakMap<OpenAISubscriptionAccount, Promise<boolean>>();

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
  authState?: "ok" | "quarantined";
  authFailure?: "permanent" | "transient";
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(account: OpenAISubscriptionAccount): Promise<boolean> {
  const existing = refreshLocks.get(account);
  if (existing) return existing;

  const promise = doRefresh(account);
  refreshLocks.set(account, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account);
  }
}

export async function prepareOpenAIAccountForRequest(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): Promise<boolean> {
  const runtime = account as OpenAISubscriptionAccount & OpenAIRuntimeHealthFields;
  // A revoked but unexpired access token must not bypass the refresh gate.
  if (!needsOpenAIRefresh(account) && runtime.authState !== "quarantined") {
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
  const ok = await refreshOpenAISubscriptionToken(account);
  if (ok) persistCredentials(account, allAccounts, saveAccounts);
  return ok;
}

export interface RefreshOpenAIAccountsOnceOptions {
  onError?: (error: unknown) => void;
}

/**
 * One scheduled refresh pass over every OpenAI account: due tokens are
 * refreshed, quarantined ones re-tried. Shared by the background loop and
 * the manual reload endpoint so both isolate failures per account the same
 * way. Returns how many accounts did not come out with usable credentials —
 * an expected refresh rejection counts, not only a thrown error.
 */
export async function refreshOpenAIAccountsOnce(
  accounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
  options: RefreshOpenAIAccountsOnceOptions = {},
): Promise<{ failed: number }> {
  let failed = 0;
  for (const account of [...accounts]) {
    // One account's refresh throwing must not skip every account after it
    // in this tick — isolate failures per-account.
    try {
      if (!await prepareOpenAIAccountForRequest(account, accounts, saveAccounts)) failed++;
    } catch (error) {
      failed++;
      (options.onError ?? console.error)(error);
    }
  }
  return { failed };
}

export function startOpenAIRefreshLoop(
  accounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): () => void {
  const check = () => refreshOpenAIAccountsOnce(accounts, saveAccounts);

  const timer = setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
  queueMicrotask(() => { check().catch(console.error); });

  return () => clearInterval(timer);
}

function refreshErrorCode(payload: unknown, depth = 0): string | undefined {
  if (typeof payload === "string") return payload;
  if (depth >= 3 || typeof payload !== "object" || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  for (const key of ["code", "type", "error"] as const) {
    const code = refreshErrorCode(record[key], depth + 1);
    if (code) return code;
  }
  return undefined;
}

function rejectIsPermanent(status: number, payload: unknown): boolean {
  if (status !== 400 && status !== 401) return false;
  const code = refreshErrorCode(payload);
  // `token_expired` is the code the real endpoint returns for a refresh token it
  // can no longer validate; like the OAuth2-standard codes it means re-auth, not
  // a retriable blip, so it must quarantine rather than cooldown-loop forever.
  return code === "invalid_grant" || code === "invalid_token" || code === "token_revoked" || code === "token_expired";
}

function markRefreshFailure(account: OpenAISubscriptionAccount, permanent: boolean): void {
  const runtime = account as OpenAISubscriptionAccount & OpenAIRuntimeHealthFields;
  if (permanent) {
    runtime.authFailure = "permanent";
    runtime.authState = "quarantined";
  } else if (runtime.authState !== "quarantined") {
    runtime.authFailure = "transient";
  }
}

function logRefreshFailure(
  account: OpenAISubscriptionAccount,
  correlationId: string,
  status: number | undefined,
  error?: unknown,
): void {
  logError(account.id, status !== undefined && status >= 400 ? status : 0, formatTransportDiagnostic({
    correlationId,
    operation: "refresh",
    ...(status !== undefined ? { status } : {}),
    causeCode: safeCauseCode(error),
  }));
}

async function doRefresh(account: OpenAISubscriptionAccount): Promise<boolean> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    // The token endpoint validates client_id before the grant; without it the
    // refresh 400s as `missing_required_parameter` and never reaches token
    // validation. Same public client the tokens were minted under (device-oauth).
    client_id: DEFAULT_CLIENT_ID,
  });

  let data: OpenAIRefreshResponse;
  let responseStatus: number | undefined;
  const correlationId = createCorrelationId();
  const deadline = createHeaderDeadline(OPENAI_REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: deadline.signal,
    });
    responseStatus = res.status;

    if (!res.ok) {
      let payload: unknown;
      try { payload = await res.json(); } catch { /* intentionally do not retain response bodies */ }
      markRefreshFailure(account, rejectIsPermanent(res.status, payload));
      logRefreshFailure(account, correlationId, res.status);
      return false;
    }

    data = await res.json() as OpenAIRefreshResponse;
  } catch (error) {
    // Network failure (or malformed response body) must resolve to `false`,
    // exactly like a non-ok HTTP response — never propagate as a rejection.
    markRefreshFailure(account, false);
    logRefreshFailure(account, correlationId, responseStatus, error);
    return false;
  } finally {
    // OAuth is a small JSON exchange: unlike inference, the deadline covers
    // both headers and body parsing so a stalled body cannot retain the lock.
    deadline.dispose();
  }

  // A 200 with an unusable payload is a failed refresh, not a successful one.
  // Writing it through would leave `expiresAt` as NaN, which then reads as
  // "never needs refreshing" in `needsOpenAIRefresh` and permanently strands
  // the account on a broken token.
  if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
    markRefreshFailure(account, false);
    logRefreshFailure(account, correlationId, 200);
    return false;
  }
  // The lifetime has to be positive and has to still name a finite instant
  // once converted. A zero or negative `expires_in` would report success on a
  // token that is already due for another refresh, so every request re-enters
  // the refresh path; a value big enough to overflow the multiplication would
  // set `expiresAt` to Infinity, which `needsOpenAIRefresh` can never reach —
  // the same permanent strand as NaN, from the opposite direction.
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) {
    markRefreshFailure(account, false);
    logRefreshFailure(account, correlationId, 200);
    return false;
  }
  if (data.expires_in <= 0) {
    markRefreshFailure(account, false);
    logRefreshFailure(account, correlationId, 200);
    return false;
  }
  const expiresAt = Date.now() + data.expires_in * 1000;
  if (!Number.isFinite(expiresAt)) {
    markRefreshFailure(account, false);
    logRefreshFailure(account, correlationId, 200);
    return false;
  }

  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token ?? account.refreshToken;
  account.expiresAt = expiresAt;

  // A successful refresh recovers an account the pool previously excluded for
  // being unhealthy (e.g. after a prior failed refresh). Without this, the pool's
  // hard `!healthy` block means the account never gets acquired again — and thus
  // never gets another chance to refresh — so it stays excluded until restart.
  const runtime = account as OpenAISubscriptionAccount & OpenAIRuntimeHealthFields;
  if (runtime.healthy !== undefined) runtime.healthy = true;
  if (runtime.consecutiveErrors !== undefined) runtime.consecutiveErrors = 0;
  if (runtime.lastRefresh !== undefined) runtime.lastRefresh = Date.now();
  runtime.authState = "ok";
  runtime.authFailure = undefined;

  // The rotated access token can carry a different plan than the one decoded
  // at account creation (e.g. a Plus->Pro upgrade). Mirrors createOpenAIAccount's
  // semantics: only overwrite when the new token actually decodes a plan claim —
  // an undecodable token leaves the previously known plan in place rather than
  // erasing it, since a missing claim means "unknown", not "no plan".
  if (runtime.rateLimits) {
    const plan = decodeOpenAIPlan(account.accessToken);
    if (plan) runtime.rateLimits.plan = plan;
  }

  return true;
}
