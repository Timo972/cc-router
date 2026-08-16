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
per-account bucket-level usage tracking with cooldowns, and a live dashboard
display — adapted to how the Codex backend actually reports limits.

## How Codex limits differ from Anthropic (the key constraint)

Anthropic exposes per-model weekly windows (Sonnet vs Opus) plus a unified
5-hour window and paid extra-usage. The ChatGPT/Codex backend is
**bucket-based** (verified against the Codex CLI's own parser,
`codex-rs/codex-api/src/rate_limits.rs`):

- Every account has a **default `codex` bucket** — the shared agentic pool —
  with a **primary** (5-hour) and a **secondary** (weekly) rolling window. All
  models drain this bucket at model-specific credit rates (GPT-5.6 Sol burns
  roughly 2x Terra and 5x Luna per token), which is why per-model message
  allowances differ even though the pool is shared.
- The backend may additionally report **named metered limit buckets**, each
  with its own primary/secondary windows and a limit name that is a **model
  slug** when the bucket is model-scoped (observed in Codex CLI fixtures:
  limit id `codex_bengalfox`, limit name `gpt-5.2-codex-sonic`). Whether a
  plan defines dedicated buckets for `gpt-5.6-sol` / `-terra` / `-luna` is a
  server-side decision that has changed over time (the 5-hour cap itself was
  removed and restored within July 2026), so the router must **discover
  buckets dynamically** instead of assuming the account-level pair is all
  there is.

Usage arrives on every response as an `x-codex-*` header family. The default
bucket uses unprefixed names (`x-codex-primary-used-percent`,
`x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, and the
`-secondary-*` equivalents); each named bucket repeats the same family under
its limit-id prefix (`x-codex-<limit>-primary-used-percent`, ...,
`x-codex-<limit>-limit-name`). On a usage-limit `429`,
`x-codex-active-limit` names the exhausted bucket. A richer private endpoint
(`https://chatgpt.com/backend-api/wham/usage`, whose payload carries the same
named buckets as `additional_rate_limits[]`) and an in-stream
`codex.rate_limits` event (scoped by `metered_limit_name`) exist but are
**out of scope** for this design (see Non-Goals).

Consequences that shape the whole design:

- "Route by model limits" maps to **routing by bucket headroom**: always the
  account's default bucket, plus the model-scoped bucket matching the
  requested model when one is known.
- Cooldowns are **bucket-scoped when the backend identifies the bucket**: a
  `429` whose `x-codex-active-limit` names a model-scoped bucket cools only
  that bucket (and the models mapped to it); a `429` for the default bucket —
  or with no active-limit header — cools the whole account.
- Codex **does** have an overage concept — credits, reported via
  `x-codex-credits-*` headers — the analog of Anthropic paid extra-usage.
  This design parses and displays credits but does not use them in selection
  (future enhancement).
- The OpenAI pool is still simpler than its Anthropic sibling (no
  ambiguous-cooldown reconciliation, no extra-usage selection tier), but it
  is no longer a fixed two-window model: it tracks a small dynamic set of
  buckets per account.

## Goals

- Keep every healthy Codex/OpenAI session on one account for prompt-cache
  locality, keyed on a stable session identifier.
- Distribute new sessions across usable accounts by live load and bucket
  headroom (the default account bucket, plus the model-scoped bucket matching
  the requested model when one is known).
- Move a session only when its account cannot serve it.
- Parse every `x-codex-*` rate-limit header family on every response — the
  default bucket plus any named metered buckets, discovered dynamically — and
  maintain a per-account, per-bucket in-memory usage snapshot, including a
  learned model-to-bucket mapping.
- On `429`, set a cooldown scoped by `x-codex-active-limit` (bucket-scoped
  when a named bucket is identified, account-global otherwise); on `401`, an
  account-global cooldown. Invalidate affected session affinity, while
  relaying the upstream response byte-for-byte.
- When no account is usable before forwarding, return a local
  OpenAI/Responses-shaped `429` (with `Retry-After`) or `503`, making zero
  upstream requests.
