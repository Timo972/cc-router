/** Private account-list metadata. Never include this object in health or telemetry. */
export interface AccountInfo {
  email?: string;
  accountId?: string;
  accountType: "personal" | "workspace" | "unknown";
  workspaceId?: string;
  workspaceName?: string;
  plan?: string;
  subscription?: {
    status?: string;
    startedAt?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    renewsAt?: string;
    cancelAtPeriodEnd?: boolean;
    trialEndsAt?: string;
  };
  fetchedAt?: number;
  fetchStatus: "fresh" | "stale" | "unavailable";
}

export function infoRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Reject, rather than truncate, control-bearing/unbounded provider strings. */
export function infoText(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  return text;
}

function timestamp(value: unknown): string | undefined {
  // Only explicit timestamps, not ambiguous local dates, seconds, or durations.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** Used at both provider and client boundaries; no arbitrary properties survive. */
export function sanitizeAccountInfo(value: unknown): AccountInfo | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = infoRecord(value);
  const info: AccountInfo = {
    accountType: raw.accountType === "personal" || raw.accountType === "workspace" ? raw.accountType : "unknown",
    fetchStatus: raw.fetchStatus === "fresh" || raw.fetchStatus === "stale" ? raw.fetchStatus : "unavailable",
  };
  for (const key of ["email", "accountId", "workspaceId", "workspaceName", "plan"] as const) {
    const text = infoText(raw[key], key === "email" ? 254 : 160);
    if (text) info[key] = text;
  }
  if (typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt) && raw.fetchedAt > 0) info.fetchedAt = raw.fetchedAt;
  const sub = infoRecord(raw.subscription);
  const subscription: NonNullable<AccountInfo["subscription"]> = {};
  const status = infoText(sub.status, 64);
  if (status) subscription.status = status;
  for (const key of ["startedAt", "currentPeriodStart", "currentPeriodEnd", "renewsAt", "trialEndsAt"] as const) {
    const date = timestamp(sub[key]);
    if (date) subscription[key] = date;
  }
  if (typeof sub.cancelAtPeriodEnd === "boolean") subscription.cancelAtPeriodEnd = sub.cancelAtPeriodEnd;
  if (Object.keys(subscription).length) info.subscription = subscription;
  return info;
}

export function formatAccountInfo(value: AccountInfo | undefined): string {
  const info = sanitizeAccountInfo(value);
  if (!info) return "";
  const parts = [info.email, info.accountType === "unknown" ? undefined : info.accountType, info.workspaceName, info.plan];
  const sub = info.subscription;
  if (sub?.status) parts.push(sub.status);
  if (sub?.cancelAtPeriodEnd && sub.currentPeriodEnd) parts.push(`Ends ${sub.currentPeriodEnd.slice(0, 10)}`);
  else if (sub?.renewsAt) parts.push(`Renews ${sub.renewsAt.slice(0, 10)}`);
  else if (sub?.startedAt) parts.push(`Since ${sub.startedAt.slice(0, 10)}`);
  if (sub?.trialEndsAt) parts.push(`Trial ends ${sub.trialEndsAt.slice(0, 10)}`);
  if (info.fetchStatus !== "fresh") parts.push(`metadata ${info.fetchStatus}`);
  return parts.filter(Boolean).join(" · ");
}
