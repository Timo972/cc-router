# Session routing

How cc-router decides which Claude subscription account serves a request, and
what that means when several people share one router.

For the *why* behind the design, see the specs under `docs/superpowers/`. This
document is the operational view.

---

## The short version

A Claude Code conversation resends its whole prior context on every turn.
Anthropic caches that shared prefix **per account**, so if consecutive turns of
one conversation land on different accounts, each one pays full price for a
prefix the other already cached.

cc-router therefore pins a session to an account and keeps it there. Load is
spread across *new* sessions rather than across individual requests.

The practical consequence for a team: **throughput scales with accounts, but a
single conversation is only ever as fast as the one account serving it.** Adding
accounts does not speed up one person's session; it lets more sessions run at
once.

---

## How an account gets picked

Claude Code sends an `X-Claude-Code-Session-Id` header. Routing depends on
whether that header is present and valid.

| Reason | When | Behaviour |
|---|---|---|
| `sticky` | Session already bound to an account eligible for the requested model | Reuses that account — the cache-hit path |
| `new-session` | Valid session, no binding yet | Picks the best account, then binds it |
| `failover` | Bound account returned 401/429/529 | Binding invalidated; next request rebinds |
| `unscoped` | No valid session header | Load-balanced per request, **no** affinity |

The session binding is account-based, not model-based. Every request still
carries its requested model into eligibility checks. A model change keeps the
same binding when that account can serve the new model; otherwise the binding
is removed and the session selects one replacement account.

For `new-session`, `failover`, and `unscoped` selection, cc-router first removes
hard-unavailable accounts and applies the configured caps described below. The
remaining accounts are ranked in this order:

1. Fewest in-flight requests
2. Fewest bound sessions
3. Included allowance before actively used paid extra allowance
4. Most headroom across the applicable global and requested-model windows
5. Rotating round-robin (tie-break only)

A session header is only honoured if it is a single non-empty string of at most
256 bytes. Multiple values are **rejected rather than picked between** — a
session must have one unambiguous identity. Anything malformed falls back to
`unscoped`, which still works, just without cache locality.

> **Claude Desktop traffic is normally `unscoped`.** It doesn't send the session
> header, so it gets per-request load balancing. This is expected, not a
> misconfiguration.

---

## Failure handling

When an upstream account returns **401, 429, or 529**, cc-router:

1. Passes the response through **unchanged** — it does not mask upstream errors,
2. Invalidates that session's affinity,
3. Lets the client's own retry pick a different account.

cc-router deliberately does **not** retry on your behalf, and **never** retries
after response bytes have started. A half-streamed answer is never silently
restarted or stitched together from two accounts.

When every account is hard-blocked before forwarding begins, cc-router makes no
Anthropic Messages request. It returns an Anthropic-shaped local **429** when
any block is rate-limit or quota related. The 429 includes `Retry-After`, rounded
up from the earliest trustworthy unblock time, only when that time is known. It
returns a local **503** only when the accounts are entirely unavailable for
non-rate-limit reasons, such as all being disabled or unhealthy. A local error
is distinguishable from an upstream response in recent activity as
`no-eligible:rate-limited` or `no-eligible:unavailable`.

---

## Streaming

Streaming is byte-transparent: cc-router never inserts, drops, or synthesizes
events, including `message_stop`.

Two different timeouts are involved, and they are frequently confused:

| Setting | Covers | Where |
|---|---|---|
| `proxyRequestTimeoutMs` | Only the wait **before** Anthropic's response headers arrive | `~/.cc-router/config.json` |
| Your reverse proxy's read timeout | The response **body**, i.e. long thinking pauses | nginx/Caddy config |

Once a response starts, the pre-response timeout is disarmed and the body streams
through untouched. So a stall *mid-answer* is never the router's timeout — check
the outer proxy's `proxy_read_timeout` (nginx) or equivalent, and give it
generous headroom for extended thinking.

`cc-router configure` sets Claude Code's own stream idle watchdogs to 30 minutes.
**Restart any running Claude Code process afterwards** so it picks them up.

---

## Operating it for a team

### Upstream allowance and cooldowns

Anthropic exposes unified five-hour and all-model weekly windows plus a dynamic
set of model-scoped weekly windows. The requested Messages model is normalized
to a model family and matched against those scopes; cc-router does not maintain
a fixed list of model names. An exhausted matching scope blocks that model but
does not block unrelated models when global capacity remains. An exhausted
five-hour or all-model weekly window blocks every model. Usable paid extra
allowance can keep an otherwise exhausted account eligible, but it ranks behind
included allowance.

These are **hard exclusions**, as are disabled or unhealthy accounts, invalid
authentication, global cooldowns, and cooldowns for the requested model. They
are never bypassed by fallback routing. A model-specific 429 narrows the
cooldown only when the response and current model-scoped evidence make that
classification unambiguous; unknown rate-limit failures and service overloads
remain account-global.

The router refreshes allowance snapshots in memory from Anthropic's fixed
internal `GET https://api.anthropic.com/api/oauth/usage` OAuth endpoint. That
endpoint is not a documented public API and may change. Refreshes use bounded
timeouts, staggered concurrency, and per-account backoff. When refresh fails,
the last good snapshot becomes stale and continues to provide conservative
exhaustion evidence until its reset, but stale paid-extra state cannot authorize
spend. If no usable snapshot exists, model-scoped status is unavailable and the
router degrades to the global rate-limit state observed in Anthropic response
headers. The dashboard labels snapshot freshness; stale model rows are not
presented as authoritative available capacity.

### Per-account throttles

Each account carries two caps (0–100), each governing a different Anthropic
rate-limit window:

| Setting | Window |
|---|---|
| `sessionLimitPercent` | 5-hour utilisation |
| `weeklyLimitPercent` | 7-day utilisation |

