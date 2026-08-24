import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import { parse as parseToml } from "smol-toml";
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

/** Root-level keys the managed block ever supersedes (bare or quoted). */
const SUPERSEDABLE_KEYS = ["model_provider", "model"] as const;

/** Builds a regex matching `key = ` with `key` optionally `"quoted"`/`'quoted'`. */
function assignmentPattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:"${key}"|'${key}'|${key})\\s*=`);
}

/**
 * Reduces a line to its "structural" code: comment tails and single-line
 * quoted-string bodies are stripped out (never inspected), while a `"""`/
 * `'''` delimiter that is NOT nested inside a single-line `"…"`/`'…'` string
 * is preserved verbatim. This is deliberately char-by-char rather than a
 * full TOML parser, but — unlike a naive quote-state toggle — it correctly
 * leaves literal `"""`/`'''` text INSIDE an ordinary single-line string
 * (e.g. `hint = 'use """ here'`) out of the output entirely, so callers
 * scanning for multiline-string delimiters never mistake it for one.
 * Escaped quotes (`\"`) inside basic (`"…"`) strings are honored; literal
 * strings (`'…'`) have no escapes, per TOML.
 */
function codeOnly(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const three = line.slice(i, i + 3);
    if (three === '"""' || three === "'''") {
      out += three;
      i += 3;
      continue;
    }
    const ch = line[i];
    if (ch === "#") break;
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\") j++;
        j++;
      }
      i = j < line.length ? j + 1 : line.length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== "'") j++;
      i = j < line.length ? j + 1 : line.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface TomlLineScan {
  /** Whether line `i` starts already inside an open multiline string. */
  insideMultilineString: boolean[];
  /** Unclosed `[`/`]` array-bracket depth at the START of line `i`. */
  bracketDepthAtLineStart: number[];
}

/**
 * Walks every line once, tracking `"""`/`'''` multiline-string open/close
 * state AND `[`/`]` array-bracket nesting depth (deliberately not a full
 * TOML parser), against `codeOnly`'s output so neither comments nor
 * single-line string content can be mistaken for real delimiters/brackets.
 * This is the single shared lexical pass used by `findFirstTableHeaderLine`
 * and `supersedeTopLevelKey` so they never disagree about what counts as
 * "inside a multiline string" or "inside an unclosed array".
 */
function scanTomlLines(lines: string[]): TomlLineScan {
  const insideMultilineString: boolean[] = [];
  const bracketDepthAtLineStart: number[] = [];
  let openDelim: '"""' | "'''" | null = null;
  let depth = 0;
  for (const line of lines) {
    insideMultilineString.push(openDelim !== null);
    bracketDepthAtLineStart.push(depth);
    if (openDelim) {
      if (countOccurrences(line, openDelim) % 2 === 1) openDelim = null;
      continue;
    }
    const code = codeOnly(line);
    for (const ch of code) {
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
    }
    if (countOccurrences(code, '"""') % 2 === 1) {
      openDelim = '"""';
    } else if (countOccurrences(code, "'''") % 2 === 1) {
      openDelim = "'''";
    }
  }
  return { insideMultilineString, bracketDepthAtLineStart };
}

/**
 * A line is only a real top-level table-header CANDIDATE when it is not
 * inside a multiline string, bracket depth is 0 at its start (i.e. it is
 * not a continuation line of a still-open multiline array — see F2: a
 * `[1, 2],` row inside `matrix = [ … ]` must never be mistaken for a table
 * header), and the trimmed line structurally starts with `[`.
 */
function isTableHeaderLine(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Line index of the first top-level table header (`[section]` / `[[array]]`),
 * or `undefined` if the file has none.
 */
function findFirstTableHeaderLine(lines: string[], scan: TomlLineScan): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (scan.insideMultilineString[i]) continue;
    if (scan.bracketDepthAtLineStart[i] !== 0) continue;
    if (isTableHeaderLine(lines[i])) return i;
  }
  return undefined;
}

