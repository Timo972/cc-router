import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout, measureElement } from "ink";
import type { DOMElement } from "ink";
import type { LogEntry } from "../proxy/stats.js";
import { createAccountsApi } from "./accountsApi.js";
import type { AccountsApi } from "./accountsApi.js";
import { createModelsApi } from "./modelsApi.js";
import type { ModelEntry, ModelsApi, ModelsStatus } from "./modelsApi.js";
import { getCurrentVersion } from "../utils/self-update.js";

const POLL_INTERVAL_MS = 2_000;
/** Most activity rows the dashboard will show — the list shrinks below this
 *  (down to MIN_LOG_VISIBLE) when the terminal is too short for the full
 *  frame. Ink can only erase as many lines as the viewport holds, so a frame
 *  taller than the terminal makes every poll re-append it — scrolling the
 *  header and OPERATIONS panel permanently out of view. */
const LOG_VISIBLE = 20;
const MIN_LOG_VISIBLE = 3;
/** The model window may shrink to a single row: it follows its selection, so
 *  one visible row IS the selected row — while a larger minimum rendered
 *  rows below the clip that the selection could land on invisibly. */
const MIN_MODELS_VISIBLE = 1;
const MODEL_VISIBLE_ROWS = 16;
const DASHBOARD_VERSION = getCurrentVersion();
// Distinguishes "this machine's daemon" (restartable from this shell) from a
// remote router the dashboard is merely pointed at.
const LOCAL_TARGET_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountRateLimitsView {
  status: string;
  fiveHourUtil: number;
  fiveHourReset: number;
  sevenDayUtil: number;
  sevenDayReset: number;
  claim: string;
  plan: string;
  requestsLimit: number;
  lastUpdated: number;
  usage?: AccountUsageView;
}

interface AccountUsageView {
  fiveHour?: { utilization: number; resetAt: number };
  sevenDay?: { utilization: number; resetAt: number };
  modelLimits: AccountModelLimitView[];
  extraUsage?: { enabled: boolean; spendLimitReached: boolean; usable: boolean };
  fetchedAt: number;
  fetchStatus: "fresh" | "stale" | "unavailable";
}

interface AccountModelLimitView {
  modelFamily: string;
  displayName: string;
  utilization: number;
  resetAt: number;
  active: boolean;
  severity: "" | "warning" | "critical" | "unknown";
}

export interface CodexRateLimitsView {
  status: "ok" | "rate_limited";
  plan: string;
  buckets: Array<{
    limitId: string;
    label: string;
    primary?: { utilization: number; resetAt: number; windowMinutes: number };
    secondary?: { utilization: number; resetAt: number; windowMinutes: number };
    cooldownUntilMs: number;
  }>;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  resetCredits?: { available: number };
  lastUpdated: number;
}

interface AccountStat {
  id: string;
  provider?: "anthropic_subscription" | "openai_subscription";
  healthy: boolean;
  busy: boolean;
  inFlightRequests?: number;
  activeSessions?: number;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
  rateLimits?: AccountRateLimitsView;
  enabled?: boolean;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
  globalCooldownUntilMs?: number;
  modelCooldowns?: Array<{ modelFamily: string; untilMs: number }>;
  codexRateLimits?: CodexRateLimitsView;
  credentialsPendingWrite?: boolean;
}

const EMPTY_RL: AccountRateLimitsView = {
  status: "unknown", fiveHourUtil: 0, fiveHourReset: 0,
  sevenDayUtil: 0, sevenDayReset: 0, claim: "", plan: "",
  requestsLimit: 0, lastUpdated: 0,
};

interface GlobalCapacityView {
  fiveHour: { utilization: number; resetAt: number };
  sevenDay: { utilization: number; resetAt: number };
  usageFetchStatus?: AccountUsageView["fetchStatus"];
}

/** Match TokenPool's source precedence for the dashboard's global windows. */
export function getGlobalCapacityView(rateLimits: AccountRateLimitsView): GlobalCapacityView {
  const usage = rateLimits.usage;
  const snapshotIsCurrent = usage !== undefined &&
    usage.fetchStatus !== "unavailable" &&
    usage.fetchedAt >= rateLimits.lastUpdated;
  const usageFetchStatus = usage?.fetchStatus === "fresh" && !snapshotIsCurrent
    ? "stale"
    : usage?.fetchStatus;

  return {
    fiveHour: snapshotIsCurrent && usage.fiveHour
      ? usage.fiveHour
      : { utilization: rateLimits.fiveHourUtil, resetAt: rateLimits.fiveHourReset },
    sevenDay: snapshotIsCurrent && usage.sevenDay
      ? usage.sevenDay
      : { utilization: rateLimits.sevenDayUtil, resetAt: rateLimits.sevenDayReset },
    usageFetchStatus,
  };
}

export interface AccountCapacityRow {
  label: string;
  state: string;
  color: "green" | "yellow" | "red" | "gray";
  utilization?: number;
  resetAt?: number;
}

/** Turn the safe account payload into compact dynamic model/cooldown rows. */
export function getAccountCapacityRows(account: Pick<AccountStat, "rateLimits" | "globalCooldownUntilMs" | "modelCooldowns">): AccountCapacityRow[] {
  const usage = account.rateLimits?.usage;
  const modelCooldowns = account.modelCooldowns ?? [];
  const rows: AccountCapacityRow[] = [];
  const matchedCooldowns = new Set<string>();
  const now = Date.now();
  if (usage?.modelLimits.length) {
    const usageFetchStatus = usage.fetchStatus === "fresh" &&
      usage.fetchedAt < (account.rateLimits?.lastUpdated ?? 0)
      ? "stale"
      : usage.fetchStatus;
    const usageState = usageFetchStatus === "fresh" ? undefined : `usage ${usageFetchStatus}`;
    const paidExtraAvailable = usage.extraUsage?.usable === true;
    for (const limit of usage.modelLimits) {
      const requestedCooldown = modelCooldowns.find(cooldown =>
        cooldown.modelFamily === limit.modelFamily && cooldown.untilMs > now,
      );
      const exhausted = limit.utilization >= 1;
      const capacityState = usageState
        ? usageState
        : !limit.active
        ? "inactive"
        : exhausted && paidExtraAvailable
          ? "paid extra active"
          : exhausted
            ? "exhausted"
            : "included available";
      const state = requestedCooldown
        ? `${capacityState} · requested-model cooldown`
        : capacityState;
      if (requestedCooldown) matchedCooldowns.add(requestedCooldown.modelFamily);
      const color: AccountCapacityRow["color"] = requestedCooldown ? "yellow"
        : usageState ? usageFetchStatus === "stale" ? "yellow" : "gray"
        : !limit.active ? "gray"
          : exhausted && paidExtraAvailable ? "yellow"
            : exhausted || limit.severity === "critical" ? "red"
              : limit.severity === "warning" || limit.utilization >= 0.7 ? "yellow"
                : "green";
      rows.push({
        label: limit.displayName,
        state,
        color,
        utilization: limit.utilization,
        resetAt: limit.resetAt,
      });
    }
  }
  for (const cooldown of modelCooldowns) {
    if (matchedCooldowns.has(cooldown.modelFamily) || cooldown.untilMs <= now) continue;
    rows.push({
      label: `cooldown ${cooldown.modelFamily}`,
      state: "requested-model cooldown",
      color: "yellow",
      resetAt: Math.floor(cooldown.untilMs / 1_000),
    });
  }
  if (account.globalCooldownUntilMs && account.globalCooldownUntilMs > now) {
    rows.push({ label: "cooldown", state: "global", color: "red", resetAt: Math.floor(account.globalCooldownUntilMs / 1_000) });
  }
  return rows;
}

function codexWindowLabel(windowMinutes: number, fallback: "5h" | "weekly"): string {
  // 10_080 minutes reads better as "weekly" than the generic "168h"; 300 needs
  // no special case because the generic branch already renders it as "5h".
  if (windowMinutes === 10_080) return "weekly";
  if (windowMinutes > 0) {
    return windowMinutes % 60 === 0 ? `${windowMinutes / 60}h` : `${windowMinutes}m`;
  }
  return fallback;
}

type CodexWindow = { utilization: number; resetAt: number; windowMinutes: number };

/**
 * Whether a reported window carries real data.
 *
 * Codex sends absent windows as all-zero placeholders rather than omitting the
 * field, so a truthiness check treats "no such window" as a window with no
 * duration — which then renders under a guessed label.
 */
function hasWindow(window: CodexWindow | undefined): window is CodexWindow {
  return window !== undefined && window.windowMinutes > 0;
}

export interface CodexDefaultWindow {
  label: string;
  utilization: number;
  resetAt: number;
  /** Which user-configured cap applies: the 5h cap or the 7d cap. */
  kind: "session" | "weekly";
}

/**
 * The default (`codex`) bucket's windows, each labelled from its own duration.
 *
 * These used to be read positionally — `primary` as the 5h window, `secondary`
 * as the weekly one. Codex reports the weekly window in `primary` and leaves
 * `secondary` empty, so an account at 100% of its weekly quota displayed as
 * "5h 100%" beside a "weekly 0%" bar that was really the empty slot. The reset
 * countdown gave it away: a 5h window cannot reset five days out.
 */
