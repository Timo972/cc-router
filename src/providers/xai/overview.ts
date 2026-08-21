import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { loadXaiAccounts } from "../../config/manager.js";
import { fetchGrokSubscription, type GrokSubscriptionFetchResult } from "./subscription-fetch.js";

/**
 * Read-only Grok CLI overview for the status dashboard.
 *
 * Grok Build authenticates via OIDC into ~/.grok/auth.json and tracks live
 * sessions in ~/.grok/active_sessions.json. That is the source of truth —
 * cc-router does not copy those tokens into accounts.json and does not
 * intercept Grok traffic. xAI also has no Claude-style 5h/7d windows; the
 * dashboard shows live sessions plus the subscription tier.
 *
 * The sync path (`loadGrokHealthSnapshots`) reports the coarse spend-tier from
 * the access-token claims and never touches the network. The async path
 * (`loadGrokHealthSnapshotsWithSubscription`) additionally reads the live plan
 * name ("GrokPro", …) and code-access flag from the Grok backend — see
 * `subscription-fetch.ts` for why that is the only quota-relevant signal xAI
 * exposes to the CLI token.
 */

export interface GrokAccountSnapshot {
  id: string;
  provider: "xai_subscription";
  enabled: true;
  healthy: boolean;
  busy: boolean;
  inFlightRequests: 0;
  activeSessions: number;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: 0;
  tier?: number;
  /** Live plan name from the Grok backend, e.g. "GrokPro" (async path only). */
  subscriptionTier?: string;
  /** Live `hasGrokCodeAccess` flag from the Grok backend (async path only). */
  hasCodeAccess?: boolean;
}

export interface GrokOverviewOptions {
  grokHome?: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  readFile?: (filePath: string) => string;
  fileExists?: (filePath: string) => boolean;
}

interface GrokAuthEntry {
  key?: unknown;
  auth_mode?: unknown;
  email?: unknown;
  expires_at?: unknown;
  team_id?: unknown;
}

interface GrokActiveSession {
  session_id?: unknown;
  pid?: unknown;
  opened_at?: unknown;
}

export function grokHomeDir(homeDir = os.homedir()): string {
  const fromEnv = process.env["GROK_HOME"]?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homeDir, ".grok");
}

