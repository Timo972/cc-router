# Stream Idle Timeout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent CC-Router and routed Claude Code sessions from cutting a valid, already-started Anthropic stream at the legacy five-minute idle boundary while retaining byte-exact forwarding and adding passive terminal-event diagnostics.

**Architecture:** Keep the configured five-minute HPM timeout only until Anthropic response headers arrive, then clear both router socket inactivity timers without taking ownership of the response body. Manage Claude Code's event and byte watchdogs at 30 minutes through reversible settings backups. Observe response chunks and lifecycle events through listeners that mutate only bounded log metadata.

**Tech Stack:** TypeScript, Node.js HTTP streams, Express 4, http-proxy-middleware 3, node-http-proxy 1.18, Vitest 4, pnpm.

## Global Constraints

- Preserve Anthropic response status, headers, body bytes, chunk order, and timing; `selfHandleResponse` stays false.
- Never synthesize SSE comments, pings, `message_stop`, or any other response bytes.
- Never retry after response bytes have been delivered.
- `proxyRequestTimeoutMs` remains 300,000 ms by default and applies only before upstream response headers.
- Managed Claude event-level and byte-level stream idle watchdogs are exactly 1,800,000 ms.
- Restore backed-up Claude environment values only while the current values are still CC-Router-managed; preserve later user edits.
- Diagnostics must not retain body text, tool input, session IDs, request IDs, or raw error objects.
- Existing cache-aware routing, affinity, cooldown, refresh, and lease semantics remain unchanged.

---

### Task 1: Add bounded passive stream lifecycle diagnostics

**Files:**
- Create: `src/proxy/stream-lifecycle.ts`
- Create: `src/__tests__/stream-lifecycle.test.ts`
- Modify: `src/proxy/stats.ts`
- Modify: `src/proxy/server.ts`
- Modify: `README.md`
- Modify: `docs/troubleshooting.md`

**Interfaces:**

```ts
export interface StreamLifecycleState {
  sawMessageStop: boolean;
  upstreamEnd: boolean;
  upstreamAborted: boolean;
  upstreamClose: boolean;
  downstreamFinish: boolean;
  downstreamClose: boolean;
  lastByteAt?: number;
  bodyDurationMs?: number;
}

export interface StreamLifecycleTracker {
  readonly state: StreamLifecycleState;
  observeChunk(chunk: Buffer): void;
  attach(upstream: LifecycleEmitter, downstream: LifecycleEmitter): void;
}

export function createStreamLifecycleTracker(
  startedAt: number,
  inspectSse: boolean,
  now?: () => number,
): StreamLifecycleTracker;
```

Extend `LogEntry` with `streamLifecycle?: StreamLifecycleState`.

- [ ] **Step 1: Write failing tracker unit tests**

Create `src/__tests__/stream-lifecycle.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createStreamLifecycleTracker } from "../proxy/stream-lifecycle.js";

describe("createStreamLifecycleTracker", () => {
  it("observes a split message_stop without retaining payload content", () => {
    let current = 1_100;
    const tracker = createStreamLifecycleTracker(1_000, true, () => current);
    tracker.observeChunk(Buffer.from("event: message_stop\nda"));
    current = 1_200;
    tracker.observeChunk(Buffer.from("ta: {\"type\":\"message_stop\",\"secret\":\"not-retained\"}\n\n"));
    expect(tracker.state.sawMessageStop).toBe(true);
    expect(tracker.state.lastByteAt).toBe(1_200);
    expect(JSON.stringify(tracker.state)).not.toContain("not-retained");
  });

  it("records upstream abort and downstream close", () => {
    let current = 2_000;
    const tracker = createStreamLifecycleTracker(1_000, false, () => current);
    const upstream = new EventEmitter();
    const downstream = new EventEmitter();
    tracker.attach(upstream, downstream);
    current = 2_100;
    upstream.emit("aborted");
    current = 2_200;
    upstream.emit("close");
    current = 2_300;
    downstream.emit("close");
    expect(tracker.state).toMatchObject({
      upstreamEnd: false,
      upstreamAborted: true,
      upstreamClose: true,
      downstreamFinish: false,
      downstreamClose: true,
      bodyDurationMs: 1_300,
    });
  });

  it("distinguishes successful upstream end and downstream finish", () => {
    let current = 5_000;
    const tracker = createStreamLifecycleTracker(4_000, false, () => current);
    const upstream = new EventEmitter();
    const downstream = new EventEmitter();
    tracker.attach(upstream, downstream);
    upstream.emit("end");
    current = 5_100;
    downstream.emit("finish");
    expect(tracker.state.upstreamEnd).toBe(true);
    expect(tracker.state.downstreamFinish).toBe(true);
    expect(tracker.state.bodyDurationMs).toBe(1_100);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run `pnpm test -- src/__tests__/stream-lifecycle.test.ts`.

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 3: Implement the bounded tracker**

Create `src/proxy/stream-lifecycle.ts` with the interfaces above plus:

```ts
export interface LifecycleEmitter {
  once(event: string, listener: () => void): unknown;
}