/**
 * Reverses `SUPERSEDED_PREFIX` commenting, but only on lines with clear
 * provenance: outside a multiline string (per `scanTomlLines`), and whose
 * remainder (after stripping the prefix) parses as an assignment of one of
 * `SUPERSEDABLE_KEYS` — the only keys this module ever supersedes. Any other
 * line that happens to start with the same text (e.g. a user's own comment,
 * or the literal marker text sitting inside an unrelated multiline string)
 * is left byte-identical.
 */
function restoreSupersededLines(text: string): string {
  const lines = text.split("\n");
  const scan = scanTomlLines(lines);
  return lines
    .map((line, i) => {
      if (scan.insideMultilineString[i]) return line;
      if (!line.startsWith(SUPERSEDED_PREFIX)) return line;
      const remainder = line.slice(SUPERSEDED_PREFIX.length);
      const isManagedKeyAssignment = SUPERSEDABLE_KEYS.some(key => assignmentPattern(key).test(remainder));
      return isManagedKeyAssignment ? remainder : line;
    })
    .join("\n");
}

/**
 * Comments out (in place) every top-level `key = ...` assignment among
 * `lines[0, scopeEnd)` — i.e. before the managed block's insertion point —
 * so the block's own value for that key is the only one TOML sees. Matches
 * `key` bare or quoted (`"key"`/`'key'` — TOML permits both for root keys).
 * Already `SUPERSEDED_PREFIX`-marked lines are left untouched: re-running
 * this on an already-commented line must not double-comment it. Lines
 * inside a multiline string value (per `scanTomlLines`) are skipped too — a
 * `key = ` looking line THERE is opaque string content, not a live
 * assignment, and must never be mutated.
 */
function supersedeTopLevelKey(lines: string[], key: string, scopeEnd: number, insideMultilineString: boolean[]): void {
  const assignment = assignmentPattern(key);
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
  const scan = scanTomlLines(lines);
  const headerLine = findFirstTableHeaderLine(lines, scan);
  const scopeEnd = headerLine ?? lines.length;

  for (const key of keysToSupersede) {
    supersedeTopLevelKey(lines, key, scopeEnd, scan.insideMultilineString);
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

/**
 * Safety net (F0): the line-based scanner above is deliberately not a full
 * TOML parser and can have blind spots. Before any write actually touches
 * disk, the candidate content is parsed with a real TOML parser and checked
 * against the invariants the write is supposed to establish. Any violation
 * throws — loudly refusing to write — rather than silently corrupting the
 * user's `~/.codex/config.toml`.
 */
function assertValidManagedWrite(next: string, defaultModel: string | undefined): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(next) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cc-router refused to write ~/.codex/config.toml: the rewritten config failed TOML validation (${detail}). Your config was NOT modified.`,
    );
  }
  if (parsed.model_provider !== "cc-router") {
    throw new Error(
      "cc-router refused to write ~/.codex/config.toml: the rewritten config failed TOML validation " +
        "(top-level model_provider is not \"cc-router\" after write). Your config was NOT modified.",
    );
  }
  if (defaultModel !== undefined && parsed.model !== defaultModel) {
    throw new Error(
      "cc-router refused to write ~/.codex/config.toml: the rewritten config failed TOML validation " +
        "(top-level model does not match the configured default model). Your config was NOT modified.",
    );
  }
}

/**
 * Safety net (F0) for the remove/strip path: the result of removing the
 * managed block and restoring superseded lines must still be valid TOML.
 * On failure, throw instead of writing — same loud-refusal contract as
 * `assertValidManagedWrite`.
 */
function assertParsesAsToml(next: string): void {
  try {
    parseToml(next);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cc-router refused to update ~/.codex/config.toml: the rewritten config failed TOML validation (${detail}). Your config was NOT modified.`,
    );
  }
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
  assertValidManagedWrite(next, opts.defaultModel);
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
  if (removed) {
    assertParsesAsToml(next);
    fs.writeFileSync(configPath, next, "utf-8");
  }
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
