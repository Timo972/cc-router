# OpenAI/Codex Sticky Routing, Usage Tracking, and Display Design

## Problem

CC-Router's Anthropic path is a mature router: it pins each Claude Code
session to one account for prompt-cache locality, selects new sessions by live
load and rate-limit headroom, tracks per-account usage from response headers and
a polled usage endpoint, sets scoped cooldowns on `429`, and renders all of this
on the live dashboard.

The OpenAI/Codex path is none of that. It is a stateless, module-closure
round-robin forwarder shared by both `/v1/responses` (Codex CLI) and the
`/v1/messages` OpenAI cross-route branch. It never reads a session identifier,
never inspects upstream rate-limit headers, takes no action on a `429` (the
response is piped through and the account is left untouched), does not track
per-account usage or counters, and reports hardcoded zeros to the health view —
so the dashboard shows only an `[OpenAI]` tag with no bars, no counts, and no
limits.

The goal is to bring the OpenAI/Codex path to Anthropic-level behavior:
cache-aware sticky session routing, load- and headroom-aware selection,
account-level usage tracking with cooldowns, and a live dashboard display —
adapted to how the Codex backend actually reports limits.

## How Codex limits differ from Anthropic (the key constraint)

Anthropic exposes per-model weekly windows (Sonnet vs Opus) plus a unified
5-hour window and paid extra-usage. The ChatGPT/Codex backend does **not**. It
reports two **account-level** rolling windows, shared across all models:

- a **primary** window (5-hour), and
- a **secondary** window (weekly).

These arrive on responses as an `x-codex-*` header family
(`x-codex-primary-used-percent`, `x-codex-secondary-used-percent`, and related
reset/window headers). A richer private endpoint
(`https://chatgpt.com/backend-api/wham/usage`) and an in-stream
`codex.rate_limits` event exist but are **out of scope** for this design (see
Non-Goals).

Consequences that shape the whole design:

- "Route by model limits" maps to **routing by each account's primary/secondary
  headroom**, not by per-model windows.
- There are **no per-model cooldowns**, **no extra/overage usage**, and **no
  ambiguous-cooldown reconciliation**. Cooldowns are **account-global**.
- The OpenAI pool is therefore materially simpler than its Anthropic sibling.

## Goals

- Keep every healthy Codex/OpenAI session on one account for prompt-cache
  locality, keyed on a stable session identifier.
- Distribute new sessions across usable accounts by live load and
  primary/secondary rate-limit headroom.
- Move a session only when its account cannot serve it.
- Parse Codex `x-codex-*` rate-limit headers on every response and maintain a
  per-account, in-memory usage snapshot.
- On `429`/`401`, set an account-global cooldown and invalidate session
  affinity, while relaying the upstream response byte-for-byte.
- When no account is usable before forwarding, return a local
  OpenAI/Responses-shaped `429` (with `Retry-After`) or `503`, making zero
  upstream requests.
- Track per-account counters (`requestCount`, `errorCount`, `lastUsed`) and feed
  token totals into `ProxyStats`; record activity for success and error paths.
- Render OpenAI accounts on the dashboard: 5-hour and weekly utilization bars,
  plan tag, request/error/in-flight/active-session counts, and cooldown state.
- Reuse the existing generic session/lease layer without altering Anthropic
  behavior.

## Non-Goals

- Polling the private `wham/usage` endpoint or parsing the in-stream
  `codex.rate_limits` event. Header parsing is the only usage source in this
  design; both are noted as future enhancements.
- Per-model weekly windows, extra/overage usage, or model-scoped cooldowns for
  OpenAI (Codex limits are account-level).
- Modifying, normalizing, buffering, reordering, or synthesizing Codex SSE
  bytes. Streaming stays byte-transparent.
- Retrying a partially delivered response on another account.
- Persisting affinity mappings, cooldowns, or usage snapshots across restarts.
- Changing Anthropic routing, selection, cooldown, or display behavior beyond
  the mechanical interface extraction described below.

## Architecture

Keep the existing two-layer split and add a Codex-specific pool underneath a
reused session layer:

- **Generic session/lease layer** — `SessionRouter` and `lease-lifecycle.ts`
  are already provider-neutral (`lease-lifecycle.ts` is typed over
  `TAccount extends { id: string }`). Extract a minimal `AccountPool` interface
  that `SessionRouter` depends on, then run a **second `SessionRouter`
  instance** for OpenAI with its own binding map. No cross-provider key
  collisions; the proven affinity/TTL/LRU/generation-invalidation logic is
  reused unchanged.
- **`OpenAITokenPool`** — a new pool that implements the same `AccountPool`
  interface as the Anthropic `TokenPool` but encodes Codex-specific eligibility
  and the two-window (primary/secondary) headroom model. Simpler than the
  Anthropic pool (global-only cooldowns, no model/extra-usage tiers).
- **Anthropic path unchanged** — its `TokenPool` and `SessionRouter` usage are
  untouched aside from `SessionRouter` now depending on the extracted
  `AccountPool` interface (which `TokenPool` already satisfies structurally).

Both OpenAI ingress paths — `/v1/responses` and the `/v1/messages` OpenAI
branch — route through the same OpenAI `SessionRouter` + `OpenAITokenPool`,
replacing the shared round-robin picker.

## Routing Model

### Session identity

The OpenAI affinity key is resolved by `extractCodexSessionKey(request, body)`
in priority order:

1. the inbound Codex `session_id` header (`/v1/responses`);
2. the `x-claude-code-session-id` header (`/v1/messages` cross-routing);
3. the request body `prompt_cache_key` (Codex thread id — stable per
   conversation);
4. otherwise the request is **unscoped**: load-aware selection with no binding.

Keys are normalized with the existing rules: non-empty trimmed string, `<= 256`
UTF-8 bytes; ambiguous/duplicated headers are ignored. Keys are never logged or
persisted.

The OpenAI `SessionRouter` stores only an in-memory
`session key -> account id + last-seen` mapping, with the same defaults as the
Anthropic router: 1-hour inactivity TTL, 10,000-entry cap, LRU eviction, and a
per-binding generation counter for safe invalidation.

### Existing sessions

If a session has a binding and the bound account is still enabled, healthy,
below its configured caps, and outside cooldown, the router reuses that account
(`tryAcquire`). Cache affinity takes priority over load balancing; an account's
current in-flight count does not break an existing binding.

### New and unscoped sessions

Eligible accounts (see Effective Availability) are ranked by the same tuple as
the Anthropic pool, minus the paid-extra tier (Codex has no overage concept):

1. lowest in-flight request count;
2. fewest active session bindings;
3. greatest remaining rate-limit headroom;
4. round-robin order as the deterministic tie-break.

Headroom is the lower-is-better value
`max(primaryUtil / configuredSessionCap, secondaryUtil / configuredWeeklyCap)`,
with utilization normalized to `0..1`. A zero cap makes the account ineligible;
missing utilization starts at zero. The chosen account is bound before
forwarding so simultaneous new sessions cannot all pick the same idle account.
Unscoped requests use the same ranking but create no binding.

### Failover and rebinding

A binding is invalidated when its account becomes disabled, unhealthy, over a
user cap, enters cooldown, or returns a `401`/`429` (and `5xx` overload, treated
as a short global cooldown). The failed response is relayed unchanged; the next
client retry selects the best eligible account and rebinds. The router never
retries after upstream response bytes have started.

## Effective Availability

For a request, an OpenAI account is hard-eligible only when all hold:

1. it is enabled and healthy, with a current/refreshable token;
2. it has no active global cooldown;
3. its primary (5-hour) window is below 100%;
4. its secondary (weekly) window is below 100%.

After hard eligibility, apply user caps (`sessionLimitPercent`,
`weeklyLimitPercent`) exactly as Anthropic does: prefer accounts within caps; if
hard-eligible accounts exist but all exceed only user caps, select the
least-loaded cap-bypass fallback and log it; if no hard-eligible account exists,
throw `NoEligibleAccountError` carrying `reason` (`rate_limited` |
`unavailable`) and the earliest known `retryAtMs`. `EmptyPoolError` remains for a
truly empty configured pool.

## Usage Tracking

### Source and parsing

