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
const refreshControllers = new Map<string, AbortController>();

interface OpenAIRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

function isOpenAIRefreshResponse(value: unknown): value is OpenAIRefreshResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return typeof response.access_token === "string"
    && response.access_token.length > 0
    && typeof response.expires_in === "number"
    && Number.isFinite(response.expires_in)
    && response.expires_in > 0
    && typeof response.token_type === "string"
    && response.token_type.length > 0
    && (response.refresh_token === undefined
      || (typeof response.refresh_token === "string" && response.refresh_token.length > 0));
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

export async function refreshOpenAISubscriptionToken(
  account: OpenAISubscriptionAccount,
  signal?: AbortSignal,
): Promise<boolean> {
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
  const unlink = linkAbortSignal(signal, controller);
  const promise = withTelemetrySpan("oauth.refresh", { provider: "openai" }, () => doRefresh(account, controller.signal));
  refreshLocks.set(account.id, promise);
  refreshControllers.set(account.id, controller);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(account.id);
    refreshControllers.delete(account.id);
    unlink();
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
): (deadlineMs?: number) => Promise<void> {
  let stopped = false;
  let activePass: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  const check = async (signal: AbortSignal) => {
    for (const account of accounts) {
      if (stopped || signal.aborted) return;
      if (!needsOpenAIRefresh(account)) continue;
      const ok = await refreshOpenAISubscriptionToken(account, signal);
      if (ok) saveAccounts(accounts);
    }
  };

  const startPass = (): void => {
    if (stopped || activePass) return;
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

  return async (deadlineMs = 500) => {
    stopped = true;
    clearInterval(timer);
    const active = activePass;
    if (!active) return;
    await drainRefreshPassWithin(active, deadlineMs, () => activeController?.abort());
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
    const data: unknown = await res.json();
    if (!isOpenAIRefreshResponse(data)) {
      throw new TypeError("Unexpected OpenAI refresh response shape");
    }
    signal?.throwIfAborted();
    account.accessToken = data.access_token;
    account.refreshToken = data.refresh_token ?? account.refreshToken;
    account.expiresAt = Date.now() + data.expires_in * 1000;
    return true;
  } catch (error) {
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
    throw error;
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
