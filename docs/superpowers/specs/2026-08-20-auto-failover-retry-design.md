# Automatic 429 failover and 5xx retry

**Date:** 2026-08-20
**Status:** Implemented alongside this spec

## Problem

Today CC-Router passes upstream 429/5xx responses through unchanged and relies
on the client to retry. That works, but wastes a full client round-trip per
failure, and some clients give up: an unattended overnight Claude session has
been stopped by a single Anthropic 500 that a router-side retry would have
absorbed. With multiple accounts configured, a 429 on account A is not a
reason to fail the request at all — account B is sitting idle.

## Behavior

For every proxied model request (Claude `/v1/messages`, Codex `/v1/responses`,
and cross-routed `/v1/messages` → Codex), when the upstream answers **429 or
any 5xx** and **no response bytes have been relayed to the client yet**, the
router retries the request itself instead of passing the failure through:

- **At most 3 upstream attempts** per client request.
- Every failed attempt runs the **exact same bookkeeping** a passed-through
  failure runs today: rate-limit header capture, cooldowns
  (`applyUpstreamFailureRoutingDetailed` / `applyCodexFailureRouting`), sticky
  binding invalidation, account error counters, an activity log entry, and —
  on the Anthropic path — the ambiguous-429 usage-refresh reconcile.
- **429 → failover:** the retry must land on a *different* account. The
  cooldown set by the failure bookkeeping already excludes the failed account
  from re-acquisition; an explicit same-account guard relays the original
  response if that invariant is ever violated. No delay between attempts.
- **5xx → retry:** re-acquisition follows each provider's existing routing
  rules. A 5xx the provider's failure routing treats as an overload (Anthropic
  529; Codex 503 and 529) takes the overload cooldown and invalidates the
  binding, so the retry fails over to a different account with no delay. Any
  other 5xx takes no cooldown and keeps the sticky binding, so a
  session-bound retry lands on the *same* account after a 500 ms abort-aware
  delay — on the Anthropic path that includes 503, which Anthropic does not
  use as its overload signal (529 is). A session-less request has no binding
  to preserve: its retry re-routes the way a fresh request would, and because
  the failed attempt's lease still counts as in-flight load, that typically
  selects an idle different account with no delay — the same account the
  client's own retry would have reached back when the failure was passed
  through. The pause applies exactly when the pool hands the same account
  back (single account, or everything else busier or blocked).
- **Pass-through remains the fallback:** if re-acquisition throws
  `NoEligibleAccountError`/`EmptyPoolError`, the new account's token refresh
  fails, the same account comes back for a 429, or the attempt budget is
  exhausted, the **last failed upstream response is relayed unchanged** —
  byte-for-byte, headers included — exactly as today.
- **401 is never retried** (unchanged: pass through, background token
  refresh, client retries).
- **Committing to a retry abandons the held failure response.** A
  network-level failure on the retry attempt therefore follows the existing
  network-failure path — a local 502 — rather than resurrecting the abandoned
  upstream response. Holding failed response bodies (and their sockets) open
  across a whole further attempt is deliberately not done.
- **Never after first byte:** the retry decision happens at upstream response
  headers. Mid-stream failures on an already-relaying response are untouched;
  the router still never synthesizes response bytes.
- **Client disconnects abort the loop:** no retry is forwarded for a client
  that has gone away; the in-flight upstream attempt is torn down.

## Architecture

### Shared policy — `src/proxy/upstream-retry.ts`

Small pure module owning the policy constants and helpers so both providers
agree: `MAX_UPSTREAM_ATTEMPTS = 3`, `SAME_ACCOUNT_RETRY_DELAY_MS = 500`,
`isRetryableUpstreamStatus(status)` (`429 || >= 500`), and an abort-aware
`retryDelay(ms, signal)`.

### OpenAI/Codex path — attempt loop in `runOpenAIIngress`

The fetch-based ingress already sees the upstream `Response` before relaying,
so the existing *acquire → prepare → forward → classify* phase becomes a loop:

