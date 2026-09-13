# Grok / xAI accounts

> **Grok is an overview integration, not a routed provider.** CC-Router tracks
> your Grok subscription alongside your Claude and ChatGPT accounts and shows it
> in the dashboard. It does **not** proxy inference to xAI — there is no
> `grok/*` model prefix, and Grok models do not appear in `GET /v1/models`.

The CLI describes itself the same way: *"Round-robin proxy for Claude Max and
ChatGPT/Codex subscriptions, with a Grok CLI overview."*

What you get is a single place to see whether your Grok login is alive, which
plan it's on, and what it's doing — without a second terminal and a second set
of commands.

## Adding an account

Two ways, both producing an `xai_subscription` account record in
`~/.cc-router/accounts.json`.

### Import an existing Grok CLI login

If you already run the Grok CLI, its OIDC login is at `~/.grok/auth.json`:

```bash
cc-router accounts add-grok
```

You're prompted for an account ID (defaults to the one derived from the import)
and the record is copied in. Account IDs are never derived from your email
address.

### Device-code login

If you have no local Grok CLI login, sign in directly:

```bash
cc-router accounts login-grok
```

The CLI prints a verification URL and a one-time code, you approve it in your
browser, and the resulting record is saved. No local callback server is used.

## Managing accounts

Grok accounts use the same commands as every other provider:

```bash
cc-router accounts list             # Claude, ChatGPT and Grok, grouped
cc-router accounts list --json      # same, as JSON
cc-router accounts rename <id> <new-id>
cc-router accounts remove <id>
```

## What the dashboard shows

Grok appears as its own provider group in `cc-router status`, with per-account:

- **Plan** — the live plan name from the xAI backend, e.g. `GrokPro`
- **Code access** — whether the subscription includes Grok Code
- **Active sessions** — sessions currently open on the account
- **Token expiry** and health/enabled state

Plan and code-access come from a live lookup. When that lookup fails or the row
is served by an older proxy daemon, the dashboard degrades to the coarse spend
tier read from the access token's claims rather than dropping the row — so an
offline dashboard shows `tier N` instead of a blank.

See [Dashboard](dashboard.md).

## Why it isn't routed

Routing a provider means CC-Router can accept a request for one of its models,
pick an account, and forward it upstream. That requires the provider to be part
of the model-reference parser, the route selector and model discovery. Grok is in
none of them today — `ProviderKind` covers `anthropic_subscription`,
`openai_subscription` and `openai_api_key` only.

So a Grok subscription contributes account visibility, not throughput. If you
want Grok models served through a single endpoint, the LiteLLM layer is the
current path — see [LiteLLM setup](litellm-setup.md).
