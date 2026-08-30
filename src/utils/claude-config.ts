import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { CLAUDE_SETTINGS_PATH } from "../config/paths.js";
import { readConfigStrict, writeConfig } from "../config/manager.js";
import type { ManagedClaudeEnvBackup } from "../config/manager.js";

const MANAGED_STREAM_IDLE_TIMEOUT_MS = "1800000";
const MANAGED_STREAM_ENV_KEYS = [
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
] as const;

function captureClaudeEnvBackup(env: Record<string, unknown>): ManagedClaudeEnvBackup {
  const capture = (key: typeof MANAGED_STREAM_ENV_KEYS[number]) => {
    const value = env[key];
    return typeof value === "string" ? { existed: true, value } : { existed: false };
  };
  return {
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: capture("CLAUDE_STREAM_IDLE_TIMEOUT_MS"),
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: capture("CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateClaudeEnvBackup(config: object): ManagedClaudeEnvBackup | undefined {
  const raw = (config as Record<string, unknown>)["claudeEnvBackup"];
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new TypeError("claudeEnvBackup must contain an object");
  }

  for (const key of MANAGED_STREAM_ENV_KEYS) {
    const entry = raw[key];
    if (!isRecord(entry) || typeof entry["existed"] !== "boolean") {
      throw new TypeError(`claudeEnvBackup.${key} must contain a boolean existed field`);
    }
    if (entry["existed"] === true && typeof entry["value"] !== "string") {
      throw new TypeError(`claudeEnvBackup.${key}.value must be a string when it existed`);
    }
    if (entry["existed"] === false && Object.hasOwn(entry, "value")) {
      throw new TypeError(`claudeEnvBackup.${key}.value must be absent when it did not exist`);
    }
  }

  return raw as unknown as ManagedClaudeEnvBackup;
}

function clearClaudeEnvBackup(): void {
  const config = readConfigStrict();
  if (!validateClaudeEnvBackup(config)) return;
  const { claudeEnvBackup: _removed, ...rest } = config;
  writeConfig(rest);
}

function parseClaudeSettings(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${CLAUDE_SETTINGS_PATH} must contain a JSON object`);
  }
  const settings = parsed as Record<string, unknown>;
  const env = settings["env"];
  if (env !== undefined && !isRecord(env)) {
    throw new TypeError(`${CLAUDE_SETTINGS_PATH} env must contain a JSON object`);
  }
  return settings;
}

function readClaudeSettingsIfPresent(): Record<string, unknown> | undefined {
  try {
    return parseClaudeSettings(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Write ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into ~/.claude/settings.json.
 *
 * Rules from official Claude Code docs:
 *   - ANTHROPIC_AUTH_TOKEN is sent as "Authorization: Bearer <value>"
 *   - Do NOT append /v1 to ANTHROPIC_BASE_URL — Claude Code adds it automatically
 *   - Merges with existing settings, preserving all other keys
 */
/**
 * @param port - proxy port (used only when baseUrl is not provided)
 * @param baseUrl - full proxy URL e.g. "http://192.168.1.50:3456" or "https://cc-router.example.com"
 *                  If omitted, defaults to http://localhost:<port>
 * @param authToken - explicit auth token; when omitted, reads proxySecret from config or uses "proxy-managed"
 * @param defaultModel - optional Claude Code model, e.g. "openai/default"
 */
export function writeClaudeSettings(port: number, baseUrl?: string, authToken?: string, defaultModel?: string): void {
  const existing = readClaudeSettingsIfPresent() ?? {};

  const existingEnv = (existing["env"] as Record<string, unknown>) ?? {};
  const config = readConfigStrict();
  const backup = validateClaudeEnvBackup(config);

  // Do not create directories or write either user file until all existing
  // settings and backup state have been read and validated successfully.
  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  if (!backup) {
    config.claudeEnvBackup = captureClaudeEnvBackup(existingEnv);
    writeConfig(config);
  }
  // ANTHROPIC_BASE_URL: no trailing /v1 — Claude Code appends it automatically
  const resolvedUrl = baseUrl ?? `http://localhost:${port}`;

  const updated = {
    ...existing,
    ...(defaultModel ? { model: defaultModel } : {}),
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: resolvedUrl,
      // ANTHROPIC_AUTH_TOKEN has higher precedence than ANTHROPIC_API_KEY in Claude Code.
      // Explicit authToken wins (client mode points at a remote secret); otherwise
      // uses the local proxy secret, or the open placeholder if neither is set.
      ANTHROPIC_AUTH_TOKEN: authToken ?? config.proxySecret ?? "proxy-managed",
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: MANAGED_STREAM_IDLE_TIMEOUT_MS,
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: MANAGED_STREAM_IDLE_TIMEOUT_MS,
    },
  };

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Remove cc-router settings from ~/.claude/settings.json.
 * Called when uninstalling cc-router so Claude Code goes back to its default auth.
 */
export function removeClaudeSettings(): void {
  const config = readConfigStrict();
  const backup = validateClaudeEnvBackup(config);

  let rawSettings: string;
  try {
    rawSettings = readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    clearClaudeEnvBackup();
    return;
  }

  let existing: Record<string, unknown>;
  try {
    existing = parseClaudeSettings(rawSettings);
  } catch {
    // Malformed settings are user-owned. Leave both the file and backup intact.
    return;
  }

  const env = existing["env"] as Record<string, unknown> | undefined;
  if (env) {
    delete env["ANTHROPIC_BASE_URL"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    if (backup) {
      for (const key of MANAGED_STREAM_ENV_KEYS) {
        if (env[key] !== MANAGED_STREAM_IDLE_TIMEOUT_MS) continue;
        const previous = backup[key];
        if (previous.existed && previous.value !== undefined) {
          env[key] = previous.value;
        } else {
          delete env[key];
        }
      }
    }
    if (Object.keys(env).length === 0) delete existing["env"];
  }

  // Persist settings first. If this fails, keep the backup for a retry.
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(existing, null, 2), "utf-8");
  clearClaudeEnvBackup();
}

/** Read current Claude Code proxy settings (for display) */
export function readClaudeProxySettings(): { baseUrl?: string; authToken?: string; model?: string } {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    const env = raw["env"] as Record<string, unknown> | undefined;
    if (!env) return {};
    return {
      baseUrl: env?.["ANTHROPIC_BASE_URL"] as string | undefined,
      authToken: env?.["ANTHROPIC_AUTH_TOKEN"] as string | undefined,
      model: raw["model"] as string | undefined,
    };
  } catch {
    return {};
  }
}
