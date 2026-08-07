import type { ProviderAccount } from "../types.js";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<boolean>>();

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
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(account: OpenAISubscriptionAccount): Promise<boolean> {
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = doRefresh(account);
  refreshLocks.set(account.id, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
  }
}

export async function prepareOpenAIAccountForRequest(
  account: OpenAISubscriptionAccount,
  allAccounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): Promise<boolean> {
  if (!needsOpenAIRefresh(account)) return true;

  const ok = await refreshOpenAISubscriptionToken(account);
  if (ok) saveAccounts(allAccounts);
  return ok;
}

export function startOpenAIRefreshLoop(
  accounts: OpenAISubscriptionAccount[],
  saveAccounts: (accounts: OpenAISubscriptionAccount[]) => void,
): () => void {
  const check = async () => {
    for (const account of accounts) {
      await prepareOpenAIAccountForRequest(account, accounts, saveAccounts);
    }
  };

  const timer = setInterval(() => { check().catch(console.error); }, CHECK_INTERVAL_MS);
  queueMicrotask(() => { check().catch(console.error); });

  return () => clearInterval(timer);
}

async function doRefresh(account: OpenAISubscriptionAccount): Promise<boolean> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) return false;

  const data = await res.json() as OpenAIRefreshResponse;
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token ?? account.refreshToken;
  account.expiresAt = Date.now() + data.expires_in * 1000;

  // A successful refresh recovers an account the pool previously excluded for
  // being unhealthy (e.g. after a prior failed refresh). Without this, the pool's
  // hard `!healthy` block means the account never gets acquired again — and thus
  // never gets another chance to refresh — so it stays excluded until restart.
  const runtime = account as OpenAISubscriptionAccount & OpenAIRuntimeHealthFields;
  if (runtime.healthy !== undefined) runtime.healthy = true;
  if (runtime.consecutiveErrors !== undefined) runtime.consecutiveErrors = 0;
  if (runtime.lastRefresh !== undefined) runtime.lastRefresh = Date.now();

  return true;
}
