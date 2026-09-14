# Client mode — connecting your own devices

Client mode lets you connect another device you own to your private CC-Router
over a trusted private network.

> It is **not** intended for sharing subscription accounts or proxy access with
> other people, or for exposing CC-Router to the public internet. See the
> [disclaimer](../README.md#disclaimer).

The setup wizard asks about this at the very first step:

```bash
cc-router setup
# → What do you want to do?
#   • Host CC-Router on this machine
#   • Connect to your existing CC-Router server  ← pick this
```

Or use the dedicated command directly:

```bash
# Connect another device you own over your private network
cc-router client connect http://192.168.1.50:3456 --secret cc-rtr-abc123...

# Check status
cc-router client status

# Disconnect (restores Claude Code defaults)
cc-router client disconnect
```

Client mode writes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into
`~/.claude/settings.json`, so Claude Code talks directly to the remote proxy.
Nothing runs locally — no accounts, no proxy process, no resources.

`cc-router status` on a client machine controls the *remote* router rather than a
local one.

## Commands

```text
cc-router client connect <url>       Connect Claude Code to a CC-Router server
cc-router client connect --desktop   Also configure Claude Desktop interception
cc-router client connect -s <secret> Pass the proxy secret inline (or use --secret)
cc-router client disconnect          Revert all client configuration
cc-router client status              Show current connection + remote server health
cc-router client start-desktop       Start the Claude Desktop mitmproxy interceptor
cc-router client stop-desktop        Stop the Claude Desktop interceptor
```

Claude Desktop on a client machine needs the same interceptor as on a host — see
[Claude Desktop](claude-desktop.md).