`parseCodexRateLimits(headers)` (pure, in `src/providers/openai/usage.ts`)
reads the `x-codex-*` header family and returns a normalized snapshot:

```ts
export interface CodexRateWindow {
  utilization: number; // normalized 0..1 (from used-percent / 100)
  resetAt: number;     // Unix seconds, 0 when unknown
  windowSeconds: number; // window size when reported, 0 when unknown
}

export interface CodexRateLimits {
  status: "ok" | "rate_limited";
  primary?: CodexRateWindow;   // 5-hour window
  secondary?: CodexRateWindow; // weekly window
  plan?: string;               // decoded from the account JWT
  lastUpdated: number;         // Unix ms, 0 when never observed
}
```

Parsing tolerates missing, malformed, negative, and over-100 values without
discarding the whole snapshot; utilization is clamped to `0..1`; timestamps
parse to Unix seconds with `0` on failure. `applyCodexRateLimits(account,
headers)` merges the snapshot onto the account on every response, keeping the
last good values when a field is absent. Exact header key names beyond
`x-codex-primary-used-percent` / `x-codex-secondary-used-percent` are confirmed
against a captured live-traffic fixture during implementation.

### Plan tier

`plan` is decoded from the account access-token JWT claims (the same token
already parsed for `exp` in `device-oauth.ts`); no additional network call.

### Cooldowns on failure

On `401`/`429`/overload, a single **global** cooldown is set on the account. Its
duration is the greatest trustworthy future value among: numeric `Retry-After`,
HTTP-date `Retry-After`, the matching `x-codex-*` reset, and the snapshot reset;
default 60s for `429` and 30s for overload. Negative, non-finite, and
absurdly-distant values are rejected. There is no model scope and no ambiguous
reconciliation.

## Account State

Upgrade the OpenAI account from a bare token record to a runtime object
mirroring the Anthropic `Account` (durable fields persisted, routing state in
memory):

- Persisted: `id`, `provider`, `accessToken`, `refreshToken`, `expiresAt`,
  `scopes`, `enabled`, `sessionLimitPercent`, `weeklyLimitPercent`.
- In-memory runtime: `healthy`, `requestCount`, `errorCount`,
  `consecutiveErrors`, `lastUsed`, `lastRefresh`, `rateLimits`
  (`CodexRateLimits`), and a global cooldown expiry.

In-flight counts and lease bookkeeping live in `OpenAITokenPool`, exactly as
in-flight counts live in the Anthropic `TokenPool`.

## Proxy Integration

Both `responses-server.ts` and the `messages-cross-route.ts` OpenAI branch:

1. resolve the session key and a route context (requested model, for logging);
2. acquire a routed lease from the OpenAI `SessionRouter`;
3. refresh the token if near expiry (existing `prepareOpenAIAccountForRequest`);
4. forward to the Codex backend (existing transport);
5. on the upstream response, parse and apply `x-codex-*` headers;
6. on `401`/`429`/overload, set the global cooldown and invalidate the binding —
   the upstream status, headers, and body are relayed unchanged;
7. attach one idempotent lease-release to every terminal path
   (`finish`/`close`/error) via `attachLeaseLifecycle`;
8. on completion, increment `requestCount`/`errorCount`/`lastUsed`, capture
   token usage into `ProxyStats`, and record a route activity entry.

When selection throws `NoEligibleAccountError` before any forwarding, return a
local response and make no upstream request:

- `rate_limited` -> HTTP `429` in the OpenAI/Responses error envelope
  (`{ "error": { "type": "rate_limit_exceeded", "message": ... } }`) with a
  numeric `Retry-After` when a reset is known;
- `unavailable` -> HTTP `503` (`service_unavailable`);
- empty pool -> existing `503` `no_accounts`.

The local response releases no unacquired lease, creates no binding, and logs a
bounded reason and requested model — never the session key.

## Display

- **Health payload** — replace the hardcoded `publicOpenAIAccountView` zeros
  with real data: `requestCount`, `errorCount`, `inFlightRequests`,
  `activeSessions`, `healthy`, `plan`, a public rate-limit view (primary +
  secondary utilization/reset), and cooldown-until. Tokens and raw headers are
  never exposed.
