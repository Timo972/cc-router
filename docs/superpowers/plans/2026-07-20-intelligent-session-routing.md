# Intelligent Session Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace request-level round robin for Anthropic subscription traffic with sticky, load-aware Claude Code session routing that preserves prompt-cache affinity and tracks concurrent streams until they really finish.

**Architecture:** `TokenPool` owns eligibility, cooldown timestamps, per-account in-flight counters, load/headroom ranking, and idempotent request leases. A new Express-independent `SessionRouter` owns a bounded in-memory session-to-account map and chooses sticky or load-aware routes. The existing Anthropic proxy acquires one routed lease before refresh/forwarding, invalidates bindings after account-specific failures, and continues to let `http-proxy-middleware` relay upstream responses without handling or rewriting SSE bodies.

**Tech Stack:** TypeScript, Node.js 20+, Express 4, `http-proxy-middleware` 3, Vitest 4, native Node HTTP test servers.

## Global Constraints

- Use normalized `X-Claude-Code-Session-Id` as the affinity key. Trim surrounding whitespace; ignore non-string/duplicate values, empty values, and values longer than 256 UTF-8 bytes.
- Store affinity only in memory as `session ID -> account ID + lastSeen`. Never log or persist session IDs.
- Expire bindings after 1 hour of inactivity. Cap the map at 10,000 entries; sweep expired entries first, then evict the least recently used entry before inserting.
- A valid existing binding wins even when its account already has in-flight work. It remains valid only while the account is enabled, healthy, below both user caps, not rate-limited, and outside cooldown.
- Rank new sessions and unscoped requests lexicographically by: lowest in-flight requests, fewest active session bindings, lowest `max(fiveHourUtil / sessionCap, sevenDayUtil / weeklyCap)`, then a rotating account-order tie-break. Normalize percent caps to fractions; a zero cap is ineligible; missing utilization is zero. Advance the tie-break cursor only after selection.
- Bind a new session synchronously before the HTTP request is forwarded. Requests without a valid session ID use the same ranking but create no binding.
- Invalidate a binding after its account is disabled, unhealthy, capped, cooling down, removed, or returns 401, 429, or 529. Relay the failed upstream response unchanged and reassign only the next client retry.
- Never retry after upstream response bytes have been received. Never synthesize, remove, reorder, parse-and-reencode, or otherwise rewrite SSE events, including `message_stop`.
- If all accounts are unavailable, keep caps advisory and select the least-loaded fallback account while invoking the existing fallback observability hook.
- Acquiring a lease increments in-flight state synchronously. Releasing is idempotent, decrements exactly once, and never makes a counter negative.
- Release leases on downstream `finish`, downstream/client `close`, proxy/upstream error, refresh failure, and other pre-forward terminal responses.
- Represent new 429/529 cooldown state with an expiry timestamp owned by `TokenPool`; do not use active-work state as cooldown state. Keep the existing public `busy` field only for backward compatibility while routing and health metrics use explicit cooldown/in-flight APIs.
- OpenAI subscription routing, Anthropic request bodies, authentication header behavior, rate-limit extraction, and usage accounting stay behaviorally unchanged.
- Health/account JSON adds numeric `inFlightRequests` and `activeSessions` fields and does not expose tokens or session identifiers.
- Every production change starts with a focused failing test. Focused tests, the full Vitest suite, `npm run lint`, and `npm run build` must pass with pristine output before completion.

---

### Task 1: Lease-Aware, Load-Aware Token Pool

**Files:**

- Modify: `src/proxy/token-pool.ts`
- Modify: `src/__tests__/token-pool.test.ts`

- [ ] **Step 1: Add failing lease lifecycle tests**

Extend `src/__tests__/token-pool.test.ts` with deterministic tests for synchronous acquisition and idempotent release:

