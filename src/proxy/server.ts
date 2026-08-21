import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import type { Request } from "express";
import { TokenPool } from "./token-pool.js";
import { needsRefresh, refreshAccountIfCurrent, saveAccounts, startRefreshLoop } from "./token-refresher.js";
import { loadAccounts, loadOpenAIAccounts, loadXaiAccounts, saveOpenAIAccountsToPath, accountsFileExists, readAccountsFromPath, readConfig, writeConfig, getProxyRequestTimeoutMs, migrateLegacyAccountProviders, setProviderAccountsEnabled, upsertAccountRecord, removeAccountRecordById } from "../config/manager.js";
import { checkForUpdate, performUpdate, restartSelf, printUpdateBanner, getCurrentVersion } from "../utils/self-update.js";
import { trackEvent, startHeartbeat } from "../utils/telemetry.js";
import { loadTelemetryState } from "../config/telemetry.js";
import { logRoute, logError, logStartup } from "./logger.js";
import { createLocalRoutingErrorLog, stats } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { PROXY_PORT, LITELLM_URL, ACCOUNTS_PATH } from "../config/paths.js";
import { loadGrokAccountSnapshots, type GrokAccountSnapshot } from "../providers/xai/overview.js";
import { writePid, removePid, managesPidFile } from "../daemon/pid.js";
import type { Account, AccountRateLimits, AccountRecord } from "./types.js";
import { applyOpenAIAccountPatch, validateAccountPatchBody } from "./account-patch.js";
import { AccountRenameConflictError, renameAccountTransaction } from "./account-rename.js";
import {
  hasPendingCredentialWrite,
  markOpenAICredentialsPersisted,
  prepareOpenAIAccountForRequest,
  refreshAndPersistOpenAIAccount,
  startOpenAIRefreshLoop,
  type OpenAISubscriptionAccount,
} from "../providers/openai/token-refresher.js";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import type { OpenAICooldownView } from "../providers/openai/token-pool.js";
import { DEFAULT_CODEX_LIMIT_ID } from "../providers/openai/usage.js";
import type { CodexLimitBucket, CodexRateWindow } from "../providers/openai/usage.js";
import { mountResponsesRoutes } from "./responses-server.js";
import { mountMessagesCrossProviderRoute } from "./messages-cross-route.js";
import { mountModelsRoute } from "./models-server.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";
import chalk from "chalk";
import { SessionRouter } from "./session-router.js";
import type { RoutedAccountLease } from "./session-router.js";
import { createAnthropicProxy } from "./anthropic-proxy.js";
import { AnthropicUsageRefresher } from "../providers/anthropic/usage-refresher.js";
import { OpenAIUsageRefresher } from "../providers/openai/usage-fetch.js";
import { createAnthropicUsageCapture } from "./usage-capture.js";
import { canUseExtraUsage } from "../providers/anthropic/usage.js";
import {
  applyUpstreamFailureRoutingDetailed,
  reconcileAmbiguousRateLimitCooldown,
  routeFailureDetails,
  routeReasonDetails,
} from "./lease-lifecycle.js";
import { persistProviderEnabledState } from "./provider-routing.js";
import {
  accountDeletionStatusCode,
  deleteAnthropicAccountTransaction,
  deleteOpenAIAccountTransaction,
} from "./account-deletion.js";
import { addOpenAIAccountTransaction } from "./account-add.js";
import {
  createAnthropicRefreshMiddleware,
  createAnthropicRoutingMiddleware,
} from "./anthropic-routing.js";
import { createStreamLifecycleTracker } from "./stream-lifecycle.js";

// Augment Request to carry the selected account and pending log entry
declare module "express-serve-static-core" {
  interface Request {
    _ccAccount?: Account;
    _ccRoute?: RoutedAccountLease;
    _ccReleaseLease?: () => void;
    _startTime?: number;
    _pendingLog?: Partial<LogEntry>;
  }
}

export interface ServerOptions {
  port?: number;
  /** Forward to LiteLLM. If not set, goes directly to Anthropic. */
  litellmUrl?: string;
  accountsPath?: string;
}

export interface HealthAccountView {
  id: string;
  provider: "anthropic_subscription" | "openai_subscription" | "xai_subscription";
  enabled: boolean;
  healthy: boolean;
  busy: boolean;
  inFlightRequests: number;
  activeSessions: number;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
  rateLimits?: PublicAccountRateLimits;
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
  cooldownUntilMs?: number;
  globalCooldownUntilMs?: number;
  modelCooldowns?: PublicModelCooldown[];
  codexRateLimits?: PublicCodexRateLimits;
  /** True while an OpenAI account's rotated credentials are live in memory but
   *  not yet on disk, because a save failed and is still being retried. The
   *  account keeps serving traffic — the token works — but a restart before
   *  the write lands would fall back to the old refresh token, which the
   *  provider already invalidated, and require re-authentication. */
  credentialsPendingWrite?: boolean;
  /** Spend-tier from the Grok CLI access-token claims. Dashboard-only. */
  xai?: { tier: number };
}

export interface PublicCodexWindow {
  utilization: number;   // clamped 0..1
  resetAt: number;       // Unix seconds, 0 unknown
  windowMinutes: number; // 0 unknown
}

export interface PublicCodexBucket {
  limitId: string;         // /^[a-z0-9_]{1,64}$/ else "unknown"
  label: string;           // sanitized limitName, fallback limitId
  primary?: PublicCodexWindow;
  secondary?: PublicCodexWindow;
  cooldownUntilMs: number; // 0 when not cooling
}

export interface PublicCodexRateLimits {
  status: "ok" | "rate_limited";
  plan: string; // sanitized, "" when unknown
  buckets: PublicCodexBucket[]; // default bucket first, max 8
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  lastUpdated: number;
}

export interface PublicRateLimitWindow {
  utilization: number;
  resetAt: number;
}

export interface PublicModelRateLimit {
  modelFamily: string;
  displayName: string;
  utilization: number;
  resetAt: number;
  active: boolean;
  severity: "" | "warning" | "critical" | "unknown";
}

export interface PublicUsageSnapshot {
  fiveHour?: PublicRateLimitWindow;
  sevenDay?: PublicRateLimitWindow;
  modelLimits: PublicModelRateLimit[];
  extraUsage?: { enabled: boolean; spendLimitReached: boolean; usable: boolean };
  fetchedAt: number;
  fetchStatus: "fresh" | "stale" | "unavailable";
}

export interface PublicAccountRateLimits {
  status: "allowed" | "rate_limited" | "unknown";
  fiveHourUtil: number;
  fiveHourReset: number;
  sevenDayUtil: number;
  sevenDayReset: number;
  claim: string;
  plan: string;
  requestsLimit: number;
  lastUpdated: number;
  usage?: PublicUsageSnapshot;
}

export interface PublicModelCooldown {
  modelFamily: string;
  untilMs: number;
}

export interface AccountRoutingMetrics {
  inFlightRequests: number;
  activeSessions: number;
  coolingDown: boolean;
  cooldownUntilMs?: number;
  globalCooldownUntilMs?: number;
  modelCooldowns?: PublicModelCooldown[];
}

type RoutingMetricsResolver = (accountId: string) => AccountRoutingMetrics;

const zeroRoutingMetrics: RoutingMetricsResolver = () => ({
  inFlightRequests: 0,
  activeSessions: 0,
  coolingDown: false,
  cooldownUntilMs: 0,
});

