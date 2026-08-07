# OpenAI/Codex Sticky Routing, Usage Tracking, and Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stateless OpenAI/Codex round-robin forwarder with cache-aware sticky session routing over a new bucket-aware `OpenAITokenPool`, with `x-codex-*` usage tracking, scoped cooldowns, and live dashboard display.

**Architecture:** Extract a provider-generic `AccountPool` interface so the existing `SessionRouter` can run as a second instance over a new `OpenAITokenPool`. Codex usage is bucket-based: a default account-level `codex` bucket (primary 5h / secondary weekly) plus dynamically discovered named metered buckets (`x-codex-<limit>-*` header families, model-scoped via `limit-name`). Cooldowns are account-global or bucket-scoped via `x-codex-active-limit`. Both OpenAI ingress paths (`/v1/responses` and the `/v1/messages` cross-route branch) acquire routed leases, parse usage headers on every response, and feed counters/tokens into `ProxyStats` and the health payload.

**Tech Stack:** TypeScript (strict, ESM `NodeNext` — relative imports need the `.js` suffix), Express, Vitest (`globals: true`, tests in `src/__tests__/*.test.ts`), Ink (dashboard). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-openai-codex-sticky-routing-design.md`

## Global Constraints

- Session keys are never logged and never persisted. Bindings, cooldowns, and usage snapshots are in-memory only.
- Streaming stays byte-transparent on `/v1/responses`: no SSE frame is inserted, removed, or rewritten. Usage observers only *read* chunks that are being piped anyway.
- Upstream failure responses (401/429/5xx) are relayed unchanged — status, headers, and body. The router never retries after upstream bytes have started.
- The health payload never exposes access/refresh tokens or raw header values; every outbound field passes a sanitizer (clamp/floor/regex).
- Session map defaults stay: 1-hour inactivity TTL, 10,000-entry cap, LRU eviction, per-binding generation counter.
- Cooldown/reset evidence is bounded: reject negative, non-finite, and beyond-8-day values (mirror `MAX_RATE_LIMIT_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1_000`).
- Utilization is normalized `0..1` and clamped; `used-percent` headers divide by 100.
- Codex bucket limit ids normalize to lowercase with `-` mapped to `_` (mirrors the Codex CLI); the default bucket id is `"codex"`.
- Anthropic routing/selection/cooldown/display behavior does not change beyond the mechanical `AccountPool` interface extraction (Task 1). Its tests must stay green untouched except where types force an import path change.
- Pure helpers take `nowMs`/`now` parameters instead of calling `Date.now()` internally (testability; matches `TokenPool`/`SessionRouter` style).
- After every task: run the focused test file, then `npm test`, `npm run lint` (tsc --noEmit), and `npm run build` must all pass before committing.

---

### Task 1: Extract the generic `AccountPool` contract and make `SessionRouter` provider-generic

The router currently hard-depends on the Anthropic `TokenPool` (`src/proxy/session-router.ts:1-2,68`). Extract the minimal interface it needs so a second router instance can run over an OpenAI pool.

**Files:**
- Create: `src/proxy/account-pool.ts`
- Modify: `src/proxy/token-pool.ts:1-28,160-170` (move error classes out, implement interface)
- Modify: `src/proxy/session-router.ts` (generic over the pool's account type)
- Test: `src/__tests__/session-router.test.ts` (add one describe block; existing tests unchanged)

**Interfaces:**
- Consumes: `RouteContext` from `src/proxy/types.ts`; existing `TokenPool` internals.
- Produces (later tasks rely on these exact names):
  - `src/proxy/account-pool.ts`: `PoolAccount`, `AccountLease<TAccount>`, `AccountPool<TAccount>`, `EmptyPoolError`, `NoEligibleAccountError` (unchanged constructor: `(reason: "rate_limited" | "unavailable", blockedAccounts: number, retryAtMs?: number)`).
  - `SessionRouter<TAccount extends PoolAccount = Account>` with `acquire(sessionHeader: unknown, context?: RouteContext): RoutedAccountLease<TAccount>` and unchanged `invalidate` / `invalidateAccount` / `getActiveSessionCountsSnapshot`.
  - `RoutedAccountLease<TAccount extends PoolAccount = Account>` (union of scoped/unscoped, generic).
  - `token-pool.ts` re-exports `EmptyPoolError`, `NoEligibleAccountError`, and `AccountLease` (as `AccountLease<Account>`) so `anthropic-routing.ts`, `account-deletion.ts`, and existing tests keep their import paths.

- [ ] **Step 1: Write the failing test** — append to `src/__tests__/session-router.test.ts`:

```ts
import type { AccountLease as GenericAccountLease, AccountPool } from "../proxy/account-pool.js";

interface FakePoolAccount {
  readonly id: string;
  readonly flavor: "codex";
}

class FakeAccountPool implements AccountPool<FakePoolAccount> {
  readonly acquired: string[] = [];
  constructor(private readonly accounts: FakePoolAccount[]) {}

  acquireBest(): GenericAccountLease<FakePoolAccount> {
    const account = this.accounts[0]!;
    this.acquired.push(account.id);
    return { account, fallback: false, release: () => undefined };
  }

  tryAcquire(accountId: string): GenericAccountLease<FakePoolAccount> | null {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return null;
    this.acquired.push(`sticky:${account.id}`);
    return { account, fallback: false, release: () => undefined };
  }
}

