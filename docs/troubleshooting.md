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

Do not assume every 429 is a short requests-per-minute throttle. Anthropic can
exhaust a model-scoped weekly allowance while the account's overall weekly
utilisation is still below 100%. For example, an account can show 67% overall
weekly use while the requested model family is already at 100%.

Inspect the authenticated dashboard or `cc-router status --json`. Find the
requested model's capacity row, its snapshot freshness, and the earliest reset
or cooldown. The row distinguishes included allowance, paid-extra use, an
applicable requested-model cooldown, and stale or unavailable usage data.

When Anthropic returns a 429, cc-router passes it through unchanged, records a
global or unambiguous requested-model cooldown, invalidates that session's
binding, and lets the client's next retry choose another usable account. It
does not retry a started request itself.

When all configured accounts are already hard-blocked, cc-router does not call
Anthropic. It returns a local Anthropic-shaped 429 whenever any account has a
rate-limit or quota blocker. The response includes `Retry-After` only when the
router knows a trustworthy unblock time; without one, it remains a 429 without
that header. A local 503 means the accounts were unavailable entirely for
non-rate-limit reasons, such as all being disabled or unhealthy. Wait for the
reported time when present or make another account with allowance available.
If recent activity shows `no-eligible:rate-limited`, the 429 was generated
locally; an original upstream 429 remains byte-transparent.

If usage is marked stale or unavailable, the internal Anthropic OAuth usage
endpoint could not be refreshed. The router keeps conservative stale exhaustion
evidence until reset and otherwise falls back to global response-header state;
it does not treat stale paid-extra state as spend authorization. Repeated
refresh failures back off automatically.

If it happens frequently with a single account, add more accounts:
```bash
cc-router setup --add
```

Configured per-account caps are soft and may be bypassed only when every
otherwise usable account is capped. They do not bypass upstream cooldowns or
effective quota exhaustion. See [session routing](session-routing.md#upstream-allowance-and-cooldowns)
for the complete distinction.

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

## Reporting an unknown setup failure

Unexpected account-setup failures print a random diagnostic ID beside the local
error. The same ID accompanies the sanitized remote setup exception; it is
separate from the stable installation pseudonym and is not reused for another
setup attempt.

When opening an issue, quote the diagnostic ID and attach only the relevant
local log lines after reviewing them for tokens, account details, paths, or
other private data. Do not post `accounts.json`, OAuth responses, credentials,
prompts, or full unreviewed logs. A maintainer can use the ID to locate the safe
remote record while your reviewed local excerpt supplies details that telemetry
deliberately omits.

Runtime exceptions also receive an internal per-occurrence diagnostic ID in the
remote record, but current runtime callers do not print or retain that ID in a
local log. Do not claim a runtime diagnostic-ID correlation when reporting a
failure. Runtime issues remain anonymously grouped by their safe fingerprint
and stable installation pseudonym; share only a reviewed local excerpt and the
approximate occurrence time.

Check effective telemetry state with:

```bash
cc-router telemetry status
```

Telemetry is on by default for fresh installations. `cc-router telemetry off`,
`DO_NOT_TRACK=1`, or `CC_ROUTER_TELEMETRY=0` disables it. Turning it off stops
new capture immediately; enabling a daemon that started disabled requires a
daemon restart. See [telemetry.md](telemetry.md) for the complete inventory and
privacy contract.

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
