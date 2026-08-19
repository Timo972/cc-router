import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import { CONFIG_DIR, ACCOUNTS_PATH, CONFIG_PATH } from "./paths.js";
import type { Account, AccountRecord } from "../proxy/types.js";
import { DEFAULT_RATE_LIMITS, ACCOUNT_USER_DEFAULTS, clampPercent } from "../proxy/types.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";
import type { ModelRoutingConfig } from "../protocol/model-ref.js";

export const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Owner-only permissions for files/dirs that hold OAuth tokens or the proxy secret. */
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: SECRET_DIR_MODE });
    return;
  }
  // Tighten an existing dir that may predate this hardening. No-op on Windows.
  try { chmodSync(CONFIG_DIR, SECRET_DIR_MODE); } catch { /* best effort */ }
}

/**
 * Atomic + private write for credential files: write tmp as 0600 (umask can
 * clear bits, so chmod defensively), then rename. rename preserves the source
 * inode's mode, so the destination ends up 0600 even if it previously existed
 * world-readable. On Windows `mode` is largely ignored; the file lives under
 * the user profile and is protected by the profile ACL.
 */
function writeFileSecureSync(path: string, data: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, { encoding: "utf-8", mode: SECRET_FILE_MODE });
  try { chmodSync(tmp, SECRET_FILE_MODE); } catch { /* best effort */ }
  renameSync(tmp, path);
  try { chmodSync(path, SECRET_FILE_MODE); } catch { /* best effort */ }
}

export function accountsFileExists(path?: string): boolean {
  return existsSync(path ?? ACCOUNTS_PATH);
}

export function readAccountsRaw(): unknown[] {
  return readRawFromPath(ACCOUNTS_PATH);
}

function readRawFromPath(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

/** Deserialize Account[] from an explicit file path */
export function readAccountsFromPath(path: string): Account[] {
  return deserialize(readRawFromPath(path) as AccountRecord[]);
}

// Escritura atómica: escribe a .tmp y renombra — evita JSON corrupto si el proceso muere mid-write
export function writeAccountsAtomic(data: unknown[]): void {
  ensureConfigDir();
  writeAccountsAtomicToPath(ACCOUNTS_PATH, data);
}

function writeAccountsAtomicToPath(path: string, data: unknown[]): void {
  // accounts.json holds plaintext OAuth access + refresh tokens — owner-only.
  writeFileSecureSync(path, JSON.stringify(data, null, 2));
}

export function writeAnthropicAccountsPreservingOtherProviders(data: AccountRecord[]): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const nonAnthropic = existing.filter(a =>
    a.provider !== undefined && a.provider !== "anthropic_subscription"
  );
  writeAccountsAtomicToPath(ACCOUNTS_PATH, [...data, ...nonAnthropic]);
}

export function upsertAccountRecord(record: AccountRecord): void {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const next = [
    ...existing.filter(a => !(a.id === record.id && a.provider === record.provider)),
    record,
  ];
  writeAccountsAtomicToPath(ACCOUNTS_PATH, next);
}

export function removeAccountRecordById(id: string): AccountRecord | null {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const removed = existing.find(a => a.id === id) ?? null;
  if (!removed) return null;

  writeAccountsAtomicToPath(ACCOUNTS_PATH, existing.filter(a => a.id !== id));
  return removed;
}

/**
 * Rename a stored account record in place, keeping every other field. The
 * uniqueness check spans ALL providers — both live in one accounts.json and
 * one URL namespace, so two records sharing an id would be unaddressable.
 * Returns the renamed record, or null if no record has `oldId`.
 */
export function renameAccountRecordById(oldId: string, newId: string): AccountRecord | null {
  ensureConfigDir();
  const existing = readAccountsRaw() as AccountRecord[];
  const target = existing.find(a => a.id === oldId) ?? null;
  if (!target) return null;
  if (newId !== oldId && existing.some(a => a.id === newId)) {
    throw new Error(`An account named "${newId}" already exists`);
  }

  target.id = newId;
  writeAccountsAtomicToPath(ACCOUNTS_PATH, existing);
  return target;
}

export type AccountProvider = "anthropic_subscription" | "openai_subscription";

function normalizeAccountProvider(record: AccountRecord): AccountProvider {
  return record.provider === "openai_subscription"
    ? "openai_subscription"
    : "anthropic_subscription";
}

export function migrateLegacyAccountProviders(path = ACCOUNTS_PATH): boolean {
  const records = readRawFromPath(path) as AccountRecord[];
  let changed = false;
  const migrated = records.map(record => {
    if (record.provider !== undefined) return record;
    changed = true;
    return { ...record, provider: "anthropic_subscription" as const };
  });
  if (changed) writeAccountsAtomicToPath(path, migrated);
  return changed;
}

