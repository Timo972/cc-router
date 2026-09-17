<div align="center">

# CC-Router

**One local proxy. All of your Claude and ChatGPT subscriptions.**

Route Claude Code, Codex CLI and Claude Desktop across every subscription you own —
cache-aware, with automatic failover, and without changing how you work.

[![npm](https://img.shields.io/npm/v/@timo972/cc-router)](https://www.npmjs.com/package/@timo972/cc-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

[Quickstart](#quickstart) · [Documentation](docs/) · [Changelog](CHANGELOG.md) · [Disclaimer](#disclaimer)

![CC-Router Dashboard](assets/dashboard.png)

</div>

---

## Why

One Claude Max subscription is one rate limit. If you spend your day in Claude Code you
know the shape of it: a long session, a wall of `429`, and a cooldown you have to sit out.
Current Claude Code builds no longer retry rate limits themselves, so it surfaces as an
error mid-conversation.

CC-Router is a local proxy that sits between your tooling and the providers. It spreads
sessions across every subscription you own and fails a rate-limited request over to
another account *before a single response byte reaches the client*.

```text
1 account   →  hit the limit, the session errors out
3 accounts  →  sessions spread across all three; a 429 fails over mid-flight
```

The part that makes it usable day to day: each conversation stays **pinned to one
account**. A Claude Code turn resends its whole prior context, and Anthropic caches that
prefix *per account* — scatter the turns and you re-pay for the cache every time. CC-Router
distributes *new* sessions instead of individual requests, so your cache stays warm.

Everything else is unchanged. Same `claude`, same `codex`, same streaming, extended
thinking, tool use and prompt caching — passed through byte for byte.

## Features

- **Cache-aware session routing** — pins each session to one account, spreads new sessions across 2–20 accounts ([details](docs/session-routing.md))
- **Automatic failover & retry** — a `429` moves to another account, a `5xx` is retried in-router, always before the first response byte
- **Multi-provider routing** — model prefixes send `claude/*` to Claude subscriptions and `openai/*` / `gpt-*` to ChatGPT/Codex ([details](docs/codex.md))
- **Model-aware rate limits** — skips accounts whose global or per-model allowance is spent, and respects scoped cooldowns
- **Automatic token refresh** — OAuth tokens refresh before expiry and are written atomically ([details](docs/oauth-tokens.md))
- **Live dashboard** — terminal UI for account health, usage windows, live activity, and routing toggles ([details](docs/dashboard.md))
- **Grok CLI overview** — your Grok/xAI subscription's plan and session state in the same dashboard, alongside the accounts that are routed ([details](docs/grok.md))
- **Guided setup** — `cc-router setup` pulls tokens from the Keychain or credentials file and wires up your clients
- **Client mode** — point another device you own at your private router ([details](docs/client-mode.md))
- **Flexible deployment** — background daemon, native auto-start (launchd/systemd), foreground, or Docker Compose ([details](docs/installation.md))
- **Locked down by default** — tokens stay on your machine, proxy auth is required on non-loopback binds ([details](docs/security.md))

## Supported platforms and harnesses

**Routed** — requests are proxied to these:

| Platform | Auth | Route |
|---|---|---|
| Claude Max / Pro subscriptions | OAuth (subscription) | `/v1/messages` |
| OpenAI ChatGPT / Codex subscriptions | OAuth device code | `/v1/responses` |
| Anything LiteLLM supports (optional) | API keys, via LiteLLM | `/v1/messages` ([setup](docs/litellm-setup.md)) |

**Monitored** — tracked and shown in the dashboard, not proxied:

| Platform | Auth | What you get |
|---|---|---|
| Grok / xAI subscriptions | Device code, or import from Grok CLI | Plan, code access, active sessions, token health ([details](docs/grok.md)) |

**Harnesses**

| Harness | Support | Notes |
|---|---|---|
| Claude Code | First class | Configured automatically by `cc-router setup` |
| Codex CLI | First class | Configured by `cc-router configure codex` ([setup](docs/codex.md)) |
| Claude Desktop (chat + Cowork) | Opt-in | Needs a mitmproxy interceptor ([setup](docs/claude-desktop.md)) |
| Any Anthropic Messages client | Works | Point `ANTHROPIC_BASE_URL` at the router |
| Any OpenAI Responses client | Works | Point the base URL at `/v1` |

## Quickstart

Requires **Node.js 20 or 22** on macOS, Linux or Windows.

```bash
# 1. Install
npm install -g @timo972/cc-router

# 2. Extract tokens and configure your clients
cc-router setup

# 3. Start the proxy
cc-router start

# 4. Use Claude Code as usual — the proxy is transparent
claude
```

That's it. On first `start` you're asked how to run the router (background, foreground, or
auto-start on boot) and the choice is remembered; `cc-router start --reconfigure` changes
it later. Adding more accounts is `cc-router setup --add`, and `cc-router status` opens the
dashboard.

Per-platform token extraction, Codex CLI, Docker and everything else lives in
[the docs](docs/).

## Usage history and savings

Run `cc-router usage` for persistent token history, provider/model stacked bars,
and a daily activity grid. Switch between day, week, month and year; history
survives service restarts. Configure your monthly subscription costs to compare
them with the estimated standard API token value:

```bash
cc-router usage subscription set personal --monthly-usd 100 --from 2026-09-01
cc-router usage
cc-router usage --period month --provider claude --json
```

Use your actual monthly USD cost and account name in place of the example.
Missing prices or costs are explicitly marked incomplete. See the
[usage reference](docs/cli-reference.md#persistent-token-usage-and-savings) for
configuration, keyboard controls, estimation limits and offline/remote access.

## Documentation

| Guide | What's in it |
|---|---|
| [Installation & deployment](docs/installation.md) | Per-platform token setup, run modes, Docker |
| [CLI reference](docs/cli-reference.md) | Every command and flag |
| [Session routing](docs/session-routing.md) | How an account gets picked, failover, team operation |
| [Architecture](docs/architecture.md) | Request path and components |
| [Dashboard](docs/dashboard.md) | Live TUI, keybindings, model management |
| [Codex CLI & OpenAI](docs/codex.md) | Responses endpoint, model prefixes, OpenAI accounts |
| [Grok / xAI](docs/grok.md) | Adding Grok accounts, and why they're overview-only |
| [Claude Desktop](docs/claude-desktop.md) | mitmproxy interception setup |
| [Client mode](docs/client-mode.md) | Connecting your other devices |
| [LiteLLM](docs/litellm-setup.md) | Optional logging and rate-limiting layer |
| [OAuth tokens](docs/oauth-tokens.md) | How subscription tokens and refresh rotation work |
| [Security](docs/security.md) | Token storage, proxy auth, threat model |
| [Telemetry](docs/telemetry.md) | Privacy-bounded telemetry, on by default: exactly what is sent and how to turn it off |
| [Troubleshooting](docs/troubleshooting.md) | When something doesn't connect |

## Disclaimer

> CC-Router uses the OAuth tokens of **your own** Claude Max and ChatGPT subscriptions.
>
> **Read Anthropic's and OpenAI's Terms of Service before using this tool.** Using multiple
> subscriptions to increase throughput may violate them. Anthropic has been known to ban
> accounts for unusual OAuth usage patterns.
>
> Do not share subscription accounts, OAuth credentials, or CC-Router proxy access with
> other people.
>
> The authors are not responsible for account bans, loss of access, or any other
> consequence of using this software. Use at your own risk.

## Contributing

Bug reports and feature requests go to [GitHub Issues](https://github.com/Timo972/cc-router/issues).
For development setup, code conventions and the PR process, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

This project began as a fork of [VictorMinemu/CC-Router](https://github.com/VictorMinemu/CC-Router)
and is now maintained independently as [`@timo972/cc-router`](https://www.npmjs.com/package/@timo972/cc-router).
It is not affiliated with the upstream project — please file issues here rather than upstream.
The original MIT copyright notice is retained in [LICENSE](LICENSE).
