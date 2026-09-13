# Telemetry

> **Telemetry is opt-in and off by default.** Nothing is sent unless you
> explicitly run `cc-router telemetry on`.

When you turn it on, CC-Router sends a handful of anonymous lifecycle events to
[Aptabase](https://aptabase.com) (privacy-first, open source, EU-hosted). The
goal is simple: know how many people use the project, which versions are live,
and roughly how many instances are running — so fixes and features can be
prioritised.

```bash
cc-router telemetry status   # is it on?
cc-router telemetry on       # opt in
cc-router telemetry off      # opt back out
```

The persisted choice lives in `~/.cc-router/telemetry.json`.

## What is sent

The entire payload lives in [`src/utils/telemetry.ts`](../src/utils/telemetry.ts) —
audit it yourself.

| Event | When | Custom props |
|---|---|---|
| `app_started` | First proxy start after install | `first_run: true` |
| `setup_completed` | Setup wizard finishes successfully | `account_count` |
| `proxy_started` | Each `cc-router start` | `account_count`, `mode` |
| `proxy_heartbeat` | Every hour while the proxy is running | `uptime_minutes`, `account_count` |
| `telemetry_disabled` | When you run `cc-router telemetry off` | — |

Plus anonymous system properties with every event: `appVersion`, `osName`
(macOS/Linux/Windows), `osVersion`, `locale`, `engineVersion` (Node), and an
anonymous `installId` — a random UUID generated on first run and stored in
`~/.cc-router/telemetry.json`.

## What is never sent

IPs, OAuth tokens, account names, request content, prompts, responses, URLs,
hostnames, usernames, file paths — nothing that could identify you or your usage
patterns.

## Forcing it off

Beyond the persisted setting, two environment variables short-circuit telemetry
regardless of what's configured:

```bash
export DO_NOT_TRACK=1          # de-facto standard, honored by many OSS tools
export CC_ROUTER_TELEMETRY=0   # project-specific override
```

Either one makes `isTelemetryEnabled()` return `false` before the stored state is
even read.
