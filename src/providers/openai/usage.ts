// Codex rate-limit reporting is bucket-based: a default account-level "codex"
// bucket plus optional named metered buckets, each published as an
// `x-<limit>-{primary,secondary}-*` header family. Discovery mirrors the
// Codex CLI (codex-rs/codex-api/src/rate_limits.rs): scan header names for
// the `-primary-used-percent` suffix.

export interface CodexRateWindow {
  utilization: number;
  resetAt: number;
  windowMinutes: number;
  /** Unix ms of the last response that actually reported *this* window — set
   *  at merge time, never by pure parsing. A response can carry one window of
   *  a bucket and not the other, so the bucket's own `lastSeenAt` is not an
   *  answer to "how long since we heard about this window". */
  lastSeenAt?: number;
}

export interface CodexLimitBucket {
  limitId: string;
  limitName?: string;
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
  /** Unix ms of this bucket's own last header update — set at merge time,
   *  never by pure parsing. Staleness self-healing keys off this rather than
   *  the account-wide lastUpdated so traffic on other buckets cannot defer a
   *  quiet bucket's recovery. */
  lastSeenAt?: number;
  /** Set by the sweep when every window this bucket carries has expired to
   *  zero, so the reap survives a pool cooldown holding the bucket back. A
   *  fresh report from upstream clears it — see `applyCodexRateLimits`.
   *  Internal bookkeeping: never parsed from headers, never serialized. */
  reapPending?: boolean;
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
/** Strips ASCII control characters (including ESC) from upstream-controlled header text. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/g;
/**
 * Reject a parsed reset timestamp (or clamp a window length) implausibly far
 * in the future rather than trust it verbatim. Matches the same 8-day trust
 * horizon already enforced downstream by `MAX_TRUSTED_RATE_LIMIT_RESET_MS`
 * (token-pool.ts) and `MAX_RATE_LIMIT_COOLDOWN_MS` (lease-lifecycle.ts) — a
 * malformed or malicious header must not be able to park an account in a
 * cooldown/exhausted state for months. A reset beyond the horizon is treated
 * as unknown (0), the same sentinel already used for "no usable reset value".
 */
export const MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC = 8 * 24 * 60 * 60;
const MAX_TRUSTED_WINDOW_MINUTES = MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC / 60;

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
  const horizonSec = nowSec + MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC;
  const absolute = headerNumber(headers, `${prefix}-${kind}-reset-at`);
  if (absolute !== undefined && absolute > 0) {
    const seconds = absolute > MS_TIMESTAMP_THRESHOLD ? Math.floor(absolute / 1000) : Math.floor(absolute);
    if (seconds > nowSec && seconds <= horizonSec) return seconds;
    // The absolute value is unusable (already past, or implausibly far out), so
    // fall through to the relative header rather than reporting "no reset
    // known". Giving up here would leave an exhausted window with no
    // trustworthy expiry — an indefinite block the pool can only clear via the
    // multi-hour staleness sweep — while the upstream had just advertised a
    // reset seconds or minutes away.
  }
  const relative = headerNumber(headers, `${prefix}-${kind}-reset-after-seconds`);
  if (relative !== undefined && relative > 0) {
    const candidate = nowSec + Math.floor(relative);
    return candidate <= horizonSec ? candidate : 0;
  }
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
    windowMinutes: windowMinutes !== undefined && windowMinutes > 0
      ? Math.min(Math.floor(windowMinutes), MAX_TRUSTED_WINDOW_MINUTES)
      : 0,
  };
}