describe("SessionRouter over a non-Anthropic AccountPool", () => {
  it("binds and reuses accounts from any pool implementing AccountPool", () => {
    const pool = new FakeAccountPool([{ id: "openai-a", flavor: "codex" }]);
    const router = new SessionRouter<FakePoolAccount>(pool);

    const first = router.acquire("session-1");
    expect(first.reason).toBe("new-session");
    expect(first.account.flavor).toBe("codex");

    const second = router.acquire("session-1");
    expect(second.reason).toBe("sticky");
    expect(pool.acquired).toEqual(["openai-a", "sticky:openai-a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/session-router.test.ts`
Expected: FAIL — `Cannot find module '../proxy/account-pool.js'`.

- [ ] **Step 3: Create `src/proxy/account-pool.ts`**

```ts
import type { RouteContext } from "./types.js";

/** Minimal account shape every pool implementation must expose. */
export interface PoolAccount {
  readonly id: string;
}

export interface AccountLease<TAccount extends PoolAccount = PoolAccount> {
  readonly account: TAccount;
  /** True when user caps were bypassed because every eligible account was capped. */
  readonly fallback: boolean;
  release(): void;
}

/** The contract SessionRouter needs from a provider pool. */
export interface AccountPool<TAccount extends PoolAccount = PoolAccount> {
  acquireBest(
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): AccountLease<TAccount>;
  tryAcquire(accountId: string, context?: RouteContext): AccountLease<TAccount> | null;
}

export class EmptyPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPoolError";
  }
}

export class NoEligibleAccountError extends Error {
  readonly reason: "rate_limited" | "unavailable";
  readonly retryAtMs?: number;
  readonly blockedAccounts: number;

  constructor(
    reason: "rate_limited" | "unavailable",
    blockedAccounts: number,
    retryAtMs?: number,
  ) {
    super("no account is currently eligible for routing");
    this.name = "NoEligibleAccountError";
    this.reason = reason;
    this.blockedAccounts = blockedAccounts;
    if (retryAtMs !== undefined) this.retryAtMs = retryAtMs;
  }
}
```

- [ ] **Step 4: Update `src/proxy/token-pool.ts`** — delete its local `EmptyPoolError` / `NoEligibleAccountError` class definitions (lines 5-28) and its local `AccountLease` interface (lines 160-164), replacing them with:

```ts
import {
  EmptyPoolError,
  NoEligibleAccountError,
  type AccountLease as GenericAccountLease,
  type AccountPool,
} from "./account-pool.js";

// Re-export so existing importers (anthropic-routing.ts, tests) keep working.
export { EmptyPoolError, NoEligibleAccountError };
export type AccountLease = GenericAccountLease<Account>;
```

and declare `export class TokenPool implements AccountPool<Account> {` — no body changes.

- [ ] **Step 5: Update `src/proxy/session-router.ts`** — replace the two token-pool imports (lines 1-2) with:

```ts
import type { AccountLease, AccountPool, PoolAccount } from "./account-pool.js";
import type { Account } from "./types.js";
```

and make the types generic (defaulting to `Account` so all existing Anthropic call sites compile unchanged):

```ts
export interface UnscopedRoutedAccountLease<TAccount extends PoolAccount = Account>
  extends AccountLease<TAccount> {
  readonly reason: "unscoped";
  readonly modelFamily?: string;
  readonly sessionId?: never;
  readonly bindingGeneration?: never;
}

export interface ScopedRoutedAccountLease<TAccount extends PoolAccount = Account>
  extends AccountLease<TAccount> {
  readonly reason: ScopedRouteReason;
  readonly modelFamily?: string;
  readonly sessionId: string;
  readonly bindingGeneration: number;
}

export type RoutedAccountLease<TAccount extends PoolAccount = Account> =
  | UnscopedRoutedAccountLease<TAccount>
  | ScopedRoutedAccountLease<TAccount>;

export class SessionRouter<TAccount extends PoolAccount = Account> {
  constructor(
    private readonly pool: AccountPool<TAccount>,
    options: SessionRouterOptions = {},
  ) { /* body unchanged */ }

  acquire(sessionHeader: unknown, context?: RouteContext): RoutedAccountLease<TAccount> { /* body unchanged */ }
```

Propagate `TAccount` through the private `wrapUnscoped` / `wrapScoped` helpers (`lease: AccountLease<TAccount>`, return types `UnscopedRoutedAccountLease<TAccount>` / `ScopedRoutedAccountLease<TAccount>`). No logic changes anywhere.

- [ ] **Step 6: Run the focused tests**

Run: `npx vitest run src/__tests__/session-router.test.ts src/__tests__/token-pool.test.ts src/__tests__/anthropic-routing.test.ts src/__tests__/lease-lifecycle.test.ts`
Expected: PASS (all existing + the new describe block).

- [ ] **Step 7: Full suite, lint, build**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/account-pool.ts src/proxy/token-pool.ts src/proxy/session-router.ts src/__tests__/session-router.test.ts
git commit -m "refactor: extract generic AccountPool contract from TokenPool/SessionRouter"
```

---

### Task 2: Persist OpenAI account caps and scopes

`loadOpenAIAccounts`/`saveOpenAIAccounts` (`src/config/manager.ts:143-172`) currently drop `scopes`, `sessionLimitPercent`, and `weeklyLimitPercent`. The spec persists them (durable fields: `id`, `provider`, tokens, `expiresAt`, `scopes`, `enabled`, `sessionLimitPercent`, `weeklyLimitPercent`).

**Files:**
- Modify: `src/providers/openai/token-refresher.ts:16-21` (widen `OpenAISubscriptionAccount`)
- Modify: `src/config/manager.ts:143-172`
- Test: `src/__tests__/manager.test.ts` (append)

**Interfaces:**
- Produces: `OpenAISubscriptionAccount` gains **optional** `scopes?: string[]`, `sessionLimitPercent?: number`, `weeklyLimitPercent?: number` (optional so existing fixtures/tests compile unchanged; Task 4's runtime factory fills defaults). `loadOpenAIAccounts` round-trips all three; `saveOpenAIAccounts` writes them when present, defaulting scopes to `["openid", "profile", "email", "offline_access"]`.
- Consumes: `clampPercent` from `src/proxy/types.js` (values are clamped at runtime-account creation in Task 4, not here — the file on disk keeps what the user wrote, matching the Anthropic `AccountRecord` treatment where `deserialize`/`addAccount` clamp).

- [ ] **Step 1: Write the failing test** — append to `src/__tests__/manager.test.ts` (use the file's existing temp-dir/accounts-file helpers; it already writes accounts.json fixtures for `loadAccounts` tests):

```ts
describe("OpenAI account persistence", () => {
  it("round-trips scopes and user caps through load and save", () => {
    writeAccountsFile([
      {
        id: "openai-a",
        provider: "openai_subscription",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1234,
        scopes: ["openid", "profile"],
        enabled: true,
        sessionLimitPercent: 80,
        weeklyLimitPercent: 90,
      },
    ]);

    const loaded = loadOpenAIAccounts(accountsPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.scopes).toEqual(["openid", "profile"]);
    expect(loaded[0]?.sessionLimitPercent).toBe(80);
    expect(loaded[0]?.weeklyLimitPercent).toBe(90);
  });
});
```

(Adapt `writeAccountsFile`/`accountsPath` to the helper names actually present in `manager.test.ts` — the file already has fixture-writing helpers for accounts.json; reuse them rather than inventing new ones. If `saveOpenAIAccounts` is testable there too — it writes to the default `ACCOUNTS_PATH` — cover the save side by asserting the record written by `saveOpenAIAccounts` retains the caps, mirroring however existing save tests stub the config dir.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/manager.test.ts`
Expected: FAIL — `sessionLimitPercent` is `undefined` after load.

- [ ] **Step 3: Implement** — in `token-refresher.ts`:

```ts
export type OpenAISubscriptionAccount = ProviderAccount & {
  provider: "openai_subscription";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  sessionLimitPercent?: number;
  weeklyLimitPercent?: number;
};
```

In `manager.ts`, `loadOpenAIAccounts` maps the extra fields through:

```ts
    .map(a => ({
      id: a.id,
      provider: "openai_subscription" as const,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      enabled: a.enabled !== false,
      ...(Array.isArray(a.scopes) ? { scopes: a.scopes } : {}),
      ...(a.sessionLimitPercent !== undefined ? { sessionLimitPercent: a.sessionLimitPercent } : {}),
      ...(a.weeklyLimitPercent !== undefined ? { weeklyLimitPercent: a.weeklyLimitPercent } : {}),
    }));
```

and `saveOpenAIAccounts` writes them:

```ts
  const records: AccountRecord[] = accounts.map(a => ({
    id: a.id,
    provider: "openai_subscription",
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: a.expiresAt,
    scopes: a.scopes ?? ["openid", "profile", "email", "offline_access"],
    enabled: a.enabled,
    ...(a.sessionLimitPercent !== undefined ? { sessionLimitPercent: a.sessionLimitPercent } : {}),
    ...(a.weeklyLimitPercent !== undefined ? { weeklyLimitPercent: a.weeklyLimitPercent } : {}),
  }));
```

- [ ] **Step 4: Run the focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/manager.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/token-refresher.ts src/config/manager.ts src/__tests__/manager.test.ts
git commit -m "feat: persist OpenAI account scopes and user caps in accounts.json"
```

---

### Task 3: Codex rate-limit header parsing (`providers/openai/usage.ts`)

Pure parsing of every `x-codex-*` bucket family plus credits, the active-limit resolver, and JWT plan decoding. Bucket discovery mirrors the Codex CLI parser (`codex-rs/codex-api/src/rate_limits.rs`): scan header names for the `-primary-used-percent` suffix.

**Files:**
- Create: `src/providers/openai/usage.ts`
- Test: `src/__tests__/openai-usage.test.ts`

**Interfaces (produced — later tasks import these exact names):**

```ts
export interface CodexRateWindow {
  utilization: number;   // normalized 0..1 (from used-percent / 100)
  resetAt: number;       // Unix seconds, 0 when unknown
  windowMinutes: number; // window size when reported, 0 when unknown
}

export interface CodexLimitBucket {
  limitId: string;    // normalized (lowercase, "-" -> "_"); "codex" = default
  limitName?: string; // human label; a model slug for model-scoped buckets
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexRateLimits {
  status: "ok" | "rate_limited";
  buckets: Map<string, CodexLimitBucket>; // keyed by limitId
  credits?: CodexCredits;
  plan?: string;       // decoded from the account JWT
  lastUpdated: number; // Unix ms, 0 when never observed
}

export interface CodexRateLimitsUpdate {
  buckets: CodexLimitBucket[];
  credits?: CodexCredits;
}

export const DEFAULT_CODEX_LIMIT_ID = "codex";
export function createEmptyCodexRateLimits(): CodexRateLimits;
export function normalizeCodexLimitId(name: string): string;
export function headersToRecord(headers: Headers): Record<string, string>;
export function parseCodexRateLimits(headers: Record<string, unknown>, nowMs: number): CodexRateLimitsUpdate;
export function resolveActiveLimit(headers: Record<string, unknown>): string | undefined;
export function decodeOpenAIPlan(accessToken: string): string | undefined;
```

Header scheme handled (keys are lowercase — Node lowercases inbound headers; `headersToRecord` lowercases fetch `Headers`):
- Default bucket: `x-codex-{primary,secondary}-used-percent`, `-window-minutes`, `-reset-at` (Unix seconds; values > 1e11 treated as ms), `-reset-after-seconds` (relative fallback).
- Named bucket `<limit>`: same family under `x-codex-<limit>-…` plus `x-codex-<limit>-limit-name`. Discovery: any header matching `x-*-primary-used-percent`; limit id = the `x-`-stripped, suffix-stripped middle, normalized.
- Credits: `x-codex-credits-has-credits`, `x-codex-credits-unlimited` (`true|false|1|0`), `x-codex-credits-balance`.
- Active limit: `x-codex-active-limit`.
- Plan JWT claim: `claims["https://api.openai.com/auth"].chatgpt_plan_type`.

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/openai-usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LIMIT_ID,
  decodeOpenAIPlan,
  headersToRecord,
  normalizeCodexLimitId,
  parseCodexRateLimits,
  resolveActiveLimit,
} from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000; // fixed clock for relative resets
const NOW_SEC = Math.floor(NOW_MS / 1000);

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
}

describe("parseCodexRateLimits", () => {
  it("parses the default bucket's primary and secondary windows", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
      "x-codex-secondary-used-percent": "80",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": String(NOW_SEC + 86_400),
    }, NOW_MS);

    expect(update.buckets).toHaveLength(1);
    const bucket = update.buckets[0]!;
    expect(bucket.limitId).toBe(DEFAULT_CODEX_LIMIT_ID);
    expect(bucket.primary).toEqual({ utilization: 0.125, resetAt: NOW_SEC + 600, windowMinutes: 300 });
    expect(bucket.secondary).toEqual({ utilization: 0.8, resetAt: NOW_SEC + 86_400, windowMinutes: 10_080 });
  });

  it("discovers named bucket families dynamically and reads their limit-name", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "10",
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-primary-window-minutes": "300",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS);

    expect(update.buckets.map(b => b.limitId)).toEqual(["codex", "codex_bengalfox"]);
    const named = update.buckets[1]!;
    expect(named.limitName).toBe("gpt-5.6-sol");
    expect(named.primary?.utilization).toBeCloseTo(0.88);
    expect(named.secondary).toBeUndefined();
  });

  it("clamps malformed, negative, and over-100 values without discarding the snapshot", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "250",
      "x-codex-secondary-used-percent": "-5",
      "x-codex-secondary-reset-at": "not-a-number",
    }, NOW_MS);

    const bucket = update.buckets[0]!;
    expect(bucket.primary?.utilization).toBe(1);
    expect(bucket.secondary?.utilization).toBe(0);
    expect(bucket.secondary?.resetAt).toBe(0);
  });

  it("falls back to reset-after-seconds when reset-at is absent", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-reset-after-seconds": "120",
    }, NOW_MS);
    expect(update.buckets[0]?.primary?.resetAt).toBe(NOW_SEC + 120);
  });

  it("ignores past reset-at values and treats millisecond timestamps as seconds", () => {
    const update = parseCodexRateLimits({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-reset-at": String(NOW_SEC - 100),
      "x-codex-secondary-used-percent": "50",
      "x-codex-secondary-reset-at": String((NOW_SEC + 600) * 1000),
    }, NOW_MS);
    expect(update.buckets[0]?.primary?.resetAt).toBe(0);
    expect(update.buckets[0]?.secondary?.resetAt).toBe(NOW_SEC + 600);
  });

  it("emits no bucket when a family has no usable data", () => {
    const update = parseCodexRateLimits({ "x-codex-bengalfox-limit-name": "gpt-5.6-sol" }, NOW_MS);
    expect(update.buckets).toHaveLength(0);
  });

  it("parses credits headers and tolerates a missing balance", () => {
    const update = parseCodexRateLimits({
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "0",
    }, NOW_MS);
    expect(update.credits).toEqual({ hasCredits: true, unlimited: false });
  });
});

describe("normalizeCodexLimitId / resolveActiveLimit", () => {
  it("normalizes to lowercase with dashes mapped to underscores", () => {
    expect(normalizeCodexLimitId(" Codex-BengalFox ")).toBe("codex_bengalfox");
  });

  it("resolves the active limit header and rejects garbage", () => {
    expect(resolveActiveLimit({ "x-codex-active-limit": "codex-bengalfox" })).toBe("codex_bengalfox");
    expect(resolveActiveLimit({})).toBeUndefined();
    expect(resolveActiveLimit({ "x-codex-active-limit": "  " })).toBeUndefined();
    expect(resolveActiveLimit({ "x-codex-active-limit": "a".repeat(80) })).toBeUndefined();
  });
});

describe("decodeOpenAIPlan", () => {
  it("reads chatgpt_plan_type from the auth claim", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Plus" } });
    expect(decodeOpenAIPlan(token)).toBe("plus");
  });

  it("returns undefined for malformed tokens and missing claims", () => {
    expect(decodeOpenAIPlan("not-a-jwt")).toBeUndefined();
    expect(decodeOpenAIPlan(jwt({}))).toBeUndefined();
  });
});

describe("headersToRecord", () => {
  it("lowercases fetch Headers into a plain record", () => {
    const headers = new Headers({ "X-Codex-Primary-Used-Percent": "10" });
    expect(headersToRecord(headers)).toEqual({ "x-codex-primary-used-percent": "10" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-usage.test.ts`
Expected: FAIL — module `../providers/openai/usage.js` not found.

- [ ] **Step 3: Implement `src/providers/openai/usage.ts`**

```ts
// Codex rate-limit reporting is bucket-based: a default account-level "codex"
// bucket plus optional named metered buckets, each published as an
// `x-<limit>-{primary,secondary}-*` header family. Discovery mirrors the
// Codex CLI (codex-rs/codex-api/src/rate_limits.rs): scan header names for
// the `-primary-used-percent` suffix.

export interface CodexRateWindow {
  utilization: number;
  resetAt: number;
  windowMinutes: number;
}

export interface CodexLimitBucket {
  limitId: string;
  limitName?: string;
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexRateLimits {
  status: "ok" | "rate_limited";
  buckets: Map<string, CodexLimitBucket>;
  credits?: CodexCredits;
  plan?: string;
  lastUpdated: number;
}

export interface CodexRateLimitsUpdate {
  buckets: CodexLimitBucket[];
  credits?: CodexCredits;
}

export const DEFAULT_CODEX_LIMIT_ID = "codex";

const USED_PERCENT_SUFFIX = "-primary-used-percent";
const MS_TIMESTAMP_THRESHOLD = 100_000_000_000;

export function createEmptyCodexRateLimits(): CodexRateLimits {
  return { status: "ok", buckets: new Map(), lastUpdated: 0 };
}

export function normalizeCodexLimitId(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function headerNumber(headers: Record<string, unknown>, name: string): number | undefined {
  const raw = headerString(headers, name)?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headerBool(headers: Record<string, unknown>, name: string): boolean | undefined {
  const raw = headerString(headers, name)?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

function parseResetAtSeconds(
  headers: Record<string, unknown>,
  prefix: string,
  kind: "primary" | "secondary",
  nowMs: number,
): number {
  const nowSec = Math.floor(nowMs / 1000);
  const absolute = headerNumber(headers, `${prefix}-${kind}-reset-at`);
  if (absolute !== undefined && absolute > 0) {
    const seconds = absolute > MS_TIMESTAMP_THRESHOLD ? Math.floor(absolute / 1000) : Math.floor(absolute);
    return seconds > nowSec ? seconds : 0;
  }
  const relative = headerNumber(headers, `${prefix}-${kind}-reset-after-seconds`);
  if (relative !== undefined && relative > 0) return nowSec + Math.floor(relative);
  return 0;
}

function parseWindow(
  headers: Record<string, unknown>,
  prefix: string,
  kind: "primary" | "secondary",
  nowMs: number,
): CodexRateWindow | undefined {
  const percent = headerNumber(headers, `${prefix}-${kind}-used-percent`);
  if (percent === undefined) return undefined;
  const windowMinutes = headerNumber(headers, `${prefix}-${kind}-window-minutes`);
  return {
    utilization: Math.max(0, Math.min(1, percent / 100)),
    resetAt: parseResetAtSeconds(headers, prefix, kind, nowMs),
    windowMinutes: windowMinutes !== undefined && windowMinutes > 0 ? Math.floor(windowMinutes) : 0,
  };
}

function parseCredits(headers: Record<string, unknown>): CodexCredits | undefined {
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  if (hasCredits === undefined && unlimited === undefined) return undefined;
  const balance = headerString(headers, "x-codex-credits-balance")?.trim();
  return {
    hasCredits: hasCredits === true,
    unlimited: unlimited === true,
    ...(balance ? { balance: balance.slice(0, 32) } : {}),
  };
}

export function parseCodexRateLimits(
  headers: Record<string, unknown>,
  nowMs: number,
): CodexRateLimitsUpdate {
  const limitIds = new Set<string>([DEFAULT_CODEX_LIMIT_ID]);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("x-") || !lower.endsWith(USED_PERCENT_SUFFIX)) continue;
    const limitId = normalizeCodexLimitId(lower.slice(2, -USED_PERCENT_SUFFIX.length));
    if (limitId) limitIds.add(limitId);
  }

  const buckets: CodexLimitBucket[] = [];
  for (const limitId of limitIds) {
    const prefix = `x-${limitId.replace(/_/g, "-")}`;
    const primary = parseWindow(headers, prefix, "primary", nowMs);
    const secondary = parseWindow(headers, prefix, "secondary", nowMs);
    if (!primary && !secondary) continue;
    const limitName = headerString(headers, `${prefix}-limit-name`)?.trim();
    buckets.push({
      limitId,
      ...(limitName ? { limitName: limitName.slice(0, 64) } : {}),
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
    });
  }

  const credits = parseCredits(headers);
  return { buckets, ...(credits ? { credits } : {}) };
}

export function resolveActiveLimit(headers: Record<string, unknown>): string | undefined {
  const raw = headerString(headers, "x-codex-active-limit")?.trim();
  if (!raw) return undefined;
  const normalized = normalizeCodexLimitId(raw);
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : undefined;
}

export function decodeOpenAIPlan(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const plan = (auth as { chatgpt_plan_type?: unknown }).chatgpt_plan_type;
    if (typeof plan !== "string") return undefined;
    const normalized = plan.trim().toLowerCase().slice(0, 32);
    return /^[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/openai-usage.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/usage.ts src/__tests__/openai-usage.test.ts
git commit -m "feat: parse Codex x-codex-* rate-limit bucket families, credits, and plan"
```

---

### Task 4: OpenAI runtime account state, snapshot merge, and model-to-bucket mapping

Upgrade the OpenAI account from a bare token record to a runtime object mirroring the Anthropic `Account`, with per-bucket snapshot merging (keep last-good), a bounded model→bucket map, and window-rollover sweeping.

**Files:**
- Create: `src/providers/openai/account-state.ts`
- Test: `src/__tests__/openai-account-state.test.ts`

**Interfaces (produced):**

```ts
export interface OpenAIAccount extends OpenAISubscriptionAccount {
  scopes: string[];
  sessionLimitPercent: number;
  weeklyLimitPercent: number;
  healthy: boolean;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastUsed: number;    // Unix ms
  lastRefresh: number; // Unix ms
  rateLimits: CodexRateLimits;
  modelBuckets: Map<string, string>; // model slug -> limitId, bounded, in-memory
}

export function createOpenAIAccount(record: OpenAISubscriptionAccount): OpenAIAccount;
export function applyCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits">,
  update: CodexRateLimitsUpdate,
  nowMs: number,
): void;
export function learnModelBucket(
  account: Pick<OpenAIAccount, "modelBuckets">,
  modelSlug: string | undefined,
  limitId: string,
): void;
export function bucketForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): CodexLimitBucket | undefined;
export function sweepCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  nowMs: number,
): boolean; // true when an exhausted window recovered
```

- Consumes: Task 3's types/helpers; `clampPercent`, `ACCOUNT_USER_DEFAULTS` from `src/proxy/types.js`; `OpenAISubscriptionAccount` from `./token-refresher.js`.

Behavior rules:
- `createOpenAIAccount` spreads the record, clamps caps (default 100), defaults scopes, sets `healthy: true`, zeroes counters, and seeds `rateLimits` with `createEmptyCodexRateLimits()` plus `plan: decodeOpenAIPlan(record.accessToken)` when decodable.
- `applyCodexRateLimits` merges per bucket: an incoming window replaces the stored one; an absent field keeps the last good value (`limitName`, `primary`, `secondary` each independently). `credits` replaces when present. `lastUpdated = nowMs` whenever anything was reported.
- `learnModelBucket` no-ops for `undefined` models and the default limit id; bounded at 32 entries (evict oldest insertion).
- `bucketForModel` checks the explicit map first (dropping stale mappings whose bucket no longer exists), then lazily matches a bucket whose `limitName` equals the model slug case-insensitively (learning it into the map).
- `sweepCodexRateLimits`: default-bucket windows whose `resetAt` has passed are zeroed (`utilization = 0`, `resetAt = 0`); a **named** bucket is deleted (with its model mappings) once every window it reports has passed its reset; returns `true` when a window with `utilization >= 1` rolled over.

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/openai-account-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyCodexRateLimits,
  bucketForModel,
  createOpenAIAccount,
  learnModelBucket,
  sweepCodexRateLimits,
} from "../providers/openai/account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, parseCodexRateLimits } from "../providers/openai/usage.js";
import type { OpenAISubscriptionAccount } from "../providers/openai/token-refresher.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function record(overrides: Partial<OpenAISubscriptionAccount> = {}): OpenAISubscriptionAccount {
  return {
    id: "openai-a",
    provider: "openai_subscription",
    accessToken: "header.e30.sig", // "{}" payload — no plan claim
    refreshToken: "rt",
    expiresAt: NOW_MS + 3_600_000,
    enabled: true,
    ...overrides,
  };
}

describe("createOpenAIAccount", () => {
  it("builds a runtime account with defaults and clamped caps", () => {
    const account = createOpenAIAccount(record({ sessionLimitPercent: 250, weeklyLimitPercent: -3 }));
    expect(account.healthy).toBe(true);
    expect(account.requestCount).toBe(0);
    expect(account.sessionLimitPercent).toBe(100);
    expect(account.weeklyLimitPercent).toBe(0);
    expect(account.scopes).toEqual(["openid", "profile", "email", "offline_access"]);
    expect(account.rateLimits.buckets.size).toBe(0);
    expect(account.rateLimits.plan).toBeUndefined();
  });
});

describe("applyCodexRateLimits", () => {
  it("merges buckets and keeps last-good values for absent fields", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "40",
      "x-codex-secondary-used-percent": "10",
    }, NOW_MS), NOW_MS);
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "55",
    }, NOW_MS + 1000), NOW_MS + 1000);

    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.utilization).toBeCloseTo(0.55);
    expect(bucket.secondary?.utilization).toBeCloseTo(0.1); // kept from the first response
    expect(account.rateLimits.lastUpdated).toBe(NOW_MS + 1000);
  });
});

describe("bucketForModel", () => {
  it("learns a mapping lazily from a bucket limit-name matching the model slug", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "88",
      "x-codex-bengalfox-limit-name": "GPT-5.6-Sol",
    }, NOW_MS), NOW_MS);

    const bucket = bucketForModel(account, "gpt-5.6-sol");
    expect(bucket?.limitId).toBe("codex_bengalfox");
    expect(account.modelBuckets.get("gpt-5.6-sol")).toBe("codex_bengalfox");
    expect(bucketForModel(account, "gpt-5.6-luna")).toBeUndefined();
  });

  it("drops a stale mapping whose bucket no longer exists", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", "codex_gone");
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeUndefined();
    expect(account.modelBuckets.has("gpt-5.6-sol")).toBe(false);
  });

  it("never maps the default limit id and bounds the map", () => {
    const account = createOpenAIAccount(record());
    learnModelBucket(account, "gpt-5.6-sol", DEFAULT_CODEX_LIMIT_ID);
    expect(account.modelBuckets.size).toBe(0);
    for (let i = 0; i < 40; i++) learnModelBucket(account, `model-${i}`, "codex_x");
    expect(account.modelBuckets.size).toBeLessThanOrEqual(32);
  });
});