export function createStreamLifecycleTracker(
  startedAt: number,
  inspectSse: boolean,
  now: () => number = Date.now,
): StreamLifecycleTracker {
  const state: StreamLifecycleState = {
    sawMessageStop: false,
    upstreamEnd: false,
    upstreamAborted: false,
    upstreamClose: false,
    downstreamFinish: false,
    downstreamClose: false,
  };
  let lineBuffer = "";
  const terminal = () => { state.bodyDurationMs = Math.max(0, now() - startedAt); };
  return {
    state,
    observeChunk(chunk) {
      state.lastByteAt = now();
      if (!inspectSse || state.sawMessageStop) return;
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6)) as { type?: string };
          if (event.type === "message_stop") {
            state.sawMessageStop = true;
            lineBuffer = "";
            break;
          }
        } catch {
          // Complete non-JSON data lines are irrelevant to terminal tracking.
        }
      }
    },
    attach(upstream, downstream) {
      upstream.once("end", () => { state.upstreamEnd = true; terminal(); });
      upstream.once("aborted", () => { state.upstreamAborted = true; terminal(); });
      upstream.once("close", () => { state.upstreamClose = true; terminal(); });
      downstream.once("finish", () => { state.downstreamFinish = true; terminal(); });
      downstream.once("close", () => { state.downstreamClose = true; terminal(); });
    },
  };
}
```

Once `message_stop` is found, clear the transient line buffer.

- [ ] **Step 4: Attach lifecycle state to recent logs**

Import the state type in `stats.ts` and add `streamLifecycle?: StreamLifecycleState` to `LogEntry`.

In the Anthropic `proxyRes` callback in `server.ts`, accept the third `response` argument. After determining content type and compression, add:

```ts
const streamTracker = createStreamLifecycleTracker(
  (req as Request)._startTime ?? Date.now(),
  !isCompressed && contentType.includes("text/event-stream"),
);
entry.streamLifecycle = streamTracker.state;
streamTracker.attach(proxyRes, response);
proxyRes.on("data", (chunk: Buffer) => streamTracker.observeChunk(chunk));
```

Import `createStreamLifecycleTracker`. Keep the same mutable `entry` in `stats` so later flags appear in health output. Register the tracker for compressed and uncompressed bodies to observe bytes/lifecycle, but inspect SSE JSON only when uncompressed.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm test -- src/__tests__/stream-lifecycle.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/lease-lifecycle.test.ts
pnpm lint
```

Expected: all focused checks pass; byte-exact tests still contain exactly one upstream-provided `message_stop`.

- [ ] **Step 6: Update documentation**

Update `README.md` to state that streaming remains byte-transparent, `proxyRequestTimeoutMs` protects only the phase before Anthropic response headers, automatic configuration manages 30-minute Claude event/byte watchdogs, and existing Claude processes must restart.

Update reverse-proxy guidance to distinguish CC-Router's pre-header timeout from an outer proxy body timeout.

Add a `Response stalled mid-stream` section to `docs/troubleshooting.md` documenting:

- `sawMessageStop: true`, `upstreamEnd: true`, and `downstreamFinish: true` indicate completion;
- `upstreamAborted: true` identifies upstream termination;
- `downstreamClose: true` with `downstreamFinish: false` identifies downstream cancellation;
- missing `message_stop` is evidence only and never triggers synthesis.

- [ ] **Step 7: Commit Task 1**

```bash
pnpm test -- src/__tests__/stream-lifecycle.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/lease-lifecycle.test.ts
pnpm lint
git diff --check
git add src/proxy/stream-lifecycle.ts src/__tests__/stream-lifecycle.test.ts src/proxy/stats.ts src/proxy/server.ts README.md docs/troubleshooting.md
git commit -m "feat: expose passive stream lifecycle diagnostics"
```

---

### Task 2: Make the proxy timeout pre-response only

**Files:**
- Modify: `src/proxy/anthropic-proxy.ts`
- Modify: `src/__tests__/anthropic-proxy.test.ts`

**Interfaces:**
- Consumes: `AnthropicProxyOptions.timeoutMs` and `AnthropicProxyOptions.on`.
- Produces: unchanged `createAnthropicProxy(options): RequestHandler`; its configured timeout is cleared on both sockets when the upstream `ClientRequest` emits `response`.

- [ ] **Step 1: Write the failing real-socket regression**

Add this test inside `describe("createAnthropicProxy", ...)`:

