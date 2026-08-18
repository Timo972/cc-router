import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import type { OAuthTokens } from "../proxy/types.js";
import { SetupDiagnosticError } from "../telemetry/setup-diagnostics.js";

const execFileAsync = promisify(execFile);

/**
 * macOS: extract OAuth tokens from the macOS Keychain.
 * Uses execFile (not exec/execSync) — args are passed as an array,
 * preventing any shell injection.
 */
export async function extractFromKeychain(): Promise<OAuthTokens | null> {
  const result = await extractFromKeychainDetailed();
  return result.ok ? result.tokens : null;
}

export type CredentialExtractionResult =
  | { ok: true; tokens: OAuthTokens; completedStages: readonly ["credential_read", "credential_parse"] }
  | { ok: false; error: SetupDiagnosticError };

export interface KeychainExtractionOptions {
  readCredential?: () => Promise<string>;
}

async function readKeychainCredential(): Promise<string> {
  const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", "Claude Code-credentials",
      "-w",
  ]);
  return stdout;
}

function ownErrorCode(error: unknown): string | number | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor
    && (typeof descriptor.value === "string" || typeof descriptor.value === "number")
    ? descriptor.value
    : undefined;
}

function credentialReadError(error: unknown, source: "Keychain" | "credentials file"): SetupDiagnosticError {
  const code = ownErrorCode(error);
  const reason = code === "EACCES" || code === "EPERM"
    ? "permission_denied" as const
    : code === "ENOENT" || code === 44
      ? "not_found" as const
      : "other" as const;
  const detail = error instanceof Error ? error.message : String(error);
  return new SetupDiagnosticError(`${source} read failed: ${detail}`, {
    stage: "credential_read",
    reason,
    expected: reason !== "other",
  }, { cause: error });
}

function credentialParseError(error: unknown): SetupDiagnosticError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SetupDiagnosticError(`Credential parse failed: ${detail}`, {
    stage: "credential_parse",
    reason: "malformed_credentials",
    expected: true,
  }, { cause: error });
}

export async function extractFromKeychainDetailed(
  options: KeychainExtractionOptions = {},
): Promise<CredentialExtractionResult> {
  let stdout: string;
  try {
    stdout = await (options.readCredential ?? readKeychainCredential)();
  } catch (error) {
    return { ok: false, error: credentialReadError(error, "Keychain") };
  }
  try {
    const raw = JSON.parse(stdout.trim()) as unknown;
    // Keychain JSON can be either:
    //   { claudeAiOauth: { accessToken, refreshToken, ... }, mcpOAuth: {...} }
    //   { accessToken, refreshToken, ... }  (direct, older versions)
    const oauth = oauthPayload(raw);
    const tokens = parseCredentialJson(oauth);
    if (!tokens) throw new TypeError("Credential object is missing required OAuth token fields");
    return { ok: true, tokens, completedStages: ["credential_read", "credential_parse"] };
  } catch (error) {
    return { ok: false, error: credentialParseError(error) };
  }
}

/**
 * Linux / Windows: read from ~/.claude/.credentials.json.
 * Claude Code writes credentials here on non-macOS platforms.
 * No shell — pure Node.js file read.
 */
export function extractFromCredentialsFile(): OAuthTokens | null {
  const result = extractFromCredentialsFileDetailed();
  return result.ok ? result.tokens : null;
}

export function extractFromCredentialsFileDetailed(): CredentialExtractionResult {
  const credPath = join(os.homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) {
    return {
      ok: false,
      error: new SetupDiagnosticError("Claude credentials file was not found", {
        stage: "credential_read",
        reason: "not_found",
        expected: true,
      }),
    };
  }
  let contents: string;
  try {
    contents = readFileSync(credPath, "utf-8");
  } catch (error) {
    return { ok: false, error: credentialReadError(error, "credentials file") };
  }
  try {
    const raw = JSON.parse(contents) as unknown;
    // The file can have two shapes:
    //   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }
    //   { accessToken, refreshToken, expiresAt, scopes }  (direct)
    const oauth = oauthPayload(raw);
    const tokens = parseCredentialJson(oauth);
    if (!tokens) throw new TypeError("Credential object is missing required OAuth token fields");
    return { ok: true, tokens, completedStages: ["credential_read", "credential_parse"] };
  } catch (error) {
    return { ok: false, error: credentialParseError(error) };
  }
}

function oauthPayload(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  return record["claudeAiOauth"] ?? raw;
}

/** Parse and normalise either a raw JSON string or an already-parsed object. */
function parseCredentialJson(raw: unknown): OAuthTokens | null {
  try {
    const obj: Record<string, unknown> =
      typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);

    const accessToken = obj["accessToken"];
    const refreshToken = obj["refreshToken"];
    const expiresAt = obj["expiresAt"];

    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      !accessToken.startsWith("sk-ant-")
    ) {
      return null;
    }

    const rawScopes = obj["scopes"];
    if (rawScopes !== undefined
      && (!Array.isArray(rawScopes) || !rawScopes.every(scope => typeof scope === "string"))) {
      return null;
    }
    const scopes = rawScopes as string[] | undefined
      ?? ["user:inference", "user:profile"];

    let expiresAtMs: number;
    if (typeof expiresAt === "number") {
      expiresAtMs = expiresAt;
    } else if (typeof expiresAt === "string") {
      expiresAtMs = new Date(expiresAt).getTime();
    } else {
      // No expiry info — assume 8h from now (standard OAuth token lifetime)
      expiresAtMs = Date.now() + 8 * 60 * 60 * 1000;
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;

    return { accessToken, refreshToken, expiresAt: expiresAtMs, scopes };
  } catch {
    return null;
  }
}

/** Format a token expiry timestamp as a human-readable string */
export function formatExpiry(expiresAtMs: number): string {
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return "EXPIRED";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Redact a token for safe display: show first 20 chars + "..." */
export function redactToken(token: string): string {
  return token.length > 20 ? `${token.slice(0, 20)}...` : token;
}
