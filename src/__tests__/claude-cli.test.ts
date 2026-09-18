import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createLongLivedTokenWithClaudeCli,
  extractLongLivedToken,
  loginWithClaudeCli,
  resolveClaudeCli,
} from "../providers/anthropic/claude-cli.js";
import type { OAuthTokens } from "../proxy/types.js";

const ok = (tokens: OAuthTokens) => async () => ({ ok: true as const, tokens });
const tokens = (accessToken: string): OAuthTokens => ({
  accessToken,
  refreshToken: "sk-ant-ort01-r",
  expiresAt: 1_900_000_000_000,
  scopes: ["user:inference", "user:profile"],
});

/** A fake child process: emits `exit` with `code` after the caller writes `stdoutChunks`. */
function fakeSpawn(code: number, stdoutChunks: string[] = []) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    setImmediate(() => {
      for (const chunk of stdoutChunks) child.stdout.write(chunk);
      child.stdout.end();
      child.emit("exit", code, null);
    });
    return child;
  }) as never;
  return { spawn, calls };
}

describe("extractLongLivedToken", () => {
  it("returns the last token across repeated ANSI-coloured frames", () => {
    const frame = (n: number) => `\x1b[33msk-ant-oat01-${"a".repeat(30)}${n}\x1b[39m\n`;
    expect(extractLongLivedToken(frame(1) + "Store this token securely\n" + frame(2)))
      .toBe(`sk-ant-oat01-${"a".repeat(30)}2`);
  });
  it("returns null when nothing matches", () => {
    expect(extractLongLivedToken("Browser didn't open?\nsk-ant-ort01-not-an-access-token")).toBeNull();
  });
});

describe("resolveClaudeCli", () => {
  it("throws a not_found setup error when claude is missing", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(Object.assign(new Error("nope"), { code: "ENOENT" }))) as never;
    await expect(resolveClaudeCli({ execFile }))
      .rejects.toMatchObject({ classification: { stage: "credential_read", reason: "not_found" } });
  });
});

describe("loginWithClaudeCli", () => {
  it("passes --claudeai and --email and returns the newly stored credentials", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const extract = vi.fn()
      .mockResolvedValueOnce({ ok: true, tokens: tokens("sk-ant-oat01-old") })
      .mockResolvedValueOnce({ ok: true, tokens: tokens("sk-ant-oat01-new") });
    const result = await loginWithClaudeCli({ email: "me@example.com" }, { spawn, extract, execFile: okExecFile() });
    expect(result.accessToken).toBe("sk-ant-oat01-new");
    expect(calls[0]).toEqual({ command: "claude", args: ["auth", "login", "--claudeai", "--email", "me@example.com"] });
  });

  it("fails when login exits 0 but the stored token is unchanged", async () => {
    const { spawn } = fakeSpawn(0);
    const extract = ok(tokens("sk-ant-oat01-same"));
    await expect(loginWithClaudeCli({}, { spawn, extract, execFile: okExecFile() }))
      .rejects.toMatchObject({ classification: { stage: "credential_read", reason: "not_found" } });
  });

  it("treats a non-zero exit as a cancellation", async () => {
    const { spawn } = fakeSpawn(1);
    await expect(loginWithClaudeCli({}, { spawn, extract: ok(tokens("x")), execFile: okExecFile() }))
      .rejects.toMatchObject({ classification: { stage: "credential_read", reason: "user_cancelled" } });
  });
});

describe("createLongLivedTokenWithClaudeCli", () => {
  it("mirrors stdout and returns the captured token", async () => {
    const token = `sk-ant-oat01-${"b".repeat(40)}`;
    const { spawn, calls } = fakeSpawn(0, ["Creating...\n", `\x1b[33m${token}\x1b[39m\n`]);
    const mirrored = new PassThrough();
    let seen = "";
    mirrored.on("data", c => { seen += c; });
    const result = await createLongLivedTokenWithClaudeCli({ spawn, stdout: mirrored, execFile: okExecFile() });
    expect(result).toEqual({ accessToken: token });
    expect(seen).toContain("Creating...");
    expect(calls[0]).toEqual({ command: "claude", args: ["setup-token"] });
  });

  it("returns null when no token appears in the output", async () => {
    const { spawn } = fakeSpawn(0, ["nothing here\n"]);
    await expect(createLongLivedTokenWithClaudeCli({ spawn, stdout: new PassThrough(), execFile: okExecFile() }))
      .resolves.toBeNull();
  });
});

function okExecFile() {
  return vi.fn((_c: string, _a: string[], cb: (e: Error | null, stdout: string) => void) =>
    cb(null, "2.1.276\n")) as never;
}
