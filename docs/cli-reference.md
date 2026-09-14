# CLI reference

```text
cc-router setup              Interactive wizard: extract tokens + configure Claude Code
cc-router setup --add        Add another account to an existing configuration

cc-router start              Start proxy (asks preferences on first run, then remembers)
cc-router start --foreground Run in the foreground (stays in terminal)
cc-router start --reconfigure  Re-ask run preferences (background/service/server mode)
cc-router start --litellm    Start with LiteLLM in Docker (advanced mode)

cc-router stop               Stop proxy (offers to remove auto-start / config)
cc-router stop --keep-config Stop proxy only (keep settings.json)
cc-router stop --full        Stop + remove auto-start + revert Claude Code (no prompts)
cc-router revert             Same as stop --full

cc-router status             Live dashboard (updates every 2s, press q to quit)
cc-router status --json      Print current stats as JSON and exit

cc-router models list        List models discovered live from provider APIs
cc-router models list --json Print discovered models + routing as JSON
cc-router models set --claude-model anthropic/claude-sonnet-4-6
cc-router models set --openai-model openai/gpt-5-codex

cc-router logs               View proxy logs (background mode)
cc-router logs -f            Follow log output in real time
cc-router logs --lines 100   Show last 100 lines

cc-router accounts list      List Claude, ChatGPT and Grok accounts (live stats if proxy is running)
cc-router accounts list --json  Same, as JSON
cc-router accounts add       Add a Claude account interactively
cc-router accounts login-openai  Sign in to OpenAI subscription auth with device code
cc-router accounts add-openai  Add an OpenAI ChatGPT/Codex subscription account manually
cc-router accounts login-grok  Sign in to a Grok / xAI account with device code
cc-router accounts add-grok  Import the Grok CLI login from ~/.grok/auth.json
cc-router accounts rename <id> <new-id>  Rename an account
cc-router accounts remove <id>  Remove a Claude, OpenAI or Grok account

cc-router configure          (Re)write ~/.claude/settings.json
cc-router configure codex    (Re)write ~/.codex/config.toml for Codex CLI
cc-router configure codex --model openai/gpt-5-codex
cc-router configure models --claude-model claude-sonnet-4-6 --openai-model gpt-5-codex
cc-router configure --show   Show current Claude Code proxy settings
cc-router configure --remove Remove cc-router settings from Claude Code (proxy stays up)
cc-router configure codex --remove  Remove the Codex managed block (proxy stays up)

cc-router cli                Show whether Claude Code and Codex are routing through the proxy
cc-router cli claude start   Point Claude Code at the running proxy
cc-router cli claude stop    Restore Claude Code to native Anthropic auth (proxy stays up)
cc-router cli claude resume  Same as cli claude start
cc-router cli codex start    Point Codex CLI at the running proxy
cc-router cli codex stop     Restore Codex CLI to native OpenAI auth (proxy stays up)
cc-router cli codex resume   Same as cli codex start
cc-router claude … / cc-router codex …   Hidden shortcuts for the same commands

cc-router client connect <url>       Connect Claude Code to a remote CC-Router
cc-router client connect --desktop   Also configure Claude Desktop interception
cc-router client disconnect          Revert all client configuration
cc-router client status              Show connection + remote server health
cc-router client start-desktop       Start mitmproxy interceptor for Claude Desktop
cc-router client stop-desktop        Stop mitmproxy interceptor

cc-router telemetry status   Show whether anonymous telemetry is on (off by default)
cc-router telemetry on       Opt in to anonymous usage analytics
cc-router telemetry off      Opt back out

cc-router docker up          Start full Docker stack (cc-router + LiteLLM)
cc-router docker up --build  Rebuild cc-router image before starting
cc-router docker down        Stop Docker containers
cc-router docker logs        Tail all Docker logs
cc-router docker ps          Show container status
cc-router docker restart [service]  Restart a service
```

## Toggling a CLI while the proxy stays up

`cc-router start` / `stop` control the proxy process. To send only one CLI back
to native auth — or point it at the proxy again — without tearing the router
down:

```bash
cc-router cli                 # Claude Code + Codex routing state
cc-router cli claude stop     # Claude Code → native Anthropic auth
cc-router cli claude resume   # Claude Code → running proxy (alias of start)
cc-router cli codex start     # Codex CLI → running proxy
cc-router cli codex stop      # Codex CLI → native OpenAI auth
```

`cc-router claude …` and `cc-router codex …` are shortcuts for the same commands.
`cli` is the grouping — not `provider`, which already means the Anthropic/OpenAI
account pool. `cc-router client` is remote client mode (connecting this machine
to another CC-Router), see [Client mode](client-mode.md).

These rewrite `~/.claude/settings.json` or the managed block in
`~/.codex/config.toml`. The proxy keeps listening. Restart any already-running
Claude Code or Codex process so it picks up the new config. From
`cc-router status`, `[c]` / `[x]` do the same toggles.