- Track per-account counters (`requestCount`, `errorCount`, `lastUsed`) and feed
  token totals into `ProxyStats`; record activity for success and error paths.
- Render OpenAI accounts on the dashboard: 5-hour and weekly utilization bars
  for the default bucket, one labeled bar per reported named bucket, a credits
  indicator, plan tag, request/error/in-flight/active-session counts, and
  cooldown state.
- Reuse the existing generic session/lease layer without altering Anthropic
  behavior.

## Non-Goals

- Polling the private `wham/usage` endpoint (including its
  `additional_rate_limits[]` payload) or parsing the in-stream
  `codex.rate_limits` event. Header parsing is the only usage source in this
  design; both are noted as future enhancements.
- Using Codex credits (`x-codex-credits-*`) in selection or eligibility;
  credits are parsed and displayed only.
- Predicting or hardcoding which models get dedicated buckets (e.g. Sol,
  Terra, Luna): bucket existence and model mapping are learned entirely from
  live responses, never configured.
- Persisting the learned model-to-bucket mapping across restarts.
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
  and the bucket headroom model (default primary/secondary windows plus any
  named metered buckets). Simpler than the Anthropic pool (no extra-usage
  selection tier, no ambiguous-cooldown reconciliation; cooldowns are
  account-global or bucket-scoped).
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
the Anthropic pool, minus the paid-extra tier (credits exist but are not a
selection input in this design):

1. lowest in-flight request count;
2. fewest active session bindings;
3. greatest remaining rate-limit headroom;
4. round-robin order as the deterministic tie-break.

Headroom is the lower-is-better value
`max(primaryUtil / configuredSessionCap, secondaryUtil / configuredWeeklyCap)`
over the default bucket — joined by `max(bucketPrimaryUtil,
bucketSecondaryUtil)` for the model-scoped bucket matching the requested
model, when the account has learned one — with utilization normalized to
`0..1`. User caps apply to the default bucket only; named buckets cap at
100%. A zero cap makes the account ineligible; missing utilization starts at
zero. The chosen account is bound before
forwarding so simultaneous new sessions cannot all pick the same idle account.
Unscoped requests use the same ranking but create no binding.

### Failover and rebinding

A binding is invalidated when its account becomes disabled, unhealthy, over a
user cap, enters a cooldown that applies to the session's requests
(account-global always; bucket-scoped only when the request's model maps to
the cooling bucket), or returns a `401`/`429` (and `5xx` overload, treated as
a short global cooldown). The failed response is relayed unchanged; the next
client retry selects the best eligible account and rebinds. The router never
retries after upstream response bytes have started.

## Effective Availability

For a request, an OpenAI account is hard-eligible only when all hold:

1. it is enabled and healthy, with a current/refreshable token;
2. it has no active global cooldown;
3. its default-bucket primary (5-hour) window is below 100%;
4. its default-bucket secondary (weekly) window is below 100%;
5. when the requested model maps to a known named bucket on that account:
   the bucket has no active cooldown and both of its windows are below 100%.

Requests whose model has no learned bucket mapping are judged on the default
bucket alone — new or unmapped models never make an account ineligible.

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
reads every `x-codex-*` rate-limit header family and returns a normalized
snapshot keyed by bucket:

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

