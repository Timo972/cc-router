import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import type { ProxyConfig } from "../config/manager.js";
import { CODEX_CONFIG_PATH } from "../config/paths.js";

const START = "# cc-router:start";
const END = "# cc-router:end";

interface CodexConfigFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => void;
  mkdirSync: (path: string, opts: { recursive: true }) => unknown;
}

export interface WriteCodexRouterConfigOptions {
  homeDir?: string;
  baseUrl: string;
  tokenEnvKey?: string;
  defaultModel?: string;
  fs?: CodexConfigFs;
}

export interface WriteCodexRouterConfigResult {
  path: string;
}

export interface WriteCodexRouterConfigFromClientResult extends WriteCodexRouterConfigResult {
  hasSecret: boolean;
}

export function codexBaseUrlFromRouterUrl(remoteUrl: string): string {
  const base = remoteUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function managedBlock(baseUrl: string, tokenEnvKey: string, defaultModel?: string): string {
  return [
    START,
    ...(defaultModel ? [`model = "${defaultModel}"`] : []),
    "model_provider = \"cc-router\"",
    "",
    "[model_providers.cc-router]",
    "name = \"CC-Router\"",
    `base_url = "${baseUrl}"`,
    "wire_api = \"responses\"",
    `env_key = "${tokenEnvKey}"`,
    END,
  ].join("\n");
}

function managedBlockBounds(existing: string): { start: number; end: number } | undefined {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start) {
    throw new Error("Malformed cc-router managed block in Codex config");
  }
  return { start, end: end + END.length };
}

function replaceManagedBlock(existing: string, block: string): string {
  const bounds = managedBlockBounds(existing);
  if (bounds) {
    const before = existing.slice(0, bounds.start).trimEnd();
    const after = existing.slice(bounds.end).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }

  return [existing.trimEnd(), block].filter(Boolean).join("\n\n") + "\n";
}

function stripManagedBlock(existing: string): { next: string; removed: boolean } {
  const bounds = managedBlockBounds(existing);
  if (!bounds) return { next: existing, removed: false };
  const before = existing.slice(0, bounds.start).trimEnd();
  const after = existing.slice(bounds.end).trimStart();
  const next = [before, after].filter(Boolean).join("\n\n");
  return { next: next ? `${next}\n` : "", removed: true };
}

function quotedTomlValue(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match?.[1];
}

export interface RemoveCodexRouterConfigOptions {
  homeDir?: string;
  fs?: CodexConfigFs;
}

export interface RemoveCodexRouterConfigResult {
  path: string;
  removed: boolean;
}

export interface CodexRouterConfigView {
  path: string;
  configured: boolean;
  baseUrl?: string;
  model?: string;
  modelProvider?: string;
}

function codexConfigPath(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

function resolveCodexFs(opts?: { homeDir?: string; fs?: CodexConfigFs }): {
  fs: CodexConfigFs;
  homeDir: string;
  configPath: string;
} {
  const fs = opts?.fs ?? { existsSync, readFileSync, writeFileSync, mkdirSync };
  const homeDir = opts?.homeDir ?? os.homedir();
  const configPath = opts?.homeDir ? codexConfigPath(homeDir) : CODEX_CONFIG_PATH;
  return { fs, homeDir, configPath };
}

export function writeCodexRouterConfig(opts: WriteCodexRouterConfigOptions): WriteCodexRouterConfigResult {
  const { fs, homeDir, configPath } = resolveCodexFs(opts);
  const tokenEnvKey = opts.tokenEnvKey ?? "CC_ROUTER_TOKEN";
  const codexDir = join(homeDir, ".codex");

  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf-8")
    : "";
  const next = replaceManagedBlock(existing, managedBlock(opts.baseUrl, tokenEnvKey, opts.defaultModel));
  fs.writeFileSync(configPath, next, "utf-8");

  return { path: configPath };
}

/** Strip the managed `# cc-router:start` … `# cc-router:end` block from Codex config. */
export function removeCodexRouterConfig(
  opts: RemoveCodexRouterConfigOptions = {},
): RemoveCodexRouterConfigResult {
  const { fs, configPath } = resolveCodexFs(opts);
  if (!fs.existsSync(configPath)) return { path: configPath, removed: false };

  const existing = fs.readFileSync(configPath, "utf-8");
  const { next, removed } = stripManagedBlock(existing);
  if (removed) fs.writeFileSync(configPath, next, "utf-8");
  return { path: configPath, removed };
}

/** Read whether Codex CLI is currently pointed at CC-Router. */
export function readCodexRouterConfig(
  opts: RemoveCodexRouterConfigOptions = {},
): CodexRouterConfigView {
  const { fs, configPath } = resolveCodexFs(opts);
  if (!fs.existsSync(configPath)) return { path: configPath, configured: false };

  const existing = fs.readFileSync(configPath, "utf-8");
  const bounds = managedBlockBounds(existing);
  if (!bounds) return { path: configPath, configured: false };

  const block = existing.slice(bounds.start, bounds.end);
  return {
    path: configPath,
    configured: true,
    baseUrl: quotedTomlValue(block, "base_url"),
    model: quotedTomlValue(block, "model"),
    modelProvider: quotedTomlValue(block, "model_provider"),
  };
}

export function writeCodexRouterConfigFromClient(
  cfg: Pick<ProxyConfig, "client">,
  opts: Omit<WriteCodexRouterConfigOptions, "baseUrl" | "tokenEnvKey"> = {},
): WriteCodexRouterConfigFromClientResult {
  if (!cfg.client?.remoteUrl) {
    throw new Error("Client mode is not configured. Run: cc-router client connect <url>");
  }

  const result = writeCodexRouterConfig({
    ...opts,
    baseUrl: codexBaseUrlFromRouterUrl(cfg.client.remoteUrl),
    tokenEnvKey: "CC_ROUTER_TOKEN",
  });

  return {
    ...result,
    hasSecret: Boolean(cfg.client.remoteSecret),
  };
}