export interface OperationalStatus {
  mode: string;
  target: string;
  auth: { required: boolean };
  providers: {
    anthropic: ProviderOperationalStatus;
    openai: ProviderOperationalStatus;
    xai: ProviderOperationalStatus;
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

export interface ProviderOperationalStatus {
  configured: boolean;
  accounts: number;
  healthy: number;
  enabled: number;
}

export function createOperationalStatus(opts: {
  mode: string;
  target: string;
  authRequired: boolean;
  accounts: HealthAccountView[];
  modelRouting?: ModelRoutingConfig;
}): OperationalStatus {
  const anthropicAccounts = opts.accounts.filter(a => a.provider === "anthropic_subscription");
  const openAIAccounts = opts.accounts.filter(a => a.provider === "openai_subscription");
  const xaiAccounts = opts.accounts.filter(a => a.provider === "xai_subscription");
  const modelRouting = opts.modelRouting ?? {};

  return {
    mode: opts.mode,
    target: opts.target,
    auth: { required: opts.authRequired },
    providers: {
      anthropic: providerStatus(anthropicAccounts),
      openai: providerStatus(openAIAccounts),
      xai: providerStatus(xaiAccounts),
    },
    endpoints: {
      health: "/cc-router/health",
      accounts: "/cc-router/accounts",
      messages: "/v1/messages",
      responses: "/v1/responses",
      models: "/v1/models",
    },
    routing: {
      anthropicDefaultModel: modelRouting.anthropicDefaultModel,
      openAIDefaultModel: modelRouting.openAIDefaultModel,
      anthropicAliases: Object.keys(modelRouting.anthropicAliases ?? {}).sort(),
      openAIAliases: Object.keys(modelRouting.openAIAliases ?? {}).sort(),
    },
    capabilities: {
      anthropicMessages: anthropicAccounts.length > 0,
      openAIResponses: openAIAccounts.length > 0,
      crossProviderMessages: openAIAccounts.length > 0,
      dynamicModels: true,
      accountManagement: true,
    },
  };
}

export function createHealthAccountViews(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAIAccount[],
  resolveRoutingMetrics: RoutingMetricsResolver = zeroRoutingMetrics,
  resolveOpenAIRouting?: (accountId: string) => { metrics: AccountRoutingMetrics; cooldowns: OpenAICooldownView },
  xaiAccounts: GrokAccountSnapshot[] = [],
): HealthAccountView[] {
  return [
    ...anthropicAccounts.map(account => (
      publicAnthropicAccountView(account, resolveRoutingMetrics(account.id))
    )),
    ...openAIAccounts.map(account => publicOpenAIAccountView(
      account,
      resolveOpenAIRouting?.(account.id) ?? { metrics: zeroRoutingMetrics(account.id), cooldowns: { globalUntilMs: 0, bucketCooldowns: [] } },
    )),
    ...xaiAccounts.map(publicXaiAccountView),
  ];
}

function publicXaiAccountView(account: GrokAccountSnapshot): HealthAccountView {
  return {
    id: account.id,
    provider: "xai_subscription",
    enabled: true,
    healthy: account.healthy,
    busy: account.busy,
    inFlightRequests: 0,
    activeSessions: account.activeSessions,
    requestCount: account.requestCount,
    errorCount: 0,
    expiresInMs: account.expiresInMs,
    lastUsedMs: 0,
    lastRefreshMs: 0,
    ...(account.tier !== undefined ? { xai: { tier: account.tier } } : {}),
  };
}

function loadGrokHealthSnapshots(): GrokAccountSnapshot[] {
  const overlay = loadGrokAccountSnapshots();
  const liveSessions = overlay.reduce((sum, account) => Math.max(sum, account.activeSessions), 0);
  const stored = loadXaiAccounts();
  if (stored.length === 0) return overlay;
  const now = Date.now();
  return stored.map(account => ({
    id: account.id,
    provider: "xai_subscription" as const,
    enabled: true as const,
    healthy: account.enabled !== false && account.expiresAt > now,
    busy: liveSessions > 0,
    inFlightRequests: 0 as const,
    activeSessions: liveSessions,
    requestCount: 0,
    errorCount: 0,
    expiresInMs: account.expiresAt - now,
    lastUsedMs: 0,
    lastRefreshMs: 0,
  }));
}

function publicAnthropicAccountView(
  a: Account,
  metrics: AccountRoutingMetrics,
): HealthAccountView {
  return {
    id: a.id,
    provider: "anthropic_subscription",
    enabled: a.enabled,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
    healthy: a.enabled !== false && a.healthy,
    busy: a.busy || metrics.coolingDown,
    cooldownUntilMs: metrics.cooldownUntilMs ?? 0,
    globalCooldownUntilMs: metrics.globalCooldownUntilMs ?? 0,
    modelCooldowns: publicModelCooldowns(metrics.modelCooldowns),
    inFlightRequests: metrics.inFlightRequests,
    activeSessions: metrics.activeSessions,
    requestCount: a.requestCount,
    errorCount: a.errorCount,
    expiresInMs: a.tokens.expiresAt - Date.now(),
    lastUsedMs: a.lastUsed,
    lastRefreshMs: a.lastRefresh,
    rateLimits: publicRateLimits(a.rateLimits),
  };
}

function publicRateLimits(rateLimits: AccountRateLimits): PublicAccountRateLimits {
  return {
    status: rateLimits.status,
    fiveHourUtil: publicUtilization(rateLimits.fiveHourUtil),
    fiveHourReset: publicTimestamp(rateLimits.fiveHourReset),
    sevenDayUtil: publicUtilization(rateLimits.sevenDayUtil),
    sevenDayReset: publicTimestamp(rateLimits.sevenDayReset),
    claim: publicRepresentativeClaim(rateLimits.claim),
    plan: publicPlan(rateLimits.plan),
    requestsLimit: publicNonNegativeInteger(rateLimits.requestsLimit),
    lastUpdated: publicTimestamp(rateLimits.lastUpdated),
    ...(rateLimits.usage ? { usage: publicUsageSnapshot(rateLimits.usage) } : {}),
  };
}

function publicUsageSnapshot(usage: NonNullable<AccountRateLimits["usage"]>): PublicUsageSnapshot {
  return {
    ...(usage.fiveHour ? { fiveHour: publicWindow(usage.fiveHour) } : {}),
    ...(usage.sevenDay ? { sevenDay: publicWindow(usage.sevenDay) } : {}),
    modelLimits: usage.modelLimits.slice(0, 12).map(limit => ({
      modelFamily: publicModelFamily(limit.modelFamily),
      displayName: publicDisplayName(limit.displayName),
      utilization: publicUtilization(limit.utilization),
      resetAt: publicTimestamp(limit.resetAt),
      active: limit.active === true,
      severity: publicSeverity(limit.severity),
    })),
    ...(usage.extraUsage ? {
      extraUsage: {
        enabled: usage.extraUsage.enabled === true,
        spendLimitReached: usage.extraUsage.spendLimitReached === true,
        usable: usage.fetchStatus === "fresh" && canUseExtraUsage(usage.extraUsage),
      },
    } : {}),
    fetchedAt: publicTimestamp(usage.fetchedAt),
    fetchStatus: usage.fetchStatus,
  };
}

function publicWindow(window: { utilization: number; resetAt: number }): PublicRateLimitWindow {
  return { utilization: publicUtilization(window.utilization), resetAt: publicTimestamp(window.resetAt) };
}

function publicModelCooldowns(cooldowns: PublicModelCooldown[] | undefined): PublicModelCooldown[] {
  return (cooldowns ?? []).slice(0, 12).map(cooldown => ({
    modelFamily: publicModelFamily(cooldown.modelFamily),
    untilMs: publicTimestamp(cooldown.untilMs),
  })).filter(cooldown => cooldown.untilMs > 0);
}

function publicUtilization(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function publicTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function publicNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function publicModelFamily(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : "unknown";
}

function publicDisplayName(value: unknown): string {
  if (typeof value !== "string") return "Unknown model";
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return normalized || "Unknown model";
}

function publicSeverity(value: unknown): PublicModelRateLimit["severity"] {
  return value === "warning" || value === "critical" ? value : value ? "unknown" : "";
}

function publicPlan(value: unknown): string {
  return value === "Pro" || value === "Max 5x" || value === "Max 20x" ? value : "";
}

function publicRepresentativeClaim(claim: unknown): string {
  if (typeof claim !== "string") return "unknown";
  const normalized = claim.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "five_hour" ||
    normalized === "seven_day" ||
    normalized === "seven_day_oauth_apps" ||
    normalized === "seven_day_overage_included") return normalized;
  if (normalized.startsWith("seven_day_") && normalized.length > "seven_day_".length) {
    return "seven_day_model";
  }
  return "unknown";
}

function publicOpenAIAccountView(
  a: OpenAIAccount,
  routing: { metrics: AccountRoutingMetrics; cooldowns: OpenAICooldownView },
): HealthAccountView {
  const expiresInMs = a.expiresAt - Date.now();
  return {
    id: a.id,
    provider: "openai_subscription",
    enabled: a.enabled !== false,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
    healthy: a.enabled !== false && a.healthy && expiresInMs > 0,
    busy: routing.metrics.coolingDown,
    cooldownUntilMs: routing.metrics.cooldownUntilMs ?? 0,
    globalCooldownUntilMs: routing.cooldowns.globalUntilMs,
    inFlightRequests: routing.metrics.inFlightRequests,
    activeSessions: routing.metrics.activeSessions,
    requestCount: a.requestCount,
    errorCount: a.errorCount,
    expiresInMs,
    lastUsedMs: a.lastUsed,
    lastRefreshMs: a.lastRefresh,
    codexRateLimits: publicCodexRateLimits(a, routing.cooldowns),
    ...(hasPendingCredentialWrite(a) ? { credentialsPendingWrite: true } : {}),
  };
}

function publicCodexRateLimits(a: OpenAIAccount, cooldowns: OpenAICooldownView): PublicCodexRateLimits {
  const rl = a.rateLimits;
  // A bucket cooldown can exist without any snapshot for that bucket: a
  // header-only 429 (an `x-codex-active-limit` with no accompanying
  // rate-limit headers) sets a cooldown the pool enforces in `hardBlock`.
  // Synthesizing a window-less entry for those keeps the health view honest —
  // otherwise the account renders fully available while it is actually being
  // skipped for that model.
  const cooldownOnly: CodexLimitBucket[] = cooldowns.bucketCooldowns
    .filter(cooldown => !rl.buckets.has(cooldown.limitId))
    .map(cooldown => ({ limitId: cooldown.limitId }));
  const buckets = [...rl.buckets.values(), ...cooldownOnly]
    .sort((left, right) =>
      left.limitId === DEFAULT_CODEX_LIMIT_ID ? -1
        : right.limitId === DEFAULT_CODEX_LIMIT_ID ? 1
        : left.limitId.localeCompare(right.limitId))
    .slice(0, 8)
    .map(bucket => ({
      limitId: publicCodexLimitId(bucket.limitId),
      label: publicCodexLabel(bucket),
      ...(bucket.primary ? { primary: publicCodexWindow(bucket.primary) } : {}),
      ...(bucket.secondary ? { secondary: publicCodexWindow(bucket.secondary) } : {}),
      cooldownUntilMs: publicTimestamp(
        cooldowns.bucketCooldowns.find(c => c.limitId === bucket.limitId)?.untilMs ?? 0,
      ),
    }));
  const credits = rl.credits;
  const balance = typeof credits?.balance === "string"
    ? credits.balance.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 32)
    : "";
  return {
    status: rl.status === "rate_limited" ? "rate_limited" : "ok",
    plan: publicCodexPlan(rl.plan),
    buckets,
    ...(credits ? {
      credits: {
        hasCredits: credits.hasCredits === true,
        unlimited: credits.unlimited === true,
        ...(balance ? { balance } : {}),
      },
    } : {}),
    lastUpdated: publicTimestamp(rl.lastUpdated),
  };
}

function publicCodexWindow(window: CodexRateWindow): PublicCodexWindow {
  return {
    utilization: publicUtilization(window.utilization),
    resetAt: publicTimestamp(window.resetAt),
    windowMinutes: publicNonNegativeInteger(window.windowMinutes),
  };
}

function publicCodexLimitId(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "unknown";
}

function publicCodexLabel(bucket: CodexLimitBucket): string {
  const name = bucket.limitName?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return name || publicCodexLimitId(bucket.limitId);
}

function publicCodexPlan(value: string | undefined): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value) ? value : "";
}

