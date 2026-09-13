# Codex CLI & OpenAI subscriptions

> **Experimental.** The Responses route works, but expect rougher edges than the
> Claude route.

CC-Router exposes an OpenAI Responses-compatible endpoint at `/v1/responses`.
This lets Codex CLI use your OpenAI ChatGPT/Codex subscription accounts through
the same local router Claude Code uses for Claude subscriptions.

Sticky sessions pin each Codex conversation to one account for prompt-cache
locality, and load- and headroom-aware selection spreads new sessions across
available capacity — the same model as the Claude route, described in
[Session routing](session-routing.md). Usage is tracked from response headers:
account-level 5-hour and 7-day windows, dynamically discovered model-scoped
metered buckets, credits and plan. The user caps `sessionLimitPercent` and
`weeklyLimitPercent` apply to the default Codex bucket.

## Adding an OpenAI account

```bash
cc-router accounts login-openai
```

This uses the Codex device-code auth flow: the CLI prints a verification URL and
a one-time code, you approve the login in your browser, and CC-Router saves the
resulting account record.

Manual entry is available for debugging — it prompts for the access token,
refresh token, expiry timestamp and scopes, validates the record shape, and saves
it without touching Claude accounts:

```bash
cc-router accounts add-openai
```

OpenAI records are tagged with `provider: "openai_subscription"` so they never
enter the Anthropic token pool:

```json
{
  "id": "openai-primary",
  "provider": "openai_subscription",
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "expiresAt": 1999999999000,
  "scopes": ["openid", "profile", "email", "offline_access"]
}
```

## Configuring Codex CLI

```bash
cc-router configure codex --model openai/gpt-5-codex
```

This writes a managed provider block to `~/.codex/config.toml`:

```toml
model = "openai/gpt-5-codex"
model_provider = "cc-router"

[model_providers.cc-router]
name = "CC-Router"
base_url = "http://localhost:3456/v1"
wire_api = "responses"
env_key = "CC_ROUTER_TOKEN"
```

Then run Codex with the proxy secret in `CC_ROUTER_TOKEN` if your router is
password-protected:

```bash
CC_ROUTER_TOKEN=cc-rtr-your-secret codex -m openai/gpt-5.5
```

## Model routing

A model's provider prefix decides its upstream:

| Model | Upstream |
|---|---|
| `openai/*` | OpenAI ChatGPT/Codex subscription route |
| `gpt-*` (no prefix) | OpenAI ChatGPT/Codex subscription route |
| `claude/*` | Claude subscription route |
| `anthropic/*` | Claude subscription route |
| anything else with no prefix | Claude subscription route |

The unprefixed `gpt-*` rule exists for clients that do not speak this convention.
Codex CLI writes the bare slug from its own registry — either
`model = "gpt-5.6-sol"` in `~/.codex/config.toml` or whatever its `/model` picker
selects — so those names arrive without a prefix and would otherwise be routed to
Claude, where `/v1/responses` answers `501`. Configured `openAIAliases` apply to
the bare form too.

### Defaults and aliases

```bash
cc-router configure models \
  --claude-model claude-sonnet-4-6 \
  --openai-model gpt-5-codex
```

This writes `modelRouting` to `~/.cc-router/config.json`. It sets the Claude
default, the OpenAI default, and practical aliases so `claude/sonnet`, `sonnet`,
`openai/default` and `openai/codex` resolve to the models you selected. Restart
the router after changing these values.

With the configuration above:

| Public model | Routed upstream model |
|---|---|
| `openai/codex` | `gpt-5-codex` |
| `openai/default` | `gpt-5-codex` |
| `claude/sonnet` | `claude-sonnet-4-6` |

### Model discovery

Discovery is dynamic. `GET /v1/models` returns an OpenAI-compatible list by
querying the configured Anthropic and OpenAI subscription APIs live:

```bash
curl http://localhost:3456/v1/models
```

Results are provider-prefixed, for example `anthropic/claude-sonnet-4-6` and
`openai/gpt-5-codex`. Configured aliases such as `openai/codex` are added when
their upstream model is available. If one provider is temporarily unavailable,
CC-Router still returns the models discovered from the others.

## Cross-routing from Claude Code

Claude Code can send a `/v1/messages` request with an `openai/*` model. CC-Router
translates that Anthropic Messages request into an OpenAI Responses request, and
converts JSON or basic text SSE responses back into Anthropic-shaped message
responses. Conversion supports text and function tool calls in both streaming and
non-streaming responses.