```ts
it("does not abort a started SSE response after the pre-response timeout", async () => {
  const gate = deferred();
  const prefix = Buffer.from("event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n");
  const suffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  const upstream = createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(prefix);
    await gate.promise;
    if (!res.destroyed) res.end(suffix);
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use("/v1", createAnthropicProxy({
    target: `http://127.0.0.1:${upstreamPort}`,
    timeoutMs: 50,
    on: {},
  }));
  const downstream = createServer(app);
  const downstreamPort = await listen(downstream);
  const response = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));
  void response.completed.catch(() => undefined);
  try {
    await response.firstChunk;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(response.hasCompleted()).toBe(false);
    gate.resolve();
    await expect(response.completed).resolves.toEqual(Buffer.concat([prefix, suffix]));
  } finally {
    gate.resolve();
    response.request.destroy();
    await Promise.allSettled([response.completed]);
    await close(downstream);
    await close(upstream);
  }
});
```

- [ ] **Step 2: Run the regression and verify RED**

Run `pnpm test -- src/__tests__/anthropic-proxy.test.ts`.

Expected: FAIL because the client response aborts with `ECONNRESET` at roughly 50 ms before the gate is released.

- [ ] **Step 3: Wrap the existing proxy request hook and clear timeouts on response**

Replace `createAnthropicProxy` with:

```ts
export function createAnthropicProxy(options: AnthropicProxyOptions): RequestHandler {
  const configuredProxyRequest = options.on.proxyReq;
  return createProxyMiddleware<Request, ServerResponse>({
    target: options.target,
    changeOrigin: true,
    pathRewrite: path => `/v1${path}`,
    proxyTimeout: options.timeoutMs,
    timeout: options.timeoutMs,
    on: {
      ...options.on,
      proxyReq: (proxyRequest, request, response) => {
        proxyRequest.once("response", () => {
          proxyRequest.setTimeout(0);
          request.socket.setTimeout(0);
        });
        configuredProxyRequest?.(proxyRequest, request, response);
      },
    },
  });
}
```

Register the response listener before calling the configured hook.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm test -- src/__tests__/anthropic-proxy.test.ts
pnpm lint
git add src/proxy/anthropic-proxy.ts src/__tests__/anthropic-proxy.test.ts
git commit -m "fix: keep started anthropic streams open"
```

Expected: focused tests and TypeScript pass; the production-stack authorization test proves the wrapped hook still executes.

---

### Task 3: Manage Claude's 30-minute stream watchdog reversibly

**Files:**
- Modify: `src/config/manager.ts`
- Modify: `src/utils/claude-config.ts`
- Modify: `src/__tests__/claude-config.test.ts`

**Interfaces:**

```ts
export interface ManagedClaudeEnvValueBackup {
  existed: boolean;
  value?: string;
}

export interface ManagedClaudeEnvBackup {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: ManagedClaudeEnvValueBackup;
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: ManagedClaudeEnvValueBackup;
}
```

Extend `ProxyConfig` with `claudeEnvBackup?: ManagedClaudeEnvBackup`. Preserve the three public Claude settings function signatures. Use managed string value `"1800000"` for both variables.

- [ ] **Step 1: Write failing configuration and restoration tests**

Add cases to `src/__tests__/claude-config.test.ts` proving:

```ts
it("writes 30-minute event and byte stream idle watchdogs", () => {
  writeClaudeSettings(3456);
  const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
  expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1800000");
});
```

For backup/restore, add these complete tests:

```ts
it("backs up pre-existing watchdog values only once", () => {
  fs.writeFileSync(settingsPath(), JSON.stringify({
    env: {
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
    },
  }));
  writeClaudeSettings(3456);
  writeClaudeSettings(4567);
  const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
  expect(config.claudeEnvBackup).toEqual({
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "600000" },
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: { existed: true, value: "900000" },
  });
});

it("restores watchdog values that existed before configuration", () => {
  fs.writeFileSync(settingsPath(), JSON.stringify({
    env: {
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "900000",
    },
  }));
  writeClaudeSettings(3456);
  removeClaudeSettings();
  const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
  expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("900000");
  const config = JSON.parse(fs.readFileSync(`${MOCK_DIR}/config.json`, "utf-8"));
  expect(config.claudeEnvBackup).toBeUndefined();
});

it("removes watchdog values that did not exist before configuration", () => {
  writeClaudeSettings(3456);
  removeClaudeSettings();
  const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  expect(written.env?.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined();
  expect(written.env?.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined();
});

it("preserves watchdog values changed by the user after configuration", () => {
  writeClaudeSettings(3456);
  const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  settings.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = "1200000";
  settings.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS = "1500000";
  fs.writeFileSync(settingsPath(), JSON.stringify(settings));
  removeClaudeSettings();
  const written = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  expect(written.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("1200000");
  expect(written.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS).toBe("1500000");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm test -- src/__tests__/claude-config.test.ts`.

