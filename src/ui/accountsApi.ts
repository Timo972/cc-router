import type { CodexResetCode } from "../providers/openai/usage-reset.js";
import type { ClaudeResetCode } from "../providers/anthropic/usage-reset.js";
import { sanitizeAccountInfo, type AccountInfo } from "../providers/account-info.js";
/**
 * Tiny authenticated HTTP client for /cc-router/accounts.
 *
 * Used by the Ink dashboard to mutate account settings (enable/disable,
 * set per-account caps, delete) without exiting Ink first. The `addAccount`
 * flow is not here because it runs inquirer.
 */

const REQUEST_TIMEOUT_MS = 3_000;
// Worst case is every account timing out: OpenAI token refreshes are
// sequential with a 15s deadline each, usage fetches run two at a time with
// 10s each. The server single-flights the pass, so a client that does give
// up and presses again joins the running one rather than stacking another.
const REFRESH_ALL_TIMEOUT_MS = 120_000;
// One account only: a token refresh, one usage fetch and the identity fetch.
// Far short of the whole-pool budget, but long enough that a slow upstream
// still lands rather than the dashboard reporting a timeout it caused.
const REFRESH_ONE_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_ROWS = 12;

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

type FetchStatus = "fresh" | "stale" | "unavailable";
type Severity = "" | "warning" | "critical" | "unknown";

export interface AccountSafeView {
  id: string;
  accountInfo?: AccountInfo;
  provider?: "anthropic_subscription" | "openai_subscription" | "xai_subscription";
  rateLimits?: {
    status: "allowed" | "rate_limited" | "unknown";
    fiveHourUtil: number;
    fiveHourReset: number;
    sevenDayUtil: number;
    sevenDayReset: number;
    claim: string;
    plan: string;
    requestsLimit: number;
    lastUpdated: number;
    usage?: {
      fiveHour?: { utilization: number; resetAt: number };
      sevenDay?: { utilization: number; resetAt: number };
      modelLimits: Array<{
        modelFamily: string;
        displayName: string;
        utilization: number;
        resetAt: number;
        active: boolean;
        severity: Severity;
      }>;
      extraUsage?: { enabled: boolean; spendLimitReached: boolean; usable: boolean };
      fetchedAt: number;
      fetchStatus: FetchStatus;
    };
  };
  globalCooldownUntilMs?: number;
  modelCooldowns?: Array<{ modelFamily: string; untilMs: number }>;
}

export interface RefreshAllResult {
  accounts: number;
  usageRefreshed: number;
  usageFailed: number;
  tokenRefreshFailed: number;
  durationMs: number;
}

export interface AccountRefreshResult {
  id: string;
  /** null when no token refresh was due — not a failure. */
  tokenRefreshed: boolean | null;
  usageRefreshed: boolean;
  durationMs: number;
}

export type UsageResetResult =
  | { provider: "openai"; code: CodexResetCode; usageRefreshed: boolean; replay: boolean }
  | { provider: "anthropic"; code: ClaudeResetCode; usageRefreshed: boolean; replay: boolean; resetsLeft?: number };

const OPENAI_RESET_CODES: readonly string[] = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"];
const CLAUDE_RESET_CODES: readonly string[] = ["reset", "already_used", "not_limited", "cooldown", "ineligible"];
// Statuses where the router answered before submitting anything upstream, so
// its error text is safe and useful to show. Every other status (notably 502,
// "outcome unknown") stays a bare `HTTP <status>`.
const NOT_SUBMITTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 503]);

/** The router refused a redemption before submitting it (its error text is
 *  the message). Network failures, timeouts and bare `HTTP <status>` errors
 *  are never this type: their outcome is unknown. */
export class RouterRefusedResetError extends Error {
  override name = "RouterRefusedResetError";
  /** The router can never match this redemption id again; start over from fresh usage. */
  constructor(message: string, readonly abandon = false) { super(message); }
}

export interface AccountsApi {
  /** `retry`: this id was already sent once and its outcome is unknown. */
  resetUsage(id: string, redeemRequestId: string, attempt?: { retry?: boolean }): Promise<UsageResetResult>;
  /** Read the authenticated, disclosure-safe account status view. */
  list(): Promise<AccountSafeView[]>;
  /** Ask the router to sweep cooldowns, re-try due tokens and re-fetch every
   *  account's usage — a restart's worth of freshness without a restart. */
  refreshAll(): Promise<RefreshAllResult>;
  /** Refresh one account: its token if due, its usage, and identity metadata. */
  refreshAccount(id: string): Promise<AccountRefreshResult>;
  /** Apply a partial update to an account. Throws on non-2xx or network error. */
  patch(id: string, patch: AccountPatch): Promise<void>;
  /** Enable or disable every configured account for a provider. */
  setProviderEnabled(provider: "anthropic_subscription" | "openai_subscription" | "xai_subscription", enabled: boolean): Promise<void>;
  /** Remove an account by id. Throws on non-2xx or network error. */
  remove(id: string): Promise<void>;
}

