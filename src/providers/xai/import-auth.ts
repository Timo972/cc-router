import { existsSync, readFileSync } from "fs";
import path from "path";
import { grokHomeDir } from "./overview.js";
import { createXaiAccountRecord, type XaiAccountRecord } from "./account-record.js";

export interface ImportGrokAuthOptions {
  grokHome?: string;
  accountId?: string;
  readFile?: (filePath: string) => string;
  fileExists?: (filePath: string) => boolean;
}

interface GrokAuthEntry {
  key?: unknown;
  auth_mode?: unknown;
  email?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
}

/**
 * Copy the Grok CLI OIDC login (~/.grok/auth.json) into an accounts.json record.
 * Does not write the file itself — the caller persists via upsert.
 */
export function importGrokCliAuth(opts: ImportGrokAuthOptions = {}): XaiAccountRecord {
  const grokHome = opts.grokHome ?? grokHomeDir();
  const fileExists = opts.fileExists ?? existsSync;
  const readFile = opts.readFile ?? ((filePath: string) => readFileSync(filePath, "utf-8"));
  const authPath = path.join(grokHome, "auth.json");
  if (!fileExists(authPath)) {
    throw new Error(`No Grok CLI login at ${authPath}. Run: grok login`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(authPath));
  } catch {
    throw new Error(`Could not parse ${authPath}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${authPath} is not a Grok auth map`);
  }

  const entry = firstOidcEntry(raw as Record<string, unknown>);
  if (!entry) {
    throw new Error("No OIDC Grok login found in auth.json. Run: grok login");
  }

  const accessToken = typeof entry.key === "string" ? entry.key.trim() : "";
  const refreshToken = typeof entry.refresh_token === "string" ? entry.refresh_token.trim() : "";
  const expiresAt = parseExpiresAt(entry.expires_at, accessToken);
  const id = opts.accountId?.trim() || "grok";

  return createXaiAccountRecord({
    id,
    accessToken,
    refreshToken,
    expiresAt,
  });
}

function firstOidcEntry(raw: Record<string, unknown>): GrokAuthEntry | undefined {
  for (const value of Object.values(raw)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as GrokAuthEntry;
    if (entry.auth_mode === "oidc" && typeof entry.key === "string" && typeof entry.refresh_token === "string") {
      return entry;
    }
  }
  return undefined;
}

function parseExpiresAt(value: unknown, accessToken: string): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const parts = accessToken.split(".");
  if (parts[1]) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
      if (typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > 0) {
        return claims.exp * 1000;
      }
    } catch { /* fall through */ }
  }
  throw new Error("Grok login is missing a usable expiry");
}