Expected: FAIL because the watchdog variables and `claudeEnvBackup` do not exist.

- [ ] **Step 3: Add typed backup state**

Add the two interfaces above before `ProxyConfig`, then add:

```ts
/** Original Claude watchdog values saved while CC-Router manages them. */
claudeEnvBackup?: ManagedClaudeEnvBackup;
```

`normalizeProxyConfig` already preserves this property through its spread.

- [ ] **Step 4: Add backup helpers and managed values**

Import `writeConfig` and the backup type in `src/utils/claude-config.ts`, then add:

```ts
const MANAGED_STREAM_IDLE_TIMEOUT_MS = "1800000";
const MANAGED_STREAM_ENV_KEYS = [
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
] as const;

function captureClaudeEnvBackup(env: Record<string, unknown>): ManagedClaudeEnvBackup {
  const capture = (key: typeof MANAGED_STREAM_ENV_KEYS[number]) => {
    const value = env[key];
    return typeof value === "string" ? { existed: true, value } : { existed: false };
  };
  return {
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: capture("CLAUDE_STREAM_IDLE_TIMEOUT_MS"),
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: capture("CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS"),
  };
}
```

- [ ] **Step 5: Persist the first backup and write managed values**

After reading `existingEnv` in `writeClaudeSettings`:

```ts
const config = readConfig();
if (!config.claudeEnvBackup) {
  config.claudeEnvBackup = captureClaudeEnvBackup(existingEnv);
  writeConfig(config);
}
```

Add both managed keys to the output `env` after spreading `existingEnv`.

- [ ] **Step 6: Restore only values that remain managed**

In `removeClaudeSettings`, read `config` and `backup`, then after removing URL/auth apply:

```ts
if (backup) {
  for (const key of MANAGED_STREAM_ENV_KEYS) {
    if (env[key] !== MANAGED_STREAM_IDLE_TIMEOUT_MS) continue;
    const previous = backup[key];
    if (previous.existed && previous.value !== undefined) env[key] = previous.value;
    else delete env[key];
  }
}
```

After writing valid settings successfully, clear the backup with:

```ts
if (backup) {
  const { claudeEnvBackup: _removed, ...rest } = config;
  writeConfig(rest);
}
```

Do not clear it when settings are malformed and untouched.

- [ ] **Step 7: Verify GREEN and commit**

```bash
pnpm test -- src/__tests__/claude-config.test.ts src/__tests__/manager.test.ts
pnpm lint
git add src/config/manager.ts src/utils/claude-config.ts src/__tests__/claude-config.test.ts
git commit -m "fix: extend routed claude stream watchdogs"
```

Expected: focused tests and TypeScript pass; unrelated settings remain preserved.

---

### Task 4: Verify, package, install, and validate locally

**Files:**
- No source changes expected.
- Temporary artifact: `ai-cc-router-0.6.2.tgz` from `pnpm pack`.

**Interfaces:**
- Consumes the three reviewed task commits.
- Produces a global pnpm installation whose `dist` matches the verified worktree and a live launchd service using that installation.

- [ ] **Step 1: Run complete verification**

```bash
pnpm test
pnpm lint
pnpm build
git diff --check
git status --short
```

Expected: every Vitest file passes, lint/build pass, diff check is clean, and tracked files are clean.

- [ ] **Step 2: Pack and install the exact tree**

Use:

```bash
CC_ROUTER_PACK_DIR="$(mktemp -d)"
test -n "$CC_ROUTER_PACK_DIR"
pnpm pack --pack-destination "$CC_ROUTER_PACK_DIR"
pnpm add -g --force "$CC_ROUTER_PACK_DIR/ai-cc-router-0.6.2.tgz"
```

Resolve `pnpm root -g` and compare the changed `dist` files byte-for-byte against the build.

- [ ] **Step 3: Apply settings and restart through supported commands**

Run the installed configure command so `~/.claude/settings.json` receives the managed watchdog values. Reinstall/restart the launch service through CC-Router's service workflow so its plist points at the current pnpm store path. Do not rewrite accounts or tokens.

- [ ] **Step 4: Validate live state**

Confirm:

```text
health.status = ok
four configured Anthropic accounts remain present
CLAUDE_STREAM_IDLE_TIMEOUT_MS = 1800000
CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS = 1800000
launchd points at the newly installed package
new recent log entries expose streamLifecycle
```

Confirm the account database, proxy secret, client settings, and unrelated Claude keys are unchanged. Move temporary package artifacts to Trash.

- [ ] **Step 5: Hand off restart guidance**

Tell the user to close and reopen all running Claude Code sessions because existing processes do not reload settings. Do not claim that every possible upstream or network failure is eliminated.
