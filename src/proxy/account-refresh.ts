import type { Account } from "./types.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";

export interface AccountRefreshResult {
  id: string;
  /** null when no token refresh was due, so "nothing to do" never reads as a failure. */
  tokenRefreshed: boolean | null;
  usageRefreshed: boolean;
  durationMs: number;
}

export interface AccountRefreshHooks {
  findAnthropic(id: string): Account | null;
  findOpenAI(id: string): OpenAIAccount | undefined;
  refreshAnthropicToken(account: Account): Promise<boolean>;   // only called when due
  anthropicTokenDue(account: Account): boolean;
  refreshAnthropicUsage(account: Account): Promise<{ ok: boolean }>;
  refreshOpenAIToken(account: OpenAIAccount): Promise<boolean>;
  openAITokenDue(account: OpenAIAccount): boolean;
  refreshOpenAIUsage(account: OpenAIAccount): Promise<{ ok: boolean }>;
  refreshIdentity(): Promise<void>;
  now?: () => number;
}

/**
 * One account's worth of `POST /cc-router/refresh`: token if due, usage, then
 * identity. Step failures are reported, never thrown — only an unexpected
 * throw escapes so the route can answer 500. Single-flighted per id so a
 * second press joins the running pass instead of stacking a second fetch.
 */
export function createAccountRefreshRunner(
  hooks: AccountRefreshHooks,
): (id: string) => Promise<AccountRefreshResult | null> {
  const now = hooks.now ?? Date.now;
  const inFlight = new Map<string, Promise<AccountRefreshResult | null>>();
  const attempt = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  return id => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    let run!: Promise<AccountRefreshResult | null>;
    run = (async (): Promise<AccountRefreshResult | null> => {
      const started = now();
      const anthropic = hooks.findAnthropic(id);
      const openai = anthropic ? undefined : hooks.findOpenAI(id);
      if (!anthropic && !openai) return null;
      let tokenRefreshed: boolean | null = null;
      let usageRefreshed = false;
      if (anthropic) {
        if (hooks.anthropicTokenDue(anthropic)) {
          tokenRefreshed = await attempt(() => hooks.refreshAnthropicToken(anthropic), false);
        }
        usageRefreshed = (await attempt(() => hooks.refreshAnthropicUsage(anthropic), { ok: false })).ok;
      } else if (openai) {
        if (hooks.openAITokenDue(openai)) {
          tokenRefreshed = await attempt(() => hooks.refreshOpenAIToken(openai), false);
        }
        usageRefreshed = (await attempt(() => hooks.refreshOpenAIUsage(openai), { ok: false })).ok;
      }
      await attempt(() => hooks.refreshIdentity(), undefined);
      return { id, tokenRefreshed, usageRefreshed, durationMs: Math.max(0, now() - started) };
    })().finally(() => { if (inFlight.get(id) === run) inFlight.delete(id); });
    inFlight.set(id, run);
    return run;
  };
}