export function setProviderAccountsEnabled(
  provider: AccountProvider,
  enabled: boolean,
  path = ACCOUNTS_PATH,
): number {
  const records = readRawFromPath(path) as AccountRecord[];
  let changed = 0;
  const next = records.map(record => {
    if (normalizeAccountProvider(record) !== provider) return record;
    changed++;
    return { ...record, provider: normalizeAccountProvider(record), enabled };
  });
  if (changed > 0) writeAccountsAtomicToPath(path, next);
  return changed;
}

/** Deserialize flat AccountRecord[] from the default path into runtime Account[] */
export function loadAccounts(): Account[] {
  return deserialize(readAccountsRaw() as AccountRecord[]);
}

/** Load OpenAI ChatGPT/Codex subscription accounts without mixing them into the Anthropic pool. */
export function loadOpenAIAccounts(path?: string): OpenAISubscriptionAccount[] {
  const records = readRawFromPath(path ?? ACCOUNTS_PATH) as AccountRecord[];
  return records
    .filter(a => a.provider === "openai_subscription")
    .map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      enabled: a.enabled !== false,
      ...(Array.isArray(a.scopes) ? { scopes: a.scopes } : {}),
      ...(a.sessionLimitPercent !== undefined ? { sessionLimitPercent: a.sessionLimitPercent } : {}),
      ...(a.weeklyLimitPercent !== undefined ? { weeklyLimitPercent: a.weeklyLimitPercent } : {}),
    }));
}

/** Persist OpenAI subscription accounts to an explicit accounts file, preserving
 *  every other provider's records already in that file. Shared by `saveOpenAIAccounts`
 *  (default path) and any caller bound to a custom `--accounts <path>`. */
export function saveOpenAIAccountsToPath(accounts: OpenAISubscriptionAccount[], path: string): void {
  ensureConfigDir();
  const existing = readRawFromPath(path) as AccountRecord[];
  const nonOpenAI = existing.filter(a => a.provider !== "openai_subscription");
  const records: AccountRecord[] = accounts.map(a => ({
    id: a.id,
    provider: "openai_subscription",
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: a.expiresAt,
    scopes: a.scopes ?? ["openid", "profile", "email", "offline_access"],
    enabled: a.enabled,
    ...(a.sessionLimitPercent !== undefined ? { sessionLimitPercent: a.sessionLimitPercent } : {}),
    ...(a.weeklyLimitPercent !== undefined ? { weeklyLimitPercent: a.weeklyLimitPercent } : {}),
  }));
  writeAccountsAtomicToPath(path, [...nonOpenAI, ...records]);
}

export function saveOpenAIAccounts(accounts: OpenAISubscriptionAccount[]): void {
  saveOpenAIAccountsToPath(accounts, ACCOUNTS_PATH);
}

// ─── Proxy config (password, future settings) ─────────────────────────────────

/**
 * Client mode config — when present, this machine is acting as a CLIENT to a
 * remote (or local) CC-Router instance instead of running its own proxy.
 * Claude Code's ANTHROPIC_BASE_URL points at `remoteUrl`; Claude Desktop
 * (optionally) is intercepted via mitmproxy and redirected to the same URL.
 */
export interface ClientConfig {
  /** Full URL of the CC-Router server, e.g. "http://192.168.1.50:3456" or "https://proxy.example.com" */
  remoteUrl: string;
  /** Optional Bearer secret for authenticating against the remote proxy */
  remoteSecret?: string;
  /** True once `cc-router client connect --desktop` has successfully provisioned mitmproxy */
  desktopEnabled?: boolean;
  /** True when the mitmproxy interceptor is installed as an OS service (auto-starts on boot) */
  desktopAutoStart?: boolean;
}

/** Persisted run preferences — asked once on first `cc-router start`, reused afterwards. */
export interface RunPreferences {
  /** How the proxy runs: foreground terminal, detached background, or OS-level auto-start service */
  mode: "foreground" | "background" | "service";
  /** Bind to 0.0.0.0 (true) vs 127.0.0.1 (false) — true when serving other devices on the network */
  serverMode: boolean;
  /** Port to listen on (default 3456) */
  port: number;
  /** Automatically configure Claude Code (~/.claude/settings.json) to use the proxy on start */
  configureClaudeCode?: boolean;
}

export interface ManagedClaudeEnvValueBackup {
  existed: boolean;
  value?: string;
}

