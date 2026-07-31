# Model-Aware Rate-Limit Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Track work
> with the checkbox (`- [ ]`) steps below and preserve RED/GREEN evidence.

**Goal:** Route Claude Code requests only to Anthropic subscription accounts
that can serve the requested model, and stop fallback routing from bypassing
upstream cooldowns or exhausted usage windows.

**Architecture:** Add a bounded, in-memory Anthropic usage snapshot per account,
populated from the same fixed OAuth usage endpoint used by Claude Code and
merged with response-header observations. Normalize requested Anthropic models
into dynamic model families, pass that request context through `SessionRouter`
and `TokenPool`, and split account exclusion into hard upstream availability
versus soft user-configured caps. Replace the current all-unavailable upstream
fallback with a typed local unavailable result carrying the earliest known
retry time. Keep response streaming byte-transparent and retain session
affinity whenever the bound account can serve the requested model.

**Tech Stack:** TypeScript, Node.js 20+, Express 4,
`http-proxy-middleware` 3, native `fetch`, React/Ink, Vitest 4.

## Motivation and Confirmed Failure Mode

The existing router records only unified 5-hour and all-model 7-day
utilization. Anthropic now exposes additional model-scoped weekly limits. An
account can therefore display 67% or 79% weekly utilization while the requested
model family is already at 100%.

The current fallback also selects a healthy account after the eligible set is
empty without reapplying cooldown or upstream rate-limit exclusions. That
causes repeated `new-session:fallback:rate-limited` requests even when
`Retry-After` already proves that the chosen account cannot serve the request.

This plan treats:

- upstream cooldowns and exhausted effective quota as **hard exclusions**;
- disabled, unhealthy, and invalid-auth accounts as **hard exclusions**;
- configured `sessionLimitPercent` and `weeklyLimitPercent` as **soft policy
  caps** that retain the existing explicit cap-bypass fallback;
- model-scoped limits dynamically, without hard-coding the currently observed
  model name.

## Global Constraints

- Never route to an account that is in an applicable upstream cooldown or whose
  effective requested-model allowance is exhausted.
- Never bypass disabled state, authentication failure, or health failure.
- A fallback may bypass only user-configured percentage caps and must continue
  to emit explicit cap-bypass observability.
- When every account is hard-unavailable, make no Anthropic Messages request.
  Return a local Anthropic-shaped error with the earliest trustworthy retry
  time.
- Preserve the original upstream 401/429/529 response unchanged. A local
  all-unavailable response is allowed only before forwarding starts.
- Never retry a request after any upstream response bytes have arrived.
- Keep `selfHandleResponse: false`; do not buffer, rewrite, synthesize, reorder,
  or remove SSE bytes.
- Continue to use one session-to-account binding. Requested-model eligibility
  may invalidate that binding, but model changes do not create parallel
  bindings for the same Claude Code session.
- A model-specific 429 blocks only that model family when the evidence is
  unambiguous. Five-hour, all-model weekly, service-overload, authentication,
  and unknown rate-limit failures remain account-global.
- The OAuth usage endpoint is internal and not a documented public API. Isolate
  it behind a small parser/fetcher, use a fixed Anthropic URL, apply strict
  timeouts and backoff, and degrade to response-header behavior when it is
  unavailable or its schema changes.
- Usage snapshots, cooldowns, and model affinity metadata remain in memory.
  Never persist tokens, usage responses, cooldown maps, or session IDs.
- Never log access tokens, raw OAuth usage payloads, session IDs, or upstream
  error bodies.
- Percentages from the OAuth usage endpoint are normalized from `0..100` into
  the existing internal `0..1` convention.
- Dynamic model scopes from Anthropic are retained even when unknown to this
  version of CC-Router. Unknown requested models use global windows until a
  safe match is available.
- Every production change begins with a focused failing test. No test may call
  the live Anthropic API.
- Focused tests, the full Vitest suite, `npm run lint`, and `npm run build` must
  pass before completion.

## Target Data Contracts

Keep the existing top-level fields for API compatibility and add normalized
detail rather than replacing the current dashboard contract immediately:

```ts
export interface RateLimitWindow {
  utilization: number; // normalized 0..1
  resetAt: number;     // Unix timestamp in seconds, 0 when unknown
}

export interface ModelRateLimit {
  kind: string;        // upstream kind, e.g. "weekly_scoped"
  group: string;       // upstream group, e.g. "weekly"
  modelId?: string;
  modelFamily: string; // normalized lower-case family
  displayName: string;
  utilization: number; // normalized 0..1
  resetAt: number;
  active: boolean;
  severity: string;
}

export interface ExtraUsageState {
  enabled: boolean;
  spendLimitReached: boolean;
  disabledReason?: string;
  utilization?: number; // normalized 0..1
  currency?: string;
  usedMinor?: number;
  limitMinor?: number;
}

export interface AccountUsageSnapshot {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  modelLimits: ModelRateLimit[];
  extraUsage?: ExtraUsageState;
  fetchedAt: number;
  fetchStatus: "fresh" | "stale" | "unavailable";
}

export interface RouteContext {
  requestedModel?: string;
  modelFamily?: string;
}
```

`AccountRateLimits` continues to expose `fiveHourUtil`, `fiveHourReset`,
`sevenDayUtil`, `sevenDayReset`, `claim`, and `status`. Add the usage snapshot
as a nested field so header refreshes can merge global values without deleting
model-scoped data.

## Effective Availability Rules

For a requested route context, an account is hard-eligible only when all of
these are true:

1. It is enabled and healthy, with valid/current credentials.
2. It has no global cooldown.
3. It has no cooldown for the requested model family.
4. Its upstream unified status is not globally rate-limited.
5. Its effective five-hour and all-model weekly windows are below 100%, unless
   extra usage is enabled and still spendable.
6. A matching requested-model window is below 100%, unless extra usage is
   enabled and still spendable.

An exhausted included window is still effective capacity when extra usage is
enabled, not disabled, and has not reached its spend cap. Such an account stays
eligible but ranks behind accounts with included allowance remaining.

After hard eligibility, apply existing user caps:

1. Prefer accounts below `sessionLimitPercent` and `weeklyLimitPercent`.
2. If hard-eligible accounts exist but all exceed only user caps, select the
   least-loaded cap-bypass fallback and log it.
3. If no hard-eligible account exists, throw `NoEligibleAccountError`; never
   choose from cooling or upstream-rate-limited accounts.

The headroom ranking for a request becomes the worst applicable ratio:

```ts
Math.max(
  fiveHourUtil / configuredSessionCap,
  sevenDayUtil / configuredWeeklyCap,
  requestedModelUtil,
  extraUsagePenalty,
)
```

Use `extraUsagePenalty = 1` while paid extra usage is actively required, so
included-capacity accounts win after in-flight and active-session ties.

---

### Task 1: Add Dynamic Usage and Model-Scope Contracts

**Files:**

- Modify: `src/proxy/types.ts`
- Create: `src/providers/anthropic/usage.ts`
- Create: `src/__tests__/anthropic-usage.test.ts`

- [ ] **Step 1: Write failing OAuth usage parsing tests**

Create sanitized fixtures covering:

- a normal five-hour and all-model weekly response;
- a `limits[]` entry with `kind: "weekly_scoped"` and model display name;
- an exhausted scoped limit at 100%;
- a null model ID with a usable display name;
- an unknown future scoped model name;
- enabled extra usage with remaining spend;
- disabled extra usage and a reached spend cap;
- malformed, missing, null, negative, and over-100 percentage fields;
- ISO timestamps with fractional seconds;
- legacy top-level `seven_day_sonnet` / `seven_day_opus` fields when
  `limits[]` is absent.

The parser must return normalized internal data and no raw payload reference.

- [ ] **Step 2: Run the focused test and record RED evidence**

```bash
npm test -- src/__tests__/anthropic-usage.test.ts
```

Expected: FAIL because the usage contracts and parser do not exist.

- [ ] **Step 3: Implement pure schema-tolerant parsing**

In `src/providers/anthropic/usage.ts`, export:

```ts
export function normalizeModelFamily(
  modelIdOrName: string | undefined,
): string | undefined;

export function parseAnthropicUsage(
  value: unknown,
  fetchedAt: number,
): AccountUsageSnapshot | null;
```

Normalization requirements:

