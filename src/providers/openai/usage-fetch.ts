import type { OpenAIAccount } from "./account-state.js";
import { applyCodexRateLimits } from "./account-state.js";
import { parseCodexUsagePayload, type CodexRateLimitsUpdate } from "./usage.js";
import { UsageRefresher } from "../../proxy/usage-refresher.js";
import type { RefreshableAccountPool } from "../../proxy/usage-refresher.js";

/**
 * The endpoint the Codex CLI's own backend client reads rate limits from
 * (codex-rs/backend-client, ChatGPT path style). Answers a bearer-only GET
 * with the JSON twin of the `x-codex-*` response headers — which is what
 * makes usage visible without burning a request through /codex/responses.
 */
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

export type CodexUsageFetchResult =
  | { ok: true; update: CodexRateLimitsUpdate }
  | { ok: false; reason: "auth" | "http" | "network" | "malformed" };

export interface FetchCodexUsageOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export async function fetchCodexUsage(
  account: Pick<OpenAIAccount, "accessToken">,
  options: FetchCodexUsageOptions = {},
): Promise<CodexUsageFetchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(CODEX_USAGE_ENDPOINT, {
      headers: { authorization: `Bearer ${account.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
  if (!response.ok) return { ok: false, reason: "http" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const update = parseCodexUsagePayload(body, now());
  return update ? { ok: true, update } : { ok: false, reason: "malformed" };
}

export interface OpenAIUsageRefresherOptions {
  /** Refresh the account's token when needed before fetching — the ingress'
   *  `prepareOpenAIAccount` closure. Without it, a daemon restarted with an
   *  expired access token would 401 on every poll until real traffic
   *  happened to refresh it — the exact idle case this refresher exists for. */
  prepare?: (account: OpenAIAccount) => Promise<boolean>;
  fetchUsage?: (account: OpenAIAccount) => Promise<CodexUsageFetchResult>;
  now?: () => number;
  startupStaggerMs?: number;
  maxConcurrent?: number;
}

/**
 * The OpenAI/Codex instantiation of the shared usage scheduler: polls the
 * usage endpoint and feeds the result through `applyCodexRateLimits` — the
 * same merge the response headers go through — so the dashboard shows an
 * account's windows right after startup instead of only after its first
 * routed request. A failed fetch keeps whatever the account already knew;
 * unlike the Anthropic snapshot there is no per-fetch staleness field, and
 * header-fed data must not be erased by a flaky poll.
 */
export class OpenAIUsageRefresher extends UsageRefresher<OpenAIAccount, CodexUsageFetchResult> {
  constructor(pool: RefreshableAccountPool<OpenAIAccount>, options: OpenAIUsageRefresherOptions = {}) {
    const now = options.now ?? Date.now;
    const fetchUsage = options.fetchUsage ?? ((account: OpenAIAccount) => fetchCodexUsage(account, { now }));
    const prepare = options.prepare;
    super(pool, {
      fetchUsage: async (account) => {
        if (prepare) {
          let ready: boolean;
          try {
            ready = await prepare(account);
          } catch {
            ready = false;
          }
          if (!ready) return { ok: false, reason: "auth" };
        }
        return fetchUsage(account);
      },
      cancelledResult: () => ({ ok: false, reason: "network" }),
      applyResult: (account, result) => {
        if (result.ok) applyCodexRateLimits(account, result.update, now());
      },
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.startupStaggerMs !== undefined ? { startupStaggerMs: options.startupStaggerMs } : {}),
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    });
  }
}