```ts
describe("TokenPool — request leases", () => {
  it("tracks a request until its lease is released exactly once", () => {
    const pool = new TokenPool([makeAccount("a")]);
    const lease = pool.acquireBest(new Map());

    expect(lease.account.id).toBe("a");
    expect(pool.getInFlight("a")).toBe(1);

    lease.release();
    lease.release();
    expect(pool.getInFlight("a")).toBe(0);
  });

  it("prefers the account with fewer in-flight requests", () => {
    const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
    const first = pool.tryAcquire("a");
    expect(first).not.toBeNull();

    const next = pool.acquireBest(new Map());
    expect(next.account.id).toBe("b");

    first!.release();
    next.release();
  });
});
```

- [ ] **Step 2: Run the focused test and record RED evidence**

Run:

```bash
npm test -- src/__tests__/token-pool.test.ts
```

Expected: FAIL because `acquireBest`, `tryAcquire`, and `getInFlight` do not exist.

- [ ] **Step 3: Add the lease and ranking contracts**

In `src/proxy/token-pool.ts`, add these public contracts and inject a clock for deterministic cooldown tests:

```ts
export interface AccountLease {
  readonly account: Account;
  readonly fallback: boolean;
  release(): void;
}

export interface TokenPoolOptions {
  now?: () => number;
}

export class TokenPool {
  private readonly inFlight = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly now: () => number;
  private currentIndex = 0;

  constructor(private readonly accounts: Account[], options: TokenPoolOptions = {}) {
    this.now = options.now ?? Date.now;
  }
}
```

Implement the following API:

```ts
acquireBest(activeSessions: ReadonlyMap<string, number>): AccountLease;
tryAcquire(accountId: string): AccountLease | null;
isEligible(accountId: string): boolean;
getInFlight(accountId: string): number;
setCooldown(accountId: string, durationMs: number): void;
isCoolingDown(accountId: string): boolean;
```

`tryAcquire` must reject missing or currently ineligible accounts. Both acquisition paths must increment `requestCount`, set `lastUsed`, increment the in-flight map, and return an idempotent closure that decrements only its own lease once.

- [ ] **Step 4: Add failing ranking and cooldown tests**

Cover the complete priority order in separate tests:

```ts
it("uses active session count after in-flight load ties", () => {
  const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
  const lease = pool.acquireBest(new Map([["a", 2], ["b", 1]]));
  expect(lease.account.id).toBe("b");
  lease.release();
});

it("uses relative rate-limit headroom after load and binding ties", () => {
  const a = makeAccount("a");
  const b = makeAccount("b");
  a.sessionLimitPercent = 80;
  a.rateLimits.fiveHourUtil = 0.6;
  b.sessionLimitPercent = 80;
  b.rateLimits.fiveHourUtil = 0.2;
  const pool = new TokenPool([a, b]);

  const lease = pool.acquireBest(new Map([["a", 1], ["b", 1]]));
  expect(lease.account.id).toBe("b");
  lease.release();
});

it("keeps an account unavailable until its timestamp cooldown expires", () => {
  let now = 1_000;
  const pool = new TokenPool(
    [makeAccount("a"), makeAccount("b")],
    { now: () => now },
  );
  pool.setCooldown("a", 500);
  expect(pool.isEligible("a")).toBe(false);
  now = 1_500;
  expect(pool.isEligible("a")).toBe(true);
});
```

Also verify: zero-percent caps are ineligible; five-hour and seven-day ratios use the worse value; the rotating tie-break distributes exact ties; a valid `tryAcquire` does not reject solely due to existing in-flight work; and all-unavailable fallback chooses the lowest in-flight count.

- [ ] **Step 5: Implement lexicographic selection and timestamp cooldown**

Keep the existing rate-window rollover helpers. Eligible selection must compare an account tuple equivalent to:

```ts
[
  getInFlight(account.id),
  activeSessions.get(account.id) ?? 0,
  Math.max(
    account.rateLimits.fiveHourUtil / (account.sessionLimitPercent / 100),
    account.rateLimits.sevenDayUtil / (account.weeklyLimitPercent / 100),
  ),
  circularDistanceFromCursor,
]
```