- lower-case and trim;
- recognize family tokens such as `fable`, `sonnet`, `opus`, and `haiku`
  inside full model IDs;
- otherwise create a bounded slug from a non-empty display name;
- prefer upstream model ID when present and display name otherwise;
- do not reject an entire response because one optional field is malformed;
- reject a fieldless/non-object response as a whole;
- clamp utilization to `0..1`;
- parse timestamps to Unix seconds and use `0` when invalid.

- [ ] **Step 4: Add exact effective-extra-usage tests**

Add a pure helper:

```ts
export function canUseExtraUsage(
  state: ExtraUsageState | undefined,
): boolean;
```

It returns true only when extra usage is enabled, no spend limit has been
reached, and no disabling reason is present.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npm test -- src/__tests__/anthropic-usage.test.ts
npm run lint
```

- [ ] **Step 6: Commit Task 1**

```bash
git add src/proxy/types.ts src/providers/anthropic/usage.ts src/__tests__/anthropic-usage.test.ts
git commit -m "feat: model Anthropic scoped usage limits"
```

---

### Task 2: Fetch and Refresh Per-Account Usage Safely

**Files:**

- Modify: `src/providers/anthropic/usage.ts`
- Create: `src/providers/anthropic/usage-refresher.ts`
- Create: `src/__tests__/anthropic-usage-refresher.test.ts`
- Modify: `src/proxy/server.ts`

- [ ] **Step 1: Write failing fetcher tests with an injected `fetch`**

Cover:

- fixed `GET https://api.anthropic.com/api/oauth/usage`;
- `Authorization: Bearer <current access token>`;
- required OAuth beta header;
- bounded request timeout;
- 200 parsing;
- 401, 429, 500, timeout, invalid JSON, and schema mismatch;
- no token or response body in thrown/logged messages;
- a replaced account object with the same ID cannot receive a stale result.

- [ ] **Step 2: Implement the isolated fetcher**

Export a dependency-injected function:

```ts
export async function fetchAnthropicUsage(
  account: Account,
  options?: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<UsageFetchResult>;
```

Use a five-second default timeout. Return a discriminated result rather than
throwing expected HTTP/schema failures. Never follow a caller-provided URL.

- [ ] **Step 3: Write failing refresher lifecycle tests**

Use fake clocks and injected fetch results to prove:

- startup refresh is staggered and bounded to two concurrent accounts;
- successful accounts refresh every five minutes;
- failures back off per account through 1, 2, 5, then 15 minutes;
- only one in-flight fetch exists per exact Account object;
- the last good snapshot remains with `fetchStatus: "stale"` after failure;
- a never-successful account becomes `unavailable`;
- adding/removing accounts is picked up from `pool.getAll()` without leaked
  timers;
- `refreshNow(account)` joins an existing in-flight refresh;
- `stop()` prevents future refreshes and is safe to call twice.

- [ ] **Step 4: Implement `AnthropicUsageRefresher`**

The refresher owns scheduling/backoff only. It reads accounts from the pool on
each tick and applies a result only while
`pool.findById(account.id) === account`.

Do not make health polling trigger external requests. Start the refresher from
`startServer`, stop it during graceful shutdown, and let it observe the current
token from the mutable Account object on every fetch.

- [ ] **Step 5: Trigger a single-flight refresh after an upstream 429**

Expose a callback from proxy failure handling to call
`usageRefresher.refreshNow(account)` asynchronously. This improves ambiguous
claim classification without delaying or altering the current 429 response.