export function getCodexDefaultWindows(
  codex: CodexRateLimitsView | undefined,
): CodexDefaultWindow[] {
  const bucket = codex?.buckets.find(b => b.limitId === "codex");
  if (!bucket) return [];

  const windows: CodexDefaultWindow[] = [];
  for (const [window, fallback] of [
    [bucket.primary, "5h"] as const,
    [bucket.secondary, "weekly"] as const,
  ]) {
    if (!hasWindow(window)) continue;
    windows.push({
      label: codexWindowLabel(window.windowMinutes, fallback),
      utilization: window.utilization,
      resetAt: window.resetAt,
      kind: window.windowMinutes >= 10_080 ? "weekly" : "session",
    });
  }
  return windows;
}

/** Named Codex metered buckets as compact capacity rows (default bucket renders as bars). */
export function getCodexCapacityRows(
  codex: CodexRateLimitsView | undefined,
  globalCooldownUntilMs: number | undefined,
  now = Date.now(),
): AccountCapacityRow[] {
  const rows: AccountCapacityRow[] = [];
  for (const bucket of codex?.buckets ?? []) {
    if (bucket.limitId === "codex") continue;
    const cooling = bucket.cooldownUntilMs > now;
    const windows: Array<{ label: string; utilization: number; resetAt: number }> = [];
    // A zero-width window is Codex's placeholder for "this bucket has no such
    // window", not a real one — it arrives as an all-zero object rather than
    // being omitted. Rendering it duplicated the bucket, and both rows carried
    // the same label because codexWindowLabel(0) falls through to its fallback.
    if (hasWindow(bucket.primary)) {
      windows.push({ label: codexWindowLabel(bucket.primary.windowMinutes, "5h"), ...bucket.primary });
    }
    if (hasWindow(bucket.secondary)) {
      windows.push({ label: codexWindowLabel(bucket.secondary.windowMinutes, "weekly"), ...bucket.secondary });
    }

    for (const window of windows) {
      const exhausted = window.utilization >= 1;
      // While cooling, the countdown that matters is the cooldown's own expiry
      // — it can come from Retry-After and outlast (or replace) the window
      // reset, and a row labeled "bucket cooldown" showing the window's reset
      // instant, or no time at all when that reset is unknown, tells the
      // operator the wrong thing about when routing resumes.
      const resetAt = cooling
        ? Math.floor(bucket.cooldownUntilMs / 1000)
        : window.resetAt;
      rows.push({
        label: `${bucket.label} ${window.label}`,
        state: cooling ? "bucket cooldown" : exhausted ? "exhausted" : "available",
        color: cooling ? "yellow" : exhausted ? "red" : window.utilization >= 0.7 ? "yellow" : "green",
        utilization: window.utilization,
        ...(resetAt > 0 ? { resetAt } : {}),
      });
    }
    if (windows.length === 0 && cooling) {
      rows.push({
        label: bucket.label,
        state: "bucket cooldown",
        color: "yellow",
        resetAt: Math.floor(bucket.cooldownUntilMs / 1000),
      });
    }
  }
  if (globalCooldownUntilMs && globalCooldownUntilMs > now) {
    rows.push({ label: "cooldown", state: "global", color: "red", resetAt: Math.floor(globalCooldownUntilMs / 1000) });
  }
  return rows;
}

/**
 * True when an OpenAI/Codex account is hard-blocked from routing: the
 * account-wide status reports `rate_limited`, or the default bucket
 * (`limitId === "codex"`) has a fully exhausted primary or secondary window.
 * Named model-scoped buckets exhausting on their own does not count — the
 * account can still serve other models via those buckets' fallback.
 */
export function isCodexLimited(codex: CodexRateLimitsView | undefined): boolean {
  if (!codex) return false;
  if (codex.status === "rate_limited") return true;
  const defaultBucket = codex.buckets.find(bucket => bucket.limitId === "codex");
  if (!defaultBucket) return false;
  return (defaultBucket.primary?.utilization ?? 0) >= 1 || (defaultBucket.secondary?.utilization ?? 0) >= 1;
}

export function isOpenAIAccount(account: Pick<AccountStat, "provider">): boolean {
  return account.provider === "openai_subscription";
}

/** Compact `rst` column: banked Codex usage-limit resets. Claude is an em dash. */
export function resetCreditsColumnLabel(
  account: Pick<AccountStat, "provider" | "codexRateLimits">,
): string {
  if (!isOpenAIAccount(account)) return "—";
  return String(account.codexRateLimits?.resetCredits?.available ?? 0);
}

export function isLimitedAccount(
  account: Pick<AccountStat, "provider" | "codexRateLimits" | "rateLimits">,
): boolean {
  if (isOpenAIAccount(account)) return isCodexLimited(account.codexRateLimits);
  if (account.rateLimits?.status === "rate_limited") return true;
  if (!account.rateLimits) return false;
  const view = getGlobalCapacityView(account.rateLimits);
  return view.fiveHour.utilization >= 1 || view.sevenDay.utilization >= 1;
}

/** Claude first, ChatGPT second; within each group, accounts at limit last. */
export function orderAccountsForDashboard<T extends Pick<AccountStat, "provider" | "codexRateLimits" | "rateLimits">>(
  accounts: T[],
): T[] {
  const usableThenLimited = (list: T[]) => [
    ...list.filter(account => !isLimitedAccount(account)),
    ...list.filter(account => isLimitedAccount(account)),
  ];
  return [
    ...usableThenLimited(accounts.filter(account => !isOpenAIAccount(account))),
    ...usableThenLimited(accounts.filter(isOpenAIAccount)),
  ];
}

/** Compact view hides healthy/inactive model rows; selection shows the full set. */
export function visibleCapacityRows(rows: AccountCapacityRow[], selected: boolean): AccountCapacityRow[] {
  if (selected) return rows;
  return rows.filter(row => row.color === "red" || row.color === "yellow");
}

export function noteModelLimit(
  account: Pick<AccountStat, "rateLimits">,
): { label: string; utilization: number; color: AccountCapacityRow["color"] } | undefined {
  const limits = account.rateLimits?.usage?.modelLimits ?? [];
  if (limits.length === 0) return undefined;
  const fable = limits.find(limit =>
    limit.modelFamily === "fable" || /fable/i.test(limit.displayName),
  );
  const limit = fable ?? limits.find(entry => entry.active) ?? limits[0];
  if (!limit) return undefined;
  const utilization = limit.utilization;
  const color: AccountCapacityRow["color"] = utilization >= 1 || limit.severity === "critical"
    ? "red"
    : utilization >= 0.7 || limit.severity === "warning"
      ? "yellow"
      : "green";
  return {
    label: limit.displayName.replace(/^Claude\s+/i, ""),
    utilization,
    color,
  };
}

/** ChatGPT accounts with a known plan but no usage windows (e.g. Pro). */
export function openaiQuotaGapNote(
  account: Pick<AccountStat, "provider" | "codexRateLimits">,
): string | undefined {
  if (!isOpenAIAccount(account)) return undefined;
  if (getCodexDefaultWindows(account.codexRateLimits).length > 0) return undefined;
  const plan = account.codexRateLimits?.plan?.trim();
  return plan ? `${plan} · no quota` : "no quota";
}

export function isWeeklyLimited(account: Pick<AccountStat, "provider" | "codexRateLimits" | "rateLimits">): boolean {
  if (isOpenAIAccount(account)) {
    return getCodexDefaultWindows(account.codexRateLimits).some(
      window => window.kind === "weekly" && window.utilization >= 1,
    );
  }
  if (!account.rateLimits) return false;
  return getGlobalCapacityView(account.rateLimits).sevenDay.utilization >= 1;
}

export function earliestWeeklyReset(accounts: AccountStat[]): number | undefined {
  let earliest: number | undefined;
  for (const account of accounts) {
    if (isOpenAIAccount(account)) {
      for (const window of getCodexDefaultWindows(account.codexRateLimits)) {
        if (window.kind !== "weekly" || window.resetAt <= 0) continue;
        if (earliest === undefined || window.resetAt < earliest) earliest = window.resetAt;
      }
    } else if (account.rateLimits) {
      const resetAt = getGlobalCapacityView(account.rateLimits).sevenDay.resetAt;
      if (resetAt > 0 && (earliest === undefined || resetAt < earliest)) earliest = resetAt;
    }
  }
  return earliest;
}

/**
 * First visible row of a scrolling list window that follows its selection.
 *
 * The window stays where it is while the selection moves inside it, and
 * shifts just far enough to contain the selection when it crosses an edge —
 * one row per one-row step, but any distance when the selection jumps (it is
 * timestamp-anchored, so a burst of new entries can move it many rows at
 * once). A stale `scrollTop` from a longer list clamps back into range.
 */
export function followScrollWindow(
  scrollTop: number,
  selectedIndex: number,
  total: number,
  visible: number,
): number {
  const maxTop = Math.max(0, total - visible);
  let top = Math.min(Math.max(0, scrollTop), maxTop);
  if (selectedIndex < top) top = selectedIndex;
  else if (selectedIndex > top + visible - 1) top = selectedIndex - visible + 1;
  return Math.min(Math.max(0, top), maxTop);
}

// ─── Viewport fit planner ─────────────────────────────────────────────────────

/** One windowed list the viewport fitting controller may resize. Order in
 *  the `lists` array is SHRINK priority (first shrinks first); growth walks
 *  the array in reverse, so the last list is the most protected. */