Do not evaluate the ratio for zero caps because those accounts are ineligible. When there are no eligible accounts, choose lexicographically by in-flight count and existing reset preference from progressively broader fallback sets, and set `fallback: true`. Invoke `onCapBypass` when the selected fallback bypasses user caps.

Replace the old server-facing use of `busy` with `cooldownUntil`, but preserve `getNext()` as a compatibility wrapper:

```ts
getNext(): Account {
  const lease = this.acquireBest(new Map());
  lease.release();
  return lease.account;
}
```

The wrapper preserves existing callers/tests without leaking an in-flight lease. Include `inFlightRequests` and derived `coolingDown` in `getStats()`.

- [ ] **Step 6: Run focused and full regression tests**

Run:

```bash
npm test -- src/__tests__/token-pool.test.ts
npm test
npm run lint
```

Expected: all pass with no warnings or unhandled timer output.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/proxy/token-pool.ts src/__tests__/token-pool.test.ts
git commit -m "feat: add load-aware account leases"
```

---

### Task 2: Bounded Sticky Session Router

**Files:**

- Create: `src/proxy/session-router.ts`
- Create: `src/__tests__/session-router.test.ts`

- [ ] **Step 1: Write failing normalization and affinity tests**

Create `src/__tests__/session-router.test.ts` with a local `makeAccount` fixture and these first behaviors:

```ts
import { describe, expect, it } from "vitest";
import { SessionRouter, normalizeSessionId } from "../proxy/session-router.js";
import { TokenPool } from "../proxy/token-pool.js";

it("normalizes one bounded string header", () => {
  expect(normalizeSessionId("  session-a  ")).toBe("session-a");
  expect(normalizeSessionId("   ")).toBeUndefined();
  expect(normalizeSessionId(["a", "b"])).toBeUndefined();
  expect(normalizeSessionId("é".repeat(129))).toBeUndefined();
});

it("keeps repeated requests from one session on its account", () => {
  const pool = new TokenPool([makeAccount("a"), makeAccount("b")]);
  const router = new SessionRouter(pool);

  const first = router.acquire("session-a");
  const second = router.acquire("session-a");

  expect(first.account.id).toBe(second.account.id);
  expect(first.reason).toBe("new-session");
  expect(second.reason).toBe("sticky");
  first.release();
  second.release();
});
```

- [ ] **Step 2: Run the focused test and record RED evidence**

Run:

```bash
npm test -- src/__tests__/session-router.test.ts
```

Expected: FAIL because the session router module does not exist.

- [ ] **Step 3: Implement the public routing contract**

Create `src/proxy/session-router.ts` with:

```ts
import type { AccountLease } from "./token-pool.js";
import { TokenPool } from "./token-pool.js";

export type RouteReason = "sticky" | "new-session" | "unscoped" | "failover";

export interface RoutedAccountLease extends AccountLease {
  readonly reason: RouteReason;
  readonly sessionId?: string;
}

export interface SessionRouterOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

export function normalizeSessionId(value: unknown): string | undefined;

export class SessionRouter {
  constructor(pool: TokenPool, options?: SessionRouterOptions);
  acquire(sessionHeader: unknown): RoutedAccountLease;
  invalidate(sessionHeader: unknown, expectedAccountId?: string): boolean;
  invalidateAccount(accountId: string): number;
  getActiveSessionCount(accountId: string): number;
  getBindingCount(): number;
}
```

Use defaults `ttlMs = 60 * 60 * 1000` and `maxEntries = 10_000`. Keep both a binding map and per-account active-binding counts so the pool can rank without rescanning the whole map.

- [ ] **Step 4: Add failing distribution, failover, and bound-state tests**

Add tests proving:

- two simultaneous new sessions bind separate idle accounts;
- unscoped requests are load-aware but do not increase `getBindingCount()`;
- a sticky binding stays put when another account later has lower load;
- disabling, marking unhealthy, capping, cooling down, or removing the bound account yields `reason: "failover"` on the next acquire;
- `invalidate(sessionId, accountId)` only removes the matching current binding, preventing an old response from deleting a newer rebind;
- `invalidateAccount` removes every binding for one account and fixes counts;
- bindings update `lastSeen` on access and expire at one hour;
- insertion at 10,000 entries evicts the least-recently-used binding after sweeping expired entries;
- no public result or diagnostic callback logs/exposes any session ID other than the transient `sessionId` field required by the HTTP layer.

Use small injected `maxEntries` and a mutable injected clock for eviction tests rather than allocating 10,001 test sessions.

- [ ] **Step 5: Implement binding, expiry, LRU eviction, and failover**

`acquire` must run synchronously from lookup through lease acquisition and binding insertion. Its control flow is:

```ts
const sessionId = normalizeSessionId(sessionHeader);
sweepExpiredBindings();

