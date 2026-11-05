import { fork } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";

/**
 * Regression guard for the Windows "every request times out" bug.
 *
 * The proxy defaults to a loopback-only bind, but clients (Claude Code, the
 * CLI, the mitmproxy addon) target `http://localhost:<port>`. On Windows — and
 * anywhere getaddrinfo lists ::1 before 127.0.0.1 — `localhost` resolves to the
 * IPv6 loopback first. A server bound only to 127.0.0.1 never accepts that
 * connection, so the client hangs until it times out. The fix binds BOTH
 * loopback families; this test proves both answer.
 */

/** Can we bind the IPv6 loopback on this host? Some CI images ship without it. */
function hasIpv6Loopback(): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

async function health(url: string): Promise<{ status: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  return (await res.json()) as { status: unknown };
}

it("answers on both IPv4 and IPv6 loopback so `localhost` reaches the proxy everywhere", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-router-dualstack-"));
  mkdirSync(join(home, ".cc-router"));
  const accountsPath = join(home, ".cc-router", "accounts.json");
  const configPath = join(home, ".cc-router", "config.json");
  writeFileSync(accountsPath, JSON.stringify([{
    id: "fixture", provider: "anthropic_subscription",
    accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 86_400_000, scopes: ["user:profile", "user:inference"],
  }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));

  const ipv6 = await hasIpv6Loopback();

  // HOST is intentionally unset: exercise the default loopback path.
  const child = fork(fileURLToPath(new URL("./fixtures/account-info-server.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"),
      ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath,
      CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1",
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
      exited.then(() => { throw new Error(`Dual-stack fixture exited: ${output}`); }),
    ]) as [{ port: number }];

    // IPv4 loopback must always answer — this is what the CLI/health checks use.
    expect((await health(`http://127.0.0.1:${port}/cc-router/health`)).status).toEqual(expect.any(String));

    // Wherever an IPv6 stack exists, the proxy must answer there too. Before the
    // fix this connection was refused / hung — the Windows timeout.
    if (ipv6) {
      expect((await health(`http://[::1]:${port}/cc-router/health`)).status).toEqual(expect.any(String));
    }
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

/** A port that is free on both loopback families right now. */
async function freeDualStackPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>(resolve => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const freeOnV6 = await new Promise<boolean>(resolve => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "::1", () => probe.close(() => resolve(true)));
    });
    if (freeOnV6) return port;
  }
}

it("keeps retrying the IPv6 loopback bind while [::1]:<port> is taken, then answers there", async () => {
  if (!(await hasIpv6Loopback())) return;
  const home = mkdtempSync(join(tmpdir(), "cc-router-dualstack-retry-"));
  mkdirSync(join(home, ".cc-router"));
  const accountsPath = join(home, ".cc-router", "accounts.json");
  const configPath = join(home, ".cc-router", "config.json");
  writeFileSync(accountsPath, JSON.stringify([{
    id: "fixture", provider: "anthropic_subscription",
    accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret",
    expiresAt: Date.now() + 86_400_000, scopes: ["user:profile", "user:inference"],
  }]));
  writeFileSync(configPath, JSON.stringify({ proxySecret: "fixture-router-secret" }));

  // Something else holds [::1]:<port> when the proxy starts (a stale instance,
  // another tool). Before the retry, the proxy skipped ::1 for good, so
  // `localhost` on Windows kept hanging even after that port was free again.
  const port = await freeDualStackPort();
  const sockets = new Set<import("node:net").Socket>();
  const squatter = createServer(socket => { sockets.add(socket); });
  await new Promise<void>(resolve => squatter.listen(port, "::1", () => resolve()));

  const child = fork(fileURLToPath(new URL("./fixtures/account-info-server.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"),
      ACCOUNTS_PATH: accountsPath, CONFIG_PATH: configPath, FIXTURE_PORT: String(port),
      CC_ROUTER_TELEMETRY: "0", DO_NOT_TRACK: "1",
      CC_ROUTER_DAEMON: "0", CC_ROUTER_SERVICE: "0", CC_ROUTER_NO_AUTO_UPDATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error(`Dual-stack retry fixture exited: ${output}`); }),
    ]);
    expect((await health(`http://127.0.0.1:${port}/cc-router/health`)).status).toEqual(expect.any(String));

    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => squatter.close(() => resolve()));

    const deadline = Date.now() + 10_000;
    let status: unknown;
    while (Date.now() < deadline && status === undefined) {
      try { status = (await health(`http://[::1]:${port}/cc-router/health`)).status; }
      catch { await new Promise(r => setTimeout(r, 250)); }
    }
    expect(status).toEqual(expect.any(String));
  } finally {
    for (const socket of sockets) socket.destroy();
    squatter.close();
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