describe("sweepCodexRateLimits", () => {
  it("zeroes expired default windows and reports recovery of exhausted ones", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 60),
    }, NOW_MS), NOW_MS);

    expect(sweepCodexRateLimits(account, NOW_MS)).toBe(false);
    const recovered = sweepCodexRateLimits(account, NOW_MS + 61_000);
    expect(recovered).toBe(true);
    const bucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID)!;
    expect(bucket.primary?.utilization).toBe(0);
    expect(bucket.primary?.resetAt).toBe(0);
  });

  it("drops a named bucket and its model mappings once its windows reset", () => {
    const account = createOpenAIAccount(record());
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 60),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    }, NOW_MS), NOW_MS);
    expect(bucketForModel(account, "gpt-5.6-sol")).toBeDefined();

    sweepCodexRateLimits(account, NOW_MS + 61_000);
    expect(account.rateLimits.buckets.has("codex_bengalfox")).toBe(false);
    expect(account.modelBuckets.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-account-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/openai/account-state.ts`**

```ts
import { ACCOUNT_USER_DEFAULTS, clampPercent } from "../../proxy/types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";
import {
  DEFAULT_CODEX_LIMIT_ID,
  createEmptyCodexRateLimits,
  decodeOpenAIPlan,
  type CodexLimitBucket,
  type CodexRateLimits,
  type CodexRateLimitsUpdate,
} from "./usage.js";

const MAX_MODEL_BUCKET_ENTRIES = 32;
const DEFAULT_OPENAI_SCOPES = ["openid", "profile", "email", "offline_access"];

export interface OpenAIAccount extends OpenAISubscriptionAccount {
  scopes: string[];
  sessionLimitPercent: number;
  weeklyLimitPercent: number;
  healthy: boolean;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastUsed: number;
  lastRefresh: number;
  rateLimits: CodexRateLimits;
  modelBuckets: Map<string, string>;
}

export function createOpenAIAccount(record: OpenAISubscriptionAccount): OpenAIAccount {
  const plan = decodeOpenAIPlan(record.accessToken);
  const rateLimits: CodexRateLimits = {
    ...createEmptyCodexRateLimits(),
    ...(plan ? { plan } : {}),
  };
  return {
    ...record,
    scopes: record.scopes ?? [...DEFAULT_OPENAI_SCOPES],
    sessionLimitPercent: record.sessionLimitPercent !== undefined
      ? clampPercent(record.sessionLimitPercent)
      : ACCOUNT_USER_DEFAULTS.sessionLimitPercent,
    weeklyLimitPercent: record.weeklyLimitPercent !== undefined
      ? clampPercent(record.weeklyLimitPercent)
      : ACCOUNT_USER_DEFAULTS.weeklyLimitPercent,
    healthy: true,
    requestCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastUsed: 0,
    lastRefresh: 0,
    rateLimits,
    modelBuckets: new Map(),
  };
}

export function applyCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits">,
  update: CodexRateLimitsUpdate,
  nowMs: number,
): void {
  const limits = account.rateLimits;
  for (const bucket of update.buckets) {
    const existing = limits.buckets.get(bucket.limitId);
    const merged: CodexLimitBucket = { limitId: bucket.limitId };
    const limitName = bucket.limitName ?? existing?.limitName;
    if (limitName) merged.limitName = limitName;
    const primary = bucket.primary ?? existing?.primary;
    if (primary) merged.primary = primary;
    const secondary = bucket.secondary ?? existing?.secondary;
    if (secondary) merged.secondary = secondary;
    limits.buckets.set(bucket.limitId, merged);
  }
  if (update.credits) limits.credits = update.credits;
  if (update.buckets.length > 0 || update.credits) limits.lastUpdated = nowMs;
}

function normalizeModelSlug(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 64) : undefined;
}

export function learnModelBucket(
  account: Pick<OpenAIAccount, "modelBuckets">,
  modelSlug: string | undefined,
  limitId: string,
): void {
  const model = normalizeModelSlug(modelSlug);
  if (!model || limitId === DEFAULT_CODEX_LIMIT_ID) return;
  if (!account.modelBuckets.has(model) && account.modelBuckets.size >= MAX_MODEL_BUCKET_ENTRIES) {
    const oldest = account.modelBuckets.keys().next().value;
    if (oldest !== undefined) account.modelBuckets.delete(oldest);
  }
  account.modelBuckets.set(model, limitId);
}

export function bucketForModel(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  modelSlug: string | undefined,
): CodexLimitBucket | undefined {
  const model = normalizeModelSlug(modelSlug);
  if (!model) return undefined;

  const mapped = account.modelBuckets.get(model);
  if (mapped !== undefined) {
    const bucket = account.rateLimits.buckets.get(mapped);
    if (bucket) return bucket;
    account.modelBuckets.delete(model);
    return undefined;
  }

  for (const bucket of account.rateLimits.buckets.values()) {
    if (bucket.limitId === DEFAULT_CODEX_LIMIT_ID) continue;
    if (bucket.limitName?.trim().toLowerCase() === model) {
      learnModelBucket(account, model, bucket.limitId);
      return bucket;
    }
  }
  return undefined;
}

export function sweepCodexRateLimits(
  account: Pick<OpenAIAccount, "rateLimits" | "modelBuckets">,
  nowMs: number,
): boolean {
  const nowSec = Math.floor(nowMs / 1000);
  let recovered = false;

  for (const [limitId, bucket] of account.rateLimits.buckets) {
    const windows = [bucket.primary, bucket.secondary];
    const expired = windows.map(window =>
      window !== undefined && window.resetAt > 0 && nowSec >= window.resetAt,
    );

    if (limitId === DEFAULT_CODEX_LIMIT_ID) {
      windows.forEach((window, index) => {
        if (!window || !expired[index]) return;
        if (window.utilization >= 1) recovered = true;
        window.utilization = 0;
        window.resetAt = 0;
      });
      continue;
    }

    const stillBlocking = windows.some((window, index) => window !== undefined && !expired[index]);
    const anyExpired = expired.some(Boolean);
    if (!stillBlocking && anyExpired) {
      if (windows.some(window => window !== undefined && window.utilization >= 1)) recovered = true;
      account.rateLimits.buckets.delete(limitId);
      for (const [model, mappedLimitId] of account.modelBuckets) {
        if (mappedLimitId === limitId) account.modelBuckets.delete(model);
      }
    }
  }
  return recovered;
}
```

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/openai-account-state.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/account-state.ts src/__tests__/openai-account-state.test.ts
git commit -m "feat: OpenAI runtime account state with bucket merge and model-to-bucket map"
```

---

### Task 5: `OpenAITokenPool`

The Codex-specific pool implementing `AccountPool<OpenAIAccount>`: hard eligibility over default-bucket and model-mapped-bucket windows, user caps on the default bucket, account-global and bucket-scoped cooldowns, the 4-key selection tuple, and `NoEligibleAccountError` with `retryAtMs`.

**Files:**
- Create: `src/providers/openai/token-pool.ts`
- Test: `src/__tests__/openai-token-pool.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AccountPool`, `AccountLease`, errors), Task 4 (`OpenAIAccount`, `bucketForModel`, `sweepCodexRateLimits`), Task 3 (`DEFAULT_CODEX_LIMIT_ID`), `RouteContext` from `src/proxy/types.js`.
- Produces (Tasks 6, 8, 9, 10 rely on these exact members):

```ts
export interface OpenAICooldownView {
  globalUntilMs: number;
  bucketCooldowns: Array<{ limitId: string; untilMs: number }>;
}

export class OpenAITokenPool implements AccountPool<OpenAIAccount> {
  constructor(accounts: OpenAIAccount[], options?: { now?: () => number });
  onCapBypass?: (account: OpenAIAccount) => void;
  onCooldownExpired?: (account: OpenAIAccount) => void;
  acquireBest(activeSessions: ReadonlyMap<string, number>, context?: RouteContext): AccountLease<OpenAIAccount>;
  tryAcquire(accountId: string, context?: RouteContext): AccountLease<OpenAIAccount> | null;
  getInFlight(accountId: string): number;
  setGlobalCooldownForAccount(account: OpenAIAccount, durationMs: number): void;
  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void;
  getCooldownView(accountId: string): OpenAICooldownView;
  getEarliestCooldownUntil(accountId: string): number;
  isCoolingDown(accountId: string): boolean;
  sweepExpiredCooldowns(): void;
  findById(id: string): OpenAIAccount | null;
  getAll(): OpenAIAccount[];
}
```

Selection ranking (lower wins, lexicographic): `[inFlight, activeSessions, headroomScore, circularDistance]` — the Anthropic tuple minus the paid-extra tier. `headroomScore = max(defaultPrimaryUtil / (sessionCap/100), defaultSecondaryUtil / (weeklyCap/100), modelBucketPrimaryUtil, modelBucketSecondaryUtil)`; a zero cap yields `Infinity` (and `overUserCap` already excludes it from the within-caps tier). Hard block: disabled/unhealthy → `unavailable`; active global cooldown, exhausted default window (util ≥ 1), or — when `context.requestedModel` maps to a named bucket — that bucket's cooldown/exhausted windows → `rate_limited` with `retryAtMs = max(trustworthy blockers)` (trustworthy = future, ≤ 8 days; any untrusted blocker ⇒ no `retryAtMs`). User caps apply to the default bucket only; when all hard-eligible accounts are capped, select least-loaded with `fallback: true` and fire `onCapBypass`. Leases increment `inFlight`/`requestCount`/`lastUsed`; `release()` is idempotent and identity-checked (never decrements a replacement account with a reused id). `sweepExpiredCooldowns()` runs `sweepCodexRateLimits` per account, clears expired cooldown scopes, flips `rateLimits.status` back to `"ok"` when nothing blocks, and fires `onCooldownExpired` once per recovered account.

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/openai-token-pool.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { EmptyPoolError, NoEligibleAccountError } from "../proxy/account-pool.js";
import { createOpenAIAccount, applyCodexRateLimits } from "../providers/openai/account-state.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeAccount(id: string, overrides: Partial<OpenAIAccount> = {}): OpenAIAccount {
  return {
    ...createOpenAIAccount({
      id,
      provider: "openai_subscription",
      accessToken: "header.e30.sig",
      refreshToken: "rt",
      expiresAt: NOW_MS + 3_600_000,
      enabled: true,
    }),
    ...overrides,
  };
}

function applyHeaders(account: OpenAIAccount, headers: Record<string, string>, nowMs = NOW_MS): void {
  applyCodexRateLimits(account, parseCodexRateLimits(headers, nowMs), nowMs);
}

describe("OpenAITokenPool eligibility", () => {
  it("throws EmptyPoolError for an empty pool", () => {
    const pool = new OpenAITokenPool([], { now: () => NOW_MS });
    expect(() => pool.acquireBest(new Map())).toThrow(EmptyPoolError);
  });

  it("excludes an account whose default primary window is exhausted", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
    });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");
  });

  it("excludes an account whose default secondary window is exhausted", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, { "x-codex-secondary-used-percent": "100" });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");
  });

  it("throws NoEligibleAccountError with reason and retryAtMs when all are exhausted", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 600),
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    try {
      pool.acquireBest(new Map());
      expect.unreachable("acquireBest should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligibleAccountError);
      const typed = error as NoEligibleAccountError;
      expect(typed.reason).toBe("rate_limited");
      expect(typed.retryAtMs).toBe((NOW_SEC + 600) * 1000);
    }
  });

  it("a model-mapped named bucket at 100% blocks only that model", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-primary-used-percent": "10",
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-reset-at": String(NOW_SEC + 600),
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });
});

describe("OpenAITokenPool cooldowns", () => {
  it("global cooldown excludes the account and expires", () => {
    let now = NOW_MS;
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => now });
    pool.setGlobalCooldownForAccount(a, 60_000);
    expect(() => pool.acquireBest(new Map())).toThrow(NoEligibleAccountError);
    now += 61_000;
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });

  it("bucket cooldown excludes only requests for the mapped model", () => {
    const a = makeAccount("a");
    applyHeaders(a, {
      "x-codex-bengalfox-primary-used-percent": "50",
      "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setBucketCooldownForAccount(a, "codex_bengalfox", 60_000);

    expect(() => pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-sol" }))
      .toThrow(NoEligibleAccountError);
    expect(pool.acquireBest(new Map(), { requestedModel: "gpt-5.6-luna" }).account.id).toBe("a");
    const view = pool.getCooldownView("a");
    expect(view.globalUntilMs).toBe(0);
    expect(view.bucketCooldowns).toEqual([{ limitId: "codex_bengalfox", untilMs: NOW_MS + 60_000 }]);
  });
});

describe("OpenAITokenPool selection and caps", () => {
  it("prefers the account with fewer in-flight requests, then sessions, then headroom", () => {
    const a = makeAccount("a");
    const b = makeAccount("b");
    applyHeaders(a, { "x-codex-primary-used-percent": "80" });
    applyHeaders(b, { "x-codex-primary-used-percent": "10" });
    const pool = new OpenAITokenPool([a, b], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).account.id).toBe("b");

    const leaseB = pool.tryAcquire("b");
    expect(leaseB).not.toBeNull(); // b now has 1 in flight
    expect(pool.acquireBest(new Map()).account.id).toBe("a");
  });

  it("marks a cap-bypass lease as fallback and fires onCapBypass", () => {
    const a = makeAccount("a", { sessionLimitPercent: 50 });
    applyHeaders(a, { "x-codex-primary-used-percent": "60" });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    const onCapBypass = vi.fn();
    pool.onCapBypass = onCapBypass;

    const lease = pool.acquireBest(new Map());
    expect(lease.fallback).toBe(true);
    expect(onCapBypass).toHaveBeenCalledWith(a);
  });

  it("a zero cap makes the account a cap-bypass candidate, never within caps", () => {
    const a = makeAccount("a", { sessionLimitPercent: 0 });
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    expect(pool.acquireBest(new Map()).fallback).toBe(true);
  });
});