export interface ManagedClaudeEnvBackup {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: ManagedClaudeEnvValueBackup;
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: ManagedClaudeEnvValueBackup;
}

export interface ProxyConfig {
  proxySecret?: string;
  /** Upstream proxy request timeout in milliseconds. Default: 300000 (5 minutes). */
  proxyRequestTimeoutMs?: number;
  /** Deprecated typo-compatible alias for proxyRequestTimeoutMs. */
  proxyRequesTime?: number;
  /** Auto-update on patch/minor releases. Default: false (notify-only). Set to true to
   *  opt in to unattended installs from the npm registry. */
  autoUpdate?: boolean;
  /** Default and alias model routing for Claude and OpenAI subscription providers. */
  modelRouting?: ModelRoutingConfig;
  /** Present only when this machine is in "client" mode (connected to a remote CC-Router) */
  client?: ClientConfig;
  /** Run preferences — asked once on first start, reused on subsequent starts */
  runPreferences?: RunPreferences;
  /** Original Claude watchdog values saved while CC-Router manages them. */
  claudeEnvBackup?: ManagedClaudeEnvBackup;
}

function parseProxyConfig(raw: string): ProxyConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${CONFIG_PATH} must contain a JSON object`);
  }
  return parsed as ProxyConfig;
}

/**
 * Read config for a read-modify-write operation.
 *
 * Unlike readConfig(), this deliberately propagates read and parse failures so
 * callers cannot replace an unreadable or malformed user config with defaults.
 */
export function readConfigStrict(): ProxyConfig {
  try {
    return parseProxyConfig(readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export function readConfig(): ProxyConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return readConfigStrict();
  } catch (err) {
    console.warn(`Warning: ${CONFIG_PATH} contains invalid JSON: ${(err as Error).message}`);
    try {
      const backupPath = CONFIG_PATH + ".bak";
      copyFileSync(CONFIG_PATH, backupPath);
      console.warn(`  Backup saved to ${backupPath}`);
    } catch { /* best-effort backup */ }
    console.warn(`  Using default configuration for this session.`);
    return {};
  }
}

export function getProxyRequestTimeoutMs(): number {
  const { proxyRequestTimeoutMs, proxyRequesTime } = readConfig();
  const timeoutMs = proxyRequestTimeoutMs ?? proxyRequesTime;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
}

function normalizeProxyConfig(cfg: ProxyConfig): ProxyConfig {
  const { proxyRequesTime, ...normalized } = cfg;
  const timeoutMs = normalized.proxyRequestTimeoutMs ?? proxyRequesTime;
  normalized.proxyRequestTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
  return normalized;
}

export function writeConfig(cfg: ProxyConfig): void {
  ensureConfigDir();
  // config.json holds proxySecret and client.remoteSecret — owner-only.
  writeFileSecureSync(CONFIG_PATH, JSON.stringify(normalizeProxyConfig(cfg), null, 2));
}

export function generateProxySecret(): string {
  return "cc-rtr-" + randomBytes(16).toString("hex");
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function deserialize(records: AccountRecord[]): Account[] {
  return records.filter(a => a.provider === undefined || a.provider === "anthropic_subscription").map(a => ({
    id: a.id,
    tokens: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      scopes: a.scopes ?? ["user:inference", "user:profile"],
    },
    // An authExpired account must come back unhealthy. `needsRefresh()` skips
    // it, so the startup refresh that would otherwise fail and clear `healthy`
    // never runs — and TokenPool.hardBlock() gates only on `enabled && healthy`,
    // so defaulting to true here would route live traffic to a dead token.
    healthy: a.authExpired !== true,
    busy: false,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    lastRefresh: 0,
    consecutiveErrors: 0,
    authExpired: a.authExpired === true,
    rateLimits: { ...DEFAULT_RATE_LIMITS },
    enabled: a.enabled !== false,                         // default true
    sessionLimitPercent: a.sessionLimitPercent !== undefined
      ? clampPercent(a.sessionLimitPercent)
      : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent !== undefined
      ? clampPercent(a.weeklyLimitPercent)
      : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
  }));
}

/** Serialize runtime Account[] back to the flat on-disk AccountRecord[] shape. */
export function serialize(accounts: Account[]): AccountRecord[] {
  return accounts.map(a => ({
    id: a.id,
    provider: "anthropic_subscription",
    accessToken: a.tokens.accessToken,
    refreshToken: a.tokens.refreshToken,
    expiresAt: a.tokens.expiresAt,
    scopes: a.tokens.scopes,
    enabled: a.enabled,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
    ...(a.authExpired ? { authExpired: true } : {}),
  }));
}
