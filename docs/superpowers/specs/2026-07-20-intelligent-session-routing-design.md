# Intelligent Session Routing Design

## Problem

CC-Router currently calls `TokenPool.getNext()` for every `/v1/*` request. The
`X-Claude-Code-Session-Id` header is used only to label traffic as coming from
Claude Code; it does not influence account selection.

This request-level round robin has two harmful effects:

1. A conversation moves between subscription accounts. Prompt caches are
   isolated between accounts, so each account repeatedly creates overlapping
   cache prefixes instead of extending one warm conversation cache.
2. The pool does not track in-flight requests. Concurrent sessions can select
   an account that is already serving a long stream, increasing upstream
   throttling and stalled-stream risk.

The router must make account assignment at the session level while preserving
the upstream and downstream protocols unchanged.

## Goals

- Keep every healthy Claude Code session on one account for cache locality.
- Distribute new sessions across usable accounts according to live load and
  rate-limit headroom.
- Move a session only when its account cannot serve it.
- Track request leases until the downstream response actually completes.
- Preserve Anthropic response status, headers, SSE bytes, ordering, and timing.
- Keep routing state bounded and avoid persisting session identifiers.

## Non-Goals

- Modifying, normalizing, or synthesizing Anthropic SSE events.
- Retrying a partially delivered response on another account.
- Sharing prompt caches across accounts; Anthropic isolates those caches.
- Persisting affinity mappings across router restarts.

## Routing Model

### Session identity

For Claude Code traffic, the normalized `X-Claude-Code-Session-Id` header is
the affinity key. Empty values and values longer than 256 UTF-8 bytes are
ignored. Requests
without a usable session ID use load-aware request routing without persistent
affinity.

The router stores only an in-memory mapping:

```text
session ID -> account ID + last-seen timestamp
```

Mappings expire after one hour of inactivity. This bounds stale state and
matches the longest prompt-cache lifetime relevant to normal Claude Code use.
The map is capped at 10,000 entries. Expired entries are swept first; if it is
still full, the least recently used mapping is evicted. Session IDs are never
logged or written to disk.

### Existing sessions

If a session has a binding and the account remains enabled, healthy, below its
configured caps, and outside cooldown, the router reuses that account. Cache
affinity takes priority over global load balancing for an established session.

An account's current in-flight count does not break an existing binding. This
prevents related requests within one Claude Code session from bouncing to a
different cache domain.

### New sessions and unscoped requests

The router filters accounts using the existing health, enablement, cap, and
cooldown rules. It then ranks eligible accounts by:

1. Lowest in-flight request count.
2. Fewest active session bindings.
3. Greatest remaining rate-limit headroom, based on the worse of the 5-hour
   and 7-day utilization ratios relative to configured caps.
4. Round-robin order as the deterministic tie-breaker.

The headroom score is the lower-is-better value
`max(fiveHourUtil / sessionCap, sevenDayUtil / weeklyCap)`, with percentages
normalized to fractions. A zero cap makes the account ineligible; missing
upstream utilization starts at zero. The rotating tie-break cursor advances
only after an account is selected.

The chosen account is bound to the session before forwarding begins, ensuring
simultaneous new sessions cannot all observe and select the same idle account.
Requests without a session ID use the same ranking but do not create a binding.

### Failover and rebinding

A binding is invalidated when its account is disabled, unhealthy, over a user
cap, in cooldown, or returns an account-specific 401, 429, or 529 response.
The failed response is still relayed unchanged. Claude Code's next retry is
then assigned to the best eligible account and establishes a new binding.

The router never retries after response bytes have been sent. This avoids
duplicating text or tool calls.

If every account is unavailable, the existing fallback policy remains, but it
selects the least-loaded account and logs the fallback reason. User caps remain
advisory when bypassing them is the only way to avoid an empty pool.

## Request Leases

Selection returns an account lease rather than a bare account. Acquiring a
lease increments that account's in-flight count synchronously. Releasing it is
idempotent and decrements the count exactly once.

The HTTP layer releases the lease on all terminal paths:

- downstream response `finish`;
- downstream/client `close`;
- proxy or upstream error;
- refresh failure or another pre-forward rejection.

This lifecycle represents the complete body, not merely receipt of upstream
headers. It therefore works for long SSE responses and ordinary JSON bodies.

Cooldown is represented by an expiry timestamp rather than conflating active
work with the existing `busy` boolean. Expired cooldowns are swept during
selection and health polling.

## Components

### `TokenPool`

- Owns per-account in-flight counts.
- Exposes lease acquisition and idempotent release.
- Preserves existing health, cap, cooldown, mutation, and fallback behavior.
- Provides the load and headroom values needed by the session router.

### `SessionRouter`

- Owns bounded, expiring session-to-account mappings.
- Reuses valid bindings.
- Chooses and binds accounts for new sessions.
- Invalidates bindings after account-specific failures or management changes.
- Does not depend on Express or inspect message content.

### Proxy integration

- Extracts and validates the session header.
- Acquires a routed lease before token refresh and forwarding.
- Attaches one idempotent cleanup function to every response path.
- Invalidates affinity after 401, 429, and 529 responses.
- Leaves `http-proxy-middleware` response passthrough unchanged.

## Observability

Health/account views add an in-flight count and active-session count. Route
logs may record the non-sensitive selection reason (`sticky`, `new-session`,
`unscoped`, or `failover`) but never the session ID. A response remains logged
with its actual upstream status.

## Testing

Unit tests will verify:

- Repeated requests from one session retain the same account.
- New sessions distribute across idle accounts before reusing one.
- In-flight load, active bindings, rate-limit headroom, and round-robin order
  are applied in the documented priority.
- A valid sticky binding survives unrelated load changes.
- Disabled, unhealthy, capped, cooling-down, and failed accounts cause a
  controlled rebind on the next request.
- Lease release is idempotent and never produces a negative count.
- Expired and excess mappings are evicted without logging session IDs.
- Requests without a session ID are load-aware but not sticky.

Integration tests will hold several SSE responses open concurrently and verify:

- Different sessions use separate idle accounts when available.
- A session's follow-up request retains its account.
- Leases remain active until the full response finishes or disconnects.
- Complete upstream SSE bodies remain byte-for-byte identical downstream.
- No `message_stop` or other SSE frame is inserted, removed, or rewritten.

The focused tests, full Vitest suite, typecheck, and production build must pass.
