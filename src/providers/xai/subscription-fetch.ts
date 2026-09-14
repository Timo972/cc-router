/**
 * Live subscription lookup for the Grok dashboard row.
 *
 * The Grok CLI's own backend is `https://cli-chat-proxy.grok.com/v1`. A
 * bearer-only GET on `/v1/user?include=subscription` answers with the account
 * identity plus `subscriptionTier` ("GrokPro", …) and `hasGrokCodeAccess` — the
 * only quota-relevant signals xAI exposes to the OIDC CLI token. The
 * `?include=subscription` query is REQUIRED: the bare `/v1/user` omits
 * `subscriptionTier` entirely (verified live 2026-08-21).
 *
 * Probed 2026-08-21 against the live endpoint: there is NO usage/limit/reset
 * data here. `/v1/usage`, `/v1/rate-limits`, `/v1/quota` and friends all 404;
 * no `x-ratelimit-*` response headers. xAI's weekly usage pool lives only in the
 * web app's Settings → Usage surface behind a different auth context, so the
 * dashboard shows the plan, not a percentage. This is why the Grok row has no
 * Claude-style 5h/7d windows — they do not exist.
 */
export const GROK_USER_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";

export interface GrokSubscription {
  subscriptionTier?: string;
  hasCodeAccess?: boolean;
}

export type GrokSubscriptionFetchResult =
  | ({ ok: true } & GrokSubscription)
  | { ok: false; reason: "auth" | "http" | "network" | "malformed" };

export interface FetchGrokSubscriptionOptions {
  fetch?: typeof globalThis.fetch;
}

export async function fetchGrokSubscription(
  account: { accessToken: string },
  options: FetchGrokSubscriptionOptions = {},
): Promise<GrokSubscriptionFetchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(GROK_USER_ENDPOINT, {
      headers: { authorization: `Bearer ${account.accessToken}`, accept: "application/json" },
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
  return parseGrokUserPayload(body);
}

export function parseGrokUserPayload(body: unknown): GrokSubscriptionFetchResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "malformed" };
  }
  const record = body as Record<string, unknown>;
  const tier = record["subscriptionTier"];
  const codeAccess = record["hasGrokCodeAccess"];
  return {
    ok: true,
    ...(typeof tier === "string" && tier.trim() ? { subscriptionTier: tier.trim() } : {}),
    ...(typeof codeAccess === "boolean" ? { hasCodeAccess: codeAccess } : {}),
  };
}
