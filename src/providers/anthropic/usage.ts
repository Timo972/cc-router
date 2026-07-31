import type {
  AccountUsageSnapshot,
  ExtraUsageState,
  ModelRateLimit,
  RateLimitWindow,
} from "../../proxy/types.js";

type UnknownRecord = Record<string, unknown>;

const USAGE_FIELDS = new Set([
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "limits",
  "extra_usage",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function utilization(value: unknown): number {
  const number = numberValue(value);
  if (number === undefined) return 0;
  return Math.max(0, Math.min(1, number / 100));
}

function resetAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value > 10_000_000_000 ? value / 1_000 : value));
  }
  if (typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : 0;
}

function getFirst(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  return {
    utilization: utilization(getFirst(value, ["utilization", "percentage", "percent"])),
    resetAt: resetAt(getFirst(value, ["resets_at", "reset_at", "resetAt"])),
  };
}

/** Normalize an upstream model id or display name into a stable routing family. */
export function normalizeModelFamily(modelIdOrName: string | undefined): string | undefined {
  const input = modelIdOrName?.trim().toLowerCase();
  if (!input) return undefined;

  for (const family of ["fable", "sonnet", "opus", "haiku"]) {
    if (input.includes(family)) return family;
  }

  const slug = input
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || undefined;
}

function modelDetails(limit: UnknownRecord): { modelId?: string; displayName: string; modelFamily: string } | undefined {
  const model = isRecord(limit.model) ? limit.model : undefined;
  const modelId = stringValue(getFirst(limit, ["model_id", "modelId"]))
    ?? (model ? stringValue(getFirst(model, ["id", "model_id"])) : undefined);
  const displayName = stringValue(getFirst(limit, ["model_name", "display_name", "displayName"]))
    ?? (typeof limit.model === "string" ? stringValue(limit.model) : undefined)
    ?? (model ? stringValue(getFirst(model, ["display_name", "displayName", "name"])) : undefined)
    ?? modelId;
  const modelFamily = normalizeModelFamily(modelId ?? displayName);
  if (!displayName || !modelFamily) return undefined;
  return { ...(modelId ? { modelId } : {}), displayName, modelFamily };
}

function parseModelLimit(value: unknown): ModelRateLimit | undefined {
  if (!isRecord(value) || stringValue(value.kind) !== "weekly_scoped") return undefined;
  const model = modelDetails(value);
  if (!model) return undefined;
  return {
    kind: "weekly_scoped",
    group: stringValue(value.group) ?? "weekly",
    ...model,
    utilization: utilization(getFirst(value, ["utilization", "percentage", "percent"])),
    resetAt: resetAt(getFirst(value, ["resets_at", "reset_at", "resetAt"])),
    active: typeof value.active === "boolean" ? value.active : true,
    severity: stringValue(value.severity) ?? "",
  };
}

function parseExtraUsage(value: unknown): ExtraUsageState | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = getFirst(value, ["is_enabled", "enabled"]) === true;
  const disabledReason = stringValue(getFirst(value, ["disabled_reason", "disabledReason", "reason"]));
  const usedMinor = numberValue(getFirst(value, ["used_minor", "used_credits", "used"]));
  const limitMinor = numberValue(getFirst(value, ["limit_minor", "monthly_limit", "spend_limit", "limit"]));
  const explicitReached = getFirst(value, ["spend_limit_reached", "is_spend_limit_reached"]);
  const spendLimitReached = explicitReached === true
    || (usedMinor !== undefined && limitMinor !== undefined && limitMinor >= 0 && usedMinor >= limitMinor);
  const parsed: ExtraUsageState = { enabled, spendLimitReached };
  if (disabledReason) parsed.disabledReason = disabledReason;
  const rawUtilization = getFirst(value, ["utilization", "percentage", "percent"]);
  if (rawUtilization !== undefined) parsed.utilization = utilization(rawUtilization);
  const currency = stringValue(value.currency);
  if (currency) parsed.currency = currency;
  if (usedMinor !== undefined) parsed.usedMinor = usedMinor;
  if (limitMinor !== undefined) parsed.limitMinor = limitMinor;
  return parsed;
}

function legacyModelLimit(family: string, value: unknown): ModelRateLimit | undefined {
  const window = parseWindow(value);
  if (!window) return undefined;
  return {
    kind: "weekly_scoped",
    group: "weekly",
    modelFamily: family,
    displayName: family,
    ...window,
    active: true,
    severity: "",
  };
}

/** Parse the OAuth usage endpoint without retaining its provider-specific payload. */
export function parseAnthropicUsage(value: unknown, fetchedAt: number): AccountUsageSnapshot | null {
  if (!isRecord(value) || !Object.keys(value).some((key) => USAGE_FIELDS.has(key))) return null;

  const limits = Array.isArray(value.limits) ? value.limits : undefined;
  const modelLimits = limits
    ? limits.map(parseModelLimit).filter((limit): limit is ModelRateLimit => limit !== undefined)
    : [
      legacyModelLimit("sonnet", value.seven_day_sonnet),
      legacyModelLimit("opus", value.seven_day_opus),
    ].filter((limit): limit is ModelRateLimit => limit !== undefined);

  const snapshot: AccountUsageSnapshot = {
    modelLimits,
    fetchedAt,
    fetchStatus: "fresh",
  };
  const fiveHour = parseWindow(value.five_hour);
  const sevenDay = parseWindow(value.seven_day);
  const extraUsage = parseExtraUsage(value.extra_usage);
  if (fiveHour) snapshot.fiveHour = fiveHour;
  if (sevenDay) snapshot.sevenDay = sevenDay;
  if (extraUsage) snapshot.extraUsage = extraUsage;
  return snapshot;
}

export function canUseExtraUsage(state: ExtraUsageState | undefined): boolean {
  return state?.enabled === true
    && state.spendLimitReached === false
    && !state.disabledReason;
}