- **Dashboard (`Dashboard.tsx`)** — render OpenAI account rows using the
  existing `UtilBar` and `AccountRow` scaffolding: two bars labeled **5h** and
  **weekly**, the plan tag, `req`/`err`/in-flight/active-session counts, and a
  cooldown indicator. OpenAI rows show no per-model capacity rows (none exist).
  The existing Anthropic rendering is unaffected.

## Components

### `AccountPool` interface (extracted)

- Minimal contract `SessionRouter` needs: `acquireBest(activeSessions, context)`
  and `tryAcquire(accountId, context)` returning a lease with an idempotent
  `release()`. Both `TokenPool` and `OpenAITokenPool` implement it.

### `SessionRouter` (reused, one instance per provider)

- Owns bounded, expiring session-to-account mappings and generation-safe
  invalidation. Now generic over `AccountPool`. Unchanged behavior.

### `OpenAITokenPool` (new)

- Owns per-account in-flight counts, counters, and global cooldowns.
- Implements hard eligibility (enabled/healthy/cooldown/primary/secondary),
  user-cap tiers, `NoEligibleAccountError`/`EmptyPoolError`, and the 4-key
  selection tuple.
- Provides load and headroom values for selection.

### `providers/openai/usage.ts` (new)

- `parseCodexRateLimits(headers)` and `applyCodexRateLimits(account, headers)`;
  plan decoding helper.

### Ingress (`responses-server.ts`, `messages-cross-route.ts`)

- Session-key extraction, lease acquisition, header capture, cooldown/
  invalidation, counters, activity/token logging, and local error responses.

## Observability

Health/account views add OpenAI in-flight and active-session counts, plan, and
the two windows. Route logs may record the non-sensitive selection reason
(`sticky`, `new-session`, `unscoped`, `failover`) and requested model, never the
session key. Success and error requests are logged to recent activity (they are
invisible today).

## Testing

Unit tests:

- `parseCodexRateLimits`: normal primary/secondary; missing headers; malformed/
  negative/over-100 values; absent reset/window; clamping and timestamp parsing.
- `OpenAITokenPool`: primary-exhausted and secondary-exhausted exclusion;
  healthy selection by the tuple; global cooldown excludes and expires;
  user-cap-only fallback is marked and logged; `NoEligibleAccountError` reason
  and `retryAtMs`; lease release is idempotent and never negative.
- OpenAI `SessionRouter` behavior via the shared router over the OpenAI pool:
  repeated keys retain the account; new sessions distribute across idle
  accounts; a valid binding survives unrelated load; disabled/unhealthy/capped/
  cooling/failed accounts rebind; unscoped requests are load-aware but not
  sticky; expired/excess mappings evict without logging keys.
- Cooldown duration parsing from `Retry-After` / `x-codex-*` reset with defaults
  and bounds.

Integration tests (local fake Codex upstream, never live):

- `/v1/responses` pins a session to one account across turns; a different
  session uses a separate idle account.
- `x-codex-*` headers on a fake response populate the account snapshot and the
  health payload.
- A fake `429` sets a global cooldown, invalidates the binding, and is relayed
  byte-for-byte; the next request rebinds to another account.
- All-blocked before forward returns a local `429` with `Retry-After` and makes
  zero upstream requests; advancing the clock past the reset resumes selection.
- `/v1/messages` with `model: openai/*` uses the same sticky routing via
  `x-claude-code-session-id`.
- Success and error requests increment counters and appear in recent activity;
  token totals reach `ProxyStats`.
- Streaming responses remain byte-for-byte identical downstream; no SSE frame is
  inserted, removed, or rewritten.
- Dashboard rendering: OpenAI rows show 5h + weekly bars, plan, counts, and
  cooldown state; Anthropic rows are unchanged.

The focused tests, full Vitest suite, `npm run lint`, and `npm run build` must
pass.

## Documentation

Update `README.md` (Codex sticky routing + usage), `docs/session-routing.md`
(OpenAI affinity key resolution and account-level windows), and `CHANGELOG.md`.
State clearly that Codex limits are account-level (primary 5h / secondary
weekly), that cooldowns are global, and that usage is derived from response
headers only in this release.
