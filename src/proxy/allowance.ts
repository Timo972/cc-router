import type { HealthAccountView, PublicCodexWindow } from "./server.js";

// The 7-day (weekly) window is the headline constraint for both providers —
// it is the one that actually forces a provider switch. The 5-hour window
// resets hourly-scale and is only a secondary, tie-breaking signal. This
// module is a PURE function over the already-in-memory HealthAccountView[]
// (no upstream fetch, no I/O) so polling it can never itself rate-limit an
// account.

const CONSTRAINED_THRESHOLD = 0.85;

export interface ProviderAllowance {
  status: "ok" | "constrained" | "exhausted";
  accountsTotal: number;
  accountsAvailable: number;
  sevenDayUtil: number | null;
  sevenDayHeadroom: number | null;
  sevenDaySpread: number | null;
  fiveHourUtil: number | null;
  earliestResetAt: number | null;
  coolingModelFamilies: string[];
}

export interface AllowanceView {
  ts: number;
  providers: {
    anthropic: ProviderAllowance;
    openai: ProviderAllowance;
  };
}

interface AccountWindows {
  sevenDayUtil: number | null;
  sevenDayResetMs: number | null;
  fiveHourUtil: number | null;
}

const NO_WINDOWS: AccountWindows = { sevenDayUtil: null, sevenDayResetMs: null, fiveHourUtil: null };

export function createAllowanceView(views: HealthAccountView[], now: number): AllowanceView {
  return {
    ts: now,
    providers: {
      anthropic: computeProviderAllowance(
        views.filter(v => v.provider === "anthropic_subscription"),
        now,
        anthropicWindows,
        isAnthropicRateLimited,
      ),
      openai: computeProviderAllowance(
        views.filter(v => v.provider === "openai_subscription"),
        now,
        openAIWindows,
        isOpenAIRateLimited,
      ),
    },
  };
}

function isCandidate(view: HealthAccountView): boolean {
  return view.enabled !== false;
}

function isCooling(view: HealthAccountView, now: number): boolean {
  return Math.max(view.cooldownUntilMs ?? 0, view.globalCooldownUntilMs ?? 0) > now;
}

function isAnthropicRateLimited(view: HealthAccountView): boolean {
  return view.rateLimits?.status === "rate_limited";
}

function isOpenAIRateLimited(view: HealthAccountView): boolean {
  return view.codexRateLimits?.status === "rate_limited";
}

function anthropicWindows(view: HealthAccountView): AccountWindows {
  const rl = view.rateLimits;
  if (!rl) return NO_WINDOWS;
  return {
    sevenDayUtil: typeof rl.sevenDayUtil === "number" ? rl.sevenDayUtil : null,
    sevenDayResetMs: rl.sevenDayReset > 0 ? rl.sevenDayReset * 1000 : null,
    fiveHourUtil: typeof rl.fiveHourUtil === "number" ? rl.fiveHourUtil : null,
  };
}

// The default Codex bucket carries two windows: a short one (primary,
// typically the 5h window) and a long one (secondary, typically the 7d /
// weekly window). We identify the weekly window by whichever has the LARGER
// windowMinutes rather than by name, since primary/secondary are positional,
// not semantic. If only one window is present it is treated as the weekly
// (7d-primary) signal and there is no secondary 5h reading.
function openAIWindows(view: HealthAccountView): AccountWindows {
  const bucket = view.codexRateLimits?.buckets?.[0];
  if (!bucket) return NO_WINDOWS;

  const windows: PublicCodexWindow[] = [bucket.primary, bucket.secondary]
    .filter((w): w is PublicCodexWindow => w != null);
  if (windows.length === 0) return NO_WINDOWS;

  const weekly = windows.reduce((best, w) => (w.windowMinutes > best.windowMinutes ? w : best));
  const short = windows.length > 1 ? windows.find(w => w !== weekly) ?? null : null;

  return {
    sevenDayUtil: weekly.utilization,
    sevenDayResetMs: weekly.resetAt > 0 ? weekly.resetAt * 1000 : null,
    fiveHourUtil: short ? short.utilization : null,
  };
}

