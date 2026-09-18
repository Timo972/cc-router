import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";

it("serves metadata only through authenticated accounts, never health, and supports manual refresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-router-info-"));
  mkdirSync(join(home, ".cc-router"));
  const accountsPath = join(home, ".cc-router", "accounts.json");
  const configPath = join(home, ".cc-router", "config.json");
  writeFileSync(accountsPath, JSON.stringify([{
    id: "fixture", provider: "anthropic_subscription",
    accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 86_400_000, scopes: ["user:profile", "user:inference"],
  }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));
  const child = fork(fileURLToPath(new URL("./fixtures/account-info-server.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"),
      ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath,
      HOST: "127.0.0.1", CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1",
      CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "0", CC_ROUTER_NO_AUTO_UPDATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = once(child, "exit");
  try {
    const [{ port }] = await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error(`Metadata fixture exited: ${output}`); }),
    ]) as [{ port: number }];
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: "Bearer fixture-router-secret" };
    expect((await fetch(`${base}/cc-router/accounts`)).status).toBe(401);
    const publicHealth = await (await fetch(`${base}/cc-router/health`)).json();
    expect(Object.keys(publicHealth)).toEqual(["status"]);
    const health = await (await fetch(`${base}/cc-router/health`, { headers })).text();
    expect(health).not.toMatch(/accountInfo|fixture@example.com|Workspace/);
    let body: any;
    await expect.poll(async () => {
      const response = await fetch(`${base}/cc-router/accounts`, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      body = await response.json();
      return body.accounts[0].accountInfo.fetchStatus;
    }).toBe("fresh");
    expect(body.accounts[0].accountInfo).toMatchObject({
      email: "fixture@example.com", workspaceName: "Workspace 1", accountType: "workspace",
      plan: "Team", subscription: { status: "active", startedAt: "2025-01-01T00:00:00.000Z" },
    });
    expect(JSON.stringify(body)).not.toMatch(/fixture-access-secret|fixture-refresh-secret/);
    const refreshed = await fetch(`${base}/cc-router/refresh`, { method: "POST", headers });
    expect(refreshed.status).toBe(200);
    const after = await (await fetch(`${base}/cc-router/accounts`, { headers })).json();
    expect(after.accounts[0].accountInfo.workspaceName).toBe("Workspace 2");
    // The fixture answers the usage endpoint with `{}`, which
    // `parseAnthropicUsage` rejects as an invalid schema — so a working
    // per-account refresh reports `usageRefreshed: false` here, and the
    // identity fetch it also runs is what moves the workspace on again.
    const one = await fetch(`${base}/cc-router/accounts/fixture/refresh`, { method: "POST", headers });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ refresh: { id: "fixture", usageRefreshed: false } });
    const afterOne = await (await fetch(`${base}/cc-router/accounts`, { headers })).json();
    expect(afterOne.accounts[0].accountInfo.workspaceName).toBe("Workspace 3");
    expect((await fetch(`${base}/cc-router/accounts/nope/refresh`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${base}/cc-router/accounts/fixture/refresh`, { method: "POST" })).status).toBe(401);
    expect(output).not.toContain("fixture@example.com");
  } finally {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(kill);
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
