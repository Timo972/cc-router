// Codex rate-limit reporting is bucket-based: a default account-level "codex"
// bucket plus optional named metered buckets, each published as an
// `x-<limit>-{primary,secondary}-*` header family. Discovery mirrors the
// Codex CLI (codex-rs/codex-api/src/rate_limits.rs): scan header names for
// the `-primary-used-percent` suffix.

export interface CodexRateWindow {
  utilization: number;
  resetAt: number;
  windowMinutes: number;
}

export interface CodexLimitBucket {
  limitId: string;
  limitName?: string;
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexRateLimits {
  status: "ok" | "rate_limited";
  buckets: Map<string, CodexLimitBucket>;
  credits?: CodexCredits;
  plan?: string;
  lastUpdated: number;
}

export interface CodexRateLimitsUpdate {
  buckets: CodexLimitBucket[];
  credits?: CodexCredits;
}

export const DEFAULT_CODEX_LIMIT_ID = "codex";

const USED_PERCENT_SUFFIX = "-primary-used-percent";
const MS_TIMESTAMP_THRESHOLD = 100_000_000_000;

export function createEmptyCodexRateLimits(): CodexRateLimits {
  return { status: "ok", buckets: new Map(), lastUpdated: 0 };
}

export function normalizeCodexLimitId(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function headerNumber(headers: Record<string, unknown>, name: string): number | undefined {
  const raw = headerString(headers, name)?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headerBool(headers: Record<string, unknown>, name: string): boolean | undefined {
  const raw = headerString(headers, name)?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

function parseResetAtSeconds(
  headers: Record<string, unknown>,
  prefix: string,
  kind: "primary" | "secondary",
  nowMs: number,
): number {
  const nowSec = Math.floor(nowMs / 1000);
  const absolute = headerNumber(headers, `${prefix}-${kind}-reset-at`);
  if (absolute !== undefined && absolute > 0) {
    const seconds = absolute > MS_TIMESTAMP_THRESHOLD ? Math.floor(absolute / 1000) : Math.floor(absolute);
    return seconds > nowSec ? seconds : 0;
  }
  const relative = headerNumber(headers, `${prefix}-${kind}-reset-after-seconds`);
  if (relative !== undefined && relative > 0) return nowSec + Math.floor(relative);
  return 0;
}

function parseWindow(
  headers: Record<string, unknown>,
  prefix: string,
  kind: "primary" | "secondary",
  nowMs: number,
): CodexRateWindow | undefined {
  const percent = headerNumber(headers, `${prefix}-${kind}-used-percent`);
  if (percent === undefined) return undefined;
  const windowMinutes = headerNumber(headers, `${prefix}-${kind}-window-minutes`);
  return {
    utilization: Math.max(0, Math.min(1, percent / 100)),
    resetAt: parseResetAtSeconds(headers, prefix, kind, nowMs),
    windowMinutes: windowMinutes !== undefined && windowMinutes > 0 ? Math.floor(windowMinutes) : 0,
  };
}

function parseCredits(headers: Record<string, unknown>): CodexCredits | undefined {
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  if (hasCredits === undefined && unlimited === undefined) return undefined;
  const balance = headerString(headers, "x-codex-credits-balance")?.trim();
  return {
    hasCredits: hasCredits === true,
    unlimited: unlimited === true,
    ...(balance ? { balance: balance.slice(0, 32) } : {}),
  };
}

export function parseCodexRateLimits(
  headers: Record<string, unknown>,
  nowMs: number,
): CodexRateLimitsUpdate {
  const limitIds = new Set<string>([DEFAULT_CODEX_LIMIT_ID]);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("x-") || !lower.endsWith(USED_PERCENT_SUFFIX)) continue;
    const limitId = normalizeCodexLimitId(lower.slice(2, -USED_PERCENT_SUFFIX.length));
    if (limitId) limitIds.add(limitId);
  }

  const buckets: CodexLimitBucket[] = [];
  for (const limitId of limitIds) {
    const prefix = `x-${limitId.replace(/_/g, "-")}`;
    const primary = parseWindow(headers, prefix, "primary", nowMs);
    const secondary = parseWindow(headers, prefix, "secondary", nowMs);
    if (!primary && !secondary) continue;
    const limitName = headerString(headers, `${prefix}-limit-name`)?.trim();
    buckets.push({
      limitId,
      ...(limitName ? { limitName: limitName.slice(0, 64) } : {}),
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
    });
  }

  const credits = parseCredits(headers);
  return { buckets, ...(credits ? { credits } : {}) };
}

export function resolveActiveLimit(headers: Record<string, unknown>): string | undefined {
  const raw = headerString(headers, "x-codex-active-limit")?.trim();
  if (!raw) return undefined;
  const normalized = normalizeCodexLimitId(raw);
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : undefined;
}

export function decodeOpenAIPlan(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const plan = (auth as { chatgpt_plan_type?: unknown }).chatgpt_plan_type;
    if (typeof plan !== "string") return undefined;
    const normalized = plan.trim().toLowerCase().slice(0, 32);
    return /^[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}
