# Troubleshooting

## Claude Code is not connecting to the proxy

**Check if the proxy is configured:**
```bash
cc-router configure --show
```

Expected output:
```
Claude Code is configured to use cc-router:
  ANTHROPIC_BASE_URL  = http://localhost:3456
  ANTHROPIC_AUTH_TOKEN = proxy-managed
```

If it's not configured, run:
```bash
cc-router configure
```

**Check if the proxy is running:**
```bash
cc-router status --json
```

If you get "Cannot connect", start it:
```bash
cc-router start
# or as a background service:
cc-router service install
```

---

## 401 Unauthorized errors

The OAuth token is invalid or expired.

**Check token expiry:**
```bash
cc-router status --json | python3 -m json.tool
# Look at accounts[].expiresInMs
```

**Force a refresh:** restart the proxy — it refreshes all tokens on startup:
```bash
cc-router stop && cc-router start
```

**If the refresh token itself expired**, you need to re-add the account:
```bash
cc-router setup --add
# Log out and back in with that account in Claude Code first
```

---

## 429 Rate limit errors

The account is hitting Anthropic's rate limits. cc-router puts the account on cooldown for the `Retry-After` period automatically.

If it happens frequently with a single account, add more accounts:
```bash
cc-router setup --add
```

Before adding accounts, check that per-account caps aren't taking accounts out of
rotation while budget remains — see [per-account throttles](session-routing.md#per-account-throttles).

---

## Streaming (SSE) is broken or incomplete

This usually means a body-parsing middleware is interfering with the proxy.

If you're running cc-router behind another proxy (e.g. nginx), make sure:
- `proxy_buffering off` is set in nginx
- `X-Accel-Buffering: no` header is forwarded

cc-router itself does not buffer SSE — `selfHandleResponse` is always `false`.

---

## Response stalled mid-stream

CC-Router keeps passive lifecycle details on recent route entries returned by `cc-router status --json` and the `/cc-router/health` endpoint. Inspect the entry's `streamLifecycle` object:

- `sawMessageStop: true`, `upstreamEnd: true`, and `downstreamFinish: true` indicate a normally completed SSE response.
- `upstreamAborted: true` identifies termination by the upstream response.
- `downstreamClose: true` with `downstreamFinish: false` identifies downstream cancellation, such as a client disconnect.
- A missing `message_stop` is diagnostic evidence only. CC-Router never synthesizes a terminal event or changes the response body based on this flag.

Streaming remains byte-transparent, and these diagnostics never retain response payload content or session IDs. If you changed Claude Code's stream idle watchdog configuration, restart existing Claude Code processes so they inherit the new values. When an outer reverse proxy is present, also check its response-body idle timeout separately from CC-Router's pre-header `proxyRequestTimeoutMs`.

---

## Claude Code ignores the proxy after system restart

The proxy is not set to auto-start. Either:

```bash
# Option A: manual start after reboot
cc-router start

# Option B: install as system service (auto-start)
cc-router service install
```

---

## `cc-router setup` doesn't find tokens on macOS

Claude Code must be logged in before running setup:
```bash
claude login          # log in with your Max account
cc-router setup       # now it can read from Keychain
```

If the Keychain entry is locked, the `security` command will prompt for your macOS password.

---

## Docker: cc-router container exits immediately

Check logs:
```bash
cc-router docker logs --service cc-router
# or: docker compose logs cc-router
```

Most likely cause: `accounts.json` is not mounted or is empty. Verify:
```bash
ls -la ~/.cc-router/accounts.json
cat ~/.cc-router/accounts.json
```

---

## Docker: LiteLLM fails to start

Check logs:
```bash
cc-router docker logs --service litellm
```

Common causes:
- `LITELLM_MASTER_KEY` not set in `.env`
- Port 4000 already in use (`lsof -i:4000`)
- Image pull failed (no internet, or image tag changed)

To use a specific LiteLLM version, edit `docker-compose.yml`:
```yaml
image: ghcr.io/berriai/litellm:v1.72.0  # pin a specific version
```

---

## How do I go back to using Claude Code normally?

```bash
cc-router revert
```

This stops the proxy and removes cc-router's settings from `~/.claude/settings.json`. Claude Code will use its normal authentication on the next launch.
