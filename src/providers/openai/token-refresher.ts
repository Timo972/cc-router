import type { ProviderAccount } from "../types.js";
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
};

export function needsOpenAIRefresh(account: Pick<OpenAISubscriptionAccount, "expiresAt">): boolean {
  return account.expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

export async function refreshOpenAISubscriptionToken(account: OpenAISubscriptionAccount): Promise<boolean> {
  const existing = refreshLocks.get(account.id);
  if (existing) return existing;

  const promise = withTelemetrySpan("oauth.refresh", { provider: "openai" }, () => doRefresh(account));
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
    });
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
    account.accessToken = data.access_token;
    account.refreshToken = data.refresh_token ?? account.refreshToken;
    account.expiresAt = Date.now() + data.expires_in * 1000;
    return true;
  } catch (error) {
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
    throw error;
  }
}

function refreshHttpReason(status: number): "unauthorized" | "forbidden" | "rate_limited" | "upstream_4xx" | "upstream_5xx" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
}
