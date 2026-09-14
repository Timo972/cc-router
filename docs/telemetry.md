# Telemetry

CC-Router sends privacy-bounded operational telemetry to the maintainer's
PostHog EU project: sampled proxy traces, closed-schema diagnostics, a few
lifecycle events, and sanitized exceptions. This page is the complete public
inventory of what can leave the machine. The contracts are implemented in
[`src/telemetry/`](../src/telemetry/) and every outbound record is rebuilt from
an allowlist immediately before it is exported.

```bash
cc-router telemetry status   # effective state and what is sent
cc-router telemetry on
cc-router telemetry off
```

## Enablement

Telemetry is **on by default for fresh installations**. An existing
`~/.cc-router/telemetry.json` with `enabled: false` stays off after an upgrade.
The effective state is:

```text
persisted enabled  AND  DO_NOT_TRACK != "1"  AND  CC_ROUTER_TELEMETRY != "0"
```

`cc-router telemetry off` persists the choice, emits no opt-out beacon, and
records a new *consent generation*. A running daemon re-reads the state before
every capture and every export; once it observes a different generation it
stops exporting for the rest of its life and discards queued records. An HTTPS
request already in flight cannot be recalled. Environment variables can only
turn telemetry off, never on. After `cc-router telemetry on`, restart a daemon
that started while disabled.

## Destination, identity, sampling

The only destination host is `eu.i.posthog.com`:

| Signal | Endpoint |
|---|---|
| analytics events and sanitized exceptions | `https://eu.i.posthog.com/batch/` |
| OpenTelemetry traces | `https://eu.i.posthog.com/i/v1/traces` |
| OpenTelemetry logs | `https://eu.i.posthog.com/i/v1/logs` |

PostHog necessarily sees the connection's source IP at the transport layer;
CC-Router does not put it in the payload, disables GeoIP enrichment, and never
creates a PostHog Person profile (`$process_person_profile: false`,
`$geoip_disable: true` on every event).

A random installation UUID stored in `~/.cc-router/telemetry.json` is the
stable PostHog `distinctId` and OpenTelemetry `service.instance.id`. It is not
derived from any user, account, host, network, or machine identifier.

Root traces are head-sampled at 10%; child spans follow their root. Diagnostics,
warnings, errors, lifecycle events, and exceptions are not sampled. Inbound
`traceparent`/`tracestate`/`baggage` headers are stripped from proxied requests
and no trace headers are injected upstream.

## Closed inventory

Application code cannot choose an arbitrary event name, log body, operation, or
property. Values outside the closed enums are rejected before export.

### Analytics events

| Event | When | Properties |
|---|---|---|
| `app.first_start` | first start of a fresh installation, once | runtime fields |
| `proxy.started` | each `cc-router start` | runtime fields |
| `proxy.heartbeat` | hourly while the proxy runs | runtime fields |
| `account_setup.started` / `stage_completed` / `succeeded` / `cancelled` / `failed` | account setup funnel | setup fields |

Runtime fields: application version, OS family, runtime mode
(`foreground`/`daemon`/`service`), bounded account-pool size. Setup fields add
provider, method, stage, optional safe reason, optional duration bucket, and the
attempt's random diagnostic ID.

### Log records

- `account.setup.diagnostic` — provider, method, stage, optional reason and
  outcome, exact HTTP status, duration bucket, diagnostic ID.
- `runtime.failure` — operation, provider, reason, outcome, exact HTTP status,
  bounded attempt / pool-size / concurrency / duration values, optional
  diagnostic ID.

Both carry severity (`info`, `warn`, `error`, `fatal`), a timestamp, the
runtime fields above, and trace/span IDs only when emitted inside a sampled
trace. Console output and local log files are never forwarded.

### Trace spans

Operations: `proxy.request`, `provider.inference`, `oauth.refresh`,
`provider.usage_refresh`, `model.discovery`.

A span may carry only: operation, trace/span/parent IDs, kind, start time,
duration, status, and these attributes — HTTP method and status code, provider
(`anthropic`/`openai`/`other`), route (`messages`/`responses`/`other`), model
family (`fable`/`sonnet`/`opus`/`haiku`/`codex`/`other`), request source
(`cli`/`desktop`/`api`/`other`), runtime mode, streaming flag, stream outcome,
outcome (`complete`/`rate_limited`/`timeout`/`upstream_error`/`cancelled`/
`other`), and bounded attempt, pool-size, concurrency, input-token,
output-token, and duration values. Span events, links, URLs, and headers are
not exported.

### Setup funnel

Providers `anthropic` (`macos_keychain`, `claude_credentials_file`,
`manual_token`) and `openai` (`manual_token`, `device_oauth`). Stages:
`attempt_start`, `credential_source_selection`, `credential_read`,
`credential_parse`, `token_validation`, `device_code_request`,
`authorization_polling`, `token_exchange`, `access_token_parse`, `persistence`,
`success`, `cancellation`, `failure`. Safe reasons: `not_found`,
`permission_denied`, `malformed_credentials`, `invalid_token`, `unauthorized`,
`forbidden`, `rate_limited`, `upstream_4xx`, `upstream_5xx`, `timeout`,
`network_failure`, `unexpected_response_shape`, `persistence_failure`,
`user_cancelled`, `other`. Duration buckets: `under_1s`, `1s_to_5s`,
`5s_to_30s`, `30s_to_2m`, `over_2m`.

### Sanitized exceptions

An unexpected failure is rebuilt as a *new* `Error` containing only: category
(`setup`/`runtime`), one safe reason, error kind (`error`, `type_error`,
`range_error`, `reference_error`, `syntax_error`, `uri_error`, `eval_error`,
`aggregate_error`, `unexpected_error`), optional system code (`EAI_AGAIN`,
`ECONNREFUSED`, `ECONNRESET`, `ENETUNREACH`, `ENOTFOUND`, `EPIPE`,
`ETIMEDOUT`), optional HTTP status, operation, provider, setup stage, runtime
mode, stack frames normalized to `dist/...` or `node_modules/<package>/...`
(max 20 frames, 256 chars each), a fingerprint over those safe fields, and a
fresh random diagnostic ID. The original message, cause chain, custom
properties, and unrecognized frames are dropped. The diagnostic ID is printed
next to the detailed local error so an issue report can reference it.

### Resource and bounds

Resource: `service.name` (`cc-router`), `service.version`,
`service.instance.id` (installation UUID), `process.runtime.version`, `os.type`
(`macos`/`linux`/`windows`/`other`), `host.arch` (`arm64`/`x64`/`other`),
`cc_router.runtime_mode`. Automatic resource detection is off; host, process,
cloud, and environment metadata is not exported.

| Value | Accepted range |
|---|---:|
| version strings | 1–64 characters |
| attempt | 0–100 |
| account-pool size, concurrency | 0–10,000 |
| input/output tokens | 0–1,000,000,000 |
| durations | 0–86,400,000 ms |
| HTTP status | 100–599 |

## Never sent

Prompts, tool calls, message content, request or response bodies; OAuth or
refresh tokens, cookies, credentials, device or user codes; request or
response headers, URLs, query strings, peer addresses; account IDs or names,
Claude session IDs, user IDs, emails, usernames; hostnames, home or working
directories, absolute paths, command lines, PIDs, environment variables;
raw exception messages, cause chains, custom error properties, or arbitrary
attributes — raw, encoded, or hashed.

Telemetry failures are swallowed at the telemetry boundary and never change
proxy responses, streamed bytes, retry behavior, exit codes, or crash
semantics.