1. Forward, classify (unchanged per-attempt bookkeeping).
2. If the status is retryable, budget remains, and the client is still
   connected: re-acquire (catch no-eligible → relay held response), guard the
   429 same-account case, prepare the new account's token (failure → relay
   held response), then commit: record the failed attempt's activity entry and
   `stats.totalErrors`, cancel the held body, release the old lease, delay if
   retrying the same account, loop.
3. The final attempt flows into the existing relay and final bookkeeping
   unchanged. Its route reason naturally reads `failover` after a 429.

### Anthropic path — `src/proxy/anthropic-messages-route.ts`

`http-proxy-middleware` pipes upstream responses natively and offers no
pre-relay decision point, so Claude-bound POST `/v1/messages` moves to a
dedicated route mounted between the cross-provider dispatch (which already
buffers the body as `_ccRawBody` and calls `next()` for Anthropic-bound
requests) and the generic `/v1` proxy chain:

- Reuses `createAnthropicRoutingMiddleware` + `createAnthropicRefreshMiddleware`
  for the first attempt, exactly like the `/v1` chain.
- A hand-rolled transport (`node:http`/`node:https` request) replicates
  http-proxy 1.18's observable behavior: request headers copied with
  `connection: close`, `host` rewritten to the target (`changeOrigin`),
  OAuth `authorization` injected, `x-api-key` stripped, the
  `oauth-2025-04-20` beta appended (helper shared with the remaining hpm
  handler), `content-length` set from the buffered body; response status +
  headers copied verbatim and the raw body **piped without decompression or
  transformation** — byte-transparent, including SSE. `proxyRequestTimeoutMs`
  applies only until response headers arrive, as before.
- Requests without a buffered body (non-JSON) fall through to the untouched
  hpm chain, as do all other `/v1/*` endpoints (`count_tokens`, models, …),
  which keep their existing `proxyRes` bookkeeping.
- Per-attempt bookkeeping mirrors today's `proxyRes` handler: 401 background
  refresh, 429 cooldown + reconcile hook, 529 cooldown, 5xx logging,
  `applyRateLimitHeaders`, per-attempt activity entries; the final relayed
  response also attaches the usage capture and stream-lifecycle tracker.

### Wiring — `server.ts`

`mountAnthropicMessagesRoute(app, …)` is mounted directly after
`mountMessagesCrossProviderRoute`. The no-eligible/empty-pool callbacks are
shared with the `/v1` chain.

The feature is on by default and toggleable: `"autoFailover": false` in
`~/.cc-router/config.json` (read at startup via `getAutoFailoverEnabled()`;
anything but an explicit `false` keeps the default on) opts out for anyone
who cannot work with the commit trade-off above. The off switch is wired as
a single-attempt budget (`maxAttempts: 1`) into all three mounts — both
transports then relay every upstream failure unchanged, byte-for-byte, which
is exactly the pre-feature contract. The startup banner prints the active
state next to the auto-update line.

## Diagnostics

- Failed-then-retried attempts log with the existing failure details plus a
  `:will-retry` suffix (e.g. `sticky:rate-limited:global:will-retry`), so the
  dashboard shows the failover chain.
- The successful retry logs with its own route reason (`failover` after a
  429 rebind, `sticky` for a same-account 500 retry).
- `stats.totalRequests` counts client requests once (Anthropic: up front, as
  today; OpenAI: on final success, as today); each failed upstream attempt
  increments `stats.totalErrors` and the account's error counters.

## Testing

- `upstream-retry.test.ts`: policy helpers.
- `anthropic-messages-route.test.ts` (real HTTP upstreams, style of
  `anthropic-proxy.test.ts`): 429 failover to the second account with cooldown
  + rebind asserted; 500 same-account retry; pass-through byte/header
  exactness when no account remains; SSE byte transparency through the new
  transport; no retry after first byte; client disconnect during the loop;
  refresh failure on the retry account relays the original failure.
- `openai-ingress-retry.test.ts` (mounted `mountResponsesRoutes` with injected
  `forwardOpenAI`): same matrix for the Codex path, including per-attempt
  activity entries and budget exhaustion.
