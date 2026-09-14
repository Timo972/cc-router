# Installation & deployment

## Requirements

- **Node.js 20 or 22**
- macOS, Linux or Windows
- Claude Code installed and logged in at least once (`claude login`) for token extraction

## Install

```bash
npm install -g @timo972/cc-router
```

Verify:

```bash
cc-router --version
```

## Extracting account tokens

`cc-router setup` is an interactive wizard: it locates your existing Claude Code
credentials, imports them as a router account, and configures your clients. What
it offers depends on the platform.

### macOS

CC-Router can read OAuth tokens directly from the macOS Keychain — no manual
copy-pasting.

```bash
cc-router setup
# Select "Extract automatically from macOS Keychain"
```

For multiple accounts, switch accounts in Claude Code between extractions:

```bash
# Account 1 is already logged in — run setup and extract
cc-router setup

# To add account 2:
claude logout && claude login   # log in with account 2
cc-router setup --add           # extract and merge
claude logout && claude login   # log back in with account 1
```

### Linux

Tokens are read from `~/.claude/.credentials.json`:

```bash
cc-router setup
# Select "Read from ~/.claude/.credentials.json"
```

Make sure Claude Code is installed and you have run `claude login` at least once.

### Windows

Same as Linux — tokens are read from `%USERPROFILE%\.claude\.credentials.json`:

```bash
cc-router setup
```

### OpenAI subscription accounts

ChatGPT/Codex accounts use a device-code login rather than token extraction:

```bash
cc-router accounts login-openai
```

See [Codex CLI & OpenAI](codex.md).

### Grok / xAI accounts

Grok accounts are tracked for visibility rather than routed — see
[Grok / xAI](grok.md) for what that means. Add one either by importing an
existing Grok CLI login or with a device-code sign-in:

```bash
cc-router accounts add-grok     # import ~/.grok/auth.json
cc-router accounts login-grok   # device-code sign-in
```

## Run modes

On the first `cc-router start` you're asked how you want the router to run, and
the answer is remembered. `cc-router start --reconfigure` re-asks.

### Standalone (default — no Docker)

```text
Claude Code → cc-router:3456 → api.anthropic.com
```

Best for personal use. Runs in the background by default.

```bash
cc-router start
```

| Mode | Command | Behaviour |
|---|---|---|
| Background daemon | `cc-router start` | Detaches; `cc-router logs -f` to follow |
| Foreground | `cc-router start --foreground` | Stays attached to the terminal |
| Native auto-start | choose it during `start` | launchd (macOS) / systemd (Linux) on boot |
| Server mode | choose it during `start` | Binds a non-loopback interface; a proxy secret is required |

### With LiteLLM (optional — requires Docker)

```text
Claude Code → cc-router:3456 → LiteLLM:4000 → api.anthropic.com
```

Adds a LiteLLM layer for usage logging, rate limiting and a web dashboard at
`http://localhost:4000/ui`.

```bash
cc-router docker up
# or: cc-router start --litellm
```

See [LiteLLM setup](litellm-setup.md).

### Docker

```bash
cc-router docker up          # start the full stack (cc-router + LiteLLM)
cc-router docker up --build  # rebuild the cc-router image first
cc-router docker logs        # tail all logs
cc-router docker down        # stop
```

## Reverting to normal Claude Code

```bash
cc-router revert
```

This stops the proxy, removes the auto-start service if one was installed, and
strips CC-Router's settings from `~/.claude/settings.json`. Claude Code uses its
own authentication on the next launch.

For a gentler path, `cc-router stop` asks interactively what to clean up. To send
a single CLI back to native auth while leaving the router running, use
`cc-router cli claude stop` — see the [CLI reference](cli-reference.md).