describe("OpenAITokenPool leases", () => {
  it("release is idempotent and never negative", () => {
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    const lease = pool.acquireBest(new Map());
    expect(pool.getInFlight("a")).toBe(1);
    lease.release();
    lease.release();
    expect(pool.getInFlight("a")).toBe(0);
  });

  it("tryAcquire returns null for disabled, unhealthy, cooling, or capped accounts", () => {
    const a = makeAccount("a");
    const pool = new OpenAITokenPool([a], { now: () => NOW_MS });
    pool.setGlobalCooldownForAccount(a, 60_000);
    expect(pool.tryAcquire("a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-token-pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/openai/token-pool.ts`**

```ts
import {
  EmptyPoolError,
  NoEligibleAccountError,
  type AccountLease,
  type AccountPool,
} from "../../proxy/account-pool.js";
import type { RouteContext } from "../../proxy/types.js";
import { bucketForModel, sweepCodexRateLimits, type OpenAIAccount } from "./account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, type CodexLimitBucket, type CodexRateWindow } from "./usage.js";

const MAX_TRUSTED_RATE_LIMIT_RESET_MS = 8 * 24 * 60 * 60 * 1_000;

interface OpenAICooldowns {
  globalUntil: number;
  bucketUntil: Map<string, number>;
}

interface HardBlock {
  reason: "rate_limited" | "unavailable";
  retryAtMs?: number;
}

export interface OpenAICooldownView {
  globalUntilMs: number;
  bucketCooldowns: Array<{ limitId: string; untilMs: number }>;
}

export class OpenAITokenPool implements AccountPool<OpenAIAccount> {
  private readonly inFlight = new Map<string, number>();
  private readonly cooldowns = new Map<OpenAIAccount, OpenAICooldowns>();
  private readonly now: () => number;
  private currentIndex = 0;

  public onCapBypass?: (account: OpenAIAccount) => void;
  public onCooldownExpired?: (account: OpenAIAccount) => void;

  constructor(
    private readonly accounts: OpenAIAccount[],
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  acquireBest(
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): AccountLease<OpenAIAccount> {
    if (this.accounts.length === 0) {
      throw new EmptyPoolError("OpenAI token pool is empty — add an account first");
    }

    this.sweepExpiredCooldowns();
    const hardBlocks = new Map<OpenAIAccount, HardBlock>();
    const hardEligible = this.accounts.filter(account => {
      const block = this.hardBlock(account, context);
      if (block) hardBlocks.set(account, block);
      return block === null;
    });
    const withinUserCaps = hardEligible.filter(account => !this.overUserCap(account));

    if (withinUserCaps.length > 0) {
      const account = this.selectEligible(withinUserCaps, activeSessions, context);
      this.advanceCursor(account);
      return this.createLease(account, false);
    }

    if (hardEligible.length > 0) {
      const account = this.selectEligible(hardEligible, activeSessions, context);
      this.advanceCursor(account);
      this.onCapBypass?.(account);
      return this.createLease(account, true);
    }

    const rateLimited = [...hardBlocks.values()].filter(block => block.reason === "rate_limited");
    const retryTimes = rateLimited
      .map(block => block.retryAtMs)
      .filter((retryAtMs): retryAtMs is number => retryAtMs !== undefined);
    throw new NoEligibleAccountError(
      rateLimited.length > 0 ? "rate_limited" : "unavailable",
      this.accounts.length,
      retryTimes.length > 0 ? Math.min(...retryTimes) : undefined,
    );
  }

  tryAcquire(accountId: string, context?: RouteContext): AccountLease<OpenAIAccount> | null {
    const account = this.findById(accountId);
    if (!account) return null;
    sweepCodexRateLimits(account, this.now());
    this.clearExpiredCooldownState(account);
    if (this.hardBlock(account, context) || this.overUserCap(account)) return null;
    return this.createLease(account, false);
  }

  getInFlight(accountId: string): number {
    return this.inFlight.get(accountId) ?? 0;
  }

  setGlobalCooldownForAccount(account: OpenAIAccount, durationMs: number): void {
    const expiry = this.proposedExpiry(account, durationMs);
    if (expiry === undefined) return;
    const state = this.cooldownsFor(account);
    state.globalUntil = Math.max(state.globalUntil, expiry);
  }

  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void {
    const expiry = this.proposedExpiry(account, durationMs);
    if (expiry === undefined) return;
    const state = this.cooldownsFor(account);
    state.bucketUntil.set(limitId, Math.max(state.bucketUntil.get(limitId) ?? 0, expiry));
  }

  getCooldownView(accountId: string): OpenAICooldownView {
    const account = this.findById(accountId);
    if (!account) return { globalUntilMs: 0, bucketCooldowns: [] };
    this.clearExpiredCooldownState(account);
    const state = this.cooldowns.get(account);
    if (!state) return { globalUntilMs: 0, bucketCooldowns: [] };
    return {
      globalUntilMs: state.globalUntil,
      bucketCooldowns: [...state.bucketUntil]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 12)
        .map(([limitId, untilMs]) => ({ limitId, untilMs })),
    };
  }

  getEarliestCooldownUntil(accountId: string): number {
    const view = this.getCooldownView(accountId);
    const expiries = [view.globalUntilMs, ...view.bucketCooldowns.map(c => c.untilMs)]
      .filter(value => value > 0);
    return expiries.length > 0 ? Math.min(...expiries) : 0;
  }

  isCoolingDown(accountId: string): boolean {
    return this.getEarliestCooldownUntil(accountId) > 0;
  }

  sweepExpiredCooldowns(): void {
    const now = this.now();
    for (const account of this.accounts) {
      const windowRecovered = sweepCodexRateLimits(account, now);
      const cooldownRecovered = this.clearExpiredCooldownState(account);

      if (account.rateLimits.status === "rate_limited" && !this.isCoolingDown(account.id)) {
        const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
        const exhausted = [defaultBucket?.primary, defaultBucket?.secondary]
          .some(window => window !== undefined && window.utilization >= 1);
        if (!exhausted) account.rateLimits.status = "ok";
      }
      if (windowRecovered || cooldownRecovered) this.onCooldownExpired?.(account);
    }
  }

  findById(id: string): OpenAIAccount | null {
    return this.accounts.find(account => account.id === id) ?? null;
  }

  getAll(): OpenAIAccount[] {
    return this.accounts;
  }

  private hardBlock(account: OpenAIAccount, context?: RouteContext): HardBlock | null {
    if (!account.enabled || !account.healthy) return { reason: "unavailable" };

    const nowMs = this.now();
    const timedBlockers: number[] = [];
    let hasIndefiniteBlocker = false;
    let rateLimited = false;

    const state = this.cooldowns.get(account);
    if (state !== undefined && state.globalUntil > nowMs) {
      rateLimited = true;
      timedBlockers.push(state.globalUntil);
    }

    const blockingWindows: CodexRateWindow[] = [];
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    for (const window of [defaultBucket?.primary, defaultBucket?.secondary]) {
      if (window !== undefined && window.utilization >= 1) blockingWindows.push(window);
    }

    const modelBucket = this.modelBucket(account, context);
    if (modelBucket !== undefined) {
      const bucketCooldown = state?.bucketUntil.get(modelBucket.limitId) ?? 0;
      if (bucketCooldown > nowMs) {
        rateLimited = true;
        timedBlockers.push(bucketCooldown);
      }
      for (const window of [modelBucket.primary, modelBucket.secondary]) {
        if (window !== undefined && window.utilization >= 1) blockingWindows.push(window);
      }
    }

    for (const window of blockingWindows) {
      rateLimited = true;
      const resetMs = trustworthyResetMs(window.resetAt, nowMs);
      if (resetMs !== undefined) timedBlockers.push(resetMs);
      else hasIndefiniteBlocker = true;
    }

    if (!rateLimited) return null;
    const retryAtMs = !hasIndefiniteBlocker && timedBlockers.length > 0
      ? Math.max(...timedBlockers)
      : undefined;
    return retryAtMs === undefined
      ? { reason: "rate_limited" }
      : { reason: "rate_limited", retryAtMs };
  }

  private modelBucket(account: OpenAIAccount, context?: RouteContext): CodexLimitBucket | undefined {
    return bucketForModel(account, context?.requestedModel);
  }

  private overUserCap(account: OpenAIAccount): boolean {
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    const primaryUtil = defaultBucket?.primary?.utilization ?? 0;
    const secondaryUtil = defaultBucket?.secondary?.utilization ?? 0;
    return (account.sessionLimitPercent < 100 && primaryUtil * 100 >= account.sessionLimitPercent) ||
      (account.weeklyLimitPercent < 100 && secondaryUtil * 100 >= account.weeklyLimitPercent);
  }

  private headroomScore(account: OpenAIAccount, context?: RouteContext): number {
    const defaultBucket = account.rateLimits.buckets.get(DEFAULT_CODEX_LIMIT_ID);
    const modelBucket = this.modelBucket(account, context);
    return Math.max(
      capNormalizedUtilization(defaultBucket?.primary?.utilization ?? 0, account.sessionLimitPercent),
      capNormalizedUtilization(defaultBucket?.secondary?.utilization ?? 0, account.weeklyLimitPercent),
      modelBucket?.primary?.utilization ?? 0,
      modelBucket?.secondary?.utilization ?? 0,
    );
  }

  private selectEligible(
    candidates: OpenAIAccount[],
    activeSessions: ReadonlyMap<string, number>,
    context?: RouteContext,
  ): OpenAIAccount {
    return candidates.reduce((best, account) => {
      const comparison = compareTuple(
        [
          this.getInFlight(account.id),
          activeSessions.get(account.id) ?? 0,
          this.headroomScore(account, context),
          this.circularDistance(account),
        ],
        [
          this.getInFlight(best.id),
          activeSessions.get(best.id) ?? 0,
          this.headroomScore(best, context),
          this.circularDistance(best),
        ],
      );
      return comparison < 0 ? account : best;
    });
  }

  private circularDistance(account: OpenAIAccount): number {
    const index = this.accounts.indexOf(account);
    return (index - this.currentIndex + this.accounts.length) % this.accounts.length;
  }

  private advanceCursor(account: OpenAIAccount): void {
    const index = this.accounts.indexOf(account);
    this.currentIndex = (index + 1) % this.accounts.length;
  }

  private proposedExpiry(account: OpenAIAccount, durationMs: number): number | undefined {
    if (this.findById(account.id) !== account) return undefined;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
    const expiry = this.now() + durationMs;
    return Number.isFinite(expiry) ? expiry : undefined;
  }

  private cooldownsFor(account: OpenAIAccount): OpenAICooldowns {
    let state = this.cooldowns.get(account);
    if (!state) {
      state = { globalUntil: 0, bucketUntil: new Map() };
      this.cooldowns.set(account, state);
    }
    return state;
  }

  /** Returns true when an active cooldown scope just expired. */
  private clearExpiredCooldownState(account: OpenAIAccount): boolean {
    const state = this.cooldowns.get(account);
    if (!state) return false;
    const now = this.now();
    let recovered = false;
    if (state.globalUntil > 0 && state.globalUntil <= now) {
      state.globalUntil = 0;
      recovered = true;
    }
    for (const [limitId, until] of state.bucketUntil) {
      if (until <= now) {
        state.bucketUntil.delete(limitId);
        recovered = true;
      }
    }
    if (state.globalUntil === 0 && state.bucketUntil.size === 0) this.cooldowns.delete(account);
    return recovered;
  }

  private createLease(account: OpenAIAccount, fallback: boolean): AccountLease<OpenAIAccount> {
    this.inFlight.set(account.id, this.getInFlight(account.id) + 1);
    account.requestCount++;
    account.lastUsed = this.now();
    let released = false;
    return {
      account,
      fallback,
      release: () => {
        if (released) return;
        released = true;
        if (this.findById(account.id) !== account) return;
        const remaining = Math.max(0, this.getInFlight(account.id) - 1);
        if (remaining === 0) this.inFlight.delete(account.id);
        else this.inFlight.set(account.id, remaining);
      },
    };
  }
}

function trustworthyResetMs(resetAtSeconds: number, nowMs: number): number | undefined {
  if (!Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0) return undefined;
  const resetAtMs = Math.floor(resetAtSeconds) * 1_000;
  if (resetAtMs <= nowMs) return undefined;
  return resetAtMs - nowMs <= MAX_TRUSTED_RATE_LIMIT_RESET_MS ? resetAtMs : undefined;
}

function capNormalizedUtilization(utilization: number, capPercent: number): number {
  const cap = Number.isFinite(capPercent) ? Math.max(0, capPercent / 100) : 1;
  return cap === 0 ? Number.POSITIVE_INFINITY : utilization / cap;
}

function compareTuple(left: number[], right: number[]): number {
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}
```

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/openai-token-pool.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai/token-pool.ts src/__tests__/openai-token-pool.test.ts
git commit -m "feat: bucket-aware OpenAITokenPool with scoped cooldowns and headroom selection"
```

---

### Task 6: Codex failure routing (cooldown scope + duration)

On upstream 401/429/5xx: invalidate the session binding and set a cooldown whose scope comes from `x-codex-active-limit`. Duration for 429 is the greatest trustworthy future value among `Retry-After` (numeric or HTTP-date), the affected bucket's `x-codex-*` reset headers (absolute or relative), and the account snapshot's bucket resets; defaults 60s (429) / 30s (401, overload).

**Files:**
- Modify: `src/proxy/lease-lifecycle.ts:145-172` (export the three private expiry helpers — no behavior change)
- Create: `src/providers/openai/failure-routing.ts`
- Test: `src/__tests__/openai-failure-routing.test.ts`

**Interfaces:**
- Consumes: `BindingInvalidator`, `FailureRoute` and (newly exported) `futureExpiry`, `retryAfterExpiry`, `resetHeaderExpiry` from `src/proxy/lease-lifecycle.js`; `resolveActiveLimit`, `DEFAULT_CODEX_LIMIT_ID` from `./usage.js`; `learnModelBucket`, `OpenAIAccount` from `./account-state.js`.
- Produces:

```ts
export interface CodexCooldownSetter {
  setGlobalCooldownForAccount(account: OpenAIAccount, durationMs: number): void;
  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void;
}

export interface AppliedCodexFailureRouting {
  cooldownSeconds?: number;
  limitingScope?: "global" | `bucket:${string}`;
}

export function applyCodexFailureRouting(
  status: number,
  failureHeaders: Record<string, unknown>,
  route: FailureRoute<OpenAIAccount>,
  requestedModel: string | undefined,
  router: BindingInvalidator,
  pool: CodexCooldownSetter,
  now?: () => number,
): AppliedCodexFailureRouting;
```

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/openai-failure-routing.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { applyCodexFailureRouting } from "../providers/openai/failure-routing.js";
import { applyCodexRateLimits, createOpenAIAccount } from "../providers/openai/account-state.js";
import { parseCodexRateLimits } from "../providers/openai/usage.js";

const NOW_MS = 1_754_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function makeAccount() {
  return createOpenAIAccount({
    id: "openai-a",
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: NOW_MS + 3_600_000,
    enabled: true,
  });
}

function makePool() {
  return {
    setGlobalCooldownForAccount: vi.fn(),
    setBucketCooldownForAccount: vi.fn(),
  };
}

function makeRouter() {
  return { invalidate: vi.fn().mockReturnValue(true) };
}

describe("applyCodexFailureRouting", () => {
  it("does nothing for success statuses", () => {
    const pool = makePool();
    const router = makeRouter();
    const result = applyCodexFailureRouting(200, {}, { account: makeAccount() }, undefined, router, pool, () => NOW_MS);
    expect(result).toEqual({});
    expect(router.invalidate).not.toHaveBeenCalled();
  });

  it("429 without x-codex-active-limit sets an account-global cooldown (default 60s) and invalidates the binding", () => {
    const account = makeAccount();
    const pool = makePool();
    const router = makeRouter();
    const result = applyCodexFailureRouting(
      429, {},
      { account, sessionId: "s1", bindingGeneration: 7 },
      "gpt-5.6-sol", router, pool, () => NOW_MS,
    );
    expect(router.invalidate).toHaveBeenCalledWith("s1", "openai-a", 7);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000);
    expect(result).toEqual({ cooldownSeconds: 60, limitingScope: "global" });
    expect(account.rateLimits.status).toBe("rate_limited");
  });

  it("429 with a named active limit sets a bucket cooldown and learns the model mapping", () => {
    const account = makeAccount();
    const pool = makePool();
    const result = applyCodexFailureRouting(
      429,
      { "x-codex-active-limit": "codex-bengalfox" },
      { account },
      "gpt-5.6-sol", makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setBucketCooldownForAccount).toHaveBeenCalledWith(account, "codex_bengalfox", 60_000);
    expect(pool.setGlobalCooldownForAccount).not.toHaveBeenCalled();
    expect(account.modelBuckets.get("gpt-5.6-sol")).toBe("codex_bengalfox");
    expect(result.limitingScope).toBe("bucket:codex_bengalfox");
    expect(account.rateLimits.status).toBe("ok"); // named-bucket 429 is not account-global
  });

  it("prefers the greatest trustworthy expiry among Retry-After and reset headers", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      {
        "retry-after": "120",
        "x-codex-primary-reset-at": String(NOW_SEC + 600),
      },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 600_000);
  });

  it("uses the snapshot bucket reset when headers carry none", () => {
    const account = makeAccount();
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(NOW_SEC + 300),
    }, NOW_MS), NOW_MS);
    const pool = makePool();
    applyCodexFailureRouting(429, {}, { account }, undefined, makeRouter(), pool, () => NOW_MS);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 300_000);
  });

  it("rejects absurdly distant and negative evidence, falling back to the default", () => {
    const account = makeAccount();
    const pool = makePool();
    applyCodexFailureRouting(
      429,
      { "retry-after": "-5", "x-codex-primary-reset-at": String(NOW_SEC + 365 * 24 * 3600) },
      { account }, undefined, makeRouter(), pool, () => NOW_MS,
    );
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledWith(account, 60_000);
  });

  it("401 and 5xx set short account-global cooldowns", () => {
    const account = makeAccount();
    const pool = makePool();
    expect(applyCodexFailureRouting(401, {}, { account }, undefined, makeRouter(), pool, () => NOW_MS).cooldownSeconds).toBe(30);
    expect(applyCodexFailureRouting(503, {}, { account }, undefined, makeRouter(), pool, () => NOW_MS).cooldownSeconds).toBe(30);
    expect(pool.setGlobalCooldownForAccount).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-failure-routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export the expiry helpers** — in `src/proxy/lease-lifecycle.ts`, change the declarations of `futureExpiry` (line 145), `retryAfterExpiry` (line 150), and `resetHeaderExpiry` (line 162) from `function` to `export function`. No other change.

- [ ] **Step 4: Implement `src/providers/openai/failure-routing.ts`**

```ts
import {
  futureExpiry,
  resetHeaderExpiry,
  retryAfterExpiry,
  type BindingInvalidator,
  type FailureRoute,
} from "../../proxy/lease-lifecycle.js";
import { learnModelBucket, type OpenAIAccount } from "./account-state.js";
import { DEFAULT_CODEX_LIMIT_ID, resolveActiveLimit } from "./usage.js";

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_FAILURE_COOLDOWN_MS = 30_000;
const OVERLOAD_COOLDOWN_MS = 30_000;

export interface CodexCooldownSetter {
  setGlobalCooldownForAccount(account: OpenAIAccount, durationMs: number): void;
  setBucketCooldownForAccount(account: OpenAIAccount, limitId: string, durationMs: number): void;
}

export interface AppliedCodexFailureRouting {
  cooldownSeconds?: number;
  limitingScope?: "global" | `bucket:${string}`;
}

function header(headers: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function bucketResetExpiry(account: OpenAIAccount, limitId: string, nowMs: number): number | undefined {
  const bucket = account.rateLimits.buckets.get(limitId);
  const expiries = [bucket?.primary?.resetAt, bucket?.secondary?.resetAt]
    .filter((resetAt): resetAt is number => typeof resetAt === "number" && resetAt > 0)
    .map(resetAt => futureExpiry(resetAt * 1_000, nowMs))
    .filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length > 0 ? Math.max(...expiries) : undefined;
}

function rateLimitCooldownMs(
  headers: Record<string, unknown>,
  account: OpenAIAccount,
  limitId: string,
  nowMs: number,
): number {
  const prefix = `x-${limitId.replace(/_/g, "-")}`;
  const expiries = [
    retryAfterExpiry(header(headers, "retry-after"), nowMs),
    resetHeaderExpiry(header(headers, `${prefix}-primary-reset-at`), nowMs),
    resetHeaderExpiry(header(headers, `${prefix}-secondary-reset-at`), nowMs),
    retryAfterExpiry(header(headers, `${prefix}-primary-reset-after-seconds`), nowMs),
    retryAfterExpiry(header(headers, `${prefix}-secondary-reset-after-seconds`), nowMs),
    bucketResetExpiry(account, limitId, nowMs),
  ].filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length > 0
    ? Math.max(...expiries) - nowMs
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Apply only routing state changes implied by an upstream Codex failure. The
 * failed response itself is relayed byte-for-byte by the caller.
 */
export function applyCodexFailureRouting(
  status: number,
  failureHeaders: Record<string, unknown>,
  route: FailureRoute<OpenAIAccount>,
  requestedModel: string | undefined,
  router: BindingInvalidator,
  pool: CodexCooldownSetter,
  now: () => number = Date.now,
): AppliedCodexFailureRouting {
  if (status !== 401 && status !== 429 && status < 500) return {};

  if (route.sessionId !== undefined && route.bindingGeneration !== undefined) {
    router.invalidate(route.sessionId, route.account.id, route.bindingGeneration);
  }

  const nowMs = now();
  if (status === 429) {
    const activeLimit = resolveActiveLimit(failureHeaders);
    if (activeLimit !== undefined && activeLimit !== DEFAULT_CODEX_LIMIT_ID) {
      learnModelBucket(route.account, requestedModel, activeLimit);
      const durationMs = rateLimitCooldownMs(failureHeaders, route.account, activeLimit, nowMs);
      pool.setBucketCooldownForAccount(route.account, activeLimit, durationMs);
      return { cooldownSeconds: durationMs / 1_000, limitingScope: `bucket:${activeLimit}` };
    }
    const durationMs = rateLimitCooldownMs(failureHeaders, route.account, DEFAULT_CODEX_LIMIT_ID, nowMs);
    pool.setGlobalCooldownForAccount(route.account, durationMs);
    route.account.rateLimits.status = "rate_limited";
    return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
  }

  const durationMs = status === 401 ? AUTH_FAILURE_COOLDOWN_MS : OVERLOAD_COOLDOWN_MS;
  pool.setGlobalCooldownForAccount(route.account, durationMs);
  return { cooldownSeconds: durationMs / 1_000, limitingScope: "global" };
}
```

- [ ] **Step 5: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/openai-failure-routing.test.ts src/__tests__/lease-lifecycle.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/lease-lifecycle.ts src/providers/openai/failure-routing.ts src/__tests__/openai-failure-routing.test.ts
git commit -m "feat: Codex failure routing with active-limit-scoped cooldowns"
```

---

### Task 7: Codex session-key extraction and local error responses

Resolve the OpenAI affinity key in priority order — Codex `session_id` header, `x-claude-code-session-id`, body `prompt_cache_key` — with the same exactly-one-header and ≤256-byte rules the Anthropic path uses. Plus the local OpenAI-envelope 429/503 responses for `NoEligibleAccountError`.

**Files:**
- Create: `src/proxy/openai-routing.ts`
- Modify: `src/protocol/openai-responses-types.ts:45-53` (add `prompt_cache_key?: string` to `OpenAIResponsesRequest` — it then flows through `toCodexBackendRequest`'s spread untouched)
- Test: `src/__tests__/openai-routing.test.ts`

**Interfaces:**
- Consumes: `normalizeSessionId` from `./session-router.js`, `extractClaudeSessionId` from `./anthropic-routing.js`, `NoEligibleAccountError` from `./account-pool.js`.
- Produces:

```ts
export function extractCodexSessionKey(request: IncomingMessage, body: unknown): string | undefined;
export function sendOpenAINoEligibleResponse(
  error: NoEligibleAccountError,
  response: Response, // express Response
  nowMs: number,
): void;
```

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/openai-routing.test.ts` (build fake `IncomingMessage`s the way `anthropic-routing.test.ts` does — an object with `headersDistinct` and `rawHeaders`):

```ts
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { NoEligibleAccountError } from "../proxy/account-pool.js";
import { extractCodexSessionKey, sendOpenAINoEligibleResponse } from "../proxy/openai-routing.js";

function fakeRequest(headers: Record<string, string[]>): IncomingMessage {
  const rawHeaders: string[] = [];
  for (const [name, values] of Object.entries(headers)) {
    for (const value of values) rawHeaders.push(name, value);
  }
  return { headersDistinct: headers, rawHeaders } as unknown as IncomingMessage;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; },
  };
}

describe("extractCodexSessionKey", () => {
  it("prefers the Codex session_id header", () => {
    const request = fakeRequest({
      "session_id": ["codex-session"],
      "x-claude-code-session-id": ["claude-session"],
    });
    expect(extractCodexSessionKey(request, { prompt_cache_key: "cache-key" })).toBe("codex-session");
  });

  it("falls back to x-claude-code-session-id, then prompt_cache_key", () => {
    expect(extractCodexSessionKey(
      fakeRequest({ "x-claude-code-session-id": ["claude-session"] }),
      { prompt_cache_key: "cache-key" },
    )).toBe("claude-session");
    expect(extractCodexSessionKey(fakeRequest({}), { prompt_cache_key: "cache-key" })).toBe("cache-key");
    expect(extractCodexSessionKey(fakeRequest({}), {})).toBeUndefined();
  });

  it("ignores duplicated and oversized headers", () => {
    expect(extractCodexSessionKey(
      fakeRequest({ "session_id": ["one", "two"] }),
      {},
    )).toBeUndefined();
    expect(extractCodexSessionKey(
      fakeRequest({ "session_id": ["x".repeat(300)] }),
      {},
    )).toBeUndefined();
  });

  it("rejects non-string prompt_cache_key values", () => {
    expect(extractCodexSessionKey(fakeRequest({}), { prompt_cache_key: 42 })).toBeUndefined();
    expect(extractCodexSessionKey(fakeRequest({}), null)).toBeUndefined();
  });
});

describe("sendOpenAINoEligibleResponse", () => {
  it("sends a 429 with Retry-After in the OpenAI error envelope", () => {
    const response = fakeResponse();
    const error = new NoEligibleAccountError("rate_limited", 2, 1_754_000_060_000);
    sendOpenAINoEligibleResponse(error, response as never, 1_754_000_000_000);
    expect(response.statusCode).toBe(429);
    expect(response.headers["Retry-After"]).toBe("60");
    expect(response.body).toEqual({
      error: { type: "rate_limit_exceeded", message: expect.stringContaining("rate limited") },
    });
  });

  it("sends a 503 service_unavailable when no retry time is known", () => {
    const response = fakeResponse();
    sendOpenAINoEligibleResponse(new NoEligibleAccountError("unavailable", 1), response as never, 0);
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: { type: "service_unavailable", message: expect.any(String) },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — add to `openai-responses-types.ts` inside `OpenAIResponsesRequest`:

```ts
  /** Codex thread id — stable per conversation; used for sticky routing and upstream cache routing. */
  prompt_cache_key?: string;
```

Create `src/proxy/openai-routing.ts`:

```ts
import type { IncomingMessage } from "node:http";
import type { Response } from "express";
import type { NoEligibleAccountError } from "./account-pool.js";
import { extractClaudeSessionId } from "./anthropic-routing.js";
import { normalizeSessionId } from "./session-router.js";

const CODEX_SESSION_HEADER = "session_id";

/** Extract exactly one native HTTP header field without joined duplicates. */
function extractSingleHeader(request: IncomingMessage, name: string): string | undefined {
  const distinct = request.headersDistinct;
  if (distinct !== undefined) {
    const values = distinct[name];
    if (!values || values.length !== 1) return undefined;
    return normalizeSessionId(values[0]);
  }

  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1) return undefined;
  return normalizeSessionId(values[0]);
}

/**
 * Resolve the OpenAI affinity key in priority order: Codex session_id header,
 * Claude Code session header, then the request body's prompt_cache_key
 * (Codex thread id). Returns undefined for unscoped requests.
 */
export function extractCodexSessionKey(request: IncomingMessage, body: unknown): string | undefined {
  const codexSession = extractSingleHeader(request, CODEX_SESSION_HEADER);
  if (codexSession !== undefined) return codexSession;

  const claudeSession = extractClaudeSessionId(request);
  if (claudeSession !== undefined) return claudeSession;

  const promptCacheKey = body !== null && typeof body === "object"
    ? (body as { prompt_cache_key?: unknown }).prompt_cache_key
    : undefined;
  return normalizeSessionId(promptCacheKey);
}

/** Local OpenAI/Responses-shaped rejection — zero upstream requests were made. */
export function sendOpenAINoEligibleResponse(
  error: NoEligibleAccountError,
  response: Response,
  nowMs: number,
): void {
  if (error.reason === "rate_limited") {
    if (error.retryAtMs !== undefined) {
      const retryAfterSeconds = Math.max(0, Math.ceil((error.retryAtMs - nowMs) / 1_000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
    }
    response.status(429).json({
      error: {
        type: "rate_limit_exceeded",
        message: "All configured OpenAI accounts are currently rate limited",
      },
    });
    return;
  }

  response.status(503).json({
    error: {
      type: "service_unavailable",
      message: "All configured OpenAI accounts are currently unavailable",
    },
  });
}
```

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/openai-routing.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/openai-routing.ts src/protocol/openai-responses-types.ts src/__tests__/openai-routing.test.ts
git commit -m "feat: Codex session-key extraction and local no-eligible-account responses"
```

---

### Task 8: `/v1/responses` sticky routing integration

Replace the round-robin picker in `mountResponsesRoutes` with routed leases: acquire → refresh → forward → apply `x-codex-*` → failure routing → counters/activity/tokens. Streaming output stays byte-for-byte; a passive SSE observer captures token usage.

**Files:**
- Modify: `src/protocol/openai-responses-collect.ts` (add `createCodexUsageObserver`)
- Modify: `src/proxy/responses-server.ts` (rework options + handler)
- Test: `src/__tests__/openai-responses-collect.test.ts` (append observer tests), `src/__tests__/responses-server.test.ts` (rework routing describe blocks)

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6, 7; `acquireRequestRoute`, `routeReasonDetails`, `routeFailureDetails` from `lease-lifecycle.js`; `headersToRecord`, `parseCodexRateLimits` (via `applyCodexRateLimits`) from Task 3/4; `stats`, `LogEntry`, `createLocalRoutingErrorLog` from `stats.js`; `needsOpenAIRefresh` from `token-refresher.js`.
- Produces:

```ts
// openai-responses-collect.ts
export interface CodexUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
export function createCodexUsageObserver(): {
  push(chunk: Uint8Array): void;
  finish(): CodexUsageTotals | undefined;
};

// responses-server.ts — new options shape (Task 10 wires it)
export interface ResponsesRoutesOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
}
```

Handler flow (after the existing request validation, `store:true` rejection, `max_output_tokens` warning, and provider check, which all stay exactly as they are):

1. `const selected = acquireRequestRoute(extractCodexSessionKey(req, req.body), res, opts.openAIRouter, { requestedModel: route.upstreamModel })` — wrapped in try/catch: `EmptyPoolError` → existing 503 `no_accounts` envelope; `NoEligibleAccountError` → `recordActivity(createLocalRoutingErrorLog(error.reason, route.upstreamModel))` + `sendOpenAINoEligibleResponse(error, res, now())`; **no upstream request, no binding, no lease to release** (acquire threw).
2. `const account = selected.route.account;` — refresh: `const needed = needsOpenAIRefresh(account); const ready = await prepareOpenAIAccount(account);` On failure: `selected.release(); account.errorCount++; account.healthy = false;` respond 401 `authentication_error` (existing envelope), record an `error` activity entry. On success: `account.healthy = true; if (needed) account.lastRefresh = now();`.
3. Forward via `forwardOpenAI({ account, body, stream: body.stream === true })` with the model-rewritten body (existing code, body now carries `prompt_cache_key` through untouched).
4. `const headerRecord = headersToRecord(upstream.headers); applyCodexRateLimits(account, parseCodexRateLimits(headerRecord, now()), now());`
5. If `upstream.status === 401 || upstream.status === 429 || upstream.status >= 500`: `account.errorCount++; account.consecutiveErrors++;` and `const applied = applyCodexFailureRouting(upstream.status, headerRecord, selected.route, route.upstreamModel, opts.openAIRouter, opts.openAIPool, opts.now)`. Record an `error` activity entry with `details: routeFailureDetails(selected.route, upstream.status === 401 ? "token-invalid" : upstream.status === 429 ? "rate-limited" : "service-overloaded", applied.limitingScope)`. Widen `routeFailureDetails`'s third parameter in `lease-lifecycle.ts` from `"global" | \`model:${string}\`` to `"global" | \`model:${string}\` | \`bucket:${string}\`` (it is only interpolated into the log string; Anthropic call sites are unaffected). Else (success): `account.consecutiveErrors = 0;` record a `route` entry.
6. Relay: streaming → `sendUpstreamResponse`, extended to (a) mirror **all** upstream headers except hop-by-hop ones (`content-length`, `transfer-encoding`, `connection`, `keep-alive`) so relayed failures keep `retry-after` and `x-codex-*` intact, and (b) accept an optional `onChunk` callback for the usage observer (`observer.push(value)` per chunk, `observer.finish()` at the end — bytes written downstream are untouched); non-streaming → existing `collectCodexResponseStream` path, reading usage from the collected JSON body's `usage` field when present.
7. Token totals: set `inputTokens`/`outputTokens`/`cacheReadTokens` on the activity entry and bump `stats.totalInputTokens`, `stats.totalOutputTokens`, `stats.totalCacheReadTokens`. Increment `stats.totalRequests` on success and `stats.totalErrors` on failure statuses.
8. The lease releases via the `attachLeaseLifecycle` binding `acquireRequestRoute` already made (`finish`/`close`); never call `selected.release()` on paths where the response is still being written.

- [ ] **Step 1: Write failing observer tests** — append to `src/__tests__/openai-responses-collect.test.ts`:

```ts
import { createCodexUsageObserver } from "../protocol/openai-responses-collect.js";

describe("createCodexUsageObserver", () => {
  const encoder = new TextEncoder();

  it("captures usage from a response.completed event split across chunks", () => {
    const observer = createCodexUsageObserver();
    const event = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } },
      },
    })}\n\n`;
    const mid = Math.floor(event.length / 2);
    observer.push(encoder.encode(event.slice(0, mid)));
    observer.push(encoder.encode(event.slice(mid)));
    expect(observer.finish()).toEqual({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 25 });
  });

  it("returns undefined when no completed event arrives", () => {
    const observer = createCodexUsageObserver();
    observer.push(encoder.encode("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"));
    expect(observer.finish()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the observer** in `src/protocol/openai-responses-collect.ts`:

Run: `npx vitest run src/__tests__/openai-responses-collect.test.ts` → FAIL, then add:

```ts
import { parseSseLines } from "./sse.js";

export interface CodexUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Passive usage reader for the byte-transparent streaming path: it only
 * observes chunks that are already being piped downstream unchanged.
 */
export function createCodexUsageObserver(): {
  push(chunk: Uint8Array): void;
  finish(): CodexUsageTotals | undefined;
} {
  const decoder = new TextDecoder();
  let remainder = "";
  let totals: CodexUsageTotals | undefined;

  const applyEvent = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const typed = event as {
      type?: unknown;
      response?: { usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } };
    };
    if (typed.type !== "response.completed") return;
    const usage = typed.response?.usage;
    if (usage === undefined || typeof usage !== "object") return;
    totals = {
      inputTokens: usageNumber(usage.input_tokens),
      cachedInputTokens: usageNumber(usage.input_tokens_details?.cached_tokens),
      outputTokens: usageNumber(usage.output_tokens),
    };
  };

  return {
    push(chunk: Uint8Array): void {
      const parsed = parseSseLines(remainder + decoder.decode(chunk, { stream: true }));
      remainder = parsed.remainder;
      parsed.events.forEach(applyEvent);
    },
    finish(): CodexUsageTotals | undefined {
      const tail = decoder.decode();
      if (tail || remainder) parseSseLines(remainder + tail + "\n").events.forEach(applyEvent);
      remainder = "";
      return totals;
    },
  };
}
```

(If `parseSseLines` lives with a different export shape than `{ events, remainder }`, mirror how `messages-cross-route.ts:114-117` calls it — that call site is the ground truth.)

- [ ] **Step 3: Write failing routing tests** — rework the `mountResponsesRoutes` describe blocks in `src/__tests__/responses-server.test.ts`. Keep the `withServer` helper and the `forwardOpenAICodexResponse` describe block untouched. Replace `getOpenAIAccount`-based setups with a real router/pool over two runtime accounts:

```ts
import { SessionRouter } from "../proxy/session-router.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import type { LogEntry } from "../proxy/stats.js";

function makeRuntimeAccount(id: string): OpenAIAccount {
  return createOpenAIAccount({
    id,
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
  });
}

function mountWithPool(accounts: OpenAIAccount[], forwardOpenAI: ForwardOpenAI, extra: Partial<ResponsesRoutesOptions> = {}) {
  const app = express();
  const openAIPool = new OpenAITokenPool(accounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  const activity: LogEntry[] = [];
  mountResponsesRoutes(app, {
    openAIRouter,
    openAIPool,
    forwardOpenAI,
    recordActivity: entry => activity.push(entry),
    ...extra,
  });
  return { app, openAIPool, openAIRouter, activity };
}
```

New/updated cases (each posts through `withServer` + `fetch`, with `forwardOpenAI` as a `vi.fn()` returning constructed `Response` objects — never live traffic). Shared fixtures for the new describe block:

```ts
const SSE_BODY = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } } },
})}\n\n`;

function sseResponse(headers: Record<string, string> = {}): Response {
  return new Response(SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function post(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: [], stream: true, ...body }),
  });
}
```

```ts
describe("mountResponsesRoutes sticky routing", () => {
  it("pins a session to one account across turns while a second session uses the idle account", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      return sseResponse();
    });
    const { app } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await post(baseUrl, {}, { "session_id": "s1" })).text();
      await (await post(baseUrl, {}, { "session_id": "s1" })).text();
      await (await post(baseUrl, {}, { "session_id": "s2" })).text();
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("populates the account snapshot from x-codex-* response headers", async () => {
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => sseResponse({
      "x-codex-primary-used-percent": "42",
      "x-codex-secondary-used-percent": "5",
    }));
    const { app } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await post(baseUrl, {})).text();
    });

    const bucket = account.rateLimits.buckets.get("codex");
    expect(bucket?.primary?.utilization).toBeCloseTo(0.42);
    expect(bucket?.secondary?.utilization).toBeCloseTo(0.05);
  });

  it("relays a 429 byte-for-byte with its headers, sets a global cooldown, and rebinds the retry", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      if (seen.length === 1) {
        return new Response("upstream-429", {
          status: 429,
          headers: { "content-type": "text/event-stream", "retry-after": "120" },
        });
      }
      return sseResponse();
    });
    const { app, openAIPool } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await post(baseUrl, {}, { "session_id": "s1" });
      expect(first.status).toBe(429);
      expect(first.headers.get("retry-after")).toBe("120");
      expect(await first.text()).toBe("upstream-429");
      expect(openAIPool.isCoolingDown(seen[0]!)).toBe(true);

      const second = await post(baseUrl, {}, { "session_id": "s1" });
      expect(second.status).toBe(200);
      await second.text();
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("scopes a 429 with x-codex-active-limit to the named bucket only", async () => {
    const account = makeRuntimeAccount("openai-a");
    const forwardOpenAI = vi.fn(async () => {
      if (forwardOpenAI.mock.calls.length === 1) {
        return new Response("bucket-429", {
          status: 429,
          headers: {
            "content-type": "text/event-stream",
            "x-codex-active-limit": "codex-bengalfox",
            "x-codex-bengalfox-primary-used-percent": "100",
            "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
          },
        });
      }
      return sseResponse();
    });
    const { app } = mountWithPool([account], forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await post(baseUrl, { model: "openai/gpt-5.6-sol" });
      expect(first.status).toBe(429);
      await first.text();

      const sameModel = await post(baseUrl, { model: "openai/gpt-5.6-sol" });
      expect(sameModel.status).toBe(429);
      const localBody = await sameModel.json() as { error: { type: string } };
      expect(localBody.error.type).toBe("rate_limit_exceeded");
      expect(forwardOpenAI).toHaveBeenCalledTimes(1); // zero upstream calls for the blocked model

      const otherModel = await post(baseUrl, { model: "openai/gpt-5.6-luna" });
      expect(otherModel.status).toBe(200);
      await otherModel.text();
      expect(forwardOpenAI).toHaveBeenCalledTimes(2);
    });
  });

  it("returns a local 429 with Retry-After and zero upstream calls when all accounts are blocked", async () => {
    const account = makeRuntimeAccount("openai-a");
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 600),
    }, Date.now()), Date.now());
    const forwardOpenAI = vi.fn();
    const { app, activity } = mountWithPool([account], forwardOpenAI as never);

    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = await response.json() as { error: { type: string } };
      expect(body.error.type).toBe("rate_limit_exceeded");
    });

    expect(forwardOpenAI).not.toHaveBeenCalled();
    expect(activity.some(entry => entry.type === "error" && entry.details?.includes("rate-limited"))).toBe(true);
  });

  it("streams responses byte-for-byte and captures token usage into activity", async () => {
    const account = makeRuntimeAccount("openai-a");
    const { app, activity } = mountWithPool([account], vi.fn(async () => sseResponse()));

    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(await response.text()).toBe(SSE_BODY); // byte-identical relay
    });

    const entry = activity.find(e => e.type === "route");
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.outputTokens).toBe(25);
    expect(entry?.cacheReadTokens).toBe(60);
  });

  it("keeps returning 503 no_accounts for an empty pool", async () => {
    const { app } = mountWithPool([], vi.fn() as never);
    await withServer(app, async baseUrl => {
      const response = await post(baseUrl, {});
      expect(response.status).toBe(503);
      const body = await response.json() as { error: { type: string } };
      expect(body.error.type).toBe("no_accounts");
    });
  });
});
```

(Imports for the new block: `applyCodexRateLimits` from `../providers/openai/account-state.js` and `parseCodexRateLimits` from `../providers/openai/usage.js`.) Delete only the old `getOpenAIAccount` plumbing from existing tests — assertions about validation (400 store:true, 501 unsupported provider) stay as-is, re-mounted with the new helper.

- [ ] **Step 4: Run to verify the new tests fail**

Run: `npx vitest run src/__tests__/responses-server.test.ts`
Expected: FAIL — `mountResponsesRoutes` has no `openAIRouter` option yet.

- [ ] **Step 5: Rework `src/proxy/responses-server.ts`** per the handler flow in this task's header. Key code shape:

```ts
export function mountResponsesRoutes(app: Express, opts: ResponsesRoutesOptions): void {
  const forwardOpenAI = opts.forwardOpenAI ?? forwardOpenAICodexResponse;
  const prepareOpenAIAccount = opts.prepareOpenAIAccount ?? (async () => true);
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));
  const now = opts.now ?? Date.now;

  app.post("/v1/responses", express.json({ limit: "10mb" }), async (req, res) => {
    // ... existing validation, store:true rejection, max_output_tokens warning,
    // selectRoute + provider check — UNCHANGED ...

    let selected: { route: RoutedAccountLease<OpenAIAccount>; release: () => void; details: string };
    try {
      selected = acquireRequestRoute(
        extractCodexSessionKey(req, req.body),
        res,
        opts.openAIRouter,
        { requestedModel: route.upstreamModel },
      );
    } catch (error) {
      if (error instanceof EmptyPoolError) {
        res.status(503).json({ error: { type: "no_accounts", message: "No OpenAI subscription accounts are configured" } });
        return;
      }
      if (error instanceof NoEligibleAccountError) {
        recordActivity(createLocalRoutingErrorLog(error.reason, route.upstreamModel));
        sendOpenAINoEligibleResponse(error, res, now());
        return;
      }
      throw error;
    }

    const account = selected.route.account;
    const startedAt = now();
    const needed = needsOpenAIRefresh(account);
    const ready = await prepareOpenAIAccount(account);
    if (!ready) {
      selected.release();
      account.errorCount++;
      account.healthy = false;
      recordActivity({ ts: now(), accountId: account.id, model: route.upstreamModel, type: "error", statusCode: 401, details: "openai token refresh failed" });
      res.status(401).json({ error: { type: "authentication_error", message: "OpenAI subscription token refresh failed" } });
      return;
    }
    account.healthy = true;
    if (needed) account.lastRefresh = now();

    const body: OpenAIResponsesRequest = { ...req.body, model: route.upstreamModel };
    const upstream = await forwardOpenAI({ account, body, stream: body.stream === true });

    const headerRecord = headersToRecord(upstream.headers);
    applyCodexRateLimits(account, parseCodexRateLimits(headerRecord, now()), now());

    const failed = upstream.status === 401 || upstream.status === 429 || upstream.status >= 500;
    let details = routeReasonDetails(selected.route);
    if (failed) {
      account.errorCount++;
      account.consecutiveErrors++;
      stats.totalErrors++;
      const applied = applyCodexFailureRouting(
        upstream.status, headerRecord, selected.route, route.upstreamModel,
        opts.openAIRouter, opts.openAIPool, now,
      );
      details = routeFailureDetails(
        selected.route,
        upstream.status === 401 ? "token-invalid" : upstream.status === 429 ? "rate-limited" : "service-overloaded",
        applied.limitingScope,
      );
    } else {
      account.consecutiveErrors = 0;
      stats.totalRequests++;
    }

    const entry: LogEntry = {
      ts: startedAt,
      accountId: account.id,
      model: route.upstreamModel,
      type: failed ? "error" : "route",
      statusCode: upstream.status,
      path: "/v1/responses",
      details,
    };

    if (body.stream === true) {
      const observer = createCodexUsageObserver();
      await sendUpstreamResponse(upstream, res, chunk => observer.push(chunk));
      applyCodexUsage(entry, observer.finish());
    } else {
      const collected = await collectCodexResponseStream(upstream);
      if (collected.kind === "json") {
        applyCodexUsage(entry, usageFromResponseBody(collected.body));
        res.status(collected.status).json(collected.body);
      } else {
        res.status(collected.status).type(collected.contentType ?? "text/plain").send(collected.body);
      }
    }
    entry.durationMs = now() - startedAt;
    recordActivity(entry);
  });
}
```

with two small helpers in the same file:

```ts
function usageFromResponseBody(body: unknown): CodexUsageTotals | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } }).usage;
  if (usage === undefined || typeof usage !== "object") return undefined;
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return {
    inputTokens: num(usage.input_tokens),
    cachedInputTokens: num(usage.input_tokens_details?.cached_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

function applyCodexUsage(entry: LogEntry, usage: CodexUsageTotals | undefined): void {
  if (!usage) return;
  entry.inputTokens = usage.inputTokens;
  entry.outputTokens = usage.outputTokens;
  entry.cacheReadTokens = usage.cachedInputTokens;
  stats.totalInputTokens += usage.inputTokens;
  stats.totalOutputTokens += usage.outputTokens;
  stats.totalCacheReadTokens += usage.cachedInputTokens;
}
```

`sendUpstreamResponse` changes in two ways: (a) it mirrors **all** upstream headers except `content-length`, `transfer-encoding`, `connection`, and `keep-alive` (`upstream.headers.forEach((value, key) => { if (!HOP_BY_HOP.has(key)) res.setHeader(key, value); })`) so relayed failures keep `retry-after` and the `x-codex-*` family; (b) it gains an optional `onChunk?: (chunk: Uint8Array) => void` parameter invoked with each `value` before `res.write` — the bytes written downstream are untouched. Also widen `routeFailureDetails`'s `limitingScope` parameter in `lease-lifecycle.ts` from `"global" | \`model:${string}\`` to `"global" | \`model:${string}\` | \`bucket:${string}\``.

- [ ] **Step 6: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/responses-server.test.ts src/__tests__/openai-responses-collect.test.ts && npm test && npm run lint && npm run build`
Expected: PASS. (`server.ts` still compiles because Task 10 hasn't changed its call site yet — it will fail to compile NOW since the options shape changed. If so, patch the `mountResponsesRoutes(...)` call in `server.ts` minimally in THIS task: build the pool/router inline from `openAIAccounts.map(createOpenAIAccount)` and pass them; Task 10 finishes the wiring properly.)

- [ ] **Step 7: Commit**

```bash
git add src/proxy/responses-server.ts src/protocol/openai-responses-collect.ts src/proxy/lease-lifecycle.ts src/proxy/server.ts src/__tests__/responses-server.test.ts src/__tests__/openai-responses-collect.test.ts
git commit -m "feat: sticky bucket-aware routing for /v1/responses with usage capture"
```

---

### Task 9: `/v1/messages` cross-route sticky routing integration

Same acquisition/failure/counters flow for the OpenAI branch of `/v1/messages`, keyed by `x-claude-code-session-id` (via `extractCodexSessionKey` — there is no Codex `session_id` header on this path, and the Anthropic-format body has no `prompt_cache_key`). Local errors use the **Anthropic** envelope, matching this route's existing `no_accounts`/`authentication_error` responses.

**Files:**
- Modify: `src/proxy/anthropic-routing.ts:48-75` (export the existing private `sendNoEligibleAccountResponse` — rename to `export function sendAnthropicNoEligibleResponse`, update its one internal call site)
- Modify: `src/proxy/messages-cross-route.ts`
- Test: `src/__tests__/messages-cross-route.test.ts`

**Interfaces:**
- Consumes: same stack as Task 8, plus `sendAnthropicNoEligibleResponse(error, response, nowMs)` from `anthropic-routing.js`, `sendOpenAIAsAnthropic` internals.
- Produces: `MessagesCrossProviderRouteOptions` becomes:

```ts
export interface MessagesCrossProviderRouteOptions {
  openAIRouter: SessionRouter<OpenAIAccount>;
  openAIPool: OpenAITokenPool;
  prepareOpenAIAccount?: (account: OpenAIAccount) => Promise<boolean>;
  forwardOpenAI?: ForwardOpenAI;
  modelRouting?: ModelRoutingConfig;
  recordActivity?: (entry: LogEntry) => void;
  now?: () => number;
}
```

- [ ] **Step 1: Write the failing tests** — in `src/__tests__/messages-cross-route.test.ts`, add a mount helper mirroring Task 8's `mountWithPool` (router + pool over runtime accounts, `mountMessagesCrossProviderRoute` instead of `mountResponsesRoutes`) plus a poster, and migrate existing cases to the helper without weakening their assertions. Keep the existing passthrough test ("hands non-OpenAI models to next()") as-is. New cases:

```ts
function postMessages(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "openai/gpt-5.6-luna",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });
}