Refresh failure must not replace `Retry-After` cooldown state.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- src/__tests__/anthropic-usage.test.ts
npm test -- src/__tests__/anthropic-usage-refresher.test.ts
npm run lint
```

- [ ] **Step 7: Commit Task 2**

```bash
git add src/providers/anthropic/usage.ts src/providers/anthropic/usage-refresher.ts src/__tests__/anthropic-usage-refresher.test.ts src/proxy/server.ts
git commit -m "feat: refresh Anthropic usage snapshots"
```

---

### Task 3: Carry Requested-Model Context Into Session Routing

**Files:**

- Create: `src/proxy/request-model.ts`
- Create: `src/__tests__/request-model.test.ts`
- Modify: `src/proxy/messages-cross-route.ts`
- Modify: `src/proxy/anthropic-routing.ts`
- Modify: `src/proxy/session-router.ts`
- Modify: `src/__tests__/anthropic-routing.test.ts`
- Modify: `src/__tests__/session-router.test.ts`

- [ ] **Step 1: Write failing request-model extraction tests**

Cover:

- full Anthropic model IDs;
- configured Anthropic aliases;
- `claude/<alias>` references;
- absent or non-string `model`;
- unknown future models;
- OpenAI-routed messages never reach Anthropic account selection;
- the original raw request body remains byte-identical for Anthropic proxying.

- [ ] **Step 2: Implement request context without reparsing the body**

`mountMessagesCrossProviderRoute` already uses `express.json()` and saves
`_ccRawBody` before the Anthropic routing middleware runs. For Anthropic-bound
requests, derive and attach:

```ts
declare module "express-serve-static-core" {
  interface Request {
    _ccRawBody?: Buffer;
    _ccRouteContext?: RouteContext;
  }
}
```

Use `parseModelRef(...).upstreamModel` followed by
`normalizeModelFamily(...)`. Do not add another body parser and do not rewrite
`_ccRawBody`.

- [ ] **Step 3: Pass route context through routing APIs**

Change the contracts to:

```ts
SessionRouter.acquire(sessionHeader: unknown, context?: RouteContext): RoutedAccountLease;
TokenPool.acquireBest(activeSessions: ReadonlyMap<string, number>, context?: RouteContext): AccountLease;
TokenPool.tryAcquire(accountId: string, context?: RouteContext): AccountLease | null;
```

Include a bounded `modelFamily` on scoped and unscoped routed leases for
failure classification and safe logging. Do not include the session ID in any
log-facing summary.

- [ ] **Step 4: Preserve one binding across model changes when possible**

Add tests proving:

- the same session stays on its bound account when both requested models are
  available;
- a model change rebinds only when the bound account is hard-ineligible for
  the new model;
- returning to the previous model uses the current binding if eligible rather
  than resurrecting historical bindings;
- unscoped requests use model-aware selection without creating affinity.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- src/__tests__/request-model.test.ts
npm test -- src/__tests__/anthropic-routing.test.ts
npm test -- src/__tests__/session-router.test.ts
npm run lint
```

- [ ] **Step 6: Commit Task 3**

```bash
git add src/proxy/request-model.ts src/proxy/messages-cross-route.ts src/proxy/anthropic-routing.ts src/proxy/session-router.ts src/__tests__/request-model.test.ts src/__tests__/anthropic-routing.test.ts src/__tests__/session-router.test.ts
git commit -m "feat: carry model context through session routing"
```

---

### Task 4: Make TokenPool Eligibility Model-Aware

**Files:**

- Modify: `src/proxy/token-pool.ts`
- Modify: `src/__tests__/token-pool.test.ts`

- [ ] **Step 1: Add failing hard-eligibility tests**

Test each rule independently:

- an exhausted matching model scope excludes an account;
- an exhausted unrelated model scope does not exclude it;
- an unknown request model uses global windows only;
- exhausted global five-hour or weekly capacity excludes every model;
- usable extra usage keeps an otherwise exhausted account eligible;
- reached/disabled extra usage does not;
- fresh usage snapshot values override older global header values;
- stale snapshots remain usable as conservative evidence until their reset,
  while unavailable snapshots fall back to current response headers;
- a reset timestamp in the past rolls the matching window over;
- non-finite/malformed utilization never produces `NaN` ranking.

- [ ] **Step 2: Add failing hard-versus-soft fallback tests**

Required cases:

```ts
it("may bypass only user caps when hard capacity remains", () => {});
it("never falls back to a globally cooling account", () => {});
it("never falls back to an account cooling for the requested model", () => {});
it("can use a model-cooling account for a different model", () => {});
it("never falls back to an upstream rate-limited account", () => {});
it("returns the earliest applicable unblock time when all accounts are hard-blocked", () => {});
```

- [ ] **Step 3: Introduce a typed no-eligible result**

Add:

```ts
export class NoEligibleAccountError extends Error {
  readonly reason: "rate_limited" | "unavailable";
  readonly retryAtMs?: number;
  readonly blockedAccounts: number;
}
```

