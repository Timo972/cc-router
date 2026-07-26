# Security

## Token storage

OAuth tokens are stored in `~/.cc-router/accounts.json` on your local machine — **never in the repository**.

The file contains:
```json
[
  {
    "id": "max-account-1",
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748658860000,
    "scopes": ["user:inference", "user:profile"]
  }
]
```

OpenAI subscription records use the same file but are tagged with a provider:

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

**Protect this file:** anyone with access to it can make API requests on behalf of your Claude Max or OpenAI ChatGPT/Codex subscription accounts.

### File permissions

`~/.cc-router/` is created as `0700` and `accounts.json` / `config.json` are
written `0600` (owner read/write only) on both Linux and macOS — the atomic
temp file is created `0600` and `chmod`ed defensively before the rename. On
Windows the POSIX mode is not enforced by the filesystem; the files live under
your user profile and are protected by the profile ACL.

### Never commit tokens

`accounts.json` is in `.gitignore`. Double-check before any commit:
```bash
git status  # accounts.json should not appear
```

---

## Atomic writes

When tokens are refreshed, cc-router writes to a temporary file first and then renames it to `accounts.json`. This prevents file corruption if the process is killed mid-write — a corrupted `accounts.json` would lock you out of all accounts permanently.

---

## System call security

When extracting tokens on macOS, cc-router calls:
```
security find-generic-password -s "Claude Code-credentials" -w
```

This uses `execFile` (not `exec` or `execSync`), passing arguments as a fixed array — **no shell interpolation, no injection risk**. The command only reads from the Keychain; it does not modify anything.

---

## Network

cc-router only makes outbound connections to:

| Host | Purpose |
|------|---------|
| `api.anthropic.com` | Forwarding Claude Code requests (standalone mode) |
| `console.anthropic.com` | OAuth token refresh |
| `chatgpt.com` | OpenAI Codex subscription Responses route |
| `auth.openai.com` | OpenAI subscription OAuth token refresh |
| `localhost:4000` | LiteLLM (full mode only) |
| `registry.npmjs.org` | Update **check** (version lookup only; installs are manual by default) |
| `eu.aptabase.com` | Anonymous telemetry — **only if you opt in** (see below) |

## Telemetry

Telemetry is **opt-in and off by default.** Nothing is sent unless you run
`cc-router telemetry on`. When enabled, anonymous usage events are sent to
Aptabase (`https://eu.aptabase.com`).

**What is sent:** a random install UUID (not linked to any identity), OS name/
version, app and Node versions, and coarse counters (event name, account count,
uptime). **What is never sent:** OAuth tokens, prompts, request/response bodies,
account names, or email addresses. Your IP is visible to the endpoint at the
network layer, as with any HTTPS request.

**Opt out / stay off:** it is already off by default. You can also set
`DO_NOT_TRACK=1` or `CC_ROUTER_TELEMETRY=0`, or run `cc-router telemetry off`.
The endpoint is hardcoded and cannot be redirected.

---

## Transport security (TLS)

CC-Router listens over **plain HTTP** and binds to `127.0.0.1` by default, which
is safe for a single machine. It does **not** terminate TLS itself.

If you serve other devices (server mode / client mode), the proxy secret is sent
as `Authorization: Bearer <secret>` and **all prompts and responses travel in
cleartext** on the hop between client and CC-Router (the upstream hop to
Anthropic/OpenAI is always HTTPS). Anyone on the network path — same LAN, a VPS
neighbour, or an on-path attacker — can read the secret and the traffic, and
replay the secret.

**Requirement for non-loopback use:** put CC-Router behind a TLS-terminating
reverse proxy and give clients the `https://` URL. Minimal Caddy example:

```
proxy.example.com {
    reverse_proxy 127.0.0.1:3456
}
```

Then bind CC-Router to localhost (default) and let Caddy/nginx/Cloudflare Tunnel
handle TLS. Server mode also **requires** a proxy secret — CC-Router refuses to
bind a non-loopback interface without one.

---

## Docker

In Docker mode, `accounts.json` is mounted from the host into the container. The container runs as the `node` user (non-root). The Dockerfile uses a minimal `node:22-alpine` image.

**Do not push a custom Docker image containing accounts.json** — the `.dockerignore` excludes it, but verify before any custom builds.

---

## Threat model

| Threat | Mitigation |
|--------|-----------|
| accounts.json leaked | `.gitignore`, `0600` permissions, stored outside repo |
| Process killed mid-refresh | Atomic write (tmp + rename) |
| Concurrent refresh calls | Per-account lock (`Map<id, Promise>`) |
| Shell injection in Keychain read | `execFile` with fixed arg array |
| Malicious body parsing | No `express.json()` on proxy routes |
| OpenAI and Anthropic tokens mixed | Provider-tagged records; OpenAI accounts are loaded outside the Anthropic pool |
| OpenAI refresh token rotation loss | Refreshes persist the rotated token immediately while preserving other providers |