export function loadGrokAccountSnapshots(opts: GrokOverviewOptions = {}): GrokAccountSnapshot[] {
  const grokHome = opts.grokHome ?? grokHomeDir();
  const now = opts.now ?? Date.now;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const readFile = opts.readFile ?? ((filePath: string) => readFileSync(filePath, "utf-8"));
  const fileExists = opts.fileExists ?? existsSync;

  const authPath = path.join(grokHome, "auth.json");
  if (!fileExists(authPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(authPath));
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];

  const liveSessions = readLiveSessions(
    path.join(grokHome, "active_sessions.json"),
    { readFile, fileExists, isProcessAlive },
  );
  const nowMs = now();
  const usedIds = new Set<string>();
  const snapshots: GrokAccountSnapshot[] = [];

  for (const entry of Object.values(raw as Record<string, unknown>)) {
    const snapshot = snapshotFromAuthEntry(entry, liveSessions.length, nowMs, usedIds);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

/** Stored xAI accounts if any, otherwise the live Grok CLI login. */
export function loadGrokHealthSnapshots(opts: GrokOverviewOptions = {}): GrokAccountSnapshot[] {
  const overlay = loadGrokAccountSnapshots(opts);
  const liveSessions = overlay.reduce((sum, account) => Math.max(sum, account.activeSessions), 0);
  const stored = loadXaiAccounts();
  if (stored.length === 0) return overlay;
  const now = (opts.now ?? Date.now)();
  return stored.map(account => {
    const tier = grokTierFromAccessToken(account.accessToken);
    return {
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
      ...(tier !== undefined ? { tier } : {}),
    };
  });
}

export interface GrokSubscriptionOptions extends GrokOverviewOptions {
  /** Injectable for tests; defaults to the live Grok backend fetch. */
  fetchSubscription?: (accessToken: string) => Promise<GrokSubscriptionFetchResult>;
  /** Injectable for tests; defaults to the stored xAI accounts. */
  accounts?: Array<{ id: string; accessToken: string }>;
}

/**
 * Sync snapshots enriched with the live plan name + code-access flag. Each
 * stored xAI account gets one `/v1/user` lookup (matched by id); a failed or
 * missing lookup leaves the snapshot on its access-token `tier` fallback, so an
 * offline dashboard degrades to the coarse tier instead of dropping the row.
 */
export async function loadGrokHealthSnapshotsWithSubscription(
  opts: GrokSubscriptionOptions = {},
): Promise<GrokAccountSnapshot[]> {
  const base = loadGrokHealthSnapshots(opts);
  if (base.length === 0) return base;
  const accounts = opts.accounts ?? loadXaiAccounts();
  const fetchSubscription = opts.fetchSubscription
    ?? ((accessToken: string) => fetchGrokSubscription({ accessToken }));

  return Promise.all(base.map(async snapshot => {
    const account = accounts.find(candidate => candidate.id === snapshot.id);
    if (!account) return snapshot;
    const result = await fetchSubscription(account.accessToken);
    if (!result.ok) return snapshot;
    return {
      ...snapshot,
      ...(result.subscriptionTier !== undefined ? { subscriptionTier: result.subscriptionTier } : {}),
      ...(result.hasCodeAccess !== undefined ? { hasCodeAccess: result.hasCodeAccess } : {}),
    };
  }));
}

export function grokSnapshotAsHealthAccount(snapshot: GrokAccountSnapshot): {
  id: string;
  provider: "xai_subscription";
  enabled: true;
  healthy: boolean;
  busy: boolean;
  inFlightRequests: 0;
  activeSessions: number;
  requestCount: number;
  errorCount: number;
  expiresInMs: number;
  lastUsedMs: number;
  lastRefreshMs: number;
  xai?: { tier?: number; subscriptionTier?: string; hasCodeAccess?: boolean };
} {
  const xai = {
    ...(snapshot.tier !== undefined ? { tier: snapshot.tier } : {}),
    ...(snapshot.subscriptionTier !== undefined ? { subscriptionTier: snapshot.subscriptionTier } : {}),
    ...(snapshot.hasCodeAccess !== undefined ? { hasCodeAccess: snapshot.hasCodeAccess } : {}),
  };
  return {
    id: snapshot.id,
    provider: "xai_subscription",
    enabled: true,
    healthy: snapshot.healthy,
    busy: snapshot.busy,
    inFlightRequests: 0,
    activeSessions: snapshot.activeSessions,
    requestCount: snapshot.requestCount,
    errorCount: snapshot.errorCount,
    expiresInMs: snapshot.expiresInMs,
    lastUsedMs: snapshot.lastUsedMs,
    lastRefreshMs: snapshot.lastRefreshMs,
    ...(Object.keys(xai).length > 0 ? { xai } : {}),
  };
}

export function mergeGrokIntoHealth<T extends {
  accounts: Array<{
    provider?: string;
    id?: string;
    xai?: { tier?: number; subscriptionTier?: string; hasCodeAccess?: boolean };
  }>;
  operational?: {
    providers: {
      anthropic: { configured: boolean; accounts: number; healthy: number; enabled: number };
      openai: { configured: boolean; accounts: number; healthy: number; enabled: number };
      xai?: { configured: boolean; accounts: number; healthy: number; enabled: number };
    };
  };
}>(health: T, snapshots: GrokAccountSnapshot[] = loadGrokHealthSnapshots()): T {
  // The proxy daemon already emits the Grok row from the sync (network-free)
  // path, so it carries only the coarse `tier`. Rather than skip enrichment,
  // overlay the live plan name / code-access flag from the async snapshots the
  // caller polled — otherwise the daemon-served row would stay stuck on "tier N".
  if (health.accounts.some(account => account.provider === "xai_subscription")) {
    return enrichExistingGrokAccounts(health, snapshots);
  }
  const grokAccounts = snapshots.map(grokSnapshotAsHealthAccount);
  if (grokAccounts.length === 0) return health;
  const healthy = grokAccounts.filter(account => account.healthy).length;
  const xai = {
    configured: true,
    accounts: grokAccounts.length,
    healthy,
    enabled: grokAccounts.length,
  };
  return {
    ...health,
    accounts: [...health.accounts, ...grokAccounts],
    ...(health.operational
      ? { operational: { ...health.operational, providers: { ...health.operational.providers, xai } } }
      : {}),
  };
}

/**
 * Overlay the live plan name / code-access flag from freshly-polled snapshots
 * onto the tier-only Grok rows the proxy daemon serves. Matches by account id,
 * with a single-account fallback (the common one-Grok-login case). Returns the
 * same object untouched when nothing changed, so the fast poll path stays cheap.
 */
function enrichExistingGrokAccounts<T extends {
  accounts: Array<{
    provider?: string;
    id?: string;
    xai?: { tier?: number; subscriptionTier?: string; hasCodeAccess?: boolean };
  }>;
}>(health: T, snapshots: GrokAccountSnapshot[]): T {
  if (snapshots.length === 0) return health;
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  let changed = false;
  const accounts = health.accounts.map(account => {
    if (account.provider !== "xai_subscription") return account;
    const snapshot = (account.id !== undefined ? byId.get(account.id) : undefined)
      ?? (snapshots.length === 1 ? snapshots[0] : undefined);
    if (!snapshot) return account;
    const enrichment = {
      ...(snapshot.tier !== undefined ? { tier: snapshot.tier } : {}),
      ...(snapshot.subscriptionTier !== undefined ? { subscriptionTier: snapshot.subscriptionTier } : {}),
      ...(snapshot.hasCodeAccess !== undefined ? { hasCodeAccess: snapshot.hasCodeAccess } : {}),
    };
    if (Object.keys(enrichment).length === 0) return account;
    changed = true;
    return { ...account, xai: { ...account.xai, ...enrichment } };
  });
  return changed ? { ...health, accounts } : health;
}

function snapshotFromAuthEntry(
  value: unknown,
  liveSessionCount: number,
  nowMs: number,
  usedIds: Set<string>,
): GrokAccountSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as GrokAuthEntry;
  if (entry.auth_mode !== "oidc" && typeof entry.key !== "string") return undefined;

  const claims = typeof entry.key === "string" ? decodeJwtPayload(entry.key) : null;
  const id = uniqueAccountId("grok", usedIds);
  const expiresAt = parseExpiresAt(entry.expires_at, claims);
  const expiresInMs = expiresAt > 0 ? expiresAt - nowMs : 0;
  const healthy = expiresInMs > 0;
  const tier = numberClaim(claims, "tier");

  return {
    id,
    provider: "xai_subscription",
    enabled: true,
    healthy,
    busy: liveSessionCount > 0,
    inFlightRequests: 0,
    activeSessions: liveSessionCount,
    requestCount: 0,
    errorCount: 0,
    expiresInMs,
    lastUsedMs: 0,
    lastRefreshMs: 0,
    ...(tier !== undefined ? { tier } : {}),
  };
}

function readLiveSessions(
  sessionsPath: string,
  opts: {
    readFile: (filePath: string) => string;
    fileExists: (filePath: string) => boolean;
    isProcessAlive: (pid: number) => boolean;
  },
): GrokActiveSession[] {
  if (!opts.fileExists(sessionsPath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(opts.readFile(sessionsPath));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is GrokActiveSession => {
    if (row === null || typeof row !== "object") return false;
    const pid = (row as GrokActiveSession).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && opts.isProcessAlive(pid);
  });
}

function uniqueAccountId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
}

function parseExpiresAt(value: unknown, claims: Record<string, unknown> | null): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const exp = numberClaim(claims, "exp");
  return exp !== undefined && exp > 0 ? exp * 1000 : 0;
}

export function grokTierFromAccessToken(accessToken: string): number | undefined {
  return numberClaim(decodeJwtPayload(accessToken), "tier");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function numberClaim(claims: Record<string, unknown> | null, key: string): number | undefined {
  const value = claims?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
