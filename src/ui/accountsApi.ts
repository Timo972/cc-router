/**
 * Tiny authenticated HTTP client for /cc-router/accounts.
 *
 * Used by the Ink dashboard to mutate account settings (enable/disable,
 * set per-account caps, delete) without exiting the TUI. The `addAccount`
 * flow is NOT in here — that runs inquirer and must exit Ink first; see
 * src/cli/cmd-status.ts `runAddAccountFlow`.
 */

const REQUEST_TIMEOUT_MS = 3_000;

export interface AccountPatch {
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
}

export interface AccountSafeView {
  id: string;
  provider?: "anthropic_subscription" | "openai_subscription";
  rateLimits?: {
    usage?: {
      modelLimits: Array<{
        modelFamily?: string;
        displayName?: string;
        utilization?: number;
        resetAt?: number;
        active?: boolean;
        severity?: string;
      }>;
      extraUsage?: { enabled?: boolean; spendLimitReached?: boolean };
      fetchedAt?: number;
      fetchStatus?: "fresh" | "stale" | "unavailable";
    };
  };
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

  const authHeaders: Record<string, string> = authToken
    ? { authorization: `Bearer ${authToken}` }
    : {};

  async function send(
    method: "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<void> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...authHeaders,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Try to surface the server's error message if we can read one
      let detail = "";
      try {
        const data = await res.json() as { error?: string };
        if (data?.error) detail = `: ${data.error}`;
      } catch { /* best effort */ }
      throw new Error(`HTTP ${res.status}${detail}`);
    }
  }

  async function list(): Promise<AccountSafeView[]> {
    const res = await fetch(base, {
      method: "GET",
      headers: authHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json() as { accounts?: unknown };
    if (!Array.isArray(payload.accounts)) return [];
    return payload.accounts.flatMap(publicAccountSafeView);
  }

  return {
    list,
    patch(id, patch) {
      return send("PATCH", `/${encodeURIComponent(id)}`, patch);
    },
    setProviderEnabled(provider, enabled) {
      return send("PATCH", `/providers/${encodeURIComponent(provider)}`, { enabled });
    },
    remove(id) {
      return send("DELETE", `/${encodeURIComponent(id)}`);
    },
  };
}

function publicAccountSafeView(value: unknown): AccountSafeView[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const account = value as Record<string, unknown>;
  if (typeof account.id !== "string") return [];
  const provider = account.provider === "anthropic_subscription" || account.provider === "openai_subscription"
    ? account.provider
    : undefined;
  const rateLimits = publicRateLimits(account.rateLimits);
  return [{
    id: account.id,
    ...(provider ? { provider } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  }];
}

function publicRateLimits(value: unknown): AccountSafeView["rateLimits"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rateLimits = value as Record<string, unknown>;
  const usage = publicUsage(rateLimits.usage);
  return usage ? { usage } : undefined;
}

function publicUsage(value: unknown): NonNullable<AccountSafeView["rateLimits"]>["usage"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const rawModels = Array.isArray(usage.modelLimits) ? usage.modelLimits : [];
  const modelLimits = rawModels.slice(0, 12).flatMap(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const model = raw as Record<string, unknown>;
    return [{
      ...(typeof model.modelFamily === "string" ? { modelFamily: model.modelFamily } : {}),
      ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
      ...(typeof model.utilization === "number" ? { utilization: model.utilization } : {}),
      ...(typeof model.resetAt === "number" ? { resetAt: model.resetAt } : {}),
      ...(typeof model.active === "boolean" ? { active: model.active } : {}),
      ...(typeof model.severity === "string" ? { severity: model.severity } : {}),
    }];
  });
  const extra = usage.extraUsage;
  const extraUsage = extra && typeof extra === "object" && !Array.isArray(extra)
    ? (() => {
        const state = extra as Record<string, unknown>;
        return {
          ...(typeof state.enabled === "boolean" ? { enabled: state.enabled } : {}),
          ...(typeof state.spendLimitReached === "boolean" ? { spendLimitReached: state.spendLimitReached } : {}),
        };
      })()
    : undefined;
  const fetchStatus = usage.fetchStatus === "fresh" || usage.fetchStatus === "stale" || usage.fetchStatus === "unavailable"
    ? usage.fetchStatus
    : undefined;
  return {
    modelLimits,
    ...(extraUsage ? { extraUsage } : {}),
    ...(typeof usage.fetchedAt === "number" ? { fetchedAt: usage.fetchedAt } : {}),
    ...(fetchStatus ? { fetchStatus } : {}),
  };
}