Do not place account IDs or raw upstream claims in the public error message.
Keep `EmptyPoolError` for a truly empty configured pool.

- [ ] **Step 4: Split selection into explicit tiers**

Refactor `acquireBest`:

1. Sweep expired global/model cooldowns and usage windows.
2. Build `hardEligible`.
3. From that set, build `withinUserCaps`.
4. Select normally from `withinUserCaps`.
5. If only `hardEligible` remains, select a cap-bypass fallback and invoke
   `onCapBypass`.
6. If `hardEligible` is empty, throw `NoEligibleAccountError`.

Delete the current fallback candidate path that broadens selection to cooling,
rate-limited, disabled, or unhealthy accounts. Stop using legacy `account.busy`
as an eligibility signal; health views may continue deriving `busy` from
explicit cooldown state for compatibility.

- [ ] **Step 5: Add requested-model headroom ranking**

Retain ordering by:

1. fewest in-flight requests;
2. fewest bound sessions;
3. greatest effective requested-model/global headroom;
4. rotating account order.

Accounts actively using paid extra usage rank behind equal-load accounts with
included quota.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- src/__tests__/token-pool.test.ts
npm run lint
```

- [ ] **Step 7: Commit Task 4**

```bash
git add src/proxy/token-pool.ts src/__tests__/token-pool.test.ts
git commit -m "fix: enforce model-aware hard routing limits"
```

---

### Task 5: Add Scoped Cooldowns and Current-Claim Classification

**Files:**

- Modify: `src/proxy/token-pool.ts`
- Modify: `src/proxy/lease-lifecycle.ts`
- Modify: `src/proxy/server.ts`
- Modify: `src/__tests__/lease-lifecycle.test.ts`
- Modify: `src/__tests__/token-pool.test.ts`

- [ ] **Step 1: Write failing global/model cooldown tests**

Cover:

- account-global cooldown blocks every model;
- model cooldown blocks only the normalized matching family;
- repeated cooldown writes extend but never shorten an expiry;
- expiration removes exactly the matching cooldown;
- account removal and same-ID replacement cannot inherit old cooldown state;
- health metrics report the earliest applicable cooldown without exposing
  internal keys.

- [ ] **Step 2: Replace one cooldown map with scoped state**

Use exact Account object identity protection and an internal shape equivalent
to:

```ts
interface AccountCooldowns {
  globalUntil: number;
  modelUntil: Map<string, number>;
}
```

Expose:

```ts
setGlobalCooldownForAccount(account: Account, durationMs: number): void;
setModelCooldownForAccount(account: Account, modelFamily: string, durationMs: number): void;
getApplicableCooldownUntil(accountId: string, context?: RouteContext): number;
```

Keep the old `setCooldown` wrapper temporarily for compatibility and make it
global.

- [ ] **Step 3: Write failing representative-claim classification tests**

Pass these headers plus the failed route context into failure handling:

- `five_hour` -> global;
- `seven_day` -> global;
- `seven_day_oauth_apps` -> global;
- `seven_day_sonnet` / `seven_day_opus` -> named model family;
- another future `seven_day_<family>` -> normalized model family;
- `seven_day_overage_included` with a matching exhausted usage snapshot ->
  requested model family;
- `seven_day_overage_included` without matching evidence -> global;
- empty/unknown claim -> global;
- 529 -> global 30-second cooldown;
- 401 invalidates affinity but does not create a rate-limit cooldown.

- [ ] **Step 4: Parse retry timing defensively**

Use the greatest trustworthy future expiry from:

- numeric `Retry-After`;
- HTTP-date `Retry-After`;
- `anthropic-ratelimit-unified-reset`;
- the matching usage snapshot reset.

Fall back to 60 seconds for a 429 and 30 seconds for a 529. Reject negative,
non-finite, and unreasonably distant malformed values without overflowing.

- [ ] **Step 5: Reconcile ambiguous cooldown after usage refresh**

When a post-429 usage refresh proves that:

- the global five-hour and weekly windows still have capacity;
- the requested model scope is exhausted; and
- extra usage cannot serve it,

replace an ambiguity-created global cooldown with a requested-model cooldown
using the same or later expiry. Never broaden a model cooldown based only on a
failed usage refresh.

- [ ] **Step 6: Preserve response passthrough**

Integration assertions must prove the original 429 status, headers, and body
remain byte-identical while only next-request routing state changes.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- src/__tests__/lease-lifecycle.test.ts
npm test -- src/__tests__/token-pool.test.ts
npm test -- src/__tests__/anthropic-proxy.test.ts
npm run lint
```