export interface CodexRateLimits {
  status: "ok" | "rate_limited";
  buckets: Map<string, CodexLimitBucket>; // "codex" always present once seen
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  plan?: string;       // decoded from the account JWT
  lastUpdated: number; // Unix ms, 0 when never observed
}
```

Bucket discovery is dynamic, mirroring the Codex CLI parser
(`codex-rs/codex-api/src/rate_limits.rs`): scan response header names for the
`-primary-used-percent` suffix; the unprefixed `x-codex-*` family is the
default `codex` bucket, and every `x-codex-<limit>-*` family is a named
bucket whose id is normalized to lowercase with `-` mapped to `_`. Per
bucket, read `-{primary,secondary}-used-percent`, `-window-minutes`, and the
reset — `-reset-at` (Unix seconds, current scheme) preferred, with
`-reset-after-seconds` (relative, seen in earlier live captures) as fallback
— plus `x-codex-<limit>-limit-name`. Credits come from
`x-codex-credits-{has-credits,unlimited,balance}`.

Parsing tolerates missing, malformed, negative, and over-100 values without
discarding the whole snapshot; utilization is clamped to `0..1`; timestamps
parse to Unix seconds with `0` on failure. `applyCodexRateLimits(account,
headers)` merges the snapshot onto the account on every response, keeping the
last good values per bucket when a field is absent. Buckets that stop being
reported are retained until their windows reset, then dropped. The header
scheme is still confirmed against a captured live-traffic fixture during
implementation (it has changed across backend revisions).

### Model-to-bucket mapping

Each account keeps a small in-memory map from model slug to bucket id,
learned two ways and never configured:

- a bucket's `limitName` equals a requested model slug
  (case-insensitively, e.g. `gpt-5.6-sol`);
- a usage-limit `429` arrives with `x-codex-active-limit` naming a
  non-default bucket — the request's model maps to that bucket.

The map is bounded, evicts with the bucket, and is used only to pick which
bucket (beyond the default) gates eligibility, headroom, and cooldown scope
for a given request.

### Plan tier

`plan` is decoded from the account access-token JWT claims (the same token
already parsed for `exp` in `device-oauth.ts`); no additional network call.
Live captures have also shown an `x-codex-plan-type` response header, which
may serve as a cross-check but is not required by this design.

### Cooldowns on failure

On a `429`, the cooldown scope comes from `x-codex-active-limit`:

- the header names a **named bucket** -> a **bucket-scoped** cooldown on that
  bucket only; requests for models mapped to other buckets (or unmapped)
  still route to the account;
- the header names the default `codex` bucket, is absent, or is unrecognized
  -> an **account-global** cooldown (the safe default).

On `401` and `5xx` overload the cooldown is always account-global. For `429`
and overload alike the duration is the greatest trustworthy future value
among: numeric `Retry-After`, HTTP-date `Retry-After`, the affected bucket's
`x-codex-*` reset, and the snapshot reset — counting only windows actually
reported exhausted. A `429` with nothing exhausted falls back further, to the
soonest known future window reset, because a quota reset is precisely what it
is waiting for; an overload does not, because a window resetting hours from
now says nothing about how long a service blip lasts. Defaults when nothing
is known: 60s for `429`, 30s for overload; `401` is a flat 30s. Negative,
non-finite, and absurdly-distant values are rejected. There is no ambiguous
reconciliation: each cooldown is scoped exactly once, at set time.

## Account State

Upgrade the OpenAI account from a bare token record to a runtime object
mirroring the Anthropic `Account` (durable fields persisted, routing state in
memory):

- Persisted: `id`, `provider`, `accessToken`, `refreshToken`, `expiresAt`,
  `scopes`, `enabled`, `sessionLimitPercent`, `weeklyLimitPercent`.
- In-memory runtime: `healthy`, `requestCount`, `errorCount`,
  `consecutiveErrors`, `lastUsed`, `lastRefresh`, `rateLimits`
  (`CodexRateLimits`, per-bucket), the model-to-bucket map, a global cooldown
  expiry, and a per-bucket cooldown map.

In-flight counts and lease bookkeeping live in `OpenAITokenPool`, exactly as
in-flight counts live in the Anthropic `TokenPool`.

## Proxy Integration

Both `responses-server.ts` and the `messages-cross-route.ts` OpenAI branch:

1. resolve the session key and a route context (requested model, for logging);
2. acquire a routed lease from the OpenAI `SessionRouter`;
3. refresh the token if near expiry (existing `prepareOpenAIAccountForRequest`);
4. forward to the Codex backend (existing transport);
5. on the upstream response, parse and apply all `x-codex-*` bucket families
   (and update the model-to-bucket map);
6. on `401`/`429`/overload, set the cooldown at its resolved scope
   (bucket-scoped via `x-codex-active-limit`, else account-global) and
   invalidate the binding when the scope applies to the session — the
   upstream status, headers, and body are relayed unchanged;
7. attach one idempotent lease-release to every terminal path
   (`finish`/`close`/error) via `attachLeaseLifecycle`;
8. on completion, increment `requestCount`/`errorCount`/`lastUsed`, capture
   token usage into `ProxyStats`, and record a route activity entry.

When selection throws `NoEligibleAccountError` before any forwarding, return a
local response and make no upstream request:

- `rate_limited` -> HTTP `429` in the OpenAI/Responses error envelope
  (`{ "error": { "type": "rate_limit_exceeded", "message": ... } }`) with a
  numeric `Retry-After` when a reset is known (the earliest reset among the
  buckets that blocked each account);
- `unavailable` -> HTTP `503` (`service_unavailable`);
- empty pool -> existing `503` `no_accounts`.

The local response releases no unacquired lease, creates no binding, and logs a
bounded reason and requested model — never the session key.

## Display

- **Health payload** — replace the hardcoded `publicOpenAIAccountView` zeros
  with real data: `requestCount`, `errorCount`, `inFlightRequests`,
  `activeSessions`, `healthy`, `plan`, a public rate-limit view (every
  reported bucket's utilization/reset, keyed by limit id with its display
  label), a credits summary (`hasCredits`/`unlimited`/balance), and cooldown
  state (global expiry plus any bucket-scoped expiries). Tokens and raw
  headers are never exposed.
- **Dashboard (`Dashboard.tsx`)** — render OpenAI account rows using the
  existing `UtilBar` and `AccountRow` scaffolding: two bars labeled **5h** and
  **weekly** for the default bucket, plus one bar per reported named bucket
  labeled by its limit name (the model slug, e.g. `gpt-5.6-sol`, falling back
  to the limit id) — the OpenAI analog of Anthropic's per-model capacity
  rows, rendered only when the backend reports them. Also the plan tag, a
  credits indicator when reported, `req`/`err`/in-flight/active-session
  counts, and cooldown indicators (global and per-bucket). The existing
  Anthropic rendering is unaffected.

## Components

### `AccountPool` interface (extracted)

- Minimal contract `SessionRouter` needs: `acquireBest(activeSessions, context)`
  and `tryAcquire(accountId, context)` returning a lease with an idempotent
  `release()`. Both `TokenPool` and `OpenAITokenPool` implement it.

### `SessionRouter` (reused, one instance per provider)

- Owns bounded, expiring session-to-account mappings and generation-safe
  invalidation. Now generic over `AccountPool`. Unchanged behavior.

### `OpenAITokenPool` (new)

- Owns per-account in-flight counts, counters, and cooldowns (account-global
  and per-bucket).
- Implements hard eligibility (enabled/healthy/cooldowns/default-bucket
  windows/model-mapped-bucket windows), user-cap tiers,
  `NoEligibleAccountError`/`EmptyPoolError`, and the 4-key selection tuple.
- Provides load and bucket-aware headroom values for selection (requests
  carry the requested model in their route context).

### `providers/openai/usage.ts` (new)

- `parseCodexRateLimits(headers)` (all bucket families + credits) and
  `applyCodexRateLimits(account, headers)`; `resolveActiveLimit(headers)` for
  `x-codex-active-limit`; model-to-bucket mapping helpers; plan decoding
  helper.

### Ingress (`responses-server.ts`, `messages-cross-route.ts`)

- Session-key extraction, lease acquisition, header capture, cooldown/
  invalidation, counters, activity/token logging, and local error responses.

## Observability

Health/account views add OpenAI in-flight and active-session counts, plan,
credits, and all reported buckets. Route logs may record the non-sensitive
selection reason (`sticky`, `new-session`, `unscoped`, `failover`), the
requested model, and — on cooldown — the resolved scope and limit id, never
the session key. Success and error requests are logged to recent activity (they are
invisible today).

## Testing

Unit tests:

- `parseCodexRateLimits`: normal primary/secondary; missing headers; malformed/
  negative/over-100 values; absent reset/window; clamping and timestamp
  parsing; `-reset-at` preferred over `-reset-after-seconds`; named-bucket
  families discovered dynamically (`x-codex-<limit>-*` with `-limit-name`);
  limit-id normalization; a bucket family with no data is not emitted;
  credits headers parse and survive partial absence.
- Model-to-bucket mapping: learned from a `limitName` matching a requested
  model slug and from `x-codex-active-limit` on a `429`; bounded; evicts with
  its bucket; unmapped models fall back to default-bucket-only checks.
- `OpenAITokenPool`: default-bucket primary-exhausted and secondary-exhausted
  exclusion; a model-mapped named bucket at 100% excludes only requests for
  that model while other models still select the account; healthy selection
  by the tuple; global cooldown excludes and expires; bucket-scoped cooldown
  excludes only mapped-model requests and expires; a `429` without
  `x-codex-active-limit` falls back to an account-global cooldown;
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
- `x-codex-*` headers on a fake response — default family plus a named bucket
  family with a model-slug `limit-name` — populate the account snapshot, the
  model-to-bucket map, and the health payload.
- A fake `429` without `x-codex-active-limit` sets a global cooldown,
  invalidates the binding, and is relayed byte-for-byte; the next request
  rebinds to another account.
- A fake `429` with `x-codex-active-limit` naming a named bucket cools only
  that bucket: the next request for the mapped model rebinds elsewhere, while
  a request for a different model still routes to the same account.
- All-blocked before forward returns a local `429` with `Retry-After` and makes
  zero upstream requests; advancing the clock past the reset resumes selection.
- `/v1/messages` with `model: openai/*` uses the same sticky routing via
  `x-claude-code-session-id`.
- Success and error requests increment counters and appear in recent activity;
  token totals reach `ProxyStats`.
- Streaming responses remain byte-for-byte identical downstream; no SSE frame is
  inserted, removed, or rewritten.
- Dashboard rendering: OpenAI rows show 5h + weekly bars, named-bucket bars
  labeled by limit name when reported (and none otherwise), credits, plan,
  counts, and cooldown state; Anthropic rows are unchanged.

The focused tests, full Vitest suite, `npm run lint`, and `npm run build` must
pass.

## Documentation

Update `README.md` (Codex sticky routing + usage), `docs/session-routing.md`
(OpenAI affinity key resolution and bucket model), and `CHANGELOG.md`. State
clearly that Codex usage is bucket-based — a default account-level bucket
(primary 5h / secondary weekly) shared by all models at model-specific burn
rates, plus optional model-scoped metered buckets discovered from live
responses — that cooldowns are account-global or bucket-scoped via
`x-codex-active-limit`, and that usage is derived from response headers only
in this release.

## References

- Codex CLI header/bucket parser (authoritative for the scheme):
  `openai/codex` — `codex-rs/codex-api/src/rate_limits.rs`
  (`parse_all_rate_limits`, dynamic `x-<limit>-primary-used-percent`
  discovery, `x-codex-<limit>-limit-name`, fixture limit name
  `gpt-5.2-codex-sonic`).
- `RateLimitSnapshot { limit_id, limit_name, primary, secondary, credits }`:
  `codex-rs/protocol/src/protocol.rs`.
- `x-codex-active-limit` scoping usage-limit errors to a bucket:
  `codex-rs/codex-api/src/api_bridge.rs`.
- Usage endpoint reporting named buckets as `additional_rate_limits[]`
  (`limit_name` / `metered_feature`):
  `codex-rs/app-server/tests/suite/v2/rate_limits.rs`.
- Sol/Terra/Luna share the default pool at different credit rates (Sol ~2x
  Terra, ~5x Luna); per-model message allowances on Plus; ChatGPT Work and
  Codex share the pool: OpenAI help center "Codex rate card" and "GPT-5.6 in
  ChatGPT" (help.openai.com articles 20001106, 20001354).