export interface FitList {
  key: string;
  /** Currently rendered row count. */
  current: number;
  min: number;
  max: number;
  /** MEASURED average lines per rendered row (≥ 1). Every amount the planner
   *  computes is converted through this — treating a row as one line is
   *  exactly the assumption that made each list oscillate in turn (tall
   *  accounts, wrapped activity details, wrapped model ids). */
  avgRow: number;
  /** Grow one row per step instead of filling the slack — for lists whose
   *  row heights vary so wildly that even the average misleads. */
  growOne?: boolean;
}

export interface FitAttempt { to: number; slack: number; expiresAt?: number; count?: number }

/** Cross-commit memory: the growth attempted last step, and growths that
 *  overflowed (denied) together with the slack they would actually need. */
export interface FitMemory {
  attempts: Record<string, FitAttempt | undefined>;
  denials: Record<string, FitAttempt | undefined>;
}

/**
 * How long a denied growth stays denied. A denial is measured against
 * concrete rendered row heights, and those can change through ordinary data
 * updates the reset key cannot enumerate (an account gaining or losing
 * capacity rows, a scrolled window showing different entries). Expiry is the
 * general cure: a stale denial costs at most one clipped grow/shrink pair
 * per TTL — invisible under the frame bound — instead of a list that stays
 * collapsed until an unrelated resize.
 */
export const FIT_DENIAL_TTL_MS = 2_500;

/**
 * One reallocation step for the height-fitting controller. `excess` is the
 * measured content height minus the viewport budget: positive shrinks lists
 * in array order until covered; negative (slack) grows exactly ONE list —
 * the last eligible in the array — so a single mispredicted growth can be
 * attributed, denied, and refined rather than compounding.
 *
 * Denial rule: a growth whose commit overflows is remembered with the slack
 * it actually needs (the slack it had plus the overflow it caused) and is
 * not retried below that; the next attempt steps DOWN from the denied
 * target. Targets only ever decrease under denial, so refinement
 * terminates. Callers reset the memory whenever row heights may have
 * changed (viewport, fleet, or data identity).
 */
export function planViewportFit(
  excess: number,
  lists: FitList[],
  memory: FitMemory,
  now = 0,
): Record<string, number> {
  const targets: Record<string, number> = {};
  // An expired denial stops CLAMPING but is not forgotten: its retry count
  // must survive the lapse, or the escalating backoff restarts at the base
  // TTL on every re-denial and a permanently tall hidden row gets probed
  // every few seconds forever. The record is deleted only when a retried
  // growth finally fits (geometry improved) or the caller resets the memory.
  const activeDenial = (key: string): FitAttempt | undefined => {
    const denied = memory.denials[key];
    return denied && (denied.expiresAt === undefined || denied.expiresAt > now) ? denied : undefined;
  };

  if (excess > 0) {
    for (const list of lists) {
      const attempt = memory.attempts[list.key];
      if (attempt && attempt.to === list.current) {
        // Re-denials escalate the TTL (capped at a minute): a hidden row that
        // stays tall would otherwise be probed every TTL forever, while one
        // that changed shape is picked up on the next expiry. The count
        // continues from ANY prior denial of this list — including a lapsed
        // one, and regardless of the target (the frontier is monotone while
        // active, so a different target means a lapse happened in between).
        const count = (memory.denials[list.key]?.count ?? 0) + 1;
        memory.denials[list.key] = {
          to: attempt.to,
          slack: attempt.slack + excess,
          count,
          expiresAt: now + Math.min(60_000, FIT_DENIAL_TTL_MS * 2 ** (count - 1)),
        };
      }
      delete memory.attempts[list.key];
    }
    let remaining = excess;
    for (const list of lists) {
      if (remaining <= 0) break;
      const drop = Math.min(list.current - list.min, Math.ceil(remaining / list.avgRow));
      if (drop > 0) {
        targets[list.key] = list.current - drop;
        remaining = Math.max(0, remaining - drop * list.avgRow);
      }
    }
    return targets;
  }

  for (const list of lists) {
    // A standing attempt in the fitting branch means last commit's growth
    // fit. That disproves a denial only when the growth reached the denied
    // target — a smaller growth fitting says nothing about the larger one,
    // and resetting on it would let the denied target be retried in a loop.
    const attempt = memory.attempts[list.key];
    const denied = memory.denials[list.key];
    if (attempt && denied && attempt.to >= denied.to) delete memory.denials[list.key];
    delete memory.attempts[list.key];
  }
  const slack = -excess;
  for (let i = lists.length - 1; i >= 0; i--) {
    const list = lists[i];
    if (list.current >= list.max) continue;
    // The slack alone may not cover this list's growth gate after a
    // lower-priority list absorbed it (e.g. logs grew while an account
    // growth was denied). A higher-priority growth may RECLAIM budget by
    // shrinking lower-priority lists in the same step — without this, an
    // expired denial finds no slack left and the list stays collapsed.
    const unitCost = Math.max(1, Math.ceil(list.avgRow));
    const gate = list.growOne ? unitCost + 1 : 2;
    let usable = slack;
    const funding: Array<{ key: string; to: number }> = [];
    if (usable < gate) {
      if (i === 0) continue; // no lower-priority lists to fund from — the gate stands
      // Fund one row's ACTUAL cost, not the gate: the +1 hysteresis margin
      // applies only to free-slack growth — a funded growth is protected
      // from flapping by the denial memory, and demanding the margin here
      // made a growth permanently unfundable when lower-priority lists
      // could yield exactly the row's height and nothing more.
      let deficit = unitCost - usable;
      for (let j = 0; j < i && deficit > 0; j++) {
        const funder = lists[j];
        const dropMax = funder.current - funder.min;
        if (dropMax <= 0) continue;
        const drop = Math.min(dropMax, Math.ceil(deficit / funder.avgRow));
        funding.push({ key: funder.key, to: funder.current - drop });
        deficit -= drop * funder.avgRow;
      }
      if (deficit > 0) continue; // cannot fund this growth — try lower priority
      usable = Math.max(usable, unitCost);
    }
    let target = list.growOne
      ? list.current + 1
      : Math.min(list.max, list.current + Math.max(1, Math.floor((usable - 1) / list.avgRow)));
    const denied = activeDenial(list.key);
    if (denied && usable < denied.slack) target = Math.min(target, denied.to - 1);
    if (target <= list.current) continue; // denied or no room — funding is discarded
    for (const fund of funding) targets[fund.key] = fund.to;
    memory.attempts[list.key] = { to: target, slack: usable };
    targets[list.key] = target;
    break;
  }
  return targets;
}

/**
 * Current terminal size, tracking resizes. rows/columns are 0 when unknown.
 *
 * Columns matter even where only rows is consumed: a width-only resize
 * re-wraps text and changes the RENDERED height without changing the row
 * count, and the fitting effect only runs on a React commit. Bailing out
 * when rows is unchanged would leave the freshly wrapped, taller frame
 * unmeasured until the next poll — reintroducing the scroll jump this hook
 * exists to prevent.
 */
