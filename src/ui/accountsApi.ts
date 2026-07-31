/**
 * Tiny authenticated HTTP client for /cc-router/accounts.
 *
 * Used by the Ink dashboard to mutate account settings (enable/disable,
 * set per-account caps, delete) without exiting Ink first. The `addAccount`
 * flow is not here because it runs inquirer.
 */

const REQUEST_TIMEOUT_MS = 3_000;
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
  provider?: "anthropic_subscription" | "openai_subscription";
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
      extraUsage?: { enabled: boolean; spendLimitReached: boolean };
      fetchedAt: number;
      fetchStatus: FetchStatus;
    };
  };
  globalCooldownUntilMs?: number;
  modelCooldowns?: Array<{ modelFamily: string; untilMs: number }>;
}

export interface AccountsApi {
  /** Read the authenticated, disclosure-safe account status view. */
  list(): Promise<AccountSafeView[]>;
  /** Apply a partial update to an account. Throws on non-2xx or network error. */
  patch(id: string, patch: AccountPatch): Promise<void>;
  /** Enable or disable every configured account for a provider. */
  setProviderEnabled(provider: "anthropic_subscription" | "openai_subscription", enabled: boolean): Promise<void>;
  /** Remove an account by id. Throws on non-2xx or network error. */
  remove(id: string): Promise<void>;
}

export function createAccountsApi(baseUrl: string, authToken?: string): AccountsApi {
  const base = baseUrl.replace(/\/+$/, "") + "/cc-router/accounts";
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

  return {
    list,
    patch(id, patch) { return send("PATCH", `/${encodeURIComponent(id)}`, patch); },
    setProviderEnabled(provider, enabled) { return send("PATCH", `/providers/${encodeURIComponent(provider)}`, { enabled }); },
    remove(id) { return send("DELETE", `/${encodeURIComponent(id)}`); },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicAccountSafeView(value: unknown): AccountSafeView[] {
  if (!isRecord(value) || typeof value.id !== "string") return [];
  const provider = value.provider === "anthropic_subscription" || value.provider === "openai_subscription"
    ? value.provider
    : undefined;
  const rateLimits = publicRateLimits(value.rateLimits);
  const modelCooldowns = publicCooldowns(value.modelCooldowns);
  return [{
    id: publicText(value.id, 128, "unknown-account"),
    ...(provider ? { provider } : {}),
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
    ? { enabled: value.extraUsage.enabled === true, spendLimitReached: value.extraUsage.spendLimitReached === true }
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
