# Architecture

CC-Router is a single local HTTP server that terminates your client's request,
picks a subscription account, attaches that account's OAuth credentials, and
forwards the request upstream.

```text
Claude Code  (terminal)  ─┐
                          │  ANTHROPIC_BASE_URL=http://localhost:3456
                          │
Codex CLI  ──────────────┤  base_url=http://localhost:3456/v1
                          │
Claude Desktop ─[mitmproxy]─┐  (optional — intercepts api.anthropic.com)
                             │
                             ▼
┌─────────────────────────────────────┐
│  CC-Router  :3456                   │
│                                     │
│  1. Receives /v1/messages or        │
│     /v1/responses                   │
│  2. Parses the model provider prefix│
│  3. Picks a Claude or OpenAI account│
│  4. Refreshes the token if expiring │
│  5. Injects Authorization: Bearer   │
│  6. Forwards to Anthropic, the      │
│     OpenAI Codex backend, or LiteLLM│
└──────────────┬──────────────────────┘
               │
               ▼
        api.anthropic.com
        (authenticated with the
         OAuth token of account N)
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API — the Claude Code route |
| `POST /v1/responses` | OpenAI Responses API — the Codex CLI route |
| `GET /v1/models` | OpenAI-compatible model list, discovered live from both providers |
| `GET /cc-router/health` | Operational health; detail requires the proxy secret |
| `GET /cc-router/accounts` | Account inventory, live stats, and cached identity/subscription metadata (authenticated) |
| `POST /cc-router/accounts/:id/refresh` | Refresh one account's credentials and usage; answers `{ refresh: { id, tokenRefreshed, usageRefreshed, durationMs } }` (authenticated) |

Account listings include an optional `accountInfo` object with `email`, `accountId`,
`accountType` (`personal`, `workspace`, or `unknown`), `workspaceId`,
`workspaceName`, `plan`, `subscription`, `fetchedAt`, and `fetchStatus`
(`fresh`, `stale`, or `unavailable`). Fields not supplied by the provider are
omitted. Claude's `subscription.startedAt` is subscription creation, not the
current billing-period start. Billing interval is not supported. Period and
renewal fields remain absent unless confirmed by provider data.

Metadata is memory-only, refreshed in the background with a five-minute cache
and one-minute failure retries. Listing does not wait for provider requests.
`POST /cc-router/refresh` also refreshes metadata, for the whole pool;
`POST /cc-router/accounts/:id/refresh` does the same for one account, which is
what the dashboard's `R` uses when an account is selected. The account endpoint
uses the proxy's existing authentication rules (loopback-only when no secret is set) and
returns `Cache-Control: no-store`. Metadata is excluded from all health responses,
including authenticated health, and is not sent to telemetry.

## What passes through untouched

All standard Claude Code features work transparently on the Claude route:
streaming, extended thinking, tool use and prompt caching.

Streaming is **byte-transparent** — CC-Router never inserts, drops or synthesizes
events, and in particular never appends a synthetic `message_stop`.

`proxyRequestTimeoutMs` protects only the phase *before* upstream response
headers arrive. Once a response starts, the body continues through the native
byte-exact proxy pipe with no router-side timeout. `cc-router configure` sets
Claude Code's own event-level and byte-level stream idle watchdogs to 30 minutes;
restart any running Claude Code process afterwards so it inherits them.

## Account selection

Selection is cache-aware: a conversation is pinned to one account so its shared
prompt prefix keeps hitting the same account-scoped cache, and *new* sessions —
rather than individual requests — are spread across capacity.

[Session routing](session-routing.md) covers the ranking, the hard exclusions,
failover, and what all of it means when several people share one router.

## Model routing

A model's provider prefix decides which upstream serves it.

| Model | Upstream |
|---|---|
| `openai/*` | OpenAI ChatGPT/Codex subscription route |
| `gpt-*` (no prefix) | OpenAI ChatGPT/Codex subscription route |
| `claude/*` | Claude subscription route |
| `anthropic/*` | Claude subscription route |
| anything else with no prefix | Claude subscription route |

There is no `grok/*` prefix: Grok/xAI accounts are tracked for visibility only
and never receive proxied requests. See [Grok / xAI](grok.md).

Claude Code can also send a `/v1/messages` request with an `openai/*` model.
CC-Router translates that Anthropic Messages request into an OpenAI Responses
request and converts the response back into Anthropic shape — text and function
tool calls, streaming and non-streaming. See [Codex CLI & OpenAI](codex.md).

## Deployment modes

```text
standalone   Claude Code → cc-router:3456 → api.anthropic.com
with LiteLLM Claude Code → cc-router:3456 → LiteLLM:4000 → api.anthropic.com
```

See [Installation & deployment](installation.md).

## Persistent usage history

`src/usage/` separates the durable journal and account aliases, frozen API
pricing, UTC calendar queries, subscription intervals, and authenticated HTTP
access. `cc-router usage` uses those queries through the service, or a read-only
local snapshot while stopped. It does not change the lifetime of the existing
process-local health counters.

Capture is passive: native Anthropic, native OpenAI Responses and translated
Messages usage feed cumulative observations without changing forwarded response
bytes. Attempt identities prevent duplicate terminal callbacks from counting
tokens twice. OpenAI cached input is separated from its inclusive input total;
Anthropic input, cache-read and cache-write counts are already disjoint.

Only the service (or an exclusively locked offline mutation) writes history.
Compaction publishes immutable hourly aggregate generations through an atomic
manifest. Offline reads never repair or truncate journals. Corruption and
missing coverage are explicit rather than silently replaced with zero totals.
Account profile metadata remains in the existing ephemeral `AccountInfoCache`;
the usage ledger must not copy that private object into persisted history.