const CROSS_SSE_BODY = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 5 } },
})}\n\n`;

function crossSseResponse(headers: Record<string, string> = {}): Response {
  return new Response(CROSS_SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

describe("messages cross-route sticky routing", () => {
  it("routes repeated x-claude-code-session-id requests to the same account", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      return crossSseResponse();
    });
    const { app } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" })).text();
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" })).text();
      await (await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s2" })).text();
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("applies x-codex-* headers from cross-route responses to the account snapshot", async () => {
    const account = makeRuntimeAccount("openai-a");
    const { app } = mountWithPool([account], vi.fn(async () => crossSseResponse({
      "x-codex-primary-used-percent": "33",
    })));

    await withServer(app, async baseUrl => {
      await (await postMessages(baseUrl, {})).text();
    });

    expect(account.rateLimits.buckets.get("codex")?.primary?.utilization).toBeCloseTo(0.33);
  });

  it("relays an upstream 429, cools the account, and rebinds the session's next request", async () => {
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const seen: string[] = [];
    const forwardOpenAI = vi.fn(async (opts: { account: OpenAIAccount }) => {
      seen.push(opts.account.id);
      if (seen.length === 1) {
        return new Response("{\"error\":\"limit\"}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      }
      return crossSseResponse();
    });
    const { app, openAIPool } = mountWithPool(accounts, forwardOpenAI);

    await withServer(app, async baseUrl => {
      const first = await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" });
      expect(first.status).toBe(429);
      await first.text();
      expect(openAIPool.isCoolingDown(seen[0]!)).toBe(true);

      const second = await postMessages(baseUrl, {}, { "x-claude-code-session-id": "s1" });
      expect(second.status).toBe(200);
      await second.text();
    });

    expect(seen[1]).not.toBe(seen[0]);
  });

  it("returns a local Anthropic-envelope 429 with Retry-After when everything is blocked", async () => {
    const account = makeRuntimeAccount("openai-a");
    applyCodexRateLimits(account, parseCodexRateLimits({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 600),
    }, Date.now()), Date.now());
    const forwardOpenAI = vi.fn();
    const { app } = mountWithPool([account], forwardOpenAI as never);

    await withServer(app, async baseUrl => {
      const response = await postMessages(baseUrl, {});
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = await response.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("rate_limit_error");
    });

    expect(forwardOpenAI).not.toHaveBeenCalled();
  });
});
```

