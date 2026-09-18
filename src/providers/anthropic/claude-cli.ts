import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { OAuthTokens } from "../../proxy/types.js";
import { SetupDiagnosticError } from "../../telemetry/setup-diagnostics.js";
import {
  extractFromCredentialsFileDetailed,
  extractFromKeychainDetailed,
  type CredentialExtractionResult,
} from "../../utils/token-extractor.js";
import { isMacos } from "../../utils/platform.js";

/** `claude setup-token` credentials are long-lived and never refreshable. */
export const LONG_LIVED_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const CLAUDE = "claude";
const TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface ClaudeCliDeps {
  spawn?: typeof nodeSpawn;
  execFile?: typeof nodeExecFile;
  extract?: () => Promise<CredentialExtractionResult>;
  stdout?: NodeJS.WritableStream;
  now?: () => number;
}

function defaultExtract(): Promise<CredentialExtractionResult> {
  return isMacos()
    ? extractFromKeychainDetailed()
    : Promise.resolve(extractFromCredentialsFileDetailed());
}

/** Confirms the Claude Code CLI is runnable; the error message tells the operator the import fallback. */
export function resolveClaudeCli(deps: ClaudeCliDeps = {}): Promise<string> {
  const execFile = deps.execFile ?? nodeExecFile;
  return new Promise((resolve, reject) => {
    execFile(CLAUDE, ["--version"], error => {
      if (!error) {
        resolve(CLAUDE);
        return;
      }
      reject(new SetupDiagnosticError(
        "Claude Code CLI not found on PATH. Install it or use `cc-router accounts add claude` to import an existing login.",
        { stage: "credential_read", reason: "not_found", expected: true },
        { cause: error },
      ));
    });
  });
}

/** Last token in the (ANSI-stripped) output: Ink repaints the success frame several times. */
export function extractLongLivedToken(output: string): string | null {
  const matches = output.replace(ANSI, "").match(TOKEN_PATTERN);
  return matches ? matches[matches.length - 1]! : null;
}

function waitForExit(child: ReturnType<typeof nodeSpawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}

/**
 * `claude auth login --claudeai [--email]` with the terminal handed over to
 * Claude Code. The snapshot comparison is what stops a login that exited 0
 * without writing from re-importing the previous account.
 */
export async function loginWithClaudeCli(
  options: { email?: string },
  deps: ClaudeCliDeps = {},
): Promise<OAuthTokens> {
  const command = await resolveClaudeCli(deps);
  const extract = deps.extract ?? defaultExtract;
  const before = await extract();
  const args = ["auth", "login", "--claudeai", ...(options.email ? ["--email", options.email] : [])];
  const child = (deps.spawn ?? nodeSpawn)(command, args, { stdio: "inherit" });
  const code = await waitForExit(child);
  if (code !== 0) {
    throw new SetupDiagnosticError("claude auth login was cancelled or failed", {
      stage: "credential_read",
      reason: "user_cancelled",
      expected: true,
    });
  }
  const after = await extract();
  if (!after.ok) throw after.error;
  if (before.ok && before.tokens.accessToken === after.tokens.accessToken) {
    throw new SetupDiagnosticError("claude auth login finished but no new credentials were stored.", {
      stage: "credential_read",
      reason: "not_found",
      expected: true,
    });
  }
  return after.tokens;
}

/**
 * `claude setup-token` with stdout mirrored to the terminal and scanned for
 * the token line. Ink keys raw mode on stdin, which stays inherited, and its
 * cursor escapes pass through untouched, so the UI renders as usual. `null`
 * means the command ended without a recognisable token; the caller falls back
 * to a paste prompt. The captured token is never logged.
 */
export async function createLongLivedTokenWithClaudeCli(
  deps: ClaudeCliDeps = {},
): Promise<{ accessToken: string } | null> {
  const command = await resolveClaudeCli(deps);
  const mirror = deps.stdout ?? process.stdout;
  const child = (deps.spawn ?? nodeSpawn)(command, ["setup-token"], {
    stdio: ["inherit", "pipe", "inherit"],
  });
  let output = "";
  const stdout = child.stdout;
  stdout?.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
    mirror.write(chunk);
  });
  const drained = stdout
    ? new Promise<void>(resolve => {
        stdout.once("end", resolve);
        stdout.once("close", resolve);
        stdout.once("error", () => resolve());
      })
    : Promise.resolve();
  const code = await waitForExit(child);
  // A child can exit before the pipe has been fully read; the token often sits
  // in that last unread chunk.
  await drained;
  if (code !== 0) return null;
  const accessToken = extractLongLivedToken(output);
  return accessToken ? { accessToken } : null;
}