if (!sessionId) {
  return wrap(pool.acquireBest(activeSessionCounts), "unscoped");
}

const existing = bindings.get(sessionId);
if (existing) {
  const stickyLease = pool.tryAcquire(existing.accountId);
  if (stickyLease) {
    existing.lastSeen = now();
    return wrap(stickyLease, "sticky", sessionId);
  }
  removeBinding(sessionId);
}

const lease = pool.acquireBest(activeSessionCounts);
insertBinding(sessionId, lease.account.id, now());
return wrap(lease, existing ? "failover" : "new-session", sessionId);
```

The wrapper delegates the original idempotent `release`; it must not introduce a second in-flight increment. LRU eviction compares `lastSeen` and uses map insertion order only as a deterministic tie-break.

- [ ] **Step 6: Run focused and dependency tests**

Run:

```bash
npm test -- src/__tests__/session-router.test.ts src/__tests__/token-pool.test.ts
npm test
npm run lint
```

Expected: all pass and no session ID appears in emitted console output.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/proxy/session-router.ts src/__tests__/session-router.test.ts
git commit -m "feat: add sticky Claude session routing"
```

---

### Task 3: Proxy Lifecycle, Failure Invalidation, and Transparent SSE

**Files:**

- Create: `src/proxy/anthropic-proxy.ts`
- Create: `src/proxy/lease-lifecycle.ts`
- Create: `src/__tests__/anthropic-proxy.test.ts`
- Create: `src/__tests__/lease-lifecycle.test.ts`
- Modify: `src/proxy/server.ts`

- [ ] **Step 1: Write failing lease terminal-path tests**

Create `src/__tests__/lease-lifecycle.test.ts` around a Node `EventEmitter`-backed response double:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachLeaseLifecycle } from "../proxy/lease-lifecycle.js";

it.each(["finish", "close"])("releases once on downstream %s", (event) => {
  const response = new EventEmitter();
  const release = vi.fn();
  attachLeaseLifecycle(response, { release });

  response.emit(event);
  response.emit("finish");
  response.emit("close");
  expect(release).toHaveBeenCalledTimes(1);
});
```

Add a test for the returned explicit cleanup function so proxy errors and pre-forward failures share the same one-shot release.

- [ ] **Step 2: Run the lifecycle test and record RED evidence**

Run:

```bash
npm test -- src/__tests__/lease-lifecycle.test.ts
```

Expected: FAIL because `lease-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement one-shot HTTP lease cleanup**

Create `src/proxy/lease-lifecycle.ts`:

```ts
export interface ResponseLifecycle {
  once(event: "finish" | "close", listener: () => void): unknown;
}

export interface Releasable {
  release(): void;
}

export function attachLeaseLifecycle(
  response: ResponseLifecycle,
  lease: Releasable,
): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  response.once("finish", release);
  response.once("close", release);
  return release;
}
```

- [ ] **Step 4: Write a failing byte-exact proxy integration test**

Create `src/__tests__/anthropic-proxy.test.ts`. Start a native Node upstream server that writes deliberately split SSE chunks, including a final `message_stop`, with small delays. Mount the production proxy factory on an ephemeral Express server, collect the downstream body as `Buffer`, and assert:

```ts
expect(downstream.status).toBe(200);
expect(downstream.headers.get("content-type")).toContain("text/event-stream");
expect(Buffer.compare(downstreamBody, upstreamBody)).toBe(0);
expect(downstreamBody.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
```

Add a concurrent case holding two streams open and asserting neither body completes before its own upstream terminates. Always close both ephemeral servers in `finally` blocks.

- [ ] **Step 5: Extract the transparent Anthropic proxy factory**

Create `src/proxy/anthropic-proxy.ts` as the single place that configures `http-proxy-middleware` transport behavior:

```ts
import type { RequestHandler, Request } from "express";
import type { ServerResponse } from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Options } from "http-proxy-middleware";

export interface AnthropicProxyOptions {
  target: string;
  timeoutMs: number;
  on: NonNullable<Options<Request, ServerResponse>["on"]>;
}

export function createAnthropicProxy(options: AnthropicProxyOptions): RequestHandler {
  return createProxyMiddleware<Request, ServerResponse>({
    target: options.target,
    changeOrigin: true,
    pathRewrite: path => `/v1${path}`,
    proxyTimeout: options.timeoutMs,
    timeout: options.timeoutMs,
    on: options.on,
  });
}
```

Do not set `selfHandleResponse`, buffer/replace the response stream, or add data-transform pipes. Move the existing `proxyReq`, `proxyRes`, and `error` callbacks from the inline factory in `server.ts` into the `on` argument without changing auth, rate-limit extraction, logging, or usage listeners.

- [ ] **Step 6: Add failing server-routing assertions**

Extend the lifecycle test or add focused exported-helper tests that prove:

- a request with a session header obtains a `RoutedAccountLease` and records only its `reason` in `_pendingLog.details`;
- a refresh-failure response invokes explicit cleanup before returning;
- proxy error cleanup is safe after response `close` already fired;
- 401 invalidates the matching session binding;
- 429 invalidates the binding and calls `pool.setCooldown` using sanitized `Retry-After` seconds with a 60-second fallback;
- 529 invalidates the binding and applies a 30-second cooldown;
- no handler automatically replays the request or writes an SSE event.

Export narrowly scoped pure helpers from `lease-lifecycle.ts` if needed; do not export the Express app or add test-only branches to production code.

- [ ] **Step 7: Integrate `SessionRouter` into `server.ts`**

Instantiate one router beside the pool:

```ts
const pool = new TokenPool(accounts);
const sessionRouter = new SessionRouter(pool);
```

Extend the request augmentation with `_ccRoute?: RoutedAccountLease` and `_ccReleaseLease?: () => void`. In `/v1`, replace `pool.getNext()` with:

```ts
const route = sessionRouter.acquire(req.headers["x-claude-code-session-id"]);
req._ccRoute = route;
req._ccReleaseLease = attachLeaseLifecycle(res, route);
const account = route.account;
```

Acquire before token refresh. On every refresh/pre-forward error, invoke `_ccReleaseLease()` before ending the response; `finish`/`close` may invoke it again safely. In the proxy error callback, invoke it before writing the 502.

In `proxyRes`, for 401/429/529 call:

```ts
sessionRouter.invalidate(req._ccRoute?.sessionId, account.id);
```

For 429 and 529 call `pool.setCooldown` instead of mutating `account.busy` or creating `setTimeout` callbacks. Sanitize `Retry-After` as a finite non-negative number of seconds. Keep relaying the original response; do not retry from `proxyRes`.

On management disable and successful removal, call `sessionRouter.invalidateAccount(account.id)`. Other invalid states are rejected lazily by `TokenPool.isEligible` on the next routed request.

- [ ] **Step 8: Run focused proxy tests and full regression tests**

Run:

```bash
npm test -- src/__tests__/lease-lifecycle.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/session-router.test.ts
npm test
npm run lint
```