These configured caps are **soft policy controls**, distinct from Anthropic's
hard quota and cooldown exclusions. Accounts below their caps are preferred.
If all hard-eligible accounts exceed only these configured caps, cc-router may
select the least-loaded capped account through an explicit cap-bypass fallback.
Below the cap, utilisation measured *relative to the cap* also feeds the
headroom ranking, so a throttled account is picked less often as it approaches
its configured limit.

Use them when accounts shouldn't be drawn down equally — for example, when one is
a teammate's personal subscription they still want capacity on. Setting an
account to 60% creates an approximate 40% holdback during normal selection while
an under-cap alternative remains. It is not a guaranteed reservation: the
all-capped fallback may cross the configured cap.

Both are editable per account from the dashboard.

> Setting caps low holds back capacity during normal selection, but cannot make
> every otherwise usable account unavailable: the all-capped fallback may
> bypass them. Anthropic quota exhaustion and cooldowns remain hard regardless
> of these settings.

### Monitoring

`GET /cc-router/health` is the operational view. When a proxy secret is set,
unauthenticated callers get only `{"status": "ok" | "degraded"}` — enough for a
load balancer healthcheck without exposing the account inventory. Pass the
secret to get the detail:

```bash
curl -H "x-api-key: $CC_ROUTER_SECRET" http://localhost:3456/cc-router/health
```

Per account, the useful routing fields are:

- `inFlightRequests` — requests currently in flight
- `activeSessions` — sessions currently bound
- `healthy` / `enabled` — eligibility for new sessions
- `rateLimits` — global windows, dynamic model-scoped windows, snapshot
  freshness, paid-extra state, and bounded cooldown summaries

A healthy multi-account router under load shows `activeSessions` spread across
accounts. If they pile onto one account while others sit idle, the others are
probably unhealthy, disabled, or cooling down — check `healthy` and `enabled`
before assuming the routing is at fault.

---

## Limits and guarantees

- Bindings live **in process memory only**. Restarting the router clears all
  affinity; sessions simply rebind on their next request, at the cost of one
  cache miss each.
- A binding expires after **1 hour** of inactivity.
- At most **10,000** bindings are retained.
- Session IDs are **never persisted and never logged**, and are not exposed
  through the health endpoint or the dashboard.

---

## OpenAI/Codex routing

OpenAI subscription accounts route Codex CLI requests and also support Claude
Code cross-routing with OpenAI models. Like Claude accounts, OpenAI accounts
benefit from sticky session routing to preserve prompt-cache locality.

### Session affinity

Codex CLI sends a `session_id` header; CC-Router resolves the affinity key in this
priority order:

1. `session_id` header (Codex CLI default)
2. `x-claude-code-session-id` header (fallback for cross-routing)
3. `prompt_cache_key` in the request body (cache key as session identity)
4. Unscoped (load-aware per-request routing, no affinity)

When a session ID is resolved, it is bound to an OpenAI account, and subsequent
requests with the same session reuse that account for prompt-cache locality. The
binding behavior mirrors Anthropic: **1 hour TTL**, **10,000-entry capacity**,
**LRU eviction**, and **per-request eligibility checks** for the requested model.

When an account returns a 401, 429, or an overload response (503 or 529), the
binding is invalidated and the client's next request selects another account.
Other 5xx statuses (500, 502, 504, ...) are treated as isolated per-request
failures — they count toward error stats but do not invalidate the binding or
cool the account down. Session headers that do not match a single non-empty
string of at most 256 bytes are rejected and fall back to unscoped routing.

### Usage tracking and buckets

OpenAI (Codex) usage is bucket-based. CC-Router maintains:

- **Default account-level `codex` bucket**: A primary 5-hour window and secondary
  7-day all-models window, shared by all models at model-specific burn rates
  (e.g., different models consume different amounts of the same shared bucket).
- **Model-scoped metered buckets** (optional): Discovered dynamically from
  `x-codex-<limit>-*` response header families when present. These are never
  configured and apply only to the model that reported them.

Usage is derived from response headers only in this release; the `wham/usage`
endpoint and `codex.rate_limits` stream events are future enhancements. Credits
are displayed in the dashboard but not used for account selection.

Cooldowns on rate-limit failures are either account-global (default) or
bucket-scoped when `x-codex-active-limit` indicates a specific bucket. Load-aware
account selection ranks eligible accounts by: fewest in-flight requests, then
fewest active session bindings, then greatest remaining rate-limit headroom, with
round-robin order as the deterministic tie-break (similar to Claude's ranking,
but without the paid-extra tier—credits are display-only).

### Dashboard display

OpenAI account rows show:
- 5-hour and 7-day usage bars (if data is available)
- Per-bucket rows when model-scoped buckets are reported
- Remaining credits and plan name
- Request, error, in-flight, and session counts
- Cooldown state (scope and remaining duration)

---

## Troubleshooting

**Cache hit rates look worse than expected.**
Confirm requests actually carry `X-Claude-Code-Session-Id` (Claude) or `session_id`
(Codex CLI). Without a session header, every request is `unscoped` and affinity
never applies. Claude Desktop always behaves this way.

**One account is doing all the work.**
Expected if your team is running one long session each — affinity holds them in
place. Check `activeSessions` per account: if the *bindings* are spread but one
account shows all the in-flight requests, that account simply has the busiest
conversation.

**A session jumped to another account mid-conversation.**
Its previous account returned 401/429/529, became ineligible for the requested
model, or the binding aged out after an hour idle. These are by design. The next
turn pays one cache miss and then stays put while the replacement remains
eligible.

**Sessions rebind constantly after a restart.**
Affinity is in-memory; a router restart clears it. If the router is restarting
repeatedly, that's the problem to chase — check `cc-router logs`.
