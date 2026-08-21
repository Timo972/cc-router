import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";

/**
 * Read-only Grok CLI overview for the status dashboard.
 *
 * Grok Build authenticates via OIDC into ~/.grok/auth.json and tracks live
 * sessions in ~/.grok/active_sessions.json. That is the source of truth —
 * cc-router does not copy those tokens into accounts.json and does not
 * intercept Grok traffic. xAI also has no Claude-style 5h/7d windows; the
 * dashboard shows live sessions plus the spend-tier from the access-token
 * claims.
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
