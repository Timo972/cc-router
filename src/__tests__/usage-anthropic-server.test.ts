import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { UsageStore } from "../usage/store.js";

it("excludes count-token preflights and retains exact native Anthropic cumulative/aborted usage across replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-anthropic-acceptance-")); const configDir = join(home, ".cc-router"); mkdirSync(configDir);
  const accountsPath = join(configDir, "accounts.json"), configPath = join(configDir, "config.json"), usageDir = join(configDir, "usage");
  writeFileSync(accountsPath, JSON.stringify([{ id: "claude", provider: "anthropic_subscription", accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret", expiresAt: Date.now() + 86_400_000, scopes: ["user:profile", "user:inference"] }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));
  const child = fork(fileURLToPath(new URL("./fixtures/usage-anthropic-server.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], env: { ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"), ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath, USAGE_DIR: usageDir,
    HOST: "127.0.0.1", CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1", CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "0", CC_ROUTER_NO_AUTO_UPDATE: "1", NO_UPDATE_NOTIFIER: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit"); let logs = ""; child.stdout?.on("data", b => { logs += b; }); child.stderr?.on("data", b => { logs += b; });
  let stopped = false;
  async function stop() { if (stopped) return; stopped = true; child.kill("SIGTERM"); const kill = setTimeout(() => child.kill("SIGKILL"), 3_000); try { const [code, signal] = await exited; if (process.platform === "win32") expect(signal === "SIGTERM" || code === 0).toBe(true); else { expect(signal).toBeNull(); expect(code).toBe(0); } } finally { clearTimeout(kill); } }
  try {
    const [{ port }] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Fixture exited: ${logs}`); })]) as [{ port: number }];
    const base = `http://127.0.0.1:${port}`, headers = { authorization: "Bearer fixture-router-secret", "content-type": "application/json", "anthropic-version": "2023-06-01" };
    const payload = (content: string) => JSON.stringify({ model: "claude-sonnet-4-6", stream: true, max_tokens: 16, messages: [{ role: "user", content }] });
    const count = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers, body: payload("count") });
    expect(count.status, await count.clone().text()).toBe(200); expect(await count.json()).toEqual({ input_tokens: 123 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(UsageStore.read(usageDir).observations).toHaveLength(0);
    const success = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: payload("normal") });
    expect(success.status).toBe(200); expect(await success.text()).toContain("message_stop");
    const health = async () => (await fetch(`${base}/cc-router/health`, { headers })).json();
    await expect.poll(async () => (await health()).totalOutputTokens).toBe(8);
    await expect.poll(() => UsageStore.read(usageDir).observations[0]?.complete).toBe(true);
    expect(UsageStore.read(usageDir).observations[0].tokens).toMatchObject({ input: 10, output: 8, cacheRead: 20, cacheWrite: 5, cacheWrite5m: 5 });
    const aborted = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: payload("abort") });
    await aborted.text().catch(() => "");
    await expect.poll(() => UsageStore.read(usageDir).observations.find(o => !o.complete)?.settled).toBe(true);
    expect(UsageStore.read(usageDir).observations.find(o => !o.complete)?.tokens.output).toBe(1);
    await expect.poll(async () => (await health()).totalOutputTokens).toBe(9);
    await stop();
    const store = UsageStore.open(usageDir); try { store.compact(); } finally { store.close(); }
    const replay = UsageStore.read(usageDir);
    expect(replay.observations).toHaveLength(0);
    expect(replay.aggregates.reduce((n, a) => n + a.tokens.output, 0)).toBe(9);
    expect(replay.gaps?.some(g => g.provider === "anthropic_subscription")).toBe(true);
  } finally { await stop(); rmSync(home, { recursive: true, force: true }); }
}, 20_000);