function computeProviderAllowance(
  views: HealthAccountView[],
  now: number,
  windowsOf: (view: HealthAccountView) => AccountWindows,
  isRateLimited: (view: HealthAccountView) => boolean,
): ProviderAllowance {
  const candidates = views.filter(isCandidate);
  const available = candidates.filter(v => !isCooling(v, now) && !isRateLimited(v));

  const availableWindows = available.map(windowsOf);
  const sevenDayUtils = availableWindows
    .map(w => w.sevenDayUtil)
    .filter((u): u is number => u != null);
  const fiveHourUtils = availableWindows
    .map(w => w.fiveHourUtil)
    .filter((u): u is number => u != null);

  const worstSevenDayUtil = sevenDayUtils.length > 0 ? Math.max(...sevenDayUtils) : null;
  const bestSevenDayUtil = sevenDayUtils.length > 0 ? Math.min(...sevenDayUtils) : null;
  const sevenDayHeadroom = bestSevenDayUtil != null ? 1 - bestSevenDayUtil : null;
  const sevenDaySpread = worstSevenDayUtil != null && bestSevenDayUtil != null
    ? worstSevenDayUtil - bestSevenDayUtil
    : null;
  const fiveHourUtil = fiveHourUtils.length > 0 ? Math.min(...fiveHourUtils) : null;

  const accountsTotal = candidates.length;
  const accountsAvailable = available.length;

  let status: ProviderAllowance["status"];
  if (accountsAvailable === 0) {
    status = "exhausted";
  } else if (
    (bestSevenDayUtil != null && bestSevenDayUtil >= CONSTRAINED_THRESHOLD)
    || (fiveHourUtil != null && fiveHourUtil >= CONSTRAINED_THRESHOLD)
  ) {
    status = "constrained";
  } else {
    status = "ok";
  }

  const earliestResetAt = computeEarliestResetAt({
    status,
    accountsAvailable,
    available,
    candidates,
    windowsOf,
    now,
  });

  const coolingModelFamilies = Array.from(new Set(
    candidates.flatMap(v => (v.modelCooldowns ?? [])
      .filter(c => c.untilMs > now)
      .map(c => c.modelFamily)),
  )).sort();

  return {
    status,
    accountsTotal,
    accountsAvailable,
    sevenDayUtil: worstSevenDayUtil,
    sevenDayHeadroom,
    sevenDaySpread,
    fiveHourUtil,
    earliestResetAt,
    coolingModelFamilies,
  };
}

function computeEarliestResetAt(args: {
  status: ProviderAllowance["status"];
  accountsAvailable: number;
  available: HealthAccountView[];
  candidates: HealthAccountView[];
  windowsOf: (view: HealthAccountView) => AccountWindows;
  now: number;
}): number | null {
  const { status, accountsAvailable, available, candidates, windowsOf, now } = args;

  if (accountsAvailable > 0) {
    if (status !== "constrained") return null;
    const resets = available
      .map(windowsOf)
      .map(w => w.sevenDayResetMs)
      .filter((r): r is number => r != null);
    return resets.length > 0 ? Math.min(...resets) : null;
  }

  // Exhausted: the earliest moment capacity could plausibly return, per
  // candidate — whichever cooldown (account or global) is currently
  // enforced, or otherwise its weekly reset if that lies in the future.
  const candidateResets: number[] = [];
  for (const view of candidates) {
    const cooldownUntil = Math.max(view.cooldownUntilMs ?? 0, view.globalCooldownUntilMs ?? 0);
    if (cooldownUntil > now) {
      candidateResets.push(cooldownUntil);
      continue;
    }
    const sevenDayResetMs = windowsOf(view).sevenDayResetMs;
    if (sevenDayResetMs != null && sevenDayResetMs > now) {
      candidateResets.push(sevenDayResetMs);
    }
  }
  return candidateResets.length > 0 ? Math.min(...candidateResets) : null;
}
