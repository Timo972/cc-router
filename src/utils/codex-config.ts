import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import type { ProxyConfig } from "../config/manager.js";
import { CODEX_CONFIG_PATH } from "../config/paths.js";

const START = "# cc-router:start";
const END = "# cc-router:end";

/**
 * Marker prefix for a top-level key the managed block's own value shadows
 * (e.g. a pre-existing `model_provider = "x"` before the block). Commenting
 * it out (rather than deleting it) makes the write reversible: `removeCodex
 * RouterConfig` strips this exact prefix to hand the line back unchanged.
 */
const SUPERSEDED_PREFIX = "# cc-router:superseded ";

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
  /** The env var name actually written into the managed block, if any. */
  tokenEnvKey?: string;
}

export interface WriteCodexRouterConfigFromClientResult extends WriteCodexRouterConfigResult {
  hasSecret: boolean;
}

export function codexBaseUrlFromRouterUrl(remoteUrl: string): string {
  const base = remoteUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function managedBlock(baseUrl: string, tokenEnvKey: string | undefined, defaultModel?: string): string {
  return [
    START,
    ...(defaultModel ? [`model = "${defaultModel}"`] : []),
    "model_provider = \"cc-router\"",
    "",
    "[model_providers.cc-router]",
    "name = \"CC-Router\"",
    `base_url = "${baseUrl}"`,
    "wire_api = \"responses\"",
    ...(tokenEnvKey ? [`env_key = "${tokenEnvKey}"`] : []),
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

function countOccurrences(line: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    idx = line.indexOf(needle, idx);
    if (idx < 0) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function isTableHeaderLine(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Strips a line down to the part that precedes any `#` comment, tracking
 * single-line `"`/`'` quote state so a `#` inside a quoted value is never
 * mistaken for a comment start. Deliberately char-by-char rather than a
 * TOML parser: a `"""`/`'''` run toggles this same quote state three times
 * (open, close, open) and so is naturally left "inside a quote" afterwards
 * — which is also the correct outcome for multiline-string open detection,
 * so the same helper serves both callers below.
 */
function stripCommentTail(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Walks every line once, tracking `"""`/`'''` multiline-string open/close
 * state (deliberately not a full TOML parser), and returns — per line —
 * whether that line's content is opaque multiline-string data (i.e. we were
 * already inside an open multiline string when the line started). Delimiter
 * counting runs against `stripCommentTail`'s output so a `"""`/`'''` inside
 * a `#` comment is never mistaken for a real delimiter (would otherwise
 * wrongly flip string-mode and hide real table headers / assignments after
 * it). This is the single shared lexical pass used by both
 * `findFirstTableHeaderLine` and `supersedeTopLevelKey` so they never
 * disagree about what counts as "inside a multiline string".
 */
function scanTomlLines(lines: string[]): boolean[] {
  const insideMultilineString: boolean[] = [];
  let openDelim: '"""' | "'''" | null = null;
  for (const line of lines) {
    insideMultilineString.push(openDelim !== null);
    if (openDelim) {
      if (countOccurrences(line, openDelim) % 2 === 1) openDelim = null;
      continue;
    }
    const effective = stripCommentTail(line);
    if (countOccurrences(effective, '"""') % 2 === 1) {
      openDelim = '"""';
    } else if (countOccurrences(effective, "'''") % 2 === 1) {
      openDelim = "'''";
    }
  }
  return insideMultilineString;
}

/**
 * Line index of the first top-level table header (`[section]` / `[[array]]`),
 * or `undefined` if the file has none. Ignores lines inside a multiline
 * string value (per `scanTomlLines`) so a `[`-looking content line there is
 * never mistaken for a header.
 */
function findFirstTableHeaderLine(lines: string[], insideMultilineString: boolean[]): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (insideMultilineString[i]) continue;
    if (isTableHeaderLine(lines[i])) return i;
  }
  return undefined;
}

/** Reverses `SUPERSEDED_PREFIX` commenting on every line that carries it. */
function restoreSupersededLines(text: string): string {
  return text
    .split("\n")
    .map(line => (line.startsWith(SUPERSEDED_PREFIX) ? line.slice(SUPERSEDED_PREFIX.length) : line))
    .join("\n");
}

/**
 * Comments out (in place) every top-level `key = ...` assignment among
 * `lines[0, scopeEnd)` — i.e. before the managed block's insertion point —
 * so the block's own value for that key is the only one TOML sees. Already
 * `SUPERSEDED_PREFIX`-marked lines are left untouched: re-running this on an
 * already-commented line must not double-comment it. Lines inside a
 * multiline string value (per `scanTomlLines`) are skipped too — a `key = `
 * looking line THERE is opaque string content, not a live assignment, and
 * must never be mutated.
 */
function supersedeTopLevelKey(lines: string[], key: string, scopeEnd: number, insideMultilineString: boolean[]): void {
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < scopeEnd; i++) {
    if (insideMultilineString[i]) continue;
    const line = lines[i];
    if (line.startsWith(SUPERSEDED_PREFIX)) continue;
    if (assignment.test(line)) {
      lines[i] = `${SUPERSEDED_PREFIX}${line}`;
    }
  }
}

/**
 * Removes the managed block (if present) and restores any superseded lines
 * to their original form. This is the shared "get back to the user's plain
 * config" step used both by the explicit remove path and as the first step
 * of a write (which then re-derives the block position and superseded set
 * from scratch, making writes idempotent).
 */
function stripManagedBlock(existing: string): { next: string; removed: boolean } {
  const bounds = managedBlockBounds(existing);
  if (!bounds) {
    return { next: existing, removed: false };
  }
  const before = existing.slice(0, bounds.start).trimEnd();
  const after = existing.slice(bounds.end).trimStart();
  const merged = [before, after].filter(Boolean).join("\n\n");
  const restored = restoreSupersededLines(merged);
  return { next: restored ? `${restored}\n` : "", removed: true };
}

/**
 * Inserts `block` immediately before the first top-level table header in
 * `existing` (after stripping any prior managed block and restoring any
 * superseded lines), so the block's top-level keys (`model`,
 * `model_provider`) always land at the document's top level per TOML
 * semantics — never silently swallowed into a later `[table]`. Falls back to
 * EOF when the config has no table header at all. Any pre-existing top-level
 * assignment of a key the block will also emit is commented out
 * (`SUPERSEDED_PREFIX`) rather than deleted, so `stripManagedBlock` can hand
 * it back unchanged later.
 */
function replaceManagedBlock(existing: string, block: string, keysToSupersede: string[]): string {
  const { next: base } = stripManagedBlock(existing);
  const lines = base.length > 0 ? base.split("\n") : [];
  const insideMultilineString = scanTomlLines(lines);
  const headerLine = findFirstTableHeaderLine(lines, insideMultilineString);
  const scopeEnd = headerLine ?? lines.length;

  for (const key of keysToSupersede) {
    supersedeTopLevelKey(lines, key, scopeEnd, insideMultilineString);
  }

  if (headerLine === undefined) {
    const trimmedBase = lines.join("\n").trimEnd();
    return [trimmedBase, block].filter(Boolean).join("\n\n") + "\n";
  }

  const before = lines.slice(0, headerLine).join("\n").trimEnd();
  const after = lines.slice(headerLine).join("\n").trimEnd();
  return [before, block, after].filter(Boolean).join("\n\n") + "\n";
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
  const tokenEnvKey = opts.tokenEnvKey;
  const codexDir = join(homeDir, ".codex");

  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf-8")
    : "";
  const keysToSupersede = ["model_provider", ...(opts.defaultModel ? ["model"] : [])];
  const next = replaceManagedBlock(existing, managedBlock(opts.baseUrl, tokenEnvKey, opts.defaultModel), keysToSupersede);
  fs.writeFileSync(configPath, next, "utf-8");

  return { path: configPath, tokenEnvKey };
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

  // Codex hard-aborts on startup with "Missing environment variable" when
  // env_key names a var that isn't set. Only emit it when a remote secret is
  // actually configured — otherwise there is nothing for that var to hold,
  // and a router-side 401 on first request is a far better failure mode than
  // Codex refusing to launch at all.
  const hasSecret = Boolean(cfg.client.remoteSecret);
  const result = writeCodexRouterConfig({
    ...opts,
    baseUrl: codexBaseUrlFromRouterUrl(cfg.client.remoteUrl),
    tokenEnvKey: hasSecret ? "CC_ROUTER_TOKEN" : undefined,
  });

  return {
    ...result,
    hasSecret,
  };
}
