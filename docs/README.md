# CC-Router documentation

Start with the [README](../README.md) for what CC-Router is and a quickstart.

## Setup

| Guide | What's in it |
|---|---|
| [Installation & deployment](installation.md) | Requirements, per-platform token extraction, run modes, Docker |
| [CLI reference](cli-reference.md) | Every command and flag |
| [Codex CLI & OpenAI](codex.md) | Responses endpoint, model prefixes, OpenAI subscription accounts |
| [Claude Desktop](claude-desktop.md) | Routing Claude Desktop / Cowork through mitmproxy |
| [Client mode](client-mode.md) | Connecting another device you own to your router |
| [LiteLLM](litellm-setup.md) | Optional logging, rate limiting and web dashboard layer |

## Operating it

| Guide | What's in it |
|---|---|
| [Architecture](architecture.md) | The request path and what each component does |
| [Session routing](session-routing.md) | How an account is picked, failover behaviour, running it for a team |
| [Dashboard](dashboard.md) | The live TUI, keybindings, model management, ChatGPT usage resets |
| [Troubleshooting](troubleshooting.md) | When something doesn't connect |

## Reference

| Guide | What's in it |
|---|---|
| [OAuth tokens](oauth-tokens.md) | How subscription tokens work and why refresh rotation matters |
| [Security](security.md) | Token storage, proxy authentication, threat model |
| [Telemetry](telemetry.md) | Opt-in analytics: what's sent if you enable it |

Design specs and implementation plans live under [`superpowers/`](superpowers).