function parseCredits(headers: Record<string, unknown>): CodexCredits | undefined {
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  if (hasCredits === undefined && unlimited === undefined) return undefined;
  const balance = headerString(headers, "x-codex-credits-balance")
    ?.replace(CONTROL_CHAR_PATTERN, "")
    .trim();
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

// ─── Usage endpoint payload (GET chatgpt.com/backend-api/wham/usage) ─────────
// The JSON twin of the `x-codex-*` header family: the same window fields
// (used_percent / limit_window_seconds / reset_after_seconds / reset_at)
// under `rate_limit.{primary,secondary}_window`, named buckets under
// `additional_rate_limits`, and a `credits` object. Parsed with the same
// trust rules as the headers — the payload is upstream-controlled data
// either way.

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageWindowFromJson(value: unknown, nowMs: number): CodexRateWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const window = value as Record<string, unknown>;
  const percent = usageNumber(window["used_percent"]);
  if (percent === undefined) return undefined;

  const nowSec = Math.floor(nowMs / 1000);
  const horizonSec = nowSec + MAX_TRUSTED_RATE_LIMIT_HORIZON_SEC;
  let resetAt = 0;
  const absolute = usageNumber(window["reset_at"]);
  if (absolute !== undefined && absolute > 0) {
    const seconds = absolute > MS_TIMESTAMP_THRESHOLD ? Math.floor(absolute / 1000) : Math.floor(absolute);
    if (seconds > nowSec && seconds <= horizonSec) resetAt = seconds;
  }
  if (resetAt === 0) {
    // Same fallback the header parser applies: an unusable absolute reset
    // must not discard a usable relative one (see parseResetAtSeconds).
    const relative = usageNumber(window["reset_after_seconds"]);
    if (relative !== undefined && relative > 0) {
      const candidate = nowSec + Math.floor(relative);
      if (candidate <= horizonSec) resetAt = candidate;
    }
  }

  const windowSeconds = usageNumber(window["limit_window_seconds"]);
  return {
    utilization: Math.max(0, Math.min(1, percent / 100)),
    resetAt,
    windowMinutes: windowSeconds !== undefined && windowSeconds > 0
      ? Math.min(Math.floor(windowSeconds / 60), MAX_TRUSTED_WINDOW_MINUTES)
      : 0,
  };
}

function usageBucketFromJson(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  nowMs: number,
): CodexLimitBucket | undefined {
  if (typeof rateLimit !== "object" || rateLimit === null) return undefined;
  const windows = rateLimit as Record<string, unknown>;
  const primary = usageWindowFromJson(windows["primary_window"], nowMs);
  const secondary = usageWindowFromJson(windows["secondary_window"], nowMs);
  if (!primary && !secondary) return undefined;
  return {
    limitId,
    ...(limitName ? { limitName: limitName.slice(0, 64) } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/**
 * Parse a usage-endpoint response body into the same update shape the
 * response-header parser produces, so both feed `applyCodexRateLimits`
 * identically. Returns null when the body is not a usage payload at all
 * (e.g. an error object) — as opposed to a payload with no windows, which
 * is a valid empty update.
 */
export function parseCodexUsagePayload(value: unknown, nowMs: number): CodexRateLimitsUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload["rate_limit"] !== "object" || payload["rate_limit"] === null) return null;

  const buckets: CodexLimitBucket[] = [];
  const defaultBucket = usageBucketFromJson(DEFAULT_CODEX_LIMIT_ID, undefined, payload["rate_limit"], nowMs);
  if (defaultBucket) buckets.push(defaultBucket);

  const additional = payload["additional_rate_limits"];
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const limitName = typeof record["limit_name"] === "string" ? record["limit_name"].trim() : undefined;
      const idSource = typeof record["metered_feature"] === "string" && record["metered_feature"].trim()
        ? record["metered_feature"]
        : limitName;
      if (!idSource) continue;
      const limitId = normalizeCodexLimitId(idSource);
      if (!/^[a-z0-9_]{1,64}$/.test(limitId) || limitId === DEFAULT_CODEX_LIMIT_ID) continue;
      const bucket = usageBucketFromJson(limitId, limitName, record["rate_limit"], nowMs);
      if (bucket) buckets.push(bucket);
    }
  }

  let credits: CodexCredits | undefined;
  const rawCredits = payload["credits"];
  if (typeof rawCredits === "object" && rawCredits !== null) {
    const record = rawCredits as Record<string, unknown>;
    const hasCredits = typeof record["has_credits"] === "boolean" ? record["has_credits"] : undefined;
    const unlimited = typeof record["unlimited"] === "boolean" ? record["unlimited"] : undefined;
    if (hasCredits !== undefined || unlimited !== undefined) {
      const balance = typeof record["balance"] === "string"
        ? record["balance"].replace(CONTROL_CHAR_PATTERN, "").trim()
        : undefined;
      credits = {
        hasCredits: hasCredits === true,
        unlimited: unlimited === true,
        ...(balance ? { balance: balance.slice(0, 32) } : {}),
      };
    }
  }

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