- [ ] **Step 8: Commit Task 5**

```bash
git add src/proxy/token-pool.ts src/proxy/lease-lifecycle.ts src/proxy/server.ts src/__tests__/lease-lifecycle.test.ts src/__tests__/token-pool.test.ts src/__tests__/anthropic-proxy.test.ts
git commit -m "feat: scope Anthropic cooldowns by model"
```

---

### Task 6: Return a Local Earliest-Retry Response Instead of a Doomed Fallback

**Files:**

- Modify: `src/proxy/anthropic-routing.ts`
- Modify: `src/proxy/server.ts`
- Modify: `src/proxy/stats.ts`
- Modify: `src/__tests__/anthropic-routing.test.ts`
- Modify: `src/__tests__/anthropic-proxy.test.ts`

- [ ] **Step 1: Add failing middleware response tests**

Prove:

- no upstream connection is made when every applicable account is cooling;
- all-rate-limited returns HTTP 429;
- `Retry-After` is the ceiling of the earliest known unblock time;
- the body follows Anthropic's error envelope;
- all-disabled/all-unhealthy with no retry time returns 503;
- an empty pool retains the existing 503 `no_accounts` behavior;
- the local response releases no unacquired lease and creates no session
  binding;
- local errors log a bounded reason and requested model family, never a session
  ID.

- [ ] **Step 2: Map `NoEligibleAccountError` before refresh/proxying**

Return:

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "All configured accounts are unavailable for the requested model"
  }
}
```

For rate-limited cases, set numeric `Retry-After` when known. Do not synthesize
Anthropic-private utilization headers. Use 503 with `service_unavailable` when
there is no rate-limit reset to wait for.

- [ ] **Step 3: Keep client retries bounded**

Do not create a new affinity binding for the rejected local request. A retry
after the earliest cooldown expires must run normal selection and bind once.

- [ ] **Step 4: Add full production-stack tests**

Use local upstream servers to cover:

- one Fable-blocked account and one available account selects the latter;
- all Fable-blocked accounts produce local 429 and zero upstream requests;
- a Sonnet request can still use an account with only a Fable cooldown;
- a global five-hour cooldown blocks both;
- cap-only fallback still forwards and is marked `fallback`;
- successful and failed SSE responses remain byte-transparent.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- src/__tests__/anthropic-routing.test.ts
npm test -- src/__tests__/anthropic-proxy.test.ts
npm run lint
```

- [ ] **Step 6: Commit Task 6**

```bash
git add src/proxy/anthropic-routing.ts src/proxy/server.ts src/proxy/stats.ts src/__tests__/anthropic-routing.test.ts src/__tests__/anthropic-proxy.test.ts
git commit -m "fix: stop fallback routing to blocked accounts"
```

---

### Task 7: Expose Model Limits and Cooldown Reasons Safely

**Files:**

- Modify: `src/proxy/server.ts`
- Modify: `src/ui/Dashboard.tsx`
- Modify: `src/ui/accountsApi.ts`
- Modify: `src/__tests__/server-health-accounts.test.ts`
- Modify: `src/__tests__/accounts-api.test.ts`
- Modify: `src/__tests__/dashboard-model-window.test.ts`

- [ ] **Step 1: Add failing safe-view tests**

The detailed authenticated account view should expose:

- global five-hour/all-model weekly values;
- dynamic model limit display name, utilization, reset, active state, and
  severity;
- extra-usage enabled/spend-limit state;
- snapshot freshness and last successful fetch time;
- global cooldown-until and bounded model cooldown summaries.

It must not expose:

- access/refresh tokens;
- raw OAuth payloads;
- session IDs or binding generations;
- raw upstream claims beyond bounded normalized categories.

The unauthenticated health response remains only `{status}`.

