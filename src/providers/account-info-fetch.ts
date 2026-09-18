import { infoRecord, infoText, sanitizeAccountInfo, type AccountInfo } from "./account-info.js";
import { GROK_USER_ENDPOINT } from "./xai/subscription-fetch.js";

export interface AccountInfoSource {
  id: string;
  provider: "anthropic_subscription" | "openai_subscription" | "xai_subscription";
  accessToken: string;
  expiresAt: number;
  enabled?: boolean;
  /** Anthropic only: the profile endpoint needs `user:profile`. */
  scopes?: string[];
}

export interface AccountInfoFetchOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
}

/** Display hints only: decoded claims never authorize a request or select a token. */
function tokenClaims(token: string): Record<string, unknown> {
  try {
    if (token.length > 64_000) return {};
    return infoRecord(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch { return {}; }
}

export async function fetchAccountInfo(
  account: AccountInfoSource,
  options: AccountInfoFetchOptions = {},
): Promise<AccountInfo | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const claims = account.provider === "openai_subscription" ? tokenClaims(account.accessToken) : {};
  const auth = infoRecord(claims["https://api.openai.com/auth"]);
  const workspaceId = infoText(auth.chatgpt_account_id);
  const headers: Record<string, string> = { authorization: `Bearer ${account.accessToken}`, accept: "application/json" };
  if (workspaceId) headers["chatgpt-account-id"] = workspaceId;
  const get = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const timeout = AbortSignal.timeout(10_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      // Never forward a credential to a redirect destination.
      const response = await fetchImpl(url, { headers, signal, redirect: "error" });
      if (!response.ok) return undefined;
      const body = await response.json();
      return Object.keys(infoRecord(body)).length ? infoRecord(body) : undefined;
    } catch {
      // Metadata is best effort. Neither raw responses nor errors reach logs/telemetry.
      return undefined;
    }
  };

  if (account.provider === "anthropic_subscription") {
    const body = await get("https://api.anthropic.com/api/oauth/profile");
    const user = infoRecord(body?.account);
    const org = infoRecord(body?.organization);
    if (!infoText(user.uuid) || !infoText(user.email, 254) || !infoText(org.uuid)) return undefined;
    const plans: Record<string, string> = { claude_pro: "Pro", claude_max: "Max", claude_team: "Team", claude_enterprise: "Enterprise" };
    const type = infoText(org.organization_type) ?? "";
    let plan = plans[type];
    if (type === "claude_max" && org.rate_limit_tier === "default_claude_max_5x") plan = "Max 5x";
    if (type === "claude_max" && org.rate_limit_tier === "default_claude_max_20x") plan = "Max 20x";
    return sanitizeAccountInfo({
      email: user.email, accountId: user.uuid, workspaceId: org.uuid, workspaceName: org.name,
      accountType: type === "claude_team" || type === "claude_enterprise" ? "workspace"
        : type === "claude_pro" || type === "claude_max" ? "personal" : "unknown",
      plan,
      subscription: {
        status: org.subscription_status, startedAt: org.subscription_created_at,
        trialEndsAt: org.claude_code_trial_ends_at,
      },
      fetchedAt: now(), fetchStatus: "fresh",
    });
  }

  if (account.provider === "xai_subscription") {
    const body = await get(GROK_USER_ENDPOINT);
    const plan = infoText(body?.subscriptionTier);
    // Identity/team and billing fields have not been verified for this endpoint.
    return plan ? sanitizeAccountInfo({ accountType: "unknown", plan, fetchedAt: now(), fetchStatus: "fresh" }) : undefined;
  }

  const [usage, listing] = await Promise.all([
    get("https://chatgpt.com/backend-api/wham/usage"),
    get("https://chatgpt.com/backend-api/wham/accounts/check"),
  ]);
  const matchingUsage = workspaceId && usage?.account_id === workspaceId ? usage : undefined;
  const entries = Array.isArray(listing?.accounts) ? listing.accounts : [];
  const selected = workspaceId ? entries.map(infoRecord).find(row => row.id === workspaceId) : undefined;
  const profile = infoRecord(claims["https://api.openai.com/profile"]);
  const email = infoText(matchingUsage?.email, 254) ?? infoText(profile.email, 254);
  const plan = infoText(selected?.plan_type) ?? infoText(matchingUsage?.plan_type) ?? infoText(auth.chatgpt_plan_type);
  if (!email && !plan && !selected) return undefined;
  const fresh = Boolean(matchingUsage && selected);
  return sanitizeAccountInfo({
    email, plan, workspaceId, workspaceName: selected?.name,
    accountId: matchingUsage?.user_id ?? auth.chatgpt_user_id,
    accountType: selected?.structure,
    ...(fresh ? { fetchedAt: now() } : {}),
    fetchStatus: fresh ? "fresh" : "stale",
  });
}
