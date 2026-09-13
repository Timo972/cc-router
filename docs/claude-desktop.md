# Claude Desktop support

Claude Desktop (chat + Cowork) **can** be routed through CC-Router, but unlike
Claude Code it does not respect `ANTHROPIC_BASE_URL` — it talks directly to
`api.anthropic.com` through an embedded Anthropic SDK. To redirect that traffic,
CC-Router uses [mitmproxy](https://mitmproxy.org/) in *local redirect mode*: a
process-scoped interceptor that captures only Claude Desktop's network traffic
and forwards it to the proxy.

This is **opt-in** — the setup wizard asks whether you want it.

## Requirements

- **mitmproxy ≥ 10.1.5** (macOS, Windows) or **≥ 11.1** (Linux — requires kernel ≥ 6.8)
- Admin access to install the mitmproxy CA certificate
- On macOS: one-time manual approval of mitmproxy's Network Extension in System Settings

## Installing mitmproxy

```bash
# macOS
brew install mitmproxy

# Windows
# Download the installer from https://mitmproxy.org/downloads/
# (or: pip install mitmproxy)

# Linux
pip install mitmproxy        # kernel 6.8+ required for local mode
```

## Enabling interception

During `cc-router setup` or `cc-router client connect`, answer **Yes** when asked
about Claude Desktop. The wizard will:

1. Check that mitmproxy is installed
2. Generate the mitmproxy CA certificate (if not already present)
3. Install the CA into the OS trust store (requires sudo/admin)
4. Write the redirect addon to `~/.cc-router/interceptor/addon.py`
5. On macOS, prompt you to approve the Network Extension

Then start the interceptor:

```bash
cc-router client start-desktop
```

Open Claude Desktop and send a message — the request is intercepted and
redirected to CC-Router.

> **Claude Desktop traffic is normally unscoped.** Requests carrying exactly one
> valid `X-Claude-Code-Session-Id` get cache-aware sticky affinity; requests
> without one use load-aware unscoped routing and get no affinity. Claude Desktop
> doesn't send the header, so it takes the unscoped path. That is expected, not a
> misconfiguration — see [Session routing](session-routing.md).

## Stopping / removing interception

```bash
cc-router client stop-desktop    # Stop the interceptor (keep configuration)
cc-router client disconnect      # Stop + remove all client config
```

## How it works under the hood

```text
Claude Desktop
     │
     │  tries to connect to api.anthropic.com:443
     ▼
mitmproxy (local mode)
     │  addon.py rewrites scheme/host to CC-Router
     ▼
CC-Router :3456 ──► api.anthropic.com  (with OAuth Bearer token)
```

mitmproxy's local mode is *process-scoped* — it only intercepts traffic from the
Claude process, not your browser, curl, or any other app. The OS-level
interception uses:

| Platform | Mechanism |
|---|---|
| macOS | Network Extension (App Proxy Provider API) |
| Windows | WinDivert (WFP kernel driver) |
| Linux | eBPF (kernel ≥ 6.8) |

## Troubleshooting

- **macOS: "provider rejected new flow"** — re-enable Mitmproxy Redirector in System Settings → General → Login Items & Extensions → Network Extensions, then restart mitmproxy.
- **Windows: UAC prompt every start** — expected; mitmproxy's redirector needs admin at runtime.
- **Linux: "eBPF program failed to load"** — check your kernel version with `uname -r`. You need ≥ 6.8.
- **Chat shows "failed to connect"** — make sure CC-Router is reachable from the mitmproxy process. Run `curl http://localhost:3456/cc-router/health` to verify the proxy is up.
