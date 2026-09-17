import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { UsageStore } from "../usage/store.js";

it("reports occupied-port startup failure, exits unsuccessfully, and releases the usage writer", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-startup-")); const configDir = join(home, ".cc-router"); mkdirSync(configDir);
  const accountsPath = join(configDir, "accounts.json"), configPath = join(configDir, "config.json"), usageDir = join(configDir, "usage");
  writeFileSync(accountsPath, JSON.stringify([{ id: "personal", provider: "openai_subscription", accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() + 86_400_000 }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));
  const occupied = createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  const port = (occupied.address() as { port: number }).port;
  const child = fork(fileURLToPath(new URL("./fixtures/usage-history-server.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], env: { ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"), ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath, USAGE_DIR: usageDir, USAGE_FIXTURE_PORT: String(port), HOST: "127.0.0.1", CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1", CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "0", CC_ROUTER_NO_AUTO_UPDATE: "1", NO_UPDATE_NOTIFIER: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = ""; child.stdout?.on("data", b => { output += b; }); child.stderr?.on("data", b => { output += b; });
  const exited = once(child, "exit"); let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([exited.then(([code, signal]) => ({ code, signal })), new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 3_000); })]);
    expect(outcome, "failed startup must not leave a non-listening daemon alive").toBeDefined();
    expect(outcome!.signal).toBeNull(); expect(outcome!.code).not.toBe(0); expect(output).toContain("EADDRINUSE");
    const store = UsageStore.open(usageDir); store.close();
  } finally {
    clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited;
    await new Promise<void>(resolve => occupied.close(() => resolve())); rmSync(home, { recursive: true, force: true });
  }
}, 10_000);
