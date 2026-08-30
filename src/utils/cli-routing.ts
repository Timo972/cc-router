import { writeClaudeSettings, removeClaudeSettings, readClaudeProxySettings } from "./claude-config.js";
import {
  writeCodexRouterConfig,
  writeCodexRouterConfigFromClient,
  removeCodexRouterConfig,
  readCodexRouterConfig,
  codexBaseUrlFromRouterUrl,
} from "./codex-config.js";
import { readConfig } from "../config/manager.js";
import { PROXY_PORT, CLAUDE_SETTINGS_PATH } from "../config/paths.js";

export interface ClaudeRoutingStatus {
  target: "claude";
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  path: string;
}

export interface CodexRoutingStatus {
  target: "codex";
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  modelProvider?: string;
  path: string;
}

export interface CliRoutingChange {
  changed: boolean;
  enabled: boolean;
  baseUrl?: string;
  path?: string;
}

function configuredPort(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  return readConfig().runPreferences?.port ?? PROXY_PORT;
}

export function readClaudeRouting(): ClaudeRoutingStatus {
  const current = readClaudeProxySettings();
  return {
    target: "claude",
    enabled: Boolean(current.baseUrl),
    baseUrl: current.baseUrl,
    model: current.model,
    path: CLAUDE_SETTINGS_PATH,
  };
}

export function readCodexRouting(): CodexRoutingStatus {
  const current = readCodexRouterConfig();
  return {
    target: "codex",
    enabled: current.configured,
    baseUrl: current.baseUrl,
    model: current.model,
    modelProvider: current.modelProvider,
    path: current.path,
  };
}

export function setClaudeRouting(enabled: boolean, opts: { port?: number; model?: string } = {}): CliRoutingChange {
  const current = readClaudeRouting();
  if (!enabled) {
    if (!current.enabled) return { changed: false, enabled: false, path: current.path };
    removeClaudeSettings();
    return { changed: true, enabled: false, path: current.path };
  }

  const cfg = readConfig();
  const port = configuredPort(opts.port);
  if (cfg.client?.remoteUrl) {
    writeClaudeSettings(0, cfg.client.remoteUrl, cfg.client.remoteSecret ?? "proxy-managed", opts.model);
    return { changed: true, enabled: true, baseUrl: cfg.client.remoteUrl, path: current.path };
  }
  writeClaudeSettings(port, undefined, undefined, opts.model);
  return { changed: true, enabled: true, baseUrl: `http://localhost:${port}`, path: current.path };
}

export function setCodexRouting(enabled: boolean, opts: { port?: number; model?: string } = {}): CliRoutingChange {
  const current = readCodexRouting();
  if (!enabled) {
    if (!current.enabled) return { changed: false, enabled: false, path: current.path };
    const result = removeCodexRouterConfig();
    return { changed: result.removed, enabled: false, path: result.path };
  }

  const cfg = readConfig();
  const port = configuredPort(opts.port);
  if (cfg.client?.remoteUrl) {
    const result = writeCodexRouterConfigFromClient(cfg, { defaultModel: opts.model });
    return {
      changed: true,
      enabled: true,
      baseUrl: codexBaseUrlFromRouterUrl(cfg.client.remoteUrl),
      path: result.path,
    };
  }
  // Local routing has no auth in front of the proxy, so no env_key is
  // written — Codex would otherwise hard-abort on startup if that env var
  // isn't set.
  const result = writeCodexRouterConfig({
    baseUrl: `http://localhost:${port}/v1`,
    defaultModel: opts.model,
  });
  return {
    changed: true,
    enabled: true,
    baseUrl: `http://localhost:${port}/v1`,
    path: result.path,
  };
}