function useTerminalViewport(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState({
    rows: stdout?.rows ?? 0,
    columns: stdout?.columns ?? 0,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setViewport(prev => {
      const rows = stdout.rows ?? 0;
      const columns = stdout.columns ?? 0;
      return prev.rows === rows && prev.columns === columns ? prev : { rows, columns };
    });
    stdout.on("resize", onResize);
    onResize();
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return viewport;
}

interface HealthData {
  status: "ok" | "degraded";
  /** Version of the code the daemon is running. Absent on daemons built
   *  before the field existed — which itself proves they are outdated. */
  version?: string;
  mode: string;
  target: string;
  operational?: OperationalStatus;
  uptime: number;
  totalRequests: number;
  totalErrors: number;
  totalRefreshes: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInputTokens: number;
  totalOutputTokens?: number;
  accounts: AccountStat[];
  recentLogs: LogEntry[];
}

interface OperationalStatus {
  auth: { required: boolean };
  providers: {
    anthropic: ProviderOperationalStatus;
    openai: ProviderOperationalStatus;
  };
  endpoints: {
    health: string;
    accounts: string;
    messages: string;
    responses: string;
    models: string;
  };
  routing: {
    anthropicDefaultModel?: string;
    openAIDefaultModel?: string;
    anthropicAliases: string[];
    openAIAliases: string[];
  };
  capabilities: {
    anthropicMessages: boolean;
    openAIResponses: boolean;
    crossProviderMessages: boolean;
    dynamicModels: boolean;
    accountManagement: boolean;
  };
}

interface ProviderOperationalStatus {
  configured: boolean;
  accounts: number;
  healthy: number;
  enabled: number;
}

type Focus = "logs" | "accounts" | "models";
type Mode = "view" | "editSession" | "editWeekly" | "confirmDelete";

// ─── Dashboard component ──────────────────────────────────────────────────────

export interface DashboardProps {
  port: number;
  baseUrl?: string;
  authToken?: string;
  /** Callback fired when the dashboard wants the outer shell to perform an
   *  action that can't run while Ink is rendering (e.g. OAuth flow). */
  onIntent?: (intent: "quit" | "addAccount") => void;
}

export function Dashboard({ port, baseUrl, authToken, onIntent }: DashboardProps) {
  const { exit } = useApp();
  const [data, setData] = useState<HealthData | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [retryCount, setRetryCount] = useState(0);

  const resolvedBase = baseUrl
    ? baseUrl.replace(/\/+$/, "")
    : `http://localhost:${port}`;

  const api = React.useMemo(
    () => createAccountsApi(resolvedBase, authToken),
    [resolvedBase, authToken],
  );
  const modelsApi = React.useMemo(
    () => createModelsApi(resolvedBase, authToken),
    [resolvedBase, authToken],
  );

  // Only q to quit when no live data yet (no mode to cancel)
  useInput((input, key) => {
    if (!data && (input === "q" || key.escape)) exit();
  });

  useEffect(() => {
    let cancelled = false;

    const healthUrl = `${resolvedBase}/cc-router/health`;
    const headers: Record<string, string> = authToken
      ? { authorization: `Bearer ${authToken}` }
      : {};

    const poll = async () => {
      try {
        const res = await fetch(healthUrl, {
          headers,
          signal: AbortSignal.timeout(1_500),
        });
        if (cancelled) return;
        if (res.ok) {
          setData(await res.json() as HealthData);
          setConnectError(null);
          setLastUpdate(Date.now());
          setRetryCount(0);
        } else {
          setConnectError(`Proxy returned HTTP ${res.status}`);
        }
      } catch {
        if (cancelled) return;
        setConnectError(`Cannot connect to ${resolvedBase}`);
        setRetryCount(n => n + 1);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [resolvedBase, authToken]);

  if (connectError) {
    return <ErrorScreen error={connectError} port={port} retries={retryCount} />;
  }

  if (!data) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">⠋ Connecting to {resolvedBase}...</Text>
      </Box>
    );
  }

  return (
    <LiveDashboard
      data={data}
      port={port}
      baseUrl={resolvedBase}
      lastUpdate={lastUpdate}
      api={api}
      modelsApi={modelsApi}
      onIntent={onIntent}
    />
  );
}

// ─── Error screen ─────────────────────────────────────────────────────────────

function ErrorScreen({ error, port, retries }: { error: string; port: number; retries: number }) {
  return (
    <Box flexDirection="column" marginY={1} marginX={2}>
      <Text color="red" bold>✗ {error}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Is the proxy running? Start it with:</Text>
        <Text color="cyan">  cc-router start</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Retrying every {POLL_INTERVAL_MS / 1000}s</Text>
        {retries > 0 && <Text color="gray">  (attempt {retries})</Text>}
        <Text color="gray">  ·  [q] quit</Text>
      </Box>
    </Box>
  );
}

// ─── Live dashboard ───────────────────────────────────────────────────────────

function LiveDashboard({
  data, port, baseUrl, lastUpdate, api, modelsApi, onIntent,
}: {
  data: HealthData; port: number; baseUrl: string; lastUpdate: number;
  api: AccountsApi; modelsApi: ModelsApi; onIntent?: (intent: "quit" | "addAccount") => void;
}) {
  const { exit } = useApp();
  const orderedAccounts = orderAccountsForDashboard(data.accounts);
  const healthyCount = orderedAccounts.filter(a => a.healthy).length;
  const logs = data.recentLogs;

  // ── Focus / mode ──────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<Focus>("logs");
  const [mode, setMode] = useState<Mode>("view");

  // Selected log by timestamp (existing)
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const selectedLogIndex = selectedTs !== null
    ? Math.max(0, logs.findIndex(l => l.ts === selectedTs))
    : 0;

  // ── Viewport fitting ──────────────────────────────────────────────────────
  // The frame must fit the terminal or Ink cannot erase it between polls (see
  // LOG_VISIBLE above). Two mechanisms cooperate:
  //
  // 1. A HARD bound applied synchronously from the terminal height on the
  //    outer box — every commit is clipped at the bottom, so no settling
  //    step, resize, or content growth can ever emit an oversized frame.
  //    (One row of slack: a frame of exactly `rows` lines still scrolls by
  //    one when the cursor advances past the last line.)
  // 2. A post-render controller that measures the natural content height and
  //    reallocates the two windowed lists so the clip normally has nothing to
  //    cut: the activity list shrinks first (to MIN_LOG_VISIBLE), then the
  //    accounts window (to one account). Growth is stepped and hysteretic so
  //    variable-height rows cannot oscillate the layout.
  const { rows: terminalRows, columns: terminalColumns } = useTerminalViewport();
  const frameBound = terminalRows > 0 ? terminalRows - 1 : undefined;
  const [logVisible, setLogVisible] = useState(MIN_LOG_VISIBLE);
  const [accountsVisible, setAccountsVisible] = useState(Number.MAX_SAFE_INTEGER);
  const [modelsVisible, setModelsVisible] = useState(MODEL_VISIBLE_ROWS);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const shownAccounts = Math.max(1, Math.min(accountsVisible, orderedAccounts.length || 1));
  const contentRef = useRef<DOMElement>(null);
  const accountRowsRef = useRef<DOMElement>(null);
  const logRowsRef = useRef<DOMElement>(null);
  const modelRowsRef = useRef<DOMElement>(null);
  // Growing the accounts window estimates the NEXT (hidden, unmeasurable)
  // row's height from the average of the visible ones. When that account is
  // much taller than average, the growth overflows and is removed again —
  // and without memory the same growth is retried every commit, forever
  // (hundreds of repaints per second). A denied growth is remembered with
  // the slack it would actually need (the slack it had plus the overflow it
  // caused) and not retried below that; the memory resets when the
  // viewport or the fleet changes, since either can change row heights.
  const fitMemoryRef = useRef<FitMemory>({ attempts: {}, denials: {} });
  const fitKeyRef = useRef("");
  useEffect(() => {
    // Denials are measured against concrete row heights, so the memory
    // resets whenever those visibly change: viewport size, fleet size, model
    // count, or the newest activity entry (new rows wrap differently).
    // Deliberately NOT part of the key: the window offsets. They derive from
    // the visible counts, so with a selection at the end of a list a
    // controller-driven grow/shrink shifts them — keying on them wiped the
    // pending attempt on the very commit that should have recorded the
    // denial, re-enabling the grow/shrink oscillation. Geometry drift from
    // scrolling (like every other content mutation the key cannot see) is
    // covered by the denial TTL instead.
    const fitKey = `${terminalRows}:${terminalColumns}:${orderedAccounts.length}:${modelsStatus?.models.length ?? 0}:${logs[0]?.ts ?? 0}`;
    if (fitKeyRef.current !== fitKey) {
      fitKeyRef.current = fitKey;
      fitMemoryRef.current = { attempts: {}, denials: {} };
    }
    if (frameBound === undefined) {
      if (logVisible !== LOG_VISIBLE) setLogVisible(LOG_VISIBLE);
      if (accountsVisible !== Number.MAX_SAFE_INTEGER) setAccountsVisible(Number.MAX_SAFE_INTEGER);
      if (modelsVisible !== MODEL_VISIBLE_ROWS) setModelsVisible(MODEL_VISIBLE_ROWS);
      return;
    }
    const modelsPanelOpen = focus === "models" || modelsStatus !== null;
    const contentH = contentRef.current ? measureElement(contentRef.current).height : 0;
    const accountsH = accountRowsRef.current ? measureElement(accountRowsRef.current).height : 0;
    const logsH = logRowsRef.current ? measureElement(logRowsRef.current).height : 0;
    const modelsH = modelRowsRef.current ? measureElement(modelRowsRef.current).height : 0;
    const shownLogs = Math.min(logVisible, logs.length);
    const shownModels = Math.min(modelsVisible, modelsStatus?.models.length ?? 0);

    // Shrink priority order; growth walks it in reverse, so the models panel
    // (the active surface while open) regrows first and the activity list
    // last. Every list goes through the same measured-average + denial
    // mechanics — each list got its own oscillation bug while the paths were
    // separate (tall accounts, wrapped activity details, wrapped model ids).
    const lists: FitList[] = [
      {
        key: "logs", current: logVisible, min: MIN_LOG_VISIBLE, max: LOG_VISIBLE,
        avgRow: shownLogs > 0 ? Math.max(1, logsH / shownLogs) : 1,
      },
      {
        key: "accounts", current: shownAccounts, min: 1, max: Math.max(1, orderedAccounts.length), growOne: true,
        avgRow: shownAccounts > 0 ? Math.max(1, accountsH / shownAccounts) : 2,
      },
      ...(modelsPanelOpen ? [{
        key: "models", current: modelsVisible, min: MIN_MODELS_VISIBLE, max: MODEL_VISIBLE_ROWS,
        avgRow: shownModels > 0 ? Math.max(1, modelsH / shownModels) : 1,
      }] : []),
    ];
    const targets = planViewportFit(contentH - frameBound, lists, fitMemoryRef.current, Date.now());
    if (targets["logs"] !== undefined) setLogVisible(targets["logs"]);
    if (targets["accounts"] !== undefined) setAccountsVisible(targets["accounts"]);
    if (targets["models"] !== undefined) setModelsVisible(targets["models"]);
  });

  // First visible activity row. The stored position only moves on navigation;
  // the derived value re-clamps every render because the selection is
  // timestamp-anchored — new entries arriving between keypresses can push the
  // selected row out of the stored window, and it must stay visible anyway.
  const [logScrollTop, setLogScrollTop] = useState(0);
  const logWindowTop = followScrollWindow(logScrollTop, selectedLogIndex, logs.length, logVisible);


  const selectedAccountIndex = selectedAccountId !== null
    ? Math.max(0, orderedAccounts.findIndex(a => a.id === selectedAccountId))
    : 0;
  const selectedAccount = orderedAccounts[selectedAccountIndex] ?? null;

  // Same follow-scroll for the accounts window: when the fitting controller
  // shrinks the list below the fleet size, the selected account must stay on
  // screen — account actions (caps, toggle, delete confirmation) target the
  // selection, and acting on an invisible account is how a wrong one dies.
  const [accountScrollTop, setAccountScrollTop] = useState(0);
  const accountWindowTop = followScrollWindow(accountScrollTop, selectedAccountIndex, orderedAccounts.length, shownAccounts);

  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const modelRows = modelsStatus?.models ?? [];
  const selectedModelIndex = selectedModelId !== null
    ? Math.max(0, modelRows.findIndex(m => m.id === selectedModelId))
    : 0;
  const selectedModel = modelRows[selectedModelIndex] ?? null;

  // Inline text input state (for w / s keys)
  const [editBuffer, setEditBuffer] = useState("");

  // Transient banner (error or success, cleared after 4s).
  // The timer handle is stored in a ref so new banners cancel the previous
  // timeout and component unmount also clears it — otherwise a deferred
  // setBanner can fire on an unmounted component after `n` exits Ink.
  const [banner, setBanner] = useState<{ text: string; color: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((text: string, color: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ text, color });
    bannerTimerRef.current = setTimeout(() => {
      setBanner(null);
      bannerTimerRef.current = null;
    }, 4_000);
  }, []);
  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  // Normalize any thrown value to a displayable string — rejections from
  // fetch/AbortSignal can be DOMException without .message, strings, or
  // even undefined.
  const errMsg = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message;
    const s = String(err ?? "");
    return s || "unknown error";
  };

  // ── Async helpers (fire-and-forget with error → banner) ──────────────────
  // Provider-agnostic: `PATCH /cc-router/accounts/:id` applies `enabled` to
  // OpenAI accounts through the same transaction contract as Claude ones, and
  // drops their sticky bindings on disable. The cap keys below never had a
  // provider check; this one was left behind after the endpoint gained OpenAI
  // support, so the dashboard was refusing an operation the server had.
  const doToggleEnabled = useCallback(async () => {
    if (!selectedAccount) return;
    const newValue = !(selectedAccount.enabled !== false);
    try {
      await api.patch(selectedAccount.id, { enabled: newValue });
      showBanner(`${selectedAccount.id} → ${newValue ? "enabled" : "disabled"}`, newValue ? "green" : "yellow");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doToggleProvider = useCallback(async (provider: "anthropic_subscription" | "openai_subscription") => {
    const providerStatus = provider === "anthropic_subscription"
      ? data.operational?.providers.anthropic
      : data.operational?.providers.openai;
    const label = provider === "anthropic_subscription" ? "Claude" : "OpenAI";
    if (!providerStatus?.configured || providerStatus.accounts === 0) {
      showBanner(`${label} accounts are not configured`, "yellow");
      return;
    }

    const enabled = providerStatus.enabled < providerStatus.accounts;
    try {
      await api.setProviderEnabled(provider, enabled);
      showBanner(`${label} accounts → ${enabled ? "enabled" : "disabled"}`, enabled ? "green" : "yellow");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [api, data.operational, showBanner]);

  const doSetLimit = useCallback(async (field: "sessionLimitPercent" | "weeklyLimitPercent", value: number) => {
    if (!selectedAccount) return;
    try {
      await api.patch(selectedAccount.id, { [field]: value });
      const label = field === "sessionLimitPercent" ? "5h cap" : "7d cap";
      showBanner(`${selectedAccount.id} → ${label} = ${value}%`, "green");
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doDelete = useCallback(async () => {
    if (!selectedAccount) return;
    try {
      await api.remove(selectedAccount.id);
      showBanner(`Removed ${selectedAccount.id}`, "yellow");
      setSelectedAccountId(null);
    } catch (err) {
      showBanner(`Error: ${errMsg(err)}`, "red");
    }
  }, [selectedAccount, api, showBanner]);

  const doLoadModels = useCallback(async () => {
    try {
      const status = await modelsApi.list();
      setModelsStatus(status);
      setSelectedModelId(status.models[0]?.id ?? null);
      setFocus("models");
      showBanner(`Loaded ${status.models.length} models`, "green");
    } catch (err) {
      showBanner(`Models error: ${errMsg(err)}`, "red");
    }
  }, [modelsApi, showBanner]);

  const doSetSelectedModel = useCallback(async (provider: "claude" | "openai") => {
    if (!selectedModel) return;
    if (provider === "claude" && !selectedModel.id.startsWith("anthropic/")) {
      showBanner("Select an anthropic/* model for Claude", "yellow");
      return;
    }
    if (provider === "openai" && !selectedModel.id.startsWith("openai/")) {
      showBanner("Select an openai/* model for OpenAI", "yellow");
      return;
    }

    try {
      const status = await modelsApi.setDefaults(
        provider === "claude"
          ? { claudeModel: selectedModel.id }
          : { openAIModel: selectedModel.id },
      );
      setModelsStatus(previous => ({
        routing: status.routing,
        models: status.models.length > 0 ? status.models : previous?.models ?? [],
      }));
      showBanner(`${provider === "claude" ? "Claude" : "OpenAI"} default → ${selectedModel.id}`, "green");
    } catch (err) {
      showBanner(`Models error: ${errMsg(err)}`, "red");
    }
  }, [modelsApi, selectedModel, showBanner]);

  // ── Keyboard handler ──────────────────────────────────────────────────────
  useInput((input, key) => {
    // ── Text editing mode (w / s) ───────────────────────────────────────
    if (mode === "editSession" || mode === "editWeekly") {
      if (key.escape) {
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.return) {
        const parsed = parseInt(editBuffer, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          const field = mode === "editSession" ? "sessionLimitPercent" as const : "weeklyLimitPercent" as const;
          void doSetLimit(field, parsed);
        } else {
          showBanner("Invalid: enter a number 0–100", "red");
        }
        setMode("view");
        setEditBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer(b => b.slice(0, -1));
        return;
      }
      if (/^[0-9]$/.test(input) && editBuffer.length < 3) {
        setEditBuffer(b => b + input);
      }
      return;
    }

    // ── Confirm delete (y/n) ────────────────────────────────────────────
    if (mode === "confirmDelete") {
      if (input === "y" || input === "Y") {
        void doDelete();
        setMode("view");
      } else {
        setMode("view");
        showBanner("Delete cancelled", "gray");
      }
      return;
    }

    // ── Normal view mode ────────────────────────────────────────────────
    // Always call exit() so Ink fully unmounts and releases stdin.
    // The outer dashboardLoop reads `pendingIntent` after waitUntilExit().
    if (input === "q") { onIntent?.("quit"); exit(); return; }
    if (key.escape) {
      if (focus === "accounts" || focus === "models") { setFocus("logs"); return; }
      onIntent?.("quit"); exit();
      return;
    }

    if (key.tab) {
      setFocus(f => f === "logs" ? "accounts" : f === "accounts" ? "models" : "logs");
      return;
    }

    // Navigation: ↑↓ move within the focused panel
    if (focus === "logs") {
      if (key.upArrow) {
        const next = Math.max(0, selectedLogIndex - 1);
        setSelectedTs(logs[next]?.ts ?? null);
        setLogScrollTop(followScrollWindow(logWindowTop, next, logs.length, logVisible));
      }
      if (key.downArrow) {
        const next = Math.min(logs.length - 1, selectedLogIndex + 1);
        setSelectedTs(logs[next]?.ts ?? null);
        setLogScrollTop(followScrollWindow(logWindowTop, next, logs.length, logVisible));
      }
    }

    if (focus === "accounts") {
      if (key.upArrow) {
        const next = Math.max(0, selectedAccountIndex - 1);
        setSelectedAccountId(orderedAccounts[next]?.id ?? null);
        setAccountScrollTop(followScrollWindow(accountWindowTop, next, orderedAccounts.length, shownAccounts));
      }
      if (key.downArrow) {
        const next = Math.min(orderedAccounts.length - 1, selectedAccountIndex + 1);
        setSelectedAccountId(orderedAccounts[next]?.id ?? null);
        setAccountScrollTop(followScrollWindow(accountWindowTop, next, orderedAccounts.length, shownAccounts));
      }

      // Account actions (only when focus = accounts)
      if (input === "e") { void doToggleEnabled(); return; }
      if (input === "a") { void doToggleProvider("anthropic_subscription"); return; }
      if (input === "o") { void doToggleProvider("openai_subscription"); return; }
      if (input === "w") {
        setMode("editWeekly"); setEditBuffer(""); return;
      }
      if (input === "s") {
        setMode("editSession"); setEditBuffer(""); return;
      }
      // Also provider-agnostic: `DELETE /cc-router/accounts/:id` removes an
      // OpenAI account through `deleteOpenAIAccountTransaction`, which is the
      // same path `cc-router accounts remove` reaches. Sending the operator to
      // the CLI for something the dashboard can do was left over from before
      // that existed.
      if (input === "d") {
        setMode("confirmDelete"); return;
      }
    }

    if (focus === "models") {
      if (key.upArrow) {
        const next = Math.max(0, selectedModelIndex - 1);
        setSelectedModelId(modelRows[next]?.id ?? null);
      }
      if (key.downArrow) {
        const next = Math.min(modelRows.length - 1, selectedModelIndex + 1);
        setSelectedModelId(modelRows[next]?.id ?? null);
      }
      if (input === "r") { void doLoadModels(); return; }
      if (input === "c") { void doSetSelectedModel("claude"); return; }
      if (input === "o") { void doSetSelectedModel("openai"); return; }
    }

    if (input === "m") {
      void doLoadModels();
      return;
    }

    // n = add account — works regardless of focus.
    // Requires an onIntent handler because the outer loop runs the OAuth
    // flow after Ink unmounts; if none is wired, this key is a no-op.
    if (input === "n") {
      if (onIntent) { onIntent("addAccount"); exit(); }
      return;
    }
  });

  const selectedLog = logs[selectedLogIndex] ?? null;
  const visibleLogs = logs.slice(logWindowTop, logWindowTop + logVisible);

  return (
    <Box flexDirection="column" height={frameBound} overflowY="hidden">
    <Box flexDirection="column" flexShrink={0} ref={contentRef}>
    <Box flexDirection="column">

      {/* ── Header bar ── */}
      <Box>
        <Text bold color="cyan"> CC-Router </Text>
        <Text color="gray">· </Text>
        <Text color="green">{data.mode}</Text>
        <Text color="gray">  ·  </Text>
        <Text>up {formatUptime(data.uptime)}</Text>
        <Text color="gray">  ·  </Text>
        <Text color="cyan">{data.totalRequests}</Text>
        <Text color="gray"> req  </Text>
        <Text color={data.totalErrors > 0 ? "red" : "green"}>{data.totalErrors}</Text>
        <Text color="gray"> err</Text>
        <CacheHealthBadge
          read={data.totalCacheReadTokens}
          created={data.totalCacheCreationTokens}
          input={data.totalInputTokens}
        />
        <Text color="gray">  ·  [q] quit</Text>
      </Box>

      {/* ── Inline prompt (edit / confirm) ──
          Directly under the header bar, above EVERYTHING else: these prompts
          arm keyboard input (`y` deletes), and any placement further down
          can end up below the viewport clip in a short pane — an armed,
          invisible destructive confirmation. Here they are visible in any
          pane of three rows or more. */}
      {mode === "editWeekly" && selectedAccount && (
        <Box paddingLeft={2}>
          <Text color="cyan">Set 7d cap for </Text>
          <Text color="white" bold>{selectedAccount.id}</Text>
          <Text color="cyan"> (0–100%): </Text>
          <Text color="white" bold>{editBuffer}</Text>
          <Text color="gray">█  [Enter] save  [Esc] cancel</Text>
        </Box>
      )}
      {mode === "editSession" && selectedAccount && (
        <Box paddingLeft={2}>
          <Text color="cyan">Set 5h cap for </Text>
          <Text color="white" bold>{selectedAccount.id}</Text>
          <Text color="cyan"> (0–100%): </Text>
          <Text color="white" bold>{editBuffer}</Text>
          <Text color="gray">█  [Enter] save  [Esc] cancel</Text>
        </Box>
      )}
      {mode === "confirmDelete" && selectedAccount && (
        <Box paddingLeft={2}>
          <Text color="red" bold>Delete "{selectedAccount.id}"?  [y] yes  [n/Esc] cancel</Text>
        </Box>
      )}

      {/* A daemon left running by a service manager can be a different build
          than the CLI rendering this dashboard — launchd keeps the old
          versioned install path alive across package upgrades. Every log row
          and account view below comes from THAT build, so any "still broken"
          reading of this screen is wrong until the daemon is restarted.
          `--keep-config` keeps the stop non-interactive (a bare stop prompts
          about auto-start mid-chain); the following start re-installs the
          service definition, which is what actually drops the pinned path. */}
      {data.version !== DASHBOARD_VERSION && (
        <Box>
          <Text bold color="yellow"> ⚠ VERSION MISMATCH  </Text>
          <Text color="yellow">
            {data.version !== undefined
              ? `daemon v${data.version}`
              : "daemon version unreported (older build)"}
            {` · dashboard v${DASHBOARD_VERSION}`}
          </Text>
          {LOCAL_TARGET_RE.test(baseUrl) ? (
            <>
              <Text color="gray">  —  restart: </Text>
              <Text color="cyan">cc-router stop --keep-config && cc-router start</Text>
            </>
          ) : (
            // A remote router can only be restarted where it runs; printing a
            // local restart command here would never clear the banner.
            <Text color="gray">  —  update and restart the daemon on {baseUrl}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1} />

      {data.operational && (
        <>
          <OperationsPanel operational={data.operational} baseUrl={baseUrl} focus={focus} />
          <Box marginTop={1} />
        </>
      )}

      {(focus === "models" || modelsStatus) && (
        <>
          <ModelsPanel
            status={modelsStatus}
            selectedIndex={selectedModelIndex}
            focused={focus === "models"}
            visibleRows={modelsVisible}
            rowsRef={modelRowsRef}
          />
          <Box marginTop={1} />
        </>
      )}

      {/* ── Accounts table ── */}
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {" ACCOUNTS  "}
            <Text color={healthyCount === orderedAccounts.length ? "green" : "yellow"}>
              {healthyCount}/{orderedAccounts.length} healthy
            </Text>
          </Text>
          {shownAccounts < orderedAccounts.length && (
            <Text color="gray">
              {"  ·  showing "}{accountWindowTop + 1}–{accountWindowTop + shownAccounts}
            </Text>
          )}
        </Box>

        <Box marginTop={1} flexDirection="column" ref={accountRowsRef}>
          <AccountGroups
            visible={orderedAccounts.slice(accountWindowTop, accountWindowTop + shownAccounts)}
            fleet={orderedAccounts}
            windowTop={accountWindowTop}
            selectedIndex={selectedAccountIndex}
            focused={focus === "accounts"}
          />
        </Box>
      </Box>

      {/* ── Banner (transient action feedback) ── */}
      {banner && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={banner.color as any}> {banner.text}</Text>
        </Box>
      )}

      <Box marginTop={1} />

      {/* ── Totals ── */}
      <Box flexDirection="column">
        <Box>
          <Text bold> TOTALS  </Text>
          <Text>requests </Text>
          <Text color="cyan">{data.totalRequests}</Text>
          <Text color="gray">  ·  </Text>
          <Text>errors </Text>
          <Text color={data.totalErrors > 0 ? "red" : "green"}>{data.totalErrors}</Text>
          <Text color="gray">  ·  </Text>
          <Text>refreshes </Text>
          <Text color="yellow">{data.totalRefreshes}</Text>
          <CacheHealthBadge
            read={data.totalCacheReadTokens}
            created={data.totalCacheCreationTokens}
            input={data.totalInputTokens}
          />
        </Box>
        <TokenSummary
          cacheRead={data.totalCacheReadTokens}
          cacheCreated={data.totalCacheCreationTokens}
          uncached={data.totalInputTokens}
          output={data.totalOutputTokens ?? 0}
        />
      </Box>

      <Box marginTop={1} />

      {/* ── Recent activity (title measures as "above", rows flex) ── */}
      <Text bold> RECENT ACTIVITY</Text>
      <Box marginTop={1} />
    </Box>

      <Box flexDirection="column" ref={logRowsRef}>
        {visibleLogs.length === 0
          ? <Text color="gray">  No activity yet</Text>
          : visibleLogs.map((log, i) => (
              <LogRow key={`${log.ts}-${i}`} log={log} selected={focus === "logs" && logWindowTop + i === selectedLogIndex} />
            ))
        }
      </Box>

      {/* ── Detail panel ── */}
      {focus === "logs" && selectedLog && (
        <Box flexDirection="column">
          <Box marginTop={1} />
          <DetailPanel log={selectedLog} />
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          {focus === "accounts"
            ? " [Tab]  [e] toggle  [n] add  [d] delete  [w] 7d  [s] 5h  [q]"
            : focus === "models"
              ? " [Tab]  [m/r] refresh  [c]/[o] default  [Esc] logs  [q]"
              : " [Tab]  [m] models  [q] quit"}
        </Text>
      </Box>

    </Box>
    </Box>
  );
}

function OperationsPanel({ operational, baseUrl, focus }: { operational: OperationalStatus; baseUrl: string; focus: Focus }) {
  const authLabel = operational.auth.required ? "protected" : "open";
  const authColor = operational.auth.required ? "green" : "yellow";
  const claudeReady = operational.capabilities.anthropicMessages;
  const openAIReady = operational.capabilities.openAIResponses;
  const crossReady = operational.capabilities.crossProviderMessages;

  return (
    <Box>
      <Text bold> OPERATIONS  </Text>
      <Text color="cyan">{baseUrl.replace(/^https?:\/\//, "")}</Text>
      <Text color="gray">  ·  auth </Text>
      <Text color={authColor}>{authLabel}</Text>
      <Text color="gray">  ·  </Text>
      <ProviderBadge label="Claude" status={operational.providers.anthropic} ready={claudeReady} />
      <Text color="gray">  </Text>
      <ProviderBadge label="ChatGPT" status={operational.providers.openai} ready={openAIReady} />
      {crossReady && <Text color="gray">  ·  cross-route</Text>}
      <Text color="gray">  ·  </Text>
      <Text color={focus === "models" ? "white" : "cyan"}>[m]</Text>
    </Box>
  );
}

function ModelsPanel({
  status,
  selectedIndex,
  focused,
  visibleRows = MODEL_VISIBLE_ROWS,
  rowsRef,
}: {
  status: ModelsStatus | null;
  selectedIndex: number;
  focused: boolean;
  /** Height-aware row budget from the fitting controller — the fixed
   *  MODEL_VISIBLE_ROWS window could extend below the viewport clip while
   *  [c]/[o] still applied the invisible selection. */
  visibleRows?: number;
  /** Measured by the fitting controller: wrapped model ids make a row taller
   *  than one line, and unmeasured growth is how lists oscillate. */
  rowsRef?: React.Ref<DOMElement>;
}) {
  const models = status?.models ?? [];
  const visible = getVisibleModelWindow(models, selectedIndex, Math.max(1, visibleRows));

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold> MODELS  </Text>
        <Text color="gray">[m/r] refresh  [↑/↓] select  [c] Claude default  [o] OpenAI default  [Esc] logs</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray">current </Text>
        <Text color="white">claude={status?.routing.anthropicDefaultModel ?? "default"}</Text>
        <Text color="gray">  </Text>
        <Text color="white">openai={status?.routing.openAIDefaultModel ?? "default"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {status === null
          ? <Text color="gray">  Press [m] to load models from provider APIs</Text>
          : models.length === 0
            ? <Text color="gray">  No models discovered</Text>
            : (
                <>
                  <Text color="gray">  showing {visible.start + 1}-{visible.end} of {models.length}</Text>
                  <Box flexDirection="column" ref={rowsRef}>
                    {visible.rows.map((model, i) => (
                      <ModelRow
                        key={model.id}
                        model={model}
                        selected={focused && visible.start + i === selectedIndex}
                        currentClaude={status.routing.anthropicDefaultModel}
                        currentOpenAI={status.routing.openAIDefaultModel}
                      />
                    ))}
                  </Box>
                </>
              )}
      </Box>
    </Box>
  );
}

export function getVisibleModelWindow<T>(
  models: T[],
  selectedIndex: number,
  maxRows = MODEL_VISIBLE_ROWS,
): { rows: T[]; start: number; end: number } {
  if (models.length <= maxRows) {
    return { rows: models, start: 0, end: models.length };
  }

  const selected = Math.max(0, Math.min(selectedIndex, models.length - 1));
  const start = Math.max(0, Math.min(selected - maxRows + 1, models.length - maxRows));
  const end = Math.min(models.length, start + maxRows);
  return {
    rows: models.slice(start, end),
    start,
    end,
  };
}

function ModelRow({
  model,
  selected,
  currentClaude,
  currentOpenAI,
}: {
  model: ModelEntry;
  selected: boolean;
  currentClaude?: string;
  currentOpenAI?: string;
}) {
  const id = model.id;
  const upstream = id.replace(/^anthropic\//, "").replace(/^openai\//, "");
  const isClaudeDefault = currentClaude === upstream || id === "claude/default";
  const isOpenAIDefault = currentOpenAI === upstream || id === "openai/default";
  const providerColor = id.startsWith("openai/") ? "cyan" : id.startsWith("anthropic/") ? "magenta" : "gray";
  const marker = isClaudeDefault ? " Claude" : isOpenAIDefault ? " OpenAI" : "";

  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{selected ? "▶" : " "}</Text>
      <Text color={providerColor}> {id}</Text>
      {marker && <Text color="green">{marker}</Text>}
    </Box>
  );
}

function ProviderBadge({
  label,
  status,
  ready,
}: {
  label: string;
  status: ProviderOperationalStatus;
  ready: boolean;
}) {
  const color = !status.configured ? "gray" : ready ? "green" : "yellow";
  const text = status.configured
    ? `${label} ${status.healthy}/${status.accounts}`
    : `${label} off`;

  return <Text color={color}>{text}</Text>;
}

function AccountGroups({
  visible,
  fleet,
  windowTop,
  selectedIndex,
  focused,
}: {
  visible: AccountStat[];
  fleet: AccountStat[];
  windowTop: number;
  selectedIndex: number;
  focused: boolean;
}) {
  const claudeVisible = visible.filter(account => !isOpenAIAccount(account));
  const chatgptVisible = visible.filter(isOpenAIAccount);
  const claudeFleet = fleet.filter(account => !isOpenAIAccount(account));
  const chatgptFleet = fleet.filter(isOpenAIAccount);

  if (visible.length === 0) {
    return <Text color="gray">  No accounts</Text>;
  }

  const renderRows = (accounts: AccountStat[], offsetInVisible: number) =>
    accounts.map((account, i) => (
      <AccountRow
        key={account.id}
        account={account}
        selected={focused && windowTop + offsetInVisible + i === selectedIndex}
      />
    ));

  return (
    <Box flexDirection="column">
      {claudeVisible.length > 0 && (
        <Box flexDirection="column">
          <GroupHeader label="CLAUDE" accounts={claudeFleet} />
          <ColumnLegend />
          {renderRows(claudeVisible, 0)}
        </Box>
      )}
      {chatgptVisible.length > 0 && (
        <Box flexDirection="column">
          {claudeVisible.length > 0 && <Box marginTop={1} />}
          <GroupHeader label="CHATGPT" accounts={chatgptFleet} />
          <ColumnLegend />
          {renderRows(chatgptVisible, claudeVisible.length)}
        </Box>
      )}
    </Box>
  );
}

function GroupHeader({ label, accounts }: { label: string; accounts: AccountStat[] }) {
  const healthy = accounts.filter(account => account.healthy).length;
  const weeklyFull = accounts.filter(isWeeklyLimited);
  const color = healthy === accounts.length && weeklyFull.length === 0 ? "green" : "yellow";
  const fableHint = label === "CLAUDE" ? exhaustedModelHint(accounts) : undefined;

  return (
    <Box>
      <Text bold color="gray"> {label}  </Text>
      <Text color={color}>{healthy}/{accounts.length} ok</Text>
      {weeklyFull.length > 0 && <Text color="red">{`  ·  ${weeklyFull.length} 7d full`}</Text>}
      {fableHint && <Text color="red">{`  ·  ${fableHint}`}</Text>}
    </Box>
  );
}

const COL = {
  name: 22,
  req: 5,
  sess: 6,
  pct: 4,
  note: 22,
  reset: 8,
  rst: 5,
} as const;

function ColumnLegend() {
  return (
    <Text color="gray">
      {`  ${"".padEnd(COL.name)} ${"req".padStart(COL.req)}${"s·n".padStart(COL.sess)}  ${"5h".padStart(COL.pct)} ${"7d".padStart(COL.pct)}  ${"note".padEnd(COL.note)} ${"↻5h".padEnd(COL.reset)} ${"↻7d".padEnd(COL.reset)} ${"rst".padStart(COL.rst)}`}
    </Text>
  );
}

function exhaustedModelHint(accounts: AccountStat[]): string | undefined {
  const hits: string[] = [];
  for (const account of accounts) {
    for (const row of getAccountCapacityRows(account)) {
      if ((row.utilization ?? 0) < 1 || row.color !== "red") continue;
      hits.push(`${row.label} full`);
    }
  }
  return hits[0];
}

// ─── Account row (one aligned line, no bars) ─────────────────────────────────

function AccountRow({ account: a, selected }: { account: AccountStat; selected: boolean }) {
  const rl = a.rateLimits ?? EMPTY_RL;
  const usage = rl.usage;
  const globalCapacity = getGlobalCapacityView(rl);
  const isOpenAI = isOpenAIAccount(a);
  const isLimited = isOpenAI ? isCodexLimited(a.codexRateLimits) : rl.status === "rate_limited";
  const isDisabled = a.enabled === false;
  const modelNote = isOpenAI ? undefined : noteModelLimit(a);
  const extraCap = usage?.extraUsage;
  const extraOff = extraCap !== undefined && extraCap.usable !== true
    && (extraCap.spendLimitReached
      || (modelNote !== undefined && modelNote.utilization >= 1 && extraCap.enabled === false));
  const gapNote = openaiQuotaGapNote(a);
  const note = [
    modelNote
      ? `${modelNote.label} ${Math.round(modelNote.utilization * 100)}%`
      : "",
    extraOff ? "extra off" : "",
    gapNote ?? "",
  ].filter(Boolean).join(" · ");
  const codexWindows = getCodexDefaultWindows(a.codexRateLimits);
  const sessionWindow = codexWindows.find(window => window.kind === "session");
  const weeklyWindow = codexWindows.find(window => window.kind === "weekly");
  const hasClaudeQuota = !isOpenAI && (rl.lastUpdated > 0 || usage);
  const fiveHour = isOpenAI
    ? sessionWindow
    : hasClaudeQuota ? globalCapacity.fiveHour : undefined;
  const sevenDay = isOpenAI
    ? weeklyWindow
    : hasClaudeQuota ? globalCapacity.sevenDay : undefined;
  const creditsLabel = resetCreditsColumnLabel(a);

  const dot = isDisabled ? "⊘" : isLimited ? "⊘" : a.busy ? "◌" : a.healthy ? "●" : "●";
  const dotColor = isDisabled ? "gray" : isLimited ? "red" : a.busy ? "yellow" : a.healthy ? "green" : "red";
  const sessions = a.activeSessions ?? 0;
  const inflight = a.inFlightRequests ?? 0;
  const load = sessions <= 0 && inflight <= 0
    ? ""
    : inflight > 0
      ? `${sessions}·${inflight}`
      : String(sessions);

  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{selected ? "▶" : " "}</Text>
      <Text color={dotColor}>{dot}</Text>
      <Text color={selected ? "white" : isDisabled ? "gray" : undefined} dimColor={isDisabled}>
        {` ${a.id.slice(0, COL.name).padEnd(COL.name)}`}
      </Text>
      <Text color="white">{String(a.requestCount).padStart(COL.req)}</Text>
      <Text color="gray">{load.padStart(COL.sess)}</Text>
      <Text>  </Text>
      <QuotaCell util={fiveHour?.utilization} />
      <Text> </Text>
      <QuotaCell util={sevenDay?.utilization} />
      <Text color={extraOff || gapNote ? "yellow" : modelNote?.color ?? "gray"}>
        {`  ${note.padEnd(COL.note)}`}
      </Text>
      <Text> </Text>
      <ResetCell resetTs={fiveHour?.resetAt} />
      <Text> </Text>
      <ResetCell resetTs={sevenDay?.resetAt} />
      <Text> </Text>
      <Text color="gray">{creditsLabel.padStart(COL.rst)}</Text>
      {a.credentialsPendingWrite && <Text color="yellow">  unsaved</Text>}
    </Box>
  );
}

function QuotaCell({ util }: { util?: number }) {
  if (util === undefined) {
    return <Text color="gray">{"—".padStart(COL.pct)}</Text>;
  }
  const pct = Math.round(util * 100);
  const color = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
  return <Text color={color}>{`${pct}%`.padStart(COL.pct)}</Text>;
}

function ResetCell({ resetTs }: { resetTs?: number }) {
  if (!resetTs || resetTs <= 0) {
    return <Text color="gray">{"—".padEnd(COL.reset)}</Text>;
  }
  return <Text color="gray">{`↻${formatResetIn(resetTs)}`.padEnd(COL.reset)}</Text>;
}

function formatResetIn(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// ─── Log row ──────────────────────────────────────────────────────────────────

function LogRow({ log, selected }: { log: LogEntry; selected: boolean }) {
  const time = new Date(log.ts).toLocaleTimeString("en-GB", { hour12: false });
  const isError = log.type === "error";
  const isRefresh = log.type === "refresh";
  const isWarn = log.type === "warn";
  const typeColor = isError ? "red" : isWarn ? "yellow" : isRefresh ? "yellow" : "gray";
  const typeIcon = isError ? "✗" : isWarn ? "⚠" : isRefresh ? "↻" : "→";

  const statusColor = log.statusCode === undefined ? undefined
    : log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : log.statusCode >= 200 ? "green"
    : "gray";

  const bg = selected ? "white" : undefined;
  const fg = (c: string | undefined) => selected ? "black" : c;

  const sourceLabel = log.source === "cli" ? "cli"
    : log.source === "desktop" ? "dsk"
    : log.source === "api" ? "api"
    : log.source === "codex" ? "cdx"
    : "   ";
  const sourceColor = log.source === "cli" ? "blue"
    : log.source === "desktop" ? "magenta"
    : log.source === "codex" ? "cyan"
    : "gray";

  // Per-request token stats
  const inputTok = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0) + (log.inputTokens ?? 0);
  const outputTok = log.outputTokens ?? 0;
  const cacheHitPct = inputTok > 0 ? Math.round(((log.cacheReadTokens ?? 0) / inputTok) * 100) : null;
  const cacheColor = cacheHitPct === null ? undefined
    : cacheHitPct >= 70 ? "green"
    : cacheHitPct >= 30 ? "yellow"
    : "red";

  return (
    <Box>
      <Text backgroundColor={bg} color={fg(undefined)}>
        {selected ? "▶" : " "}{" "}{time}{"  "}
      </Text>
      <Text backgroundColor={bg} color={fg(typeColor)}>{typeIcon} </Text>
      <Text backgroundColor={bg} color={fg(sourceColor)}>{sourceLabel} </Text>
      <Text backgroundColor={bg} color={fg("cyan")}>{log.accountId.slice(0, 22).padEnd(22)}</Text>
      {log.method && log.path
        ? <Text backgroundColor={bg} color={fg("white")}> {log.method} {log.path.padEnd(14)}</Text>
        : <Text backgroundColor={bg} color={fg(typeColor)}> {log.type.padEnd(9)}</Text>
      }
      {log.statusCode !== undefined && (
        <Text backgroundColor={bg} color={fg(statusColor)}> {log.statusCode}</Text>
      )}
      {log.durationMs !== undefined && (
        <Text backgroundColor={bg} color={fg("gray")}> {log.durationMs}ms</Text>
      )}
      {cacheHitPct !== null && (
        <Text backgroundColor={bg} color={fg(cacheColor)}> ↑{cacheHitPct}%</Text>
      )}
      {(inputTok > 0 || outputTok > 0) && (
        <Text backgroundColor={bg} color={fg("gray")}> {fmtTok(inputTok)}↑ {fmtTok(outputTok)}↓</Text>
      )}
      {log.details && (
        <Text backgroundColor={bg} color={fg("gray")}>  {log.details}</Text>
      )}
    </Box>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ log }: { log: LogEntry }) {
  const time = new Date(log.ts).toLocaleTimeString("en-GB", { hour12: false });
  const isError = log.type === "error";
  const isWarn = log.type === "warn";
  const statusLabel = log.statusCode === undefined ? ""
    : log.statusCode === 0 ? "connection error"
    : String(log.statusCode);
  const statusColor = log.statusCode === undefined ? "gray"
    : log.statusCode === 0 ? "red"
    : log.statusCode >= 500 ? "red"
    : log.statusCode >= 400 ? "yellow"
    : "green";
  const inputTok = (log.cacheReadTokens ?? 0) + (log.cacheCreationTokens ?? 0) + (log.inputTokens ?? 0);
  const outputTok = log.outputTokens ?? 0;
  const hitPct = inputTok > 0 ? Math.round(((log.cacheReadTokens ?? 0) / inputTok) * 100) : null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color={isError ? "red" : isWarn ? "yellow" : "cyan"}> DETAILS </Text>
      <Box>
        <Text color="gray">{time}  {log.accountId}</Text>
        {log.method && log.path && <Text color="white">{`  ${log.method} ${log.path}`}</Text>}
        {statusLabel !== "" && <Text color={statusColor}>{`  ${statusLabel}`}</Text>}
        {log.durationMs !== undefined && <Text color="gray">{`  ${log.durationMs}ms`}</Text>}
        <Text color="gray">{`  ${sourceFullLabel(log.source)}`}</Text>
        {log.details && <Text color="gray">{`  ${log.details}`}</Text>}
      </Box>
      {(inputTok > 0 || outputTok > 0) && (
        <Text color="gray">
          {`${fmtTok(inputTok)} in · ${fmtTok(outputTok)} out`}
          {hitPct !== null ? ` · cache ${hitPct}%` : ""}
        </Text>
      )}
    </Box>
  );
}

// ─── Cache health badge (aggregated) ─────────────────────────────────────────

function CacheHealthBadge({ read, created, input }: { read: number; created: number; input: number }) {
  const total = read + created + input;
  if (total === 0) return null;

  const hitPct = Math.round((read / total) * 100);
  const color = hitPct >= 70 ? "green" : hitPct >= 30 ? "yellow" : "red";
  const label = hitPct >= 70 ? "healthy" : hitPct >= 30 ? "fair" : "poor";

  return (
    <>
      <Text color="gray">  ·  </Text>
      <Text>cache </Text>
      <Text color={color}>{hitPct}% hit </Text>
      <Text color="gray">({label})</Text>
    </>
  );
}

// ─── Token summary (aggregated totals) ──────────────────────────────────────

function TokenSummary({ cacheRead, cacheCreated, uncached, output }: { cacheRead: number; cacheCreated: number; uncached: number; output: number }) {
  const totalInput = cacheRead + cacheCreated + uncached;
  const totalAll = totalInput + output;
  if (totalAll === 0) return null;

  return (
    <Box paddingLeft={2}>
      <Text color="gray">input </Text>
      <Text color="white">{fmtTok(totalInput)}</Text>
      <Text color="gray"> (cached </Text>
      <Text color="green">{fmtTok(cacheRead)}</Text>
      <Text color="gray"> + new </Text>
      <Text color="yellow">{fmtTok(cacheCreated)}</Text>
      <Text color="gray"> + uncached </Text>
      <Text color="white">{fmtTok(uncached)}</Text>
      <Text color="gray">)  ·  output </Text>
      <Text color="white">{fmtTok(output)}</Text>
      <Text color="gray">  ·  total </Text>
      <Text color="cyan" bold>{fmtTok(totalAll)}</Text>
    </Box>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Source label ─────────────────────────────────────────────────────────────

function sourceFullLabel(source: LogEntry["source"]): string {
  if (source === "cli") return "Claude Code";
  if (source === "desktop") return "Claude Desktop";
  if (source === "codex") return "Codex CLI";
  if (source === "api") return "API";
  return "—";
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