- [ ] **Step 2: Render dynamic model rows**

Under each Anthropic account, render model-scoped limits returned by the server
rather than a hard-coded Sonnet/Fable row. Visually distinguish:

- included capacity available;
- paid extra usage active;
- exhausted scope;
- stale/unavailable usage data;
- global cooldown versus requested-model cooldown.

Keep the current two-line account view compact when no model-scoped data exists.

- [ ] **Step 3: Correct misleading status text**

Replace any implication that a low all-model weekly percentage guarantees
availability. A 429 activity row should include the normalized limiting scope
when known, for example `rate-limited:model:fable`, without account token or
session data.

- [ ] **Step 4: Run focused UI/API tests**

```bash
npm test -- src/__tests__/server-health-accounts.test.ts
npm test -- src/__tests__/accounts-api.test.ts
npm test -- src/__tests__/dashboard-model-window.test.ts
npm run lint
```

- [ ] **Step 5: Commit Task 7**

```bash
git add src/proxy/server.ts src/ui/Dashboard.tsx src/ui/accountsApi.ts src/__tests__/server-health-accounts.test.ts src/__tests__/accounts-api.test.ts src/__tests__/dashboard-model-window.test.ts
git commit -m "feat: show model-scoped account capacity"
```

---

### Task 8: Documentation and Full Regression Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/session-routing.md`
- Modify: `docs/troubleshooting.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the operational routing contract**

Document:

- session affinity remains account-based;
- requested model affects account eligibility;
- dynamic model-scoped weekly limits;
- hard upstream exclusions versus soft configured caps;
- a cap-only fallback may still occur;
- cooldown/rate-limit fallback never occurs;
- local 429 behavior and `Retry-After`;
- usage snapshot freshness and graceful degradation;
- the internal OAuth usage endpoint dependency.

- [ ] **Step 2: Correct contradictory existing language**

The current docs call configured caps both hard and advisory. State the final
behavior precisely: configured caps are soft only in the explicit all-capped
fallback, while Anthropic cooldowns and effective quota exhaustion are always
hard.

- [ ] **Step 3: Add troubleshooting guidance**

Explain that overall weekly utilization can remain below 100% while a requested
model scope is exhausted. Direct users to the model-scoped dashboard row and
the earliest reset instead of suggesting that every 429 is requests-per-minute
throttling.

- [ ] **Step 4: Run complete verification**

```bash
npm test
npm run lint
npm run build
git diff --check
git status --short
```

Expected:

- all tests pass;
- TypeScript emits no errors;
- production build succeeds;
- no warnings, unhandled rejections, timer leaks, real Anthropic calls, or
  whitespace errors;
- only intended files are modified.

- [ ] **Step 5: Manually exercise a local deterministic scenario**

With a local fake Anthropic upstream:

1. Seed account A with exhausted requested-model capacity.
2. Seed account B with available requested-model capacity.
3. Confirm the first request selects B.
4. Hard-block B globally and confirm the next request returns local 429.
5. Confirm the fake upstream request count does not increase.
6. Advance the clock past the earliest reset.
7. Confirm selection resumes and a new session binding is created.

Do not use real subscription credentials for this verification.

- [ ] **Step 6: Commit Task 8**

```bash
git add README.md docs/session-routing.md docs/troubleshooting.md CHANGELOG.md
git commit -m "docs: explain model-aware rate-limit routing"
```

## Final Acceptance Criteria

- An account at 100% for the requested model is never selected unless usable
  extra usage can actually serve the request.
- Exhaustion of one model family does not block an unrelated model when global
  capacity remains.
- A global five-hour/all-model limit blocks every model for that account.
- Fallback never selects a cooling, upstream-rate-limited, disabled, unhealthy,
  or invalid-auth account.
- Fallback may bypass only configured percentage caps, with explicit
  observability.
- When all accounts are hard-blocked, CC-Router returns one local error with
  the earliest known retry time and makes zero upstream Messages requests.
- Session affinity survives model changes whenever the bound account remains
  eligible.
- Original upstream responses and SSE streams remain byte-transparent.
- Dashboard/API users can see the model-scoped limit that explains a 429.
- The router continues to function from response-header state when the internal
  OAuth usage endpoint is unavailable.
