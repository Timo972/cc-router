import { fork, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { UsageReport } from "../usage/types.js";

it("persists native/cross-protocol usage and subscription identity through a real service restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-acceptance-"));
  const configDir = join(home, ".cc-router"); mkdirSync(configDir);
  const accountsPath = join(configDir, "accounts.json"), configPath = join(configDir, "config.json"), usageDir = join(configDir, "usage");
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "fixture-workspace", chatgpt_user_id: "fixture-user", chatgpt_plan_type: "plus" }, "https://api.openai.com/profile": { email: "private-fixture@example.com" } };
  writeFileSync(accountsPath, JSON.stringify([{ id: "personal", provider: "openai_subscription", accessToken: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.secret`, refreshToken: "fixture-refresh-secret", expiresAt: Date.now() + 86_400_000 }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"), ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath, USAGE_DIR: usageDir,
    HOST: "127.0.0.1", CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1", CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "0", CC_ROUTER_NO_AUTO_UPDATE: "1", NO_UPDATE_NOTIFIER: "1" };
  const headers = { authorization: "Bearer fixture-router-secret", "content-type": "application/json" };
  async function start() {
    const child = fork(fileURLToPath(new URL("./fixtures/usage-history-server.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let logs = ""; child.stdout?.on("data", b => { logs += b; }); child.stderr?.on("data", b => { logs += b; });
    const exited = once(child, "exit");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [{ port }] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Fixture exited: ${logs}`); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Fixture startup timed out")), 8_000); })]) as [{ port: number }];
      return { base: `http://127.0.0.1:${port}`, logs: () => logs, async stop() { child.kill("SIGTERM"); const kill = setTimeout(() => child.kill("SIGKILL"), 3_000); try { const [code, signal] = await exited; if (process.platform === "win32") expect(signal === "SIGTERM" || code === 0).toBe(true); else { expect(signal).toBeNull(); expect(code).toBe(0); } } finally { clearTimeout(kill); } } };
    } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
    finally { clearTimeout(timeout); }
  }
  let service: Awaited<ReturnType<typeof start>> | undefined;
  try {
    service = await start();
    expect((await fetch(`${service.base}/cc-router/usage`)).status).toBe(401);
    const subscription = await fetch(`${service.base}/cc-router/usage/subscriptions`, { method: "POST", headers, body: JSON.stringify({ account: "personal", monthlyUsd: 20, from: new Date().toISOString().slice(0, 7) + "-01" }) });
    expect(subscription.status).toBe(200);
    const native = await fetch(`${service.base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "openai/gpt-5.4", stream: true, input: [{ role: "user", content: "fixture prompt must not be persisted" }] }) });
    expect(native.status).toBe(200); expect(await native.text()).toContain("response.completed");
    const translated = await fetch(`${service.base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "openai/gpt-5.4", max_tokens: 10, messages: [{ role: "user", content: "fixture prompt must not be persisted" }] }) });
    expect(translated.status).toBe(200); await translated.text();
    const read = async () => {
      const response = await fetch(`${service!.base}/cc-router/usage?period=month&provider=openai_subscription`, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.status).toBe(200);
      return response.json() as Promise<UsageReport>;
    };
    await expect.poll(async () => (await read()).totals.output).toBe(50);
    const before = await read();
    expect(before.totals).toMatchObject({ input: 80, output: 50, cacheRead: 120, cacheWrite: 0 });
    expect(before.costs.pricedApiUsd).toBeCloseTo((80 * 2.5 + 50 * 15 + 120 * 0.25) / 1e6);
    const key = before.accounts[0].key;
    const rename = await fetch(`${service.base}/cc-router/accounts/personal`, { method: "PATCH", headers, body: JSON.stringify({ id: "renamed" }) });
    expect(rename.status).toBe(200);
    expect((await read()).accounts[0]).toMatchObject({ key, alias: "renamed" });
    expect(service.logs()).not.toContain("private-fixture@example.com");
    await service.stop(); service = undefined;
    service = await start();
    const after = await read();
    expect(after.totals).toEqual(before.totals); expect(after.costs.pricedApiUsd).toBe(before.costs.pricedApiUsd);
    expect(after.accounts[0]).toMatchObject({ key, alias: "renamed" });
    const health = await (await fetch(`${service.base}/cc-router/health`, { headers })).json();
    expect(health.totalInputTokens).toBe(0);
    await service.stop(); service = undefined;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../cli/index.ts", import.meta.url)), "usage", "--period", "month", "--provider", "openai", "--port", "59999", "--json"], { env });
    const offline = JSON.parse(stdout) as UsageReport;
    expect(offline.totals).toEqual(before.totals);
    for (const file of readdirSync(usageDir)) {
      const path = join(usageDir, file); if (!statSync(path).isFile()) continue;
      expect(readFileSync(path, "utf8")).not.toMatch(/fixture-refresh-secret|private-fixture@example\.com|Private workspace|fixture prompt/);
    }
  } finally { if (service) await service.stop(); rmSync(home, { recursive: true, force: true }); }
}, 30_000);