(`makeRuntimeAccount`, `withServer`, and the imports of `applyCodexRateLimits`/`parseCodexRateLimits` mirror Task 8's test file; `mountWithPool` here wraps `mountMessagesCrossProviderRoute` and must also register a terminal 404 handler after the route so `next()` passthrough cases don't hang.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/messages-cross-route.test.ts`
Expected: FAIL — options shape mismatch.

- [ ] **Step 3: Implement** — in `anthropic-routing.ts` rename/export:

```ts
export function sendAnthropicNoEligibleResponse(
  error: NoEligibleAccountError,
  response: Response,
  now: number,
): void { /* body of the old sendNoEligibleAccountResponse, unchanged */ }
```

In `messages-cross-route.ts`, replace the account-picker section (lines 215-244) with the routed flow. Concrete handler body for the OpenAI branch (after the existing `selectRoute` provider check and `next()` passthrough, which stay unchanged):

```ts
let selected: { route: RoutedAccountLease<OpenAIAccount>; release: () => void; details: string };
try {
  selected = acquireRequestRoute(
    extractCodexSessionKey(req, req.body),
    res,
    opts.openAIRouter,
    { requestedModel: route.upstreamModel },
  );
} catch (error) {
  if (error instanceof EmptyPoolError) {
    res.status(503).json({
      type: "error",
      error: { type: "no_accounts", message: "No OpenAI subscription accounts are configured" },
    });
    return;
  }
  if (error instanceof NoEligibleAccountError) {
    recordActivity(createLocalRoutingErrorLog(error.reason, route.upstreamModel));
    sendAnthropicNoEligibleResponse(error, res, now());
    return;
  }
  throw error;
}

const account = selected.route.account;
const startedAt = now();
const needed = needsOpenAIRefresh(account);
const ready = await prepareOpenAIAccount(account);
if (!ready) {
  selected.release();
  account.errorCount++;
  account.healthy = false;
  recordActivity({ ts: now(), accountId: account.id, model: route.upstreamModel, type: "error", statusCode: 401, details: "openai token refresh failed" });
  res.status(401).json({
    type: "error",
    error: { type: "authentication_error", message: "OpenAI subscription token refresh failed" },
  });
  return;
}
account.healthy = true;
if (needed) account.lastRefresh = now();

const body = anthropicToOpenAIResponses(req.body, opts.modelRouting);
const upstream = await forwardOpenAI({ account, body, stream: body.stream === true });

const headerRecord = headersToRecord(upstream.headers);
applyCodexRateLimits(account, parseCodexRateLimits(headerRecord, now()), now());

const failed = upstream.status === 401 || upstream.status === 429 || upstream.status >= 500;
let details = routeReasonDetails(selected.route);
if (failed) {
  account.errorCount++;
  account.consecutiveErrors++;
  stats.totalErrors++;
  const applied = applyCodexFailureRouting(
    upstream.status, headerRecord, selected.route, route.upstreamModel,
    opts.openAIRouter, opts.openAIPool, now,
  );
  details = routeFailureDetails(
    selected.route,
    upstream.status === 401 ? "token-invalid" : upstream.status === 429 ? "rate-limited" : "service-overloaded",
    applied.limitingScope,
  );
} else {
  account.consecutiveErrors = 0;
  stats.totalRequests++;
}

const entry: LogEntry = {
  ts: startedAt,
  accountId: account.id,
  model: route.upstreamModel,
  type: failed ? "error" : "route",
  statusCode: upstream.status,
  path: "/v1/messages",
  details,
};
await sendOpenAIAsAnthropic(upstream, res, req.body.stream === true, usage => applyCodexUsage(entry, usage));
entry.durationMs = now() - startedAt;
recordActivity(entry);
```

Key points:

- Session key: `extractCodexSessionKey(req, req.body)` (resolves via `x-claude-code-session-id`; the Anthropic body has no `prompt_cache_key`).
- Local `NoEligibleAccountError` → `sendAnthropicNoEligibleResponse(error, res, now())`; `EmptyPoolError` → existing Anthropic-envelope 503 `no_accounts`; refresh failure → existing Anthropic-envelope 401 (plus `selected.release()`, `errorCount++`, `healthy = false`).
- `path: "/v1/messages"` on activity entries.
- Usage: pass an `onUsage` callback into `sendOpenAIAsAnthropic` — thread it into `sendOpenAIStreamAsAnthropic` (invoke on the raw upstream event where `event.type === "response.completed"`, mapping `usage` with the same `usageFromResponseBody` guard — extract that helper from Task 8 into `openai-responses-collect.ts` as `export function usageFromResponseBody(body: unknown): CodexUsageTotals | undefined` and import it in both ingress files) and into the non-stream JSON branch (`usageFromResponseBody(json)`); the collected-stream branch reuses the totals from `collectOpenAIStreamAsAnthropicMessage`'s parsed usage the same way.
- The `applyCodexUsage` helper also moves to a shared location: export it from `responses-server.ts` or duplicate it — **prefer a small shared module**: put `applyCodexUsage(entry, usage)` next to `usageFromResponseBody` in `openai-responses-collect.ts`? No — that file is protocol-layer and must not import `stats`. Put `applyCodexUsage` in `src/proxy/stats.ts` (it mutates a `LogEntry` and the `stats` singleton, which is exactly that module's business):

```ts
// stats.ts
import type { CodexUsageTotals } from "../protocol/openai-responses-collect.js";

export function applyCodexUsage(entry: LogEntry, usage: CodexUsageTotals | undefined): void {
  if (!usage) return;
  entry.inputTokens = usage.inputTokens;
  entry.outputTokens = usage.outputTokens;
  entry.cacheReadTokens = usage.cachedInputTokens;
  stats.totalInputTokens += usage.inputTokens;
  stats.totalOutputTokens += usage.outputTokens;
  stats.totalCacheReadTokens += usage.cachedInputTokens;
}
```

(Refactor Task 8's local copy to use this shared one in this task.)

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/messages-cross-route.test.ts src/__tests__/responses-server.test.ts src/__tests__/anthropic-routing.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/messages-cross-route.ts src/proxy/anthropic-routing.ts src/proxy/stats.ts src/proxy/responses-server.ts src/protocol/openai-responses-collect.ts src/__tests__/messages-cross-route.test.ts
git commit -m "feat: sticky routing for the /v1/messages OpenAI cross-route branch"
```

---

### Task 10: Server wiring, health payload, and round-robin removal

Build runtime accounts at startup, run the OpenAI pool + second `SessionRouter`, delete the round-robin picker, and replace `publicOpenAIAccountView`'s hardcoded zeros with real counters plus a sanitized bucket/credits view.

**Files:**
- Modify: `src/proxy/server.ts` (startup wiring ~lines 466-509, mount options ~lines 906-916, health view types ~lines 70-139, `publicOpenAIAccountView` ~lines 362-378, `createHealthAccountViews` ~lines 229-240, health endpoint sweep ~line 563)
- Delete: `src/providers/openai/account-pool.ts`, `src/__tests__/openai-account-pool.test.ts`
- Test: `src/__tests__/server-health-accounts.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (Task 11 renders these):

```ts
export interface PublicCodexWindow {
  utilization: number;   // clamped 0..1
  resetAt: number;       // Unix seconds, 0 unknown
  windowMinutes: number; // 0 unknown
}

export interface PublicCodexBucket {
  limitId: string;         // /^[a-z0-9_]{1,64}$/ else "unknown"
  label: string;           // sanitized limitName, fallback limitId
  primary?: PublicCodexWindow;
  secondary?: PublicCodexWindow;
  cooldownUntilMs: number; // 0 when not cooling
}

export interface PublicCodexRateLimits {
  status: "ok" | "rate_limited";
  plan: string; // sanitized, "" when unknown
  buckets: PublicCodexBucket[]; // default bucket first, max 8
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  lastUpdated: number;
}

// HealthAccountView gains:
codexRateLimits?: PublicCodexRateLimits;

// createHealthAccountViews new signature:
export function createHealthAccountViews(
  anthropicAccounts: Account[],
  openAIAccounts: OpenAIAccount[],
  resolveRoutingMetrics?: RoutingMetricsResolver,
  resolveOpenAIRouting?: (accountId: string) => { metrics: AccountRoutingMetrics; cooldowns: OpenAICooldownView },
): HealthAccountView[];
```

- [ ] **Step 1: Write the failing tests** — extend `src/__tests__/server-health-accounts.test.ts` (follow its existing patterns for calling `createHealthAccountViews` / `publicOpenAIAccountView` indirectly):

```ts
it("reports real OpenAI counters, buckets, credits, and cooldowns in the health view", () => {
  const account = createOpenAIAccount({ id: "openai-a", provider: "openai_subscription", accessToken: "header.e30.sig", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, enabled: true });
  account.requestCount = 7;
  account.errorCount = 2;
  applyCodexRateLimits(account, parseCodexRateLimits({
    "x-codex-primary-used-percent": "42",
    "x-codex-secondary-used-percent": "5",
    "x-codex-bengalfox-primary-used-percent": "88",
    "x-codex-bengalfox-limit-name": "gpt-5.6-sol",
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
  }, Date.now()), Date.now());

  const views = createHealthAccountViews([], [account], undefined, () => ({
    metrics: { inFlightRequests: 3, activeSessions: 2, coolingDown: false, cooldownUntilMs: 0 },
    cooldowns: { globalUntilMs: 0, bucketCooldowns: [] },
  }));

  const view = views[0]!;
  expect(view.requestCount).toBe(7);
  expect(view.errorCount).toBe(2);
  expect(view.inFlightRequests).toBe(3);
  expect(view.activeSessions).toBe(2);
  const codex = view.codexRateLimits!;
  expect(codex.buckets[0]?.limitId).toBe("codex");
  expect(codex.buckets[0]?.primary?.utilization).toBeCloseTo(0.42);
  expect(codex.buckets[1]).toMatchObject({ limitId: "codex_bengalfox", label: "gpt-5.6-sol" });
  expect(codex.credits).toEqual({ hasCredits: true, unlimited: false });
});

it("never exposes tokens or raw header values in the OpenAI health view", () => {
  // JSON.stringify the view and assert it contains neither the accessToken nor refreshToken strings.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/server-health-accounts.test.ts`
Expected: FAIL — no `codexRateLimits`, zeros everywhere.

- [ ] **Step 3: Implement in `server.ts`**

Startup wiring (replacing lines 466, 489):

```ts
const openAIAccounts = loadOpenAIAccounts(accountsPath).map(createOpenAIAccount);
// ...
const openAIPool = new OpenAITokenPool(openAIAccounts);
const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
const resolveOpenAIRouting = (accountId: string) => ({
  metrics: {
    inFlightRequests: openAIPool.getInFlight(accountId),
    activeSessions: openAIRouter.getActiveSessionCountsSnapshot().get(accountId) ?? 0,
    coolingDown: openAIPool.isCoolingDown(accountId),
    cooldownUntilMs: openAIPool.getEarliestCooldownUntil(accountId),
  },
  cooldowns: openAIPool.getCooldownView(accountId),
});
openAIPool.onCapBypass = (a) => {
  const msg = `all OpenAI accounts capped — routing to ${a.id}`;
  stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "error", details: msg });
};
openAIPool.onCooldownExpired = (a) => {
  stats.addLog({ ts: Date.now(), accountId: a.id, model: "-", type: "route", details: `${a.id} cooldown expired — rate limit cleared` });
};
```

Delete the `createOpenAIAccountPicker` import and call; delete `src/providers/openai/account-pool.ts` and `src/__tests__/openai-account-pool.test.ts` (`git rm`). `startOpenAIRefreshLoop(openAIAccounts, saveOpenAIAccounts)` keeps working (runtime accounts are structurally `OpenAISubscriptionAccount`s and are mutated in place).

Mounts:

```ts
mountResponsesRoutes(app, {
  openAIRouter,
  openAIPool,
  prepareOpenAIAccount: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, saveOpenAIAccounts),
  modelRouting,
});

mountMessagesCrossProviderRoute(app, {
  openAIRouter,
  openAIPool,
  prepareOpenAIAccount: (account) => prepareOpenAIAccountForRequest(account, openAIAccounts, saveOpenAIAccounts),
  modelRouting,
});
```

Health endpoint: add `openAIPool.sweepExpiredCooldowns();` next to `pool.sweepExpiredCooldowns();` and pass `resolveOpenAIRouting` through both `createHealthAccountViews` call sites.

View builder:

```ts
function publicOpenAIAccountView(
  a: OpenAIAccount,
  routing: { metrics: AccountRoutingMetrics; cooldowns: OpenAICooldownView },
): HealthAccountView {
  const expiresInMs = a.expiresAt - Date.now();
  return {
    id: a.id,
    provider: "openai_subscription",
    enabled: a.enabled !== false,
    sessionLimitPercent: a.sessionLimitPercent,
    weeklyLimitPercent: a.weeklyLimitPercent,
    healthy: a.enabled !== false && a.healthy && expiresInMs > 0,
    busy: routing.metrics.coolingDown,
    cooldownUntilMs: routing.metrics.cooldownUntilMs ?? 0,
    globalCooldownUntilMs: routing.cooldowns.globalUntilMs,
    inFlightRequests: routing.metrics.inFlightRequests,
    activeSessions: routing.metrics.activeSessions,
    requestCount: a.requestCount,
    errorCount: a.errorCount,
    expiresInMs,
    lastUsedMs: a.lastUsed,
    lastRefreshMs: a.lastRefresh,
    codexRateLimits: publicCodexRateLimits(a, routing.cooldowns),
  };
}

function publicCodexRateLimits(a: OpenAIAccount, cooldowns: OpenAICooldownView): PublicCodexRateLimits {
  const rl = a.rateLimits;
  const buckets = [...rl.buckets.values()]
    .sort((left, right) =>
      left.limitId === DEFAULT_CODEX_LIMIT_ID ? -1
        : right.limitId === DEFAULT_CODEX_LIMIT_ID ? 1
        : left.limitId.localeCompare(right.limitId))
    .slice(0, 8)
    .map(bucket => ({
      limitId: publicCodexLimitId(bucket.limitId),
      label: publicCodexLabel(bucket),
      ...(bucket.primary ? { primary: publicCodexWindow(bucket.primary) } : {}),
      ...(bucket.secondary ? { secondary: publicCodexWindow(bucket.secondary) } : {}),
      cooldownUntilMs: publicTimestamp(
        cooldowns.bucketCooldowns.find(c => c.limitId === bucket.limitId)?.untilMs ?? 0,
      ),
    }));
  const credits = rl.credits;
  return {
    status: rl.status === "rate_limited" ? "rate_limited" : "ok",
    plan: publicCodexPlan(rl.plan),
    buckets,
    ...(credits ? {
      credits: {
        hasCredits: credits.hasCredits === true,
        unlimited: credits.unlimited === true,
        ...(typeof credits.balance === "string" && credits.balance ? { balance: credits.balance.slice(0, 32) } : {}),
      },
    } : {}),
    lastUpdated: publicTimestamp(rl.lastUpdated),
  };
}

function publicCodexWindow(window: CodexRateWindow): PublicCodexWindow {
  return {
    utilization: publicUtilization(window.utilization),
    resetAt: publicTimestamp(window.resetAt),
    windowMinutes: publicNonNegativeInteger(window.windowMinutes),
  };
}

function publicCodexLimitId(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "unknown";
}

function publicCodexLabel(bucket: CodexLimitBucket): string {
  const name = bucket.limitName?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return name || publicCodexLimitId(bucket.limitId);
}

function publicCodexPlan(value: string | undefined): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value) ? value : "";
}
```

`createHealthAccountViews` takes the fourth parameter and calls `publicOpenAIAccountView(account, resolveOpenAIRouting?.(account.id) ?? { metrics: zeroRoutingMetrics(account.id), cooldowns: { globalUntilMs: 0, bucketCooldowns: [] } })`.

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/server-health-accounts.test.ts src/__tests__/accounts-api.test.ts && npm test && npm run lint && npm run build`
Expected: PASS. Fix any test that constructed plain `OpenAISubscriptionAccount`s for server helpers by wrapping with `createOpenAIAccount`.

- [ ] **Step 5: Commit**

```bash
git rm src/providers/openai/account-pool.ts src/__tests__/openai-account-pool.test.ts
git add src/proxy/server.ts src/__tests__/server-health-accounts.test.ts
git commit -m "feat: wire OpenAI sticky routing into the server and health payload"
```

---

### Task 11: Dashboard rendering

OpenAI rows get real bars and counts: **5h** and **weekly** bars from the default bucket, one capacity row per named-bucket window labeled by model slug, a credits indicator, plan in the provider tag, cooldown rows, and the active-session/in-flight counts that were previously hidden for OpenAI.

**Files:**
- Modify: `src/ui/Dashboard.tsx` (`AccountStat` interface ~line 40-64, `AccountRow` ~lines 955-1044; add exported `getCodexCapacityRows`)
- Test: `src/__tests__/dashboard-codex-rows.test.ts` (new, pure-function tests)

**Interfaces:**
- Consumes: `codexRateLimits` from the health payload (Task 10 shape, duplicated as a local view interface the way `Dashboard.tsx` already mirrors `PublicAccountRateLimits`).
- Produces:

```ts
export interface CodexRateLimitsView {
  status: "ok" | "rate_limited";
  plan: string;
  buckets: Array<{
    limitId: string;
    label: string;
    primary?: { utilization: number; resetAt: number; windowMinutes: number };
    secondary?: { utilization: number; resetAt: number; windowMinutes: number };
    cooldownUntilMs: number;
  }>;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  lastUpdated: number;
}

export function getCodexCapacityRows(
  codex: CodexRateLimitsView | undefined,
  globalCooldownUntilMs: number | undefined,
  now?: number,
): AccountCapacityRow[];
```

Rules for `getCodexCapacityRows`:
- Skip the `codex` default bucket (it renders as the two `UtilBar`s).
- For each named bucket, emit one row per present window, label `` `${bucket.label} ${windowLabel}` `` where `windowLabel` is `"5h"` for 300 minutes, `"weekly"` for 10080, `` `${minutes/60}h` `` for other whole-hour values, `` `${minutes}m` `` otherwise, and `"5h"`/`"weekly"` as primary/secondary fallbacks when `windowMinutes` is 0.
- Row state/color: bucket cooling (`cooldownUntilMs > now`) → `"bucket cooldown"`/yellow; `utilization >= 1` → `"exhausted"`/red; `>= 0.7` → `"available"`/yellow; else `"available"`/green. Include `utilization` and `resetAt` (when > 0).
- A cooling bucket with no windows still emits one row (`state: "bucket cooldown"`, `resetAt` from `cooldownUntilMs / 1000`).
- Append a global-cooldown row (`label: "cooldown"`, `state: "global"`, red) when `globalCooldownUntilMs` is in the future — same shape as `getAccountCapacityRows` does for Anthropic.

`AccountRow` changes:
- `providerTag` for OpenAI becomes `` ` [OpenAI${codex?.plan ? ` ${codex.plan}` : ""}]` ``.
- Remove the `a.provider !== "openai_subscription"` guard around the sessions/streams line (line 1005) so OpenAI rows show `N active / M streams` too.
- After the Anthropic bars block, add an OpenAI block: when `a.provider === "openai_subscription"` and the default bucket has any window, render `UtilBar label="5h"` (primary, `cap={s5}`) and `UtilBar label="weekly"` (secondary, `cap={w7}`), `isActive={false}`, plus a gray `credits …` text when `codex.credits` is present (`∞` when unlimited, the balance when present, `yes`/`no` otherwise).
- `capacityRows` becomes `a.provider === "openai_subscription" ? getCodexCapacityRows(a.codexRateLimits, a.globalCooldownUntilMs) : getAccountCapacityRows(a)` — the existing row-rendering loop is reused untouched.

- [ ] **Step 1: Write the failing tests** — create `src/__tests__/dashboard-codex-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getCodexCapacityRows, type CodexRateLimitsView } from "../ui/Dashboard.js";

const NOW = 1_754_000_000_000;

function codexView(overrides: Partial<CodexRateLimitsView> = {}): CodexRateLimitsView {
  return { status: "ok", plan: "plus", buckets: [], lastUpdated: NOW, ...overrides };
}

describe("getCodexCapacityRows", () => {
  it("returns no rows without named buckets or cooldowns", () => {
    expect(getCodexCapacityRows(codexView({
      buckets: [{ limitId: "codex", label: "codex", cooldownUntilMs: 0, primary: { utilization: 0.4, resetAt: 0, windowMinutes: 300 } }],
    }), 0, NOW)).toEqual([]);
    expect(getCodexCapacityRows(undefined, 0, NOW)).toEqual([]);
  });

  it("emits one labeled row per named-bucket window", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [
        { limitId: "codex", label: "codex", cooldownUntilMs: 0 },
        {
          limitId: "codex_bengalfox", label: "gpt-5.6-sol", cooldownUntilMs: 0,
          primary: { utilization: 0.88, resetAt: Math.floor(NOW / 1000) + 600, windowMinutes: 300 },
          secondary: { utilization: 1, resetAt: 0, windowMinutes: 10080 },
        },
      ],
    }), 0, NOW);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "gpt-5.6-sol 5h", color: "yellow", utilization: 0.88 });
    expect(rows[1]).toMatchObject({ label: "gpt-5.6-sol weekly", state: "exhausted", color: "red" });
  });

  it("marks cooling buckets and appends the global cooldown row", () => {
    const rows = getCodexCapacityRows(codexView({
      buckets: [{ limitId: "codex_x", label: "gpt-5.6-terra", cooldownUntilMs: NOW + 30_000 }],
    }), NOW + 60_000, NOW);

    expect(rows[0]).toMatchObject({ label: "gpt-5.6-terra", state: "bucket cooldown", color: "yellow" });
    expect(rows[rows.length - 1]).toMatchObject({ label: "cooldown", state: "global", color: "red" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/dashboard-codex-rows.test.ts`
Expected: FAIL — `getCodexCapacityRows` not exported.

- [ ] **Step 3: Implement in `Dashboard.tsx`** — add the `CodexRateLimitsView` interface, `codexRateLimits?: CodexRateLimitsView` on `AccountStat`, the exported helper:

```ts
function codexWindowLabel(windowMinutes: number, fallback: "5h" | "weekly"): string {
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10_080) return "weekly";
  if (windowMinutes > 0) {
    return windowMinutes % 60 === 0 ? `${windowMinutes / 60}h` : `${windowMinutes}m`;
  }
  return fallback;
}

/** Named Codex metered buckets as compact capacity rows (default bucket renders as bars). */
export function getCodexCapacityRows(
  codex: CodexRateLimitsView | undefined,
  globalCooldownUntilMs: number | undefined,
  now = Date.now(),
): AccountCapacityRow[] {
  const rows: AccountCapacityRow[] = [];
  for (const bucket of codex?.buckets ?? []) {
    if (bucket.limitId === "codex") continue;
    const cooling = bucket.cooldownUntilMs > now;
    const windows: Array<{ label: string; utilization: number; resetAt: number }> = [];
    if (bucket.primary) {
      windows.push({ label: codexWindowLabel(bucket.primary.windowMinutes, "5h"), ...bucket.primary });
    }
    if (bucket.secondary) {
      windows.push({ label: codexWindowLabel(bucket.secondary.windowMinutes, "weekly"), ...bucket.secondary });
    }

    for (const window of windows) {
      const exhausted = window.utilization >= 1;
      rows.push({
        label: `${bucket.label} ${window.label}`,
        state: cooling ? "bucket cooldown" : exhausted ? "exhausted" : "available",
        color: cooling ? "yellow" : exhausted ? "red" : window.utilization >= 0.7 ? "yellow" : "green",
        utilization: window.utilization,
        ...(window.resetAt > 0 ? { resetAt: window.resetAt } : {}),
      });
    }
    if (windows.length === 0 && cooling) {
      rows.push({
        label: bucket.label,
        state: "bucket cooldown",
        color: "yellow",
        resetAt: Math.floor(bucket.cooldownUntilMs / 1000),
      });
    }
  }
  if (globalCooldownUntilMs && globalCooldownUntilMs > now) {
    rows.push({ label: "cooldown", state: "global", color: "red", resetAt: Math.floor(globalCooldownUntilMs / 1000) });
  }
  return rows;
}
```

then apply the `AccountRow` changes listed above (provider tag with plan, sessions/streams for OpenAI, the OpenAI bars/credits block, and the `capacityRows` provider switch).

- [ ] **Step 4: Run focused tests, full suite, lint, build**

Run: `npx vitest run src/__tests__/dashboard-codex-rows.test.ts src/__tests__/dashboard-rendering.test.ts src/__tests__/dashboard-model-window.test.ts && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Dashboard.tsx src/__tests__/dashboard-codex-rows.test.ts
git commit -m "feat: render OpenAI bucket bars, credits, and cooldowns on the dashboard"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md` (the section describing OpenAI/Codex support)
- Modify: `docs/session-routing.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `docs/session-routing.md`** — add an "OpenAI/Codex routing" section stating: affinity key resolution order (`session_id` header → `x-claude-code-session-id` → body `prompt_cache_key`; unscoped otherwise), 1h TTL / 10k cap / LRU identical to Anthropic, and the bucket model: Codex usage is bucket-based — a default account-level `codex` bucket (primary 5h / secondary weekly) shared by all models at model-specific burn rates, plus optional model-scoped metered buckets discovered dynamically from `x-codex-<limit>-*` header families (never configured); cooldowns are account-global or bucket-scoped via `x-codex-active-limit`; usage is derived from response headers only in this release (the `wham/usage` endpoint and `codex.rate_limits` stream events are future enhancements); credits are displayed but not used for selection.

- [ ] **Step 2: Update `README.md`** — in the OpenAI/Codex feature description: sticky sessions per Codex conversation, load- and headroom-aware account selection, account-level 5h/weekly windows plus per-model buckets when reported, dashboard bars for OpenAI accounts, and the same user caps (`sessionLimitPercent`/`weeklyLimitPercent`) applying to the default bucket.

- [ ] **Step 3: Update `CHANGELOG.md`** — new `## Unreleased` entry:

```markdown
## Unreleased

### Added
- OpenAI/Codex sticky session routing: sessions pin to one account for prompt-cache
  locality (`session_id` → `x-claude-code-session-id` → `prompt_cache_key`), with
  load- and headroom-aware selection for new sessions.
- Codex usage tracking from `x-codex-*` response headers: default 5h/weekly windows
  plus dynamically discovered model-scoped metered buckets, credits, and plan.
- Scoped cooldowns on upstream failures: bucket-scoped via `x-codex-active-limit`,
  account-global otherwise; local 429/503 responses when no account is eligible.
- Dashboard: OpenAI accounts now show 5h/weekly bars, per-bucket rows, credits,
  plan, request/error/in-flight/session counts, and cooldown state.

### Changed
- OpenAI account records persist `scopes`, `sessionLimitPercent`, and `weeklyLimitPercent`.
- The stateless OpenAI round-robin picker was removed in favor of `OpenAITokenPool`.
```

- [ ] **Step 4: Full suite, lint, build (docs shouldn't break anything — verify anyway)**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/session-routing.md CHANGELOG.md
git commit -m "docs: OpenAI/Codex sticky routing, bucket-based usage, and dashboard display"
```

---

## Spec coverage map (for the final reviewer)

| Spec section | Tasks |
|---|---|
| Architecture: `AccountPool` extraction, second `SessionRouter` | 1, 10 |
| Account State (durable fields + runtime object) | 2, 4 |
| Usage Tracking: header parsing, bucket discovery, merge | 3, 4 |
| Model-to-bucket mapping | 4, 6 |
| Effective Availability, selection tuple, user caps, `NoEligibleAccountError` | 5 |
| Cooldowns on failure (scope + duration + binding invalidation) | 6 |
| Session identity (key priority, normalization) | 7 |
| Proxy Integration `/v1/responses` (steps 1-8, local errors, byte transparency, tokens) | 8 |
| Proxy Integration `/v1/messages` OpenAI branch | 9 |
| Display: health payload + sanitizers | 10 |
| Display: dashboard bars/rows/credits/cooldowns | 11 |
| Observability: activity entries, selection reasons, cooldown scopes | 8, 9, 10 |
| Documentation | 12 |

Out of scope (spec Non-Goals — do **not** implement): `wham/usage` polling, `codex.rate_limits` stream event parsing, credits-based selection, hardcoded model→bucket assumptions, persistence of bindings/cooldowns/snapshots/mappings across restarts, SSE modification, cross-account retry of partially delivered responses, any Anthropic behavior change beyond Task 1.