Expected: all pass; SSE buffers match byte-for-byte; tests close all sockets/timers without hanging.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/proxy/anthropic-proxy.ts src/proxy/lease-lifecycle.ts src/proxy/server.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/lease-lifecycle.test.ts
git commit -m "fix: route concurrent streams by Claude session"
```

---

### Task 4: Routing Observability and User Documentation

**Files:**

- Modify: `src/proxy/server.ts`
- Modify: `src/ui/Dashboard.tsx`
- Modify: `src/__tests__/server-health-accounts.test.ts`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add failing health-view tests**

Extend `src/__tests__/server-health-accounts.test.ts` to pass a routing-metrics resolver and assert both providers return numeric counters:

```ts
const views = createHealthAccountViews(
  [makeAnthropicAccount()],
  [openAIAccount],
  accountId => accountId === "max-account-1"
    ? { inFlightRequests: 2, activeSessions: 3, coolingDown: true }
    : { inFlightRequests: 0, activeSessions: 0, coolingDown: false },
);

expect(views[0]).toMatchObject({
  busy: true,
  inFlightRequests: 2,
  activeSessions: 3,
});
expect(views[1]).toMatchObject({
  inFlightRequests: 0,
  activeSessions: 0,
});
expect(JSON.stringify(views)).not.toContain("session-a");
```

- [ ] **Step 2: Run the health test and record RED evidence**

Run:

```bash
npm test -- src/__tests__/server-health-accounts.test.ts
```

Expected: FAIL because the health view lacks routing counters and the resolver argument.

- [ ] **Step 3: Add routing metrics to health/account JSON**

Add to `HealthAccountView`:

```ts
inFlightRequests: number;
activeSessions: number;
```

Define the resolver contract:

```ts
export interface AccountRoutingMetrics {
  inFlightRequests: number;
  activeSessions: number;
  coolingDown: boolean;
}

type RoutingMetricsResolver = (accountId: string) => AccountRoutingMetrics;
```

Give `createHealthAccountViews` a backward-compatible default resolver returning zeros. At the live health and accounts endpoints, pass a resolver using `pool.getInFlight`, `sessionRouter.getActiveSessionCount`, and `pool.isCoolingDown`. Derive Anthropic `busy` as `account.busy || metrics.coolingDown`; OpenAI counters remain zero.

Update the local `AccountStat` UI type in `src/ui/Dashboard.tsx` and show compact `N active / M streams` text for Anthropic accounts without altering account-management controls.

- [ ] **Step 4: Document cache-aware routing and failure semantics**

Update `README.md` to explain:

- one Claude Code session stays on one Anthropic subscription account for prompt-cache locality;
- new sessions prefer idle accounts, then fewer bound sessions, then more rate-limit headroom;
- 401/429/529 invalidates affinity for the next retry while the current response is passed through unchanged;
- mappings are memory-only, expire after one hour, and session IDs are never logged;
- `proxyRequestTimeoutMs` is a transport safety limit, not a fix for missing upstream terminal events;
- the router never appends a synthetic `message_stop`.

Change the package description from "Round-robin proxy" to "Cache-aware session router" and replace the `round-robin` keyword with `session-routing`.

- [ ] **Step 5: Run health, UI, and full verification**

Run:

```bash
npm test -- src/__tests__/server-health-accounts.test.ts
npm test
npm run lint
npm run build
```

Expected: all tests and both TypeScript compilation commands pass with pristine output.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/proxy/server.ts src/ui/Dashboard.tsx src/__tests__/server-health-accounts.test.ts README.md package.json
git commit -m "docs: explain cache-aware session routing"
```

---

## Final Verification and Review

- [ ] Generate a whole-branch review package from the implementation base to the final task commit.
- [ ] Dispatch a fresh whole-branch reviewer against the approved design and this plan.
- [ ] Resolve every Critical or Important finding and re-run the affected focused tests.
- [ ] Run final verification from a clean working tree:

```bash
npm test
npm run lint
npm run build
git status --short
```

- [ ] Confirm the full suite includes the concurrent byte-exact SSE test and exits without open handles.
- [ ] Use superpowers:finishing-a-development-branch to present the verified integration options.