function providerStatus(accounts: HealthAccountView[]): ProviderOperationalStatus {
  return {
    configured: accounts.length > 0,
    accounts: accounts.length,
    healthy: accounts.filter(a => a.healthy).length,
    enabled: accounts.filter(a => a.enabled !== false).length,
  };
}

// Mutates entry and updates aggregate counters with token usage from Anthropic's
// response. Called asynchronously after the log entry is already stored,
// so the dashboard picks up the values on the next poll.
function applyInputUsage(entry: LogEntry, usage: Record<string, number>): void {
  entry.cacheReadTokens = usage["cache_read_input_tokens"] ?? 0;
  entry.cacheCreationTokens = usage["cache_creation_input_tokens"] ?? 0;
  entry.inputTokens = usage["input_tokens"] ?? 0;

  stats.totalCacheReadTokens += entry.cacheReadTokens;
  stats.totalCacheCreationTokens += entry.cacheCreationTokens;
  stats.totalInputTokens += entry.inputTokens;
}

function applyOutputUsage(entry: LogEntry, usage: Record<string, number>): void {
  entry.outputTokens = usage["output_tokens"] ?? 0;
  stats.totalOutputTokens += entry.outputTokens;
}

// ─── Rate limit header extraction ──────────────────────────────────────────

function inferPlan(requestsLimit: number): string {
  if (requestsLimit <= 0) return "";
  if (requestsLimit <= 100) return "Pro";
  if (requestsLimit <= 500) return "Max 5x";
  return "Max 20x";
}

function extractRateLimits(headers: Record<string, string | string[] | undefined>): AccountRateLimits | null {
  const h = (name: string) => String(headers[name] ?? "");
  const status = h("anthropic-ratelimit-unified-status");
  if (!status) return null; // No unified headers in this response

  const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10) || 0;

  return {
    status: status === "rate_limited" ? "rate_limited" : "allowed",
    fiveHourUtil: parseFloat(h("anthropic-ratelimit-unified-5h-utilization")) || 0,
    fiveHourReset: parseInt(h("anthropic-ratelimit-unified-5h-reset"), 10) || 0,
    sevenDayUtil: parseFloat(h("anthropic-ratelimit-unified-7d-utilization")) || 0,
    sevenDayReset: parseInt(h("anthropic-ratelimit-unified-7d-reset"), 10) || 0,
    claim: h("anthropic-ratelimit-unified-representative-claim"),
    plan: inferPlan(requestsLimit),
    requestsLimit,
    lastUpdated: Date.now(),
  };
}

/** Apply upstream rate-limit headers without discarding the usage snapshot. */
export function applyRateLimitHeaders(
  account: Account,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const rateLimits = extractRateLimits(headers);
  if (!rateLimits) return false;
  account.rateLimits = { ...account.rateLimits, ...rateLimits };
  return true;
}

/**
 * Build the single function through which this server writes OpenAI accounts.
 *
 * Two things have to be true of every such write, so they live together here
 * rather than at each call site. It must land in the file the process was
 * started against — a custom `--accounts <path>` must never silently fall back
 * to the default accounts.json. And it must report its own durability: an add,
 * patch, or delete rewrites the same file from the same live array, so it puts
 * a rotation that failed to persist earlier on disk even though no refresh was
 * involved, and the pending-write bookkeeping has to clear with it.
 */
