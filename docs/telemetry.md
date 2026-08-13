# Telemetry

CC-Router sends privacy-bounded operational telemetry to the maintainer's
PostHog EU project. This page is the complete public inventory of signals and
fields accepted by the closed contracts in `src/telemetry/`.

## Enablement and lifecycle

Telemetry is on by default for a fresh or malformed telemetry state. An existing
valid `enabled: false` value in `~/.cc-router/telemetry.json` remains disabled
after upgrade. Effective enablement is the persisted value and both environment
kill switches:

```text
persisted enabled
AND DO_NOT_TRACK != "1"
AND CC_ROUTER_TELEMETRY != "0"
```

Disable persistently with `cc-router telemetry off`, or disable the current
process with `DO_NOT_TRACK=1` or `CC_ROUTER_TELEMETRY=0`. Environment variables
cannot force telemetry on. `cc-router telemetry off` emits no opt-out beacon,
stops new capture immediately, and causes queued records to be discarded at the
final transport gate. An HTTPS request already in flight cannot be recalled.

`cc-router telemetry on` persists enablement for future starts. A daemon that
started while telemetry was disabled did not initialize the runtime SDK, so
restart that daemon to begin runtime tracing and logging. Check the effective
state with `cc-router telemetry status`.

## Destination, identity, and sampling

The only telemetry destination host is `eu.i.posthog.com`:

- analytics and sanitized exceptions: `https://eu.i.posthog.com/batch/`;
- OpenTelemetry traces: `https://eu.i.posthog.com/i/v1/traces`;
- OpenTelemetry logs: `https://eu.i.posthog.com/i/v1/logs`.

Direct HTTPS ingestion necessarily exposes the connection's source IP to
PostHog at the transport layer. CC-Router does not add that IP to its telemetry
payload. PostHog Logs ingestion PII scrubbing should be enabled as
defense-in-depth, not as the primary filter: CC-Router reconstructs a new closed,
allowlisted record immediately before each exporter or SDK transport.

A random installation UUID, stored in `~/.cc-router/telemetry.json`, is the
stable PostHog `distinctId` and OpenTelemetry `service.instance.id`. It is not
derived from a user, account, hostname, IP address, network, or machine ID.
CC-Router never calls identify, alias, group, person-property, autocapture, or
session-replay APIs. Analytics and exception events set
`$process_person_profile: false` and disable GeoIP enrichment.

Normal root traces use parent-based 10% head sampling; child spans follow their
root. Safe logs, setup diagnostics, analytics, and sanitized exceptions are not
sampled. A safe log carries trace/span correlation only when it occurs inside a
sampled trace. Inbound trace context and baggage cannot force sampling, and no
trace or baggage headers are injected into provider requests.

## Closed signal inventory

No application caller can choose an arbitrary event name, log body, operation,
or property bag. Values outside the closed enums are rejected or, only where
listed, normalized to `other`.

### Analytics events

| Event | Meaning | Allowed event properties |
|---|---|---|
| `app.first_start` | First application start claimed once | runtime fields below |
| `account_setup.started` | Setup attempt began | setup fields below |
| `account_setup.stage_completed` | A setup stage completed | setup fields below |
| `account_setup.succeeded` | Setup completed | setup fields below |
| `account_setup.cancelled` | User cancelled setup | setup fields below |
| `account_setup.failed` | Expected setup failure | setup fields below |
| `proxy.started` | Proxy runtime started | runtime fields below |
| `proxy.heartbeat` | Hourly proxy heartbeat | runtime fields below |

Runtime event properties are application version, OS family, runtime mode, and
bounded account-pool size. Setup event properties are provider, method, stage,
optional safe reason, optional duration bucket, application version, OS family,
runtime mode, and the attempt diagnostic ID. Every event also uses the stable
installation pseudonym and the no-profile/no-GeoIP flags described above.
Running the opt-out command does not emit any event.

### Structured log codes

- `account.setup.diagnostic`: provider, method, stage, optional reason/outcome,
  exact HTTP status, duration bucket, application version, OS family, runtime
  mode, and required diagnostic ID.
- `runtime.failure`: operation, provider, reason/outcome, exact HTTP status,
  bounded attempt/account-pool/concurrency/operation-duration values,
  application version, OS family, runtime mode, and optional diagnostic ID.

Both log types also contain a fixed allowlisted instrumentation scope, severity,
timestamp, and optional sampled trace/span IDs. The only severities are `info`,
`warn`, `error`, and `fatal`. Existing console output and detailed local logs
are not captured or forwarded; those may contain details forbidden remotely.

### Trace operations and fields

The only operation names are:

- `proxy.request`;
- `provider.inference`;
- `oauth.refresh`;
- `provider.usage_refresh`;
- `model.discovery`.

Each reconstructed span may contain only its allowlisted scope, replacement
operation name, trace/span/parent IDs, kind, start time, duration, status code,
and these attributes: HTTP method/status; provider; route; normalized model
family; request source; runtime mode; streaming flag; stream outcome; outcome;
and bounded attempt, account-pool size, concurrency, input-token, output-token,
and operation-duration values.

Closed values are:

- scopes: `cc-router`, `@opentelemetry/instrumentation-http`,
  `@opentelemetry/instrumentation-express`, and
  `@opentelemetry/instrumentation-undici`;
- span kinds: `internal`, `server`, `client`; status: `unset`, `ok`, `error`;
- HTTP methods: `GET`, `POST`;
- providers: `anthropic`, `openai`, `other`;
- routes: `messages`, `responses`, `other`;
- request sources: `cli`, `desktop`, `api`, `other`;
- model families: `fable`, `sonnet`, `opus`, `haiku`, `codex`, `other`;
- runtime modes: `foreground`, `daemon`, `service`;
- outcomes: `complete`, `rate_limited`, `timeout`, `upstream_error`,
  `cancelled`, `other`;
- stream outcomes: `complete`, `timeout`, `upstream_error`, `cancelled`,
  `other`.

### Setup funnel

Providers are `anthropic` and `openai`. Allowed provider/method combinations
are:

- Anthropic: `macos_keychain`, `claude_credentials_file`, `manual_token`;
- OpenAI: `manual_token`, `device_oauth`.

Stages are `attempt_start`, `credential_source_selection`, `credential_read`,
`credential_parse`, `token_validation`, `device_code_request`,
`authorization_polling`, `token_exchange`, `access_token_parse`, `persistence`,
`success`, `cancellation`, and `failure`.

Safe reasons are `not_found`, `permission_denied`, `malformed_credentials`,
`invalid_token`, `unauthorized`, `forbidden`, `rate_limited`, `upstream_4xx`,
`upstream_5xx`, `timeout`, `network_failure`, `unexpected_response_shape`,
`persistence_failure`, `user_cancelled`, and `other`.

Duration buckets are `under_1s`, `1s_to_5s`, `5s_to_30s`, `30s_to_2m`, and
`over_2m`.

### Sanitized exceptions

An unexpected failure is reconstructed as a new Error and may contain only:

- category: `setup` or `runtime`;
- one safe reason from the setup-reason inventory;
- error kind: `error`, `type_error`, `range_error`, `reference_error`,
  `syntax_error`, `uri_error`, `eval_error`, `aggregate_error`, or
  `unexpected_error`;
- optional system code: `EAI_AGAIN`, `ECONNREFUSED`, `ECONNRESET`,
  `ENETUNREACH`, `ENOTFOUND`, `EPIPE`, or `ETIMEDOUT`;
- optional exact HTTP status, operation, provider, setup stage, and runtime mode;
- normalized `dist/...` or `node_modules/package-name/...` stack frames with
  optional line/column, capped at 20 frames and 256 characters per frame path;
- a stable fingerprint derived only from safe kind/context/frames;
- a fresh random diagnostic ID for that occurrence.

The new Error message is the fixed safe reason. The original message, cause,
custom properties, source context, code variables, and unrecognized frames are
not copied. Repeated occurrences with the same safe context and frames group by
fingerprint while retaining the stable install `distinctId`; no Person profile
is created.

### Resource fields and bounded counters

The complete resource is:

- `service.name` (always `cc-router`), application version, stable random
  `service.instance.id`, Node version, OS family (`macos`, `linux`, `windows`,
  or `other`), CPU architecture (`arm64`, `x64`, or `other`), and runtime mode.

Default resource detection is disabled. Host, process, cloud, container, and
environment metadata is not exported.

Numeric categories are bounded before export:

| Category | Accepted range |
|---|---:|
| attempt | integer 0-100 |
| account-pool size | integer 0-10,000 |
| concurrency | integer 0-10,000 |
| input/output tokens | integer 0-1,000,000,000 |
| span or operation duration | finite 0-86,400,000 ms |
| HTTP status | integer 100-599 |
| timestamps | finite 0-8,640,000,000,000,000 ms |

## Forbidden data

The following must never enter an outbound telemetry record, whether raw,
encoded, or hashed:

- prompts, tool calls, message content, and request or response bodies;
- OAuth tokens, refresh/access tokens, authorization data, proxy secrets,
  cookies, credentials, OAuth payloads, device codes, user codes, and scopes;
- request/response headers, URLs, query strings, server addresses, network peers,
  and trace baggage;
- account IDs/names, Claude session IDs, PostHog session IDs, user IDs, email
  addresses, usernames, and other user input;
- hostnames, home directories, current working directories, absolute paths,
  executable paths, command lines, PIDs, environment variables, cloud/container
  identifiers, and machine identifiers;
- raw exception messages, status descriptions, cause chains, custom error
  properties, code variables, source context, span events, links, and arbitrary
  event/log/resource attributes.

Automatic instrumentation never reads bodies. Unknown scopes or malformed
closed records are dropped. Telemetry failures are swallowed at the telemetry
boundary and never alter proxy responses, streamed bytes, retry behavior, exit
codes, or crash semantics.

## Reporting a diagnostic ID

A diagnostic ID correlates one setup attempt or exception with a detailed local
log. It is not the installation pseudonym and is never reused across unrelated
attempts or occurrences. When reporting an unknown failure, quote the diagnostic
ID and include only the smallest reviewed local-log excerpt needed to explain
the problem. Remove tokens, account details, paths, prompts, and any other
private content first; never publish `accounts.json` or a full unreviewed log.