export function createAccountsApi(baseUrl: string, authToken?: string): AccountsApi {
  const root = baseUrl.replace(/\/+$/, "");
  const base = root + "/cc-router/accounts";
  const authHeaders: Record<string, string> = authToken ? { authorization: `Bearer ${authToken}` } : {};

  async function send(method: "PATCH" | "DELETE", path: string, body?: unknown): Promise<void> {
    const res = await fetch(base + path, {
      method,
      headers: { ...authHeaders, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const data = await res.json() as { error?: string };
        if (data?.error) detail = `: ${data.error}`;
      } catch { /* best effort */ }
      throw new Error(`HTTP ${res.status}${detail}`);
    }
  }

  async function list(): Promise<AccountSafeView[]> {
    const res = await fetch(base, { method: "GET", headers: authHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json() as { accounts?: unknown };
    return Array.isArray(payload.accounts) ? payload.accounts.flatMap(publicAccountSafeView) : [];
  }

  async function refreshAll(): Promise<RefreshAllResult> {
    // Usage fetches for every account run behind this call, so it gets its
    // own, longer budget than the account mutations above.
    const res = await fetch(root + "/cc-router/refresh", {
      method: "POST",
      headers: authHeaders,
      signal: AbortSignal.timeout(REFRESH_ALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json() as { refresh?: unknown };
    return publicRefreshResult(payload.refresh);
  }

  return {
    list,
    refreshAll,
    async refreshAccount(id) {
      const res = await fetch(`${base}/${encodeURIComponent(id)}/refresh`, {
        method: "POST",
        headers: authHeaders,
        signal: AbortSignal.timeout(REFRESH_ONE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as { refresh?: unknown };
      const r = isRecord(payload.refresh) ? payload.refresh : {};
      return {
        id: publicText(r.id, 128, id),
        tokenRefreshed: r.tokenRefreshed === true ? true : r.tokenRefreshed === false ? false : null,
        usageRefreshed: r.usageRefreshed === true,
        durationMs: publicInteger(r.durationMs),
      };
    },
    async resetUsage(id, redeemRequestId, attempt = {}) {
      const response = await fetch(`${base}/${encodeURIComponent(id)}/reset-usage`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ redeemRequestId, retry: attempt.retry === true }),
        signal: AbortSignal.timeout(REFRESH_ALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        const fallback = `HTTP ${response.status}`;
        if (!NOT_SUBMITTED_STATUSES.has(response.status)) throw new Error(fallback);
        const errorBody: unknown = await response.json().catch(() => undefined);
        const text = isRecord(errorBody) ? publicText(errorBody.error, 160, fallback) : fallback;
        throw text === fallback ? new Error(fallback)
          : new RouterRefusedResetError(text, isRecord(errorBody) && errorBody.abandon === true);
      }
      const body: unknown = await response.json();
      const reset = isRecord(body) ? body.reset : undefined;
      if (!isRecord(reset) || typeof reset.code !== "string" || typeof reset.usageRefreshed !== "boolean") throw new Error("Invalid reset response");
      // True only when the router re-submitted a request id it had already sent.
      const replay = reset.replay === true;
      if (reset.provider === "anthropic" && CLAUDE_RESET_CODES.includes(reset.code)) {
        return {
          provider: "anthropic", code: reset.code as ClaudeResetCode, usageRefreshed: reset.usageRefreshed, replay,
          ...(typeof reset.resetsLeft === "number" ? { resetsLeft: publicInteger(reset.resetsLeft) } : {}),
        };
      }
      if (reset.provider === "openai" && OPENAI_RESET_CODES.includes(reset.code)) {
        return { provider: "openai", code: reset.code as CodexResetCode, usageRefreshed: reset.usageRefreshed, replay };
      }
      throw new Error("Invalid reset response");
    },
    patch(id, patch) { return send("PATCH", `/${encodeURIComponent(id)}`, patch); },
    setProviderEnabled(provider, enabled) { return send("PATCH", `/providers/${encodeURIComponent(provider)}`, { enabled }); },
    remove(id) { return send("DELETE", `/${encodeURIComponent(id)}`); },
  };
}

function publicRefreshResult(value: unknown): RefreshAllResult {
  const record = isRecord(value) ? value : {};
  return {
    accounts: publicInteger(record.accounts),
    usageRefreshed: publicInteger(record.usageRefreshed),
    usageFailed: publicInteger(record.usageFailed),
    tokenRefreshFailed: publicInteger(record.tokenRefreshFailed),
    durationMs: publicInteger(record.durationMs),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicAccountSafeView(value: unknown): AccountSafeView[] {
  if (!isRecord(value) || typeof value.id !== "string") return [];
  const provider = value.provider === "anthropic_subscription"
    || value.provider === "openai_subscription"
    || value.provider === "xai_subscription"
    ? value.provider
    : undefined;
  const rateLimits = publicRateLimits(value.rateLimits);
  const accountInfo = sanitizeAccountInfo(value.accountInfo);
  const modelCooldowns = publicCooldowns(value.modelCooldowns);
  return [{
    id: publicText(value.id, 128, "unknown-account"),
    ...(provider ? { provider } : {}),
    ...(accountInfo ? { accountInfo } : {}),
    ...(rateLimits ? { rateLimits } : {}),
    globalCooldownUntilMs: publicTimestamp(value.globalCooldownUntilMs),
    modelCooldowns,
  }];
}

function publicRateLimits(value: unknown): AccountSafeView["rateLimits"] | undefined {
  if (!isRecord(value)) return undefined;
  const usage = publicUsage(value.usage);
  return {
    status: value.status === "allowed" || value.status === "rate_limited" ? value.status : "unknown",
    fiveHourUtil: publicUtilization(value.fiveHourUtil),
    fiveHourReset: publicTimestamp(value.fiveHourReset),
    sevenDayUtil: publicUtilization(value.sevenDayUtil),
    sevenDayReset: publicTimestamp(value.sevenDayReset),
    claim: publicClaim(value.claim),
    plan: value.plan === "Pro" || value.plan === "Max 5x" || value.plan === "Max 20x" ? value.plan : "",
    requestsLimit: publicInteger(value.requestsLimit),
    lastUpdated: publicTimestamp(value.lastUpdated),
    ...(usage ? { usage } : {}),
  };
}

function publicUsage(value: unknown): NonNullable<AccountSafeView["rateLimits"]>["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const fiveHour = publicWindow(value.fiveHour);
  const sevenDay = publicWindow(value.sevenDay);
  const extraUsage = isRecord(value.extraUsage)
    ? {
        enabled: value.extraUsage.enabled === true,
        spendLimitReached: value.extraUsage.spendLimitReached === true,
        usable: value.extraUsage.usable === true,
      }
    : undefined;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    modelLimits: (Array.isArray(value.modelLimits) ? value.modelLimits : [])
      .flatMap(publicModelLimit)
      .slice(0, MAX_PUBLIC_ROWS),
    ...(extraUsage ? { extraUsage } : {}),
    fetchedAt: publicTimestamp(value.fetchedAt),
    fetchStatus: publicFetchStatus(value.fetchStatus),
  };
}

function publicWindow(value: unknown): { utilization: number; resetAt: number } | undefined {
  if (!isRecord(value)) return undefined;
  return { utilization: publicUtilization(value.utilization), resetAt: publicTimestamp(value.resetAt) };
}

function publicModelLimit(value: unknown): NonNullable<NonNullable<AccountSafeView["rateLimits"]>["usage"]>["modelLimits"] {
  if (!isRecord(value)) return [];
  return [{
    modelFamily: publicModelFamily(value.modelFamily),
    displayName: publicText(value.displayName, 80, "Unknown model"),
    utilization: publicUtilization(value.utilization),
    resetAt: publicTimestamp(value.resetAt),
    active: value.active === true,
    severity: publicSeverity(value.severity),
  }];
}

function publicCooldowns(value: unknown): Array<{ modelFamily: string; untilMs: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(cooldown => {
    if (!isRecord(cooldown)) return [];
    const untilMs = publicTimestamp(cooldown.untilMs);
    return untilMs > 0 ? [{ modelFamily: publicModelFamily(cooldown.modelFamily), untilMs }] : [];
  }).slice(0, MAX_PUBLIC_ROWS);
}

function publicUtilization(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function publicTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function publicInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function publicText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
  return normalized || fallback;
}

function publicModelFamily(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : "unknown";
}

function publicSeverity(value: unknown): Severity {
  return value === "warning" || value === "critical" ? value : value ? "unknown" : "";
}

function publicFetchStatus(value: unknown): FetchStatus {
  return value === "fresh" || value === "stale" || value === "unavailable" ? value : "unavailable";
}

function publicClaim(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const claim = value.trim().toLowerCase();
  if (!claim) return "";
  if (claim === "five_hour" || claim === "seven_day" || claim === "seven_day_oauth_apps" || claim === "seven_day_overage_included") return claim;
  return claim.startsWith("seven_day_") ? "seven_day_model" : "unknown";
}