export function createOpenAIPersister(
  accountsPath: string | undefined,
): (accounts: OpenAISubscriptionAccount[]) => void {
  return (accountsToSave: OpenAISubscriptionAccount[]): void => {
    saveOpenAIAccountsToPath(accountsToSave, accountsPath ?? ACCOUNTS_PATH);
    markOpenAICredentialsPersisted(accountsToSave);
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port ?? PROXY_PORT;

  // Direct-to-Anthropic (standalone) or via LiteLLM (full mode).
  // Priority: explicit option > LITELLM_URL env var > direct to Anthropic
  const litellmUrl = opts.litellmUrl ?? LITELLM_URL;
  const target = litellmUrl ?? "https://api.anthropic.com";
  const mode = litellmUrl ? "litellm" : "standalone";

  const accountsPath = opts.accountsPath;
  const persistOpenAIAccounts = createOpenAIPersister(accountsPath);

  if (!accountsFileExists(accountsPath)) {
    console.error(chalk.red("\n✗ accounts.json not found."));
    console.error(chalk.yellow("  Run: cc-router setup\n"));
    process.exit(1);
  }

  migrateLegacyAccountProviders(accountsPath);
  const accounts = accountsPath ? readAccountsFromPath(accountsPath) : loadAccounts();
  const openAIAccounts = loadOpenAIAccounts(accountsPath).map(createOpenAIAccount);
  if (accounts.length === 0 && openAIAccounts.length === 0) {
    console.error(chalk.red("\n✗ No accounts found in accounts.json."));
    console.error(chalk.yellow("  Run: cc-router setup\n"));
    process.exit(1);
  }

  const pool = new TokenPool(accounts);
  const sessionRouter = new SessionRouter(pool);
  const createRoutingMetricsResolver = (): RoutingMetricsResolver => {
    const activeSessionCounts = sessionRouter.getActiveSessionCountsSnapshot();
    return accountId => {
      const cooldowns = pool.getCooldownSummary(accountId);
      return {
        inFlightRequests: pool.getInFlight(accountId),
        activeSessions: activeSessionCounts.get(accountId) ?? 0,
        coolingDown: pool.isCoolingDown(accountId),
        cooldownUntilMs: pool.getEarliestCooldownUntil(accountId),
        globalCooldownUntilMs: cooldowns.globalUntilMs,
        modelCooldowns: cooldowns.modelCooldowns,
      };
    };
  };
  const openAIPool = new OpenAITokenPool(openAIAccounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  // Factory, mirroring `createRoutingMetricsResolver`: the active-session
  // snapshot is taken once per request rather than rebuilt (sweeping every
  // binding and copying the map) for each account, and the cooldown view is
  // computed once per account instead of three times.
  const createOpenAIRoutingResolver = () => {
    const activeSessionCounts = openAIRouter.getActiveSessionCountsSnapshot();
    return (accountId: string) => {
      const cooldowns = openAIPool.getCooldownView(accountId);
      return {
        metrics: {
          inFlightRequests: openAIPool.getInFlight(accountId),
          activeSessions: activeSessionCounts.get(accountId) ?? 0,
          coolingDown: cooldowns.globalUntilMs > 0,
          cooldownUntilMs: cooldowns.globalUntilMs,
        },
        cooldowns,
      };
    };
  };
  const resolveOpenAIRouting = (accountId: string) => createOpenAIRoutingResolver()(accountId);
  const initialConfig = readConfig();
  const modelRouting = initialConfig.modelRouting ?? {};

  // Log when the pool falls back to a capped account — makes the cap bypass
  // visible in the dashboard's "RECENT ACTIVITY" instead of being silent.
  pool.onCapBypass = (a) => {
    const msg = `all accounts capped — routing to ${a.id} (5h: ${Math.round(a.rateLimits.fiveHourUtil * 100)}%, 7d: ${Math.round(a.rateLimits.sevenDayUtil * 100)}%)`;
    logError(a.id, 0, msg);
    stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "error", details: msg });
  };

  // Surface rate-limit recovery in the dashboard so users see the account
  // rejoin the rotation instead of wondering why it stayed red.
  pool.onCooldownExpired = (a) => {
    const msg = `${a.id} cooldown expired — rate limit cleared`;
    stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "route", details: msg });
  };

  openAIPool.onCapBypass = (a) => {
    const msg = `all OpenAI accounts capped — routing to ${a.id}`;
    stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "error", details: msg });
  };
  openAIPool.onCooldownExpired = (a) => {
    stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "route", details: `${a.id} cooldown expired — rate limit cleared` });
  };

  startRefreshLoop(accounts);
  startOpenAIRefreshLoop(openAIAccounts, persistOpenAIAccounts);
  const usageRefresher = new AnthropicUsageRefresher(pool);
  usageRefresher.start();
  // Codex usage otherwise arrives only on response headers, so a freshly
  // restarted daemon showed empty OpenAI bars until the first request
  // happened to route there. Poll the usage endpoint the Codex CLI itself
  // uses, so `cc-router status` is populated immediately — mirroring the
  // Anthropic refresher above.
  const openAIUsageRefresher = new OpenAIUsageRefresher(openAIPool, {
    prepare: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, persistOpenAIAccounts),
  });
  openAIUsageRefresher.start();

  const app = express();
  const proxyRequestTimeoutMs = getProxyRequestTimeoutMs();

  // ─── Proxy auth middleware ─────────────────────────────────────────────────
  // If a proxySecret is configured, all requests must present it as EITHER
  //   "Authorization: Bearer <secret>" (Claude Code CLI, HTTP clients)
  //   OR "x-api-key: <secret>" (Claude Desktop via mitmproxy, Anthropic SDK)
  // The /cc-router/health endpoint is always exempt so monitoring and PM2
  // healthchecks keep working.
  const { proxySecret } = initialConfig;
  const secretBuf = proxySecret ? Buffer.from(proxySecret, "utf-8") : null;

  // Pull the presented secret from either accepted header.
  const presentedSecret = (req: Request): string => {
    const auth = (req.headers["authorization"] as string | undefined) ?? "";
    const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const apiKey = (req.headers["x-api-key"] as string | undefined) ?? "";
    return bearerToken || apiKey;
  };
  // Constant-time comparison with the configured secret (length pre-check is
  // required — timingSafeEqual throws on length mismatch).
  const secretMatches = (presented: string): boolean => {
    if (!secretBuf) return false;
    const presentedBuf = Buffer.from(presented, "utf-8");
    return presentedBuf.length === secretBuf.length && timingSafeEqual(presentedBuf, secretBuf);
  };

  if (secretBuf) {
    app.use((req, res, next) => {
      if (req.path === "/cc-router/health") return next();
      if (!secretMatches(presentedSecret(req))) {
        res.status(401).json({
          type: "error",
          error: { type: "authentication_error", message: "Invalid or missing proxy authentication token" },
        });
        return;
      }
      next();
    });
  }

  // ─── Health endpoint (cc-router internal, NOT proxied) ────────────────────
  // Always reachable without auth so PM2/monitoring liveness checks keep
  // working — but the DETAILED payload (account IDs, plan tier, usage, recent
  // request paths) is disclosure-sensitive. Return it only to an authenticated
  // caller. When no secret is configured the server is loopback-only (enforced
  // before app.listen), so returning full detail to localhost is acceptable.
  app.get("/cc-router/health", (req, res) => {
    // Sweep expired cooldowns on each poll so the dashboard reflects recovery
    // even during idle periods when no /v1 request would trigger getNext().
    pool.sweepExpiredCooldowns();
    openAIPool.sweepExpiredCooldowns();
    const resolveRoutingMetrics = createRoutingMetricsResolver();
    const accountViews = createHealthAccountViews(
      pool.getAll(),
      openAIAccounts,
      resolveRoutingMetrics,
      createOpenAIRoutingResolver(),
      loadGrokHealthSnapshots(),
    );
    const status = accountViews.some(a => a.healthy) ? "ok" : "degraded";

    if (secretBuf && !secretMatches(presentedSecret(req))) {
      res.json({ status });
      return;
    }

    res.json({
      status,
      // The version of the code this daemon actually runs — not what is
      // installed on disk. A service manager can keep an old build alive
      // long after an upgrade (launchd pins the versioned pnpm store path
      // in its plist), and without this field no client can tell.
      version: getCurrentVersion(),
      mode,
      target,
      operational: createOperationalStatus({
        mode,
        target,
        authRequired: Boolean(proxySecret),
        accounts: accountViews,
        modelRouting,
      }),
      uptime: stats.getUptimeSeconds(),
      totalRequests: stats.totalRequests,
      totalErrors: stats.totalErrors,
      totalRefreshes: stats.totalRefreshes,
      totalCacheReadTokens: stats.totalCacheReadTokens,
      totalCacheCreationTokens: stats.totalCacheCreationTokens,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      accounts: accountViews,
      recentLogs: stats.getRecentLogs(50),
    });
  });

  // ─── Account management endpoints (authenticated) ─────────────────────────
  // These are mounted BEFORE the /v1/* proxy middleware so they don't get
  // forwarded to Anthropic. express.json() is scoped to this sub-router so
  // the SSE streaming on /v1/* is never touched (see comment at /v1 handler).
  const accountsRouter = express.Router();
  accountsRouter.use(express.json({ limit: "32kb" }));

  // Shape returned to clients — NEVER includes access/refresh tokens.
  accountsRouter.get("/", (_req, res) => {
    const resolveRoutingMetrics = createRoutingMetricsResolver();
    res.json({
      accounts: createHealthAccountViews(
        pool.getAll(),
        openAIAccounts,
        resolveRoutingMetrics,
        createOpenAIRoutingResolver(),
        loadGrokHealthSnapshots(),
      ),
    });
  });

  accountsRouter.patch("/providers/:provider", (req, res) => {
    const providerParam = req.params.provider;
    if (providerParam !== "anthropic_subscription" && providerParam !== "openai_subscription") {
      res.status(400).json({ error: "provider must be anthropic_subscription or openai_subscription" });
      return;
    }

    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    const enabled = body.enabled;

    const provider = providerParam;
    const snapshots = {
      anthropic: pool.getAll().map(a => ({ id: a.id, enabled: a.enabled })),
      openai: openAIAccounts.map(a => ({ id: a.id, enabled: a.enabled })),
    };

    const applyRuntime = (enabled: boolean) => {
      if (provider === "anthropic_subscription") {
        for (const account of pool.getAll()) {
          pool.updateAccount(account.id, { enabled });
        }
      } else {
        for (const account of openAIAccounts) {
          account.enabled = enabled;
        }
      }
    };

    const rollback = () => {
      for (const snapshot of snapshots.anthropic) {
        pool.updateAccount(snapshot.id, { enabled: snapshot.enabled });
      }
      for (const snapshot of snapshots.openai) {
        const account = openAIAccounts.find(a => a.id === snapshot.id);
        if (account) account.enabled = snapshot.enabled;
      }
    };

    applyRuntime(enabled);
    try {
      const isAnthropic = provider === "anthropic_subscription";
      const changed = persistProviderEnabledState({
        provider,
        enabled,
        accountIds: isAnthropic
          ? pool.getAll().map(account => account.id)
          : openAIAccounts.map(account => account.id),
        // OpenAI accounts are written from the live pool rather than by
        // rewriting whatever is on disk. A refresh may have rotated
        // credentials that never reached a file, and re-serializing that
        // stale record would report this PATCH a success while the only
        // valid refresh token stayed in memory — one crash from forcing a
        // re-login. Going through the live persister saves it and clears the
        // pending marker. Anthropic has no such in-memory rotation to lose.
        persist: () => {
          if (isAnthropic) return setProviderAccountsEnabled(provider, enabled, accountsPath);
          persistOpenAIAccounts(openAIAccounts);
          // Same count `setProviderAccountsEnabled` reports, so the response
          // keeps its shape for both providers: every account of this provider
          // the write covered, not only those whose flag flipped.
          return openAIAccounts.length;
        },
        invalidateAccount: accountId => (isAnthropic ? sessionRouter : openAIRouter)
          .invalidateAccount(accountId),
      });
      res.json({ provider, enabled, changed });
    } catch (err) {
      rollback();
      const message = err instanceof Error ? err.message : String(err);
      logError("accounts", 0, `Failed to persist provider state: ${message}`);
      res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
    }
  });

  /**
   * Persist the pool to disk, returning a structured result instead of
   * throwing. Callers hold a rollback closure for in-memory state in case
   * the disk write fails — so a ENOSPC / EACCES doesn't leave the server
   * silently out of sync with accounts.json.
   */
  const tryPersist = (rollback: () => void): { ok: true } | { ok: false; message: string } => {
    try {
      saveAccounts(pool.getAll());
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { rollback(); } catch { /* best effort */ }
      logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
      return { ok: false, message };
    }
  };

  accountsRouter.patch("/:id", (req, res) => {
    const { id } = req.params;
    const body = (req.body ?? {}) as {
      enabled?: unknown;
      sessionLimitPercent?: unknown;
      weeklyLimitPercent?: unknown;
    };

    const validation = validateAccountPatchBody(body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const patch = validation.patch;

    // A rename is a transaction over pool + session router + disk, not a
    // field write (see account-rename.ts) — validation already guarantees it
    // arrives alone. The two pools share one id namespace, so uniqueness is
    // checked across both regardless of which provider owns the account.
    if (patch.id !== undefined) {
      const newId = patch.id;
      const takenIds = new Set([
        ...pool.getAll().map(a => a.id),
        ...openAIAccounts.map(a => a.id),
      ]);
      const inAnthropic = pool.findById(id) !== null;
      if (!inAnthropic && !openAIAccounts.some(a => a.id === id)) {
        res.status(404).json({ error: `Account "${id}" not found` });
        return;
      }
      try {
        renameAccountTransaction(id, newId, takenIds, inAnthropic
          ? {
              rename: (oldId, nextId) => pool.renameAccount(oldId, nextId) !== null,
              renameSessions: (oldId, nextId) => { sessionRouter.renameAccount(oldId, nextId); },
              persist: () => saveAccounts(pool.getAll()),
            }
          : {
              rename: (oldId, nextId) => openAIPool.renameAccount(oldId, nextId) !== null,
              renameSessions: (oldId, nextId) => { openAIRouter.renameAccount(oldId, nextId); },
              persist: () => persistOpenAIAccounts(openAIAccounts),
            });
      } catch (err) {
        if (err instanceof AccountRenameConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
        res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
        return;
      }
      if (inAnthropic) {
        const account = pool.findById(newId)!;
        res.json({ account: publicAnthropicAccountView(account, createRoutingMetricsResolver()(account.id)) });
      } else {
        const account = openAIAccounts.find(a => a.id === newId)!;
        res.json({ account: publicOpenAIAccountView(account, resolveOpenAIRouting(account.id)) });
      }
      return;
    }

    // Snapshot the previous values so we can roll back on persistence failure
    const existing = pool.findById(id);
    if (existing) {
      const prev = {
        enabled: existing.enabled,
        sessionLimitPercent: existing.sessionLimitPercent,
        weeklyLimitPercent: existing.weeklyLimitPercent,
      };

      const updated = pool.updateAccount(id, patch);
      if (!updated) {
        res.status(404).json({ error: `Account "${id}" not found` });
        return;
      }

      const result = tryPersist(() => {
        pool.updateAccount(id, prev);
      });
      if (!result.ok) {
        res.status(500).json({ error: `Failed to persist accounts.json: ${result.message}` });
        return;
      }
      if (patch.enabled === false) sessionRouter.invalidateAccount(id);
      res.json({
        account: publicAnthropicAccountView(updated, createRoutingMetricsResolver()(updated.id)),
      });
      return;
    }

    // Not a Claude account — try the OpenAI pool. `OpenAITokenPool` has no
    // `updateAccount` of its own, so the runtime `OpenAIAccount` is patched
    // and persisted directly via the same transaction contract used to add
    // and delete OpenAI accounts.
    let updatedOpenAI: OpenAIAccount | undefined;
    try {
      updatedOpenAI = applyOpenAIAccountPatch({
        id,
        patch,
        accounts: openAIAccounts,
        persist: persistOpenAIAccounts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
      res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
      return;
    }
    if (!updatedOpenAI) {
      res.status(404).json({ error: `Account "${id}" not found` });
      return;
    }
    // Same contract as the Anthropic branch above: disabling an account drops
    // its sticky bindings immediately instead of leaving them (and their
    // active-session counts) attributed to it until the binding TTL expires.
    if (patch.enabled === false) openAIRouter.invalidateAccount(id);
    res.json({
      account: publicOpenAIAccountView(updatedOpenAI, resolveOpenAIRouting(updatedOpenAI.id)),
    });
  });

  accountsRouter.post("/", (req, res) => {
    const body = (req.body ?? {}) as Partial<AccountRecord>;
    const required: (keyof AccountRecord)[] = ["id", "accessToken", "refreshToken", "expiresAt"];
    for (const k of required) {
      if (body[k] === undefined || body[k] === null || body[k] === "") {
        res.status(400).json({ error: `Missing required field: ${k}` });
        return;
      }
    }
    if (typeof body.id !== "string" || typeof body.accessToken !== "string" ||
        typeof body.refreshToken !== "string" || typeof body.expiresAt !== "number") {
      res.status(400).json({ error: "Invalid field types on account record" });
      return;
    }
    // Same cap validation the PATCH endpoint applies, so the two writers of
    // these fields agree instead of POST silently clamping a bad value to 100.
    const capValidation = validateAccountPatchBody({
      sessionLimitPercent: body.sessionLimitPercent,
      weeklyLimitPercent: body.weeklyLimitPercent,
    });
    if (!capValidation.ok) {
      res.status(400).json({ error: capValidation.error });
      return;
    }
    // IDs are unique across providers, so a new account may not collide with an
    // existing account in either the Claude pool or the OpenAI pool.
    if (pool.findById(body.id) || openAIAccounts.some(a => a.id === body.id)) {
      res.status(409).json({ error: `Account "${body.id}" already exists` });
      return;
    }

    if (body.provider === "xai_subscription") {
      try {
        upsertAccountRecord({
          id: body.id,
          provider: "xai_subscription",
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          expiresAt: body.expiresAt,
          scopes: Array.isArray(body.scopes) ? body.scopes : [],
          enabled: body.enabled !== false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
        return;
      }
      const now = Date.now();
      res.status(201).json({
        account: publicXaiAccountView({
          id: body.id,
          provider: "xai_subscription",
          enabled: true,
          healthy: body.expiresAt > now,
          busy: false,
          inFlightRequests: 0,
          activeSessions: 0,
          requestCount: 0,
          errorCount: 0,
          expiresInMs: body.expiresAt - now,
          lastUsedMs: 0,
          lastRefreshMs: 0,
        }),
      });
      return;
    }

    if (body.provider === "openai_subscription") {
      let addedOpenAI;
      try {
        addedOpenAI = addOpenAIAccountTransaction({
          record: {
            id: body.id,
            accessToken: body.accessToken,
            refreshToken: body.refreshToken,
            expiresAt: body.expiresAt,
            enabled: body.enabled,
            sessionLimitPercent: body.sessionLimitPercent,
            weeklyLimitPercent: body.weeklyLimitPercent,
          },
          accounts: openAIAccounts,
          persist: persistOpenAIAccounts,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
        res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
        return;
      }
      res.status(201).json({ account: publicOpenAIAccountView(addedOpenAI, resolveOpenAIRouting(addedOpenAI.id)) });
      return;
    }

    const record: AccountRecord = {
      id: body.id,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      scopes: Array.isArray(body.scopes) ? body.scopes : ["user:inference", "user:profile"],
      enabled: body.enabled,
      sessionLimitPercent: body.sessionLimitPercent,
      weeklyLimitPercent: body.weeklyLimitPercent,
    };

    let added;
    try {
      added = pool.addAccount(record);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    const result = tryPersist(() => {
      pool.removeAccount(record.id);
    });
    if (!result.ok) {
      res.status(500).json({ error: `Failed to persist accounts.json: ${result.message}` });
      return;
    }
    res.status(201).json({
      account: publicAnthropicAccountView(added, createRoutingMetricsResolver()(added.id)),
    });
  });

  accountsRouter.delete("/:id", async (req, res) => {
    const { id } = req.params;
    const existing = pool.findById(id);
    const openAIExisting = openAIAccounts.find(account => account.id === id);
    if (!existing && !openAIExisting) {
      const removedXai = removeAccountRecordById(id);
      if (removedXai?.provider === "xai_subscription") {
        res.json({ deleted: id, remaining: pool.getAll().length + openAIAccounts.length });
        return;
      }
      res.status(404).json({ error: `Account "${id}" not found` });
      return;
    }

    if (openAIExisting && !existing) {
      try {
        deleteOpenAIAccountTransaction<OpenAIAccount>({
          id,
          accounts: openAIAccounts,
          otherAccountCount: pool.getAll().length,
          persist: persistOpenAIAccounts,
          forgetAccount: account => openAIPool.forgetAccount(account),
          invalidateAccount: accountId => { openAIRouter.invalidateAccount(accountId); },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = accountDeletionStatusCode(err);
        if (status === 409) {
          res.status(409).json({ error: message });
          return;
        }
        logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
        res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
        return;
      }
      res.json({ ok: true, id });
      return;
    }

    // Preserve the existing Anthropic invariant: a running Anthropic pool
    // always retains at least one account.
    if (pool.getAll().length <= 1) {
      res.status(409).json({ error: "Cannot remove the last account — at least one must remain" });
      return;
    }
    try {
      await deleteAnthropicAccountTransaction({
        id,
        pool,
        sessionRouter,
        persist: saveAccounts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = accountDeletionStatusCode(err);
      if (status === 409) {
        res.status(409).json({ error: message });
        return;
      }
      logError("accounts", 0, `Failed to persist accounts.json: ${message}`);
      res.status(500).json({ error: `Failed to persist accounts.json: ${message}` });
      return;
    }
    res.json({ ok: true, id });
  });

  app.use("/cc-router/accounts", accountsRouter);

  mountModelsRoute(app, {
    getAnthropicAccounts: () => pool.getAll(),
    getOpenAIAccounts: () => openAIAccounts,
    getModelRouting: () => modelRouting,
    setModelRouting: async (next) => {
      Object.keys(modelRouting).forEach(key => {
        delete modelRouting[key as keyof typeof modelRouting];
      });
      Object.assign(modelRouting, next);
      writeConfig({ ...readConfig(), modelRouting: next });
    },
    prepareOpenAIAccount: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, persistOpenAIAccounts),
  });

  // A relayed upstream 401 means the subscription token is stale — kick off a
  // refresh in the background so the *next* request succeeds without making
  // this client wait on it. Best-effort: failures are swallowed here since
  // the ingress lifecycle has already recorded the 401 for this request.
  const onOpenAIUpstreamAuthFailure = (account: OpenAIAccount): void => {
    refreshAndPersistOpenAIAccount(account, openAIAccounts, persistOpenAIAccounts).catch(() => {});
  };

  mountResponsesRoutes(app, {
    openAIRouter,
    openAIPool,
    prepareOpenAIAccount: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, persistOpenAIAccounts),
    modelRouting,
    onUpstreamAuthFailure: onOpenAIUpstreamAuthFailure,
  });

  mountMessagesCrossProviderRoute(app, {
    openAIRouter,
    openAIPool,
    prepareOpenAIAccount: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, persistOpenAIAccounts),
    modelRouting,
    onUpstreamAuthFailure: onOpenAIUpstreamAuthFailure,
  });

  // ─── Proxy middleware ──────────────────────────────────────────────────────
  // IMPORTANT: selfHandleResponse must be false (default) for SSE streaming to
  // work transparently. Setting it to true breaks streaming.
  const proxy = createAnthropicProxy({
    target,
    timeoutMs: proxyRequestTimeoutMs,
    on: {
      proxyReq: (proxyReq, req) => {
        const account = (req as Request)._ccAccount;
        if (!account) return;

        // Replace the placeholder/proxy auth token with the real OAuth token.
        // Claude Code sends ANTHROPIC_AUTH_TOKEN as "Authorization: Bearer proxy-managed".
        // We replace it with the real OAuth token for this account.
        proxyReq.setHeader("authorization", `Bearer ${account.tokens.accessToken}`);

        // Remove x-api-key if present — OAuth authentication uses Authorization Bearer,
        // not x-api-key. Having both set can cause conflicts at Anthropic's side.
        proxyReq.removeHeader("x-api-key");

        // CRITICAL: api.anthropic.com requires the "oauth-2025-04-20" beta flag to
        // accept OAuth tokens (sk-ant-oat01-*). Without it the request is rejected
        // with "OAuth authentication is currently not supported."
        // APPEND — do NOT replace — so existing betas (tools, computer-use, etc.) are preserved.
        const existingBeta = proxyReq.getHeader("anthropic-beta");
        const betas = existingBeta
          ? String(existingBeta).split(",").map(b => b.trim()).filter(Boolean)
          : [];
        if (!betas.includes("oauth-2025-04-20")) {
          betas.push("oauth-2025-04-20");
          proxyReq.setHeader("anthropic-beta", betas.join(","));
        }

        // All other headers are forwarded automatically by http-proxy-middleware:
        //   anthropic-version         — required by Anthropic API
        //   X-Claude-Code-Session-Id  — session aggregation header sent by Claude Code
        //   content-type              — always application/json
        if ((req as Request)._ccRawBody) {
          proxyReq.setHeader("content-length", Buffer.byteLength((req as Request)._ccRawBody!));
          proxyReq.write((req as Request)._ccRawBody);
        }
      },

      proxyRes: (proxyRes, req, response) => {
        const account = (req as Request)._ccAccount;
        const route = (req as Request)._ccRoute;
        if (!account) return;

        const status = proxyRes.statusCode ?? 0;
        const durationMs = (req as Request)._startTime
          ? Date.now() - (req as Request)._startTime!
          : undefined;

        // Complete the pending log entry with response info
        const pendingLog = (req as Request)._pendingLog ?? {
          ts: Date.now(),
          accountId: account.id,
          model: "-",
          type: "route" as const,
        };
        pendingLog.statusCode = status;
        if (durationMs !== undefined) pendingLog.durationMs = durationMs;

        const failureRouting = route
          ? applyUpstreamFailureRoutingDetailed(
              status,
              proxyRes.headers,
              route,
              sessionRouter,
              pool,
            )
          : undefined;
        const cooldownSeconds = failureRouting?.cooldownSeconds;

        if (status === 401) {
          // Token invalid or expired mid-request.
          // Forward the 401 to the client (Claude Code will retry on 401).
          // Schedule a background refresh so the next request succeeds.
          stats.totalErrors++;
          account.errorCount++;
          pendingLog.type = "error";
          pendingLog.details = route
            ? routeFailureDetails(route, "token-invalid")
            : "token-invalid";
          logError(account.id, 401, "Token invalid — scheduling background refresh");

          void refreshAccountIfCurrent(account, pool).catch(console.error);
        } else if (status === 429) {
          // Rate limited — put account on cooldown for Retry-After seconds.
          stats.totalErrors++;
          account.errorCount++;
          const retryAfter = cooldownSeconds ?? 60;
          pendingLog.type = "error";
          pendingLog.details = route
            ? routeFailureDetails(route, "rate-limited", failureRouting?.limitingScope)
            : "rate-limited";
          logError(account.id, 429, `Rate limited — cooldown ${retryAfter}s`);
          // Refresh in the background to narrow only ambiguity-owned global
          // state when fresh usage proves a requested-model exhaustion. The
          // current upstream response remains on the native proxy stream.
          queueMicrotask(() => {
            void usageRefresher.refreshAfterCurrent(account).then(result => {
              if (result.ok && route) {
                reconcileAmbiguousRateLimitCooldown(
                  route,
                  pool,
                  failureRouting?.ambiguousCooldownToken,
                );
              }
            });
          });
        } else if (status === 529) {
          // Anthropic service overloaded — short cooldown on this account.
          stats.totalErrors++;
          account.errorCount++;
          pendingLog.type = "error";
          pendingLog.details = route
            ? routeFailureDetails(route, "service-overloaded")
            : "service-overloaded";
          logError(account.id, 529, "Service overloaded — cooldown 30s");
        } else if (status >= 500) {
          // Any other upstream 5xx passes through byte-transparent — but it
          // must not pass through the DIAGNOSTICS silently: an overnight
          // Anthropic 500 stopped an unattended Claude session while this
          // log showed nothing and the stats reported a clean night. The
          // question "did the proxy or the upstream fail?" was only
          // answerable by cross-referencing the client's own transcript.
          // Unlike 429/529 this takes no cooldown: a plain 5xx says nothing
          // about the account's capacity and can even be request-specific,
          // so cooling the account down would punish it for upstream's (or
          // the request's) problem.
          stats.totalErrors++;
          account.errorCount++;
          pendingLog.type = "error";
          pendingLog.details = route
            ? routeFailureDetails(route, "upstream-error")
            : "upstream-error";
          logError(account.id, status, "Upstream server error (passed through)");
        }

        // ── Capture rate limit utilization from response headers ────────────
        applyRateLimitHeaders(account, proxyRes.headers as Record<string, string | string[] | undefined>);

        const entry = pendingLog as LogEntry;
        stats.addLog(entry);

        // ── Capture token usage from Anthropic response body ─────────────────
        // SSE streams carry usage across two events:
        //   message_start  → input_tokens, cache_read/creation_input_tokens
        //   message_delta   → output_tokens
        // Non-streaming JSON carries all fields in a single usage object.
        // The proxy is byte-transparent and the client's accept-encoding makes
        // upstream compress, so the capture decompresses its own copy of the
        // stream (see usage-capture.ts) — previously compressed responses were
        // skipped, which in practice was EVERY response: no cache rate or
        // token counts ever appeared on Anthropic activity rows.
        const contentType = String(proxyRes.headers["content-type"] ?? "");
        const encoding = String(proxyRes.headers["content-encoding"] ?? "");
        const isCompressed = /gzip|br|deflate/.test(encoding);
        const streamTracker = createStreamLifecycleTracker(
          (req as Request)._startTime ?? Date.now(),
          !isCompressed && contentType.includes("text/event-stream"),
        );
        entry.streamLifecycle = streamTracker.state;
        streamTracker.attach(proxyRes, response);
        proxyRes.on("data", (chunk: Buffer) => streamTracker.observeChunk(chunk));

        const usageCapture = createAnthropicUsageCapture({
          contentType,
          contentEncoding: encoding,
          // Mutates the already-logged entry in place; the dashboard picks the
          // values up on its next poll.
          onInputUsage: (usage) => applyInputUsage(entry, usage),
          onOutputUsage: (usage) => applyOutputUsage(entry, usage),
        });
        if (usageCapture) {
          proxyRes.on("data", (chunk: Buffer) => usageCapture.write(chunk));
          proxyRes.on("end", () => usageCapture.end());
        }
      },

      error: (err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
        const request = _req as Request;
        request._ccReleaseLease?.();
        stats.totalErrors++;
        logError("proxy", 0, err.message);

        // Complete the pending log entry for connection-level errors
        const pendingLog = request._pendingLog;
        if (pendingLog) {
          pendingLog.type = "error";
          pendingLog.statusCode = 0;
          pendingLog.details = request._ccRoute
            ? routeFailureDetails(request._ccRoute, "proxy-error")
            : "proxy-error";
          if (request._startTime) {
            pendingLog.durationMs = Date.now() - request._startTime;
          }
          stats.addLog(pendingLog as LogEntry);
        }

        // res may be a Socket (WebSocket upgrade) — only respond on HTTP ServerResponse
        if (res instanceof ServerResponse && !res.headersSent) {
          // Match Anthropic's error response format so Claude Code handles it gracefully
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: { type: "proxy_error", message: err.message },
          }));
        }
      },
    },
  });

  // ─── /v1/* — select account, refresh if needed, then proxy ───────────────
  // CRITICAL: Do NOT use express.json() here — it consumes the body stream
  // and breaks SSE streaming passthrough.
  app.use("/v1", createAnthropicRoutingMiddleware({
    sessionRouter,
    onEmptyPool: (err, _req, res) => {
      stats.totalErrors++;
      logError("proxy", 503, err.message);
      res.status(503).json({
        type: "error",
        error: { type: "no_accounts", message: err.message },
      });
    },
    onNoEligibleAccount: (err, req) => {
      stats.totalErrors++;
      const entry = createLocalRoutingErrorLog(err.reason, req._ccRouteContext?.modelFamily);
      stats.addLog(entry);
      logError(entry.accountId, entry.statusCode ?? 0, entry.details ?? "no-eligible");
    },
  }), createAnthropicRefreshMiddleware({
    needsRefresh,
    refresh: account => refreshAccountIfCurrent(account, pool),
    onRefreshFailure: (account) => {
      stats.totalErrors++;
      logError(account.id, 401, "Token refresh failed");
    },
  }), (req, _res, next) => {
    const route = req._ccRoute!;
    const account = route.account;
    req._startTime = Date.now();
    const source = route.sessionId !== undefined
      ? "cli" as const
      : req.headers["x-api-key"]
      ? "desktop" as const
      : "api" as const;

    req._pendingLog = {
      ts: Date.now(),
      accountId: account.id,
      model: "-",
      type: "route",
      method: req.method,
      path: req.path,
      source,
      details: routeReasonDetails(route),
    };
    stats.totalRequests++;

    logRoute(
      account.id,
      account.requestCount,
      Math.round((account.tokens.expiresAt - Date.now()) / 60_000),
    );

    next();
  }, proxy);

  // ─── Catch-all — forward everything else (LiteLLM UI, /v1/models, etc.) ──
  app.use("/", createProxyMiddleware<Request, ServerResponse>({
    target,
    changeOrigin: true,
  }));

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = () => {
    console.log(chalk.yellow("\nShutting down — saving tokens..."));
    usageRefresher.stop();
    openAIUsageRefresher.stop();
    saveAccounts(pool.getAll());
    if (managesPidFile()) {
      removePid();
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Update handling ──────────────────────────────────────────────────────
  // Auto-update is OFF by default: installing code unattended from the npm
  // registry (no signature/provenance check) turns any publish-channel
  // compromise into RCE across every running proxy. Default behaviour is
  // notify-only, like pip/npm. Opt in explicitly with `autoUpdate: true` in
  // config or CC_ROUTER_AUTO_UPDATE=1.
  const cfg = readConfig();
  const autoUpdate =
    (cfg.autoUpdate === true || process.env["CC_ROUTER_AUTO_UPDATE"] === "1") &&
    process.env["CC_ROUTER_NO_AUTO_UPDATE"] !== "1";
  if (autoUpdate) {
    const AUTO_UPDATE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const runAutoUpdate = async () => {
      try {
        const check = await checkForUpdate();
        if (!check.updateAvailable || check.diff === "major") return;
        console.log(chalk.cyan(`[auto-update] v${check.current} → v${check.latest} (${check.diff})`));
        const ok = await performUpdate(check.latest);
        if (ok) {
          console.log(chalk.green("[auto-update] Restarting with new version..."));
          saveAccounts(pool.getAll());
          restartSelf();
        }
      } catch (err) {
        console.error(chalk.gray(`[auto-update] Check failed: ${(err as Error).message}`));
      }
    };
    // First check 60s after startup, then every 6h
    setTimeout(runAutoUpdate, 60_000).unref();
    setInterval(runAutoUpdate, AUTO_UPDATE_INTERVAL).unref();
  } else {
    // Notify-only: a single background check shortly after startup. Never
    // installs — just prints the banner telling the user how to update.
    setTimeout(() => {
      void checkForUpdate()
        .then(printUpdateBanner)
        .catch(() => { /* network check is non-critical */ });
    }, 60_000).unref();
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  // HOST env var lets teams bind to 0.0.0.0 for LAN/VPS shared access.
  // Defaults to 127.0.0.1 (localhost-only) for single-user safety.
  const host = process.env["HOST"] ?? "127.0.0.1";

  // Hard safety net: never expose the proxy on a non-loopback interface without
  // a secret. Every start path funnels through app.listen(host), so this guards
  // the daemon / service / HOST=0.0.0.0 cases the interactive wizard can't.
  const isLoopbackHost = (h: string): boolean =>
    h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "::ffff:127.0.0.1";
  if (!isLoopbackHost(host) && !proxySecret) {
    console.error(chalk.red(
      `\n✗ Refusing to bind ${host}:${port} without a proxy secret.\n` +
      `  Exposing the proxy to the network without authentication would let\n` +
      `  anyone who can reach it use your Claude/OpenAI accounts.\n` +
      `  Fix: run 'cc-router start' and set a password when asked, or add a\n` +
      `  "proxySecret" to ~/.cc-router/config.json. To bind localhost only,\n` +
      `  unset HOST (or set HOST=127.0.0.1).\n`,
    ));
    process.exit(1);
  }

  app.listen(port, host, () => {
    // Write PID for daemon/service process management
    if (managesPidFile()) {
      writePid(process.pid);
    }

    const totalAccountCount = accounts.length + openAIAccounts.length;
    logStartup(port, host, mode, target, {
      anthropic: accounts.length,
      openai: openAIAccounts.length,
    });
    console.log(autoUpdate
      ? chalk.gray("  Auto-update: enabled (patch/minor)")
      : chalk.gray("  Auto-update: off (notify-only) — run 'cc-router update' to install"));

    // Anonymous telemetry — fire-and-forget, never blocks proxy startup.
    try {
      const telemetryState = loadTelemetryState();
      // First-run detection: if the install is brand new, emit app_started too
      const firstRunAge = Date.now() - new Date(telemetryState.firstRunAt).getTime();
      if (firstRunAge < 5 * 60 * 1000) {
        void trackEvent("app_started", { first_run: true });
      }
      void trackEvent("proxy_started", {
        account_count: totalAccountCount,
        mode,
      });
      startHeartbeat(totalAccountCount);
    } catch {
      // never let telemetry break the proxy
    }
  });
}
