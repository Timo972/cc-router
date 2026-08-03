# OpenTelemetry and PostHog Telemetry Design

## Problem

CC-Router currently sends a small set of opt-in lifecycle events directly to
Aptabase. Those events help count active installations, but they do not explain
where proxy requests spend time, why runtime operations fail, or where account
setup breaks.

The replacement must send sampled traces, structured logs, lifecycle analytics,
and exceptions to the maintainer's PostHog EU project. Telemetry is enabled by
default for fresh installations and remains easy to disable. Prompts, request and
response bodies, credentials, account identifiers, user identifiers, and other
PII must never be included in application telemetry payloads.

Direct HTTPS export necessarily exposes the installation's source IP to PostHog
at the transport layer. This is accepted and must be disclosed. The payload and
stored telemetry fields remain subject to the privacy contract below.

## Goals

- Replace Aptabase with the maintainer's centralized PostHog EU project.
- Capture sampled proxy-runtime traces through the OpenTelemetry SDK.
- Capture structured OpenTelemetry logs and correlate them with sampled spans.
- Capture sanitized exceptions in PostHog Error Tracking.
- Diagnose account-setup failures by provider, method, stage, and safe reason.
- Enable telemetry for fresh installations while preserving every existing
  persisted opt-out.
- Make `cc-router telemetry off`, `DO_NOT_TRACK=1`, and
  `CC_ROUTER_TELEMETRY=0` authoritative kill switches for every signal.
- Ensure telemetry failures never alter proxy behavior, streamed bytes, or
  process reliability.

## Non-Goals

- Capturing prompts, tool calls, request or response bodies, raw headers, raw
  URLs, query strings, OAuth responses, or user input.
- Capturing raw exception messages or arbitrary error properties.
- Capturing account IDs, Claude session IDs, email addresses, hostnames, or
  absolute filesystem paths, including hashed versions of account IDs.
- Creating PostHog person profiles or performing GeoIP enrichment.
- Automatically forwarding existing console output to PostHog.
- Tracing health polling, dashboard traffic, update checks, or ordinary CLI
  interactions in detail.
- Adding a local OpenTelemetry Collector or another runtime service.
- Providing per-installation PostHog configuration. All enabled installations
  report to the maintainer's project.

## Chosen Architecture

The implementation uses constrained automatic instrumentation with a
reconstructive outbound privacy boundary:

```text
HTTP / Express / Undici automatic instrumentation
                    |
          local spans and context
                    |
      reconstructive privacy exporter
       |-- rejects unknown instrumentation scopes
       |-- replaces generated span names
       |-- copies only approved attributes
       |-- removes events, links, URLs, and headers
       `-- rechecks telemetry enablement
                    |
          PostHog EU OTLP endpoints
```

Only the individual HTTP, Express, and Undici instrumentations are installed.
The broad Node auto-instrumentation bundle is not used. Console, filesystem,
DNS, process, and host instrumentation remain disabled.

The OTel runtime must initialize before Express and provider transports load.
Because CC-Router is ESM, startup uses a dedicated preload/bootstrap path that
loads the supported OTel ESM hook before importing the proxy application. Every
foreground, detached-daemon, and service start path must use that same bootstrap.
The implementation plan must include an executable ESM instrumentation smoke
test so packaging cannot silently disable automatic spans.

The automatic trace layer is intentionally separate from application telemetry:

- automatic instrumentation supplies timings and in-process parent/child
  context;
- typed application helpers add safe routing and outcome attributes;
- typed log helpers accept only closed schemas;
- a sanitizer constructs a new exception before `posthog-node` sees it;
- outbound wrappers reconstruct safe trace and log records immediately before
  invoking the real exporters.

The PostHog project token is the project's public `phc_` token and is shipped as
a CC-Router application constant, matching the centralized, no-setup design.
Personal API keys are never distributed. The EU endpoints are:

- traces: `https://eu.i.posthog.com/i/v1/traces` using OTLP HTTP/protobuf;
- logs: `https://eu.i.posthog.com/i/v1/logs` using PostHog's documented OTLP
  logging transport;
- analytics and exceptions: `https://eu.i.posthog.com` through `posthog-node`.

PostHog Distributed Tracing is alpha at design time. Endpoint construction and
the exporter wrappers therefore live behind internal interfaces so a backend or
path change does not affect instrumentation call sites.

## Components

The telemetry subsystem is split into focused units:

1. **Enablement and state** owns the persisted flag, environment overrides,
   install UUID, and default/migration behavior.
2. **Runtime bootstrap** starts the OTel SDK, selected automatic
   instrumentations, sampler, resource, and exporters before application code.
3. **Privacy contract** defines the allowed resource, span, log, analytics, and
   exception schemas. It performs runtime validation in addition to TypeScript
   typing.
4. **Safe exporters** rebuild outbound spans and logs from allowed fields and
   drop batches when telemetry is disabled.
5. **Typed telemetry facade** is the only application-facing API. It exposes
   named operations rather than arbitrary event names, log bodies, or property
   bags.
6. **Exception sanitizer** maps expected context, normalizes stack frames,
   creates fingerprints and diagnostic IDs, and constructs the new Error passed
   to PostHog.
7. **PostHog client lifecycle** owns analytics/error capture, batching, bounded
   flush, and shutdown.

No proxy, provider, setup, or CLI module imports an exporter or PostHog client
directly.

## Enablement and Migration

Fresh state sets `enabled` to `true`, generates `installId` with
`crypto.randomUUID()`, and records the current time as an ISO-8601
`firstRunAt` value.

Existing valid state retains its stored `enabled` value. In particular, an
installation that previously chose `off` stays off after upgrade. A missing
`enabled` field uses the new `true` default; malformed state is replaced with a
fresh enabled state, consistent with fresh-install behavior.

Effective state is:

```text
persisted enabled
AND DO_NOT_TRACK != "1"
AND CC_ROUTER_TELEMETRY != "0"
```

Environment variables cannot force telemetry on. The same effective-state
function gates analytics, logs, traces, exceptions, initialization, flush, and
export. There are no signal-specific bypasses.

At process startup:

- if disabled, no OTel SDK, exporter, or PostHog client is initialized;
- if enabled for a proxy runtime, the full trace/log/client stack starts;
- if enabled for an account-setup CLI process, the lightweight log/client stack
  starts without automatic runtime tracing.

`cc-router telemetry off` persists the opt-out and emits no final beacon. An
already-running enabled daemon checks the state again at every application
capture and immediately before every export. New records stop and queued batches
are discarded after the opt-out is observed. A network request already in flight
cannot be recalled. Automatic patches remain locally installed until restart but
produce no outbound data. Enabling a daemon that started disabled requires a
restart, which the CLI reports clearly.

## Identity and Resource Contract

The existing random installation UUID is retained. It is used only as the
PostHog distinct ID and OTel `service.instance.id`, allowing repeated failures
from one installation to be correlated. It is never derived from a user,
account, hostname, network address, or machine identifier.

All analytics events set `$process_person_profile: false` and request disabled
GeoIP at the event level as well as in client configuration. Sanitized exception
properties also request disabled GeoIP. No identify, alias, group, person
property, or session-replay APIs are used. Live rollout validation checks the
stored events rather than trusting client defaults alone.

Allowed resource attributes are limited to:

- `service.name = cc-router`;
- application version;
- Node version;
- OS family;
- CPU architecture;
- runtime mode: foreground, daemon, or service;
- the random `service.instance.id`.

Default OTel resource detection is disabled. Hostname, process command line,
PID, executable path, cloud metadata, container identifiers, and environment
variables are not exported.

## Trace Contract

Detailed traces cover the long-running proxy runtime:

- incoming `/v1/messages` and `/v1/responses` requests;
- outgoing Anthropic and OpenAI inference calls;
- OAuth token refresh;
- provider usage refresh;
- model discovery when it occurs within the runtime;
- Express routing and request duration.

Health, dashboard/account-management polling, PostHog export, update checks, and
unrelated CLI traffic are excluded with instrumentation ignore hooks.

Allowed span data consists of:

- a replacement operation name such as `proxy.request`, `provider.inference`,
  `oauth.refresh`, or `provider.usage_refresh`;
- OTel trace/span IDs, parent relationship, kind, timestamps, and duration;
- HTTP method and status code;
- provider and route enums;
- normalized model family, with unrecognized values mapped to `other`;
- request-source enum: CLI, desktop, or API;
- runtime mode;
- streaming flag and safe stream terminal outcome;
- bounded attempt, account-pool, concurrency, token-usage, and duration values;
- safe result enums such as `complete`, `rate_limited`, `timeout`,
  `upstream_error`, or `cancelled`;
- span status code without its original description.

Generated span names are not exported because automatic HTTP names may contain
paths. Original attributes, resource fields, span events, exception events,
links, status descriptions, URLs, server addresses, network peer fields,
headers, and query parameters are discarded. Known HTTP, Express, Undici, and
CC-Router instrumentation scopes remain in the trace after reconstruction so
parent/child relationships are not broken. Unknown instrumentation scopes are
dropped.

Automatic instrumentation never reads request or response bodies. Existing
CC-Router parsing may derive a normalized model family, stream flag, usage
counts, or terminal outcome locally; only those typed results enter telemetry.

## Sampling and Propagation

The trace provider uses parent-based 10% trace-ID-ratio head sampling. Local
children follow the root decision. Background operations without an incoming
request start their own roots and receive the same sampling decision.

CC-Router uses a no-op network propagator:

- inbound `traceparent`, `tracestate`, and baggage cannot choose trace IDs or
  force sampling;
- CC-Router does not inject trace headers into Anthropic, OpenAI, OAuth, or
  other outbound requests;
- in-process async context still correlates automatic spans and safe logs.

Warnings, errors, setup diagnostics, analytics, and sanitized exceptions are
not subject to trace sampling. When emitted inside a sampled trace, logs carry
its OTel context and appear correlated. Otherwise they remain useful standalone
records.

## Structured Log Contract

Existing console output is never bridged into OTel. It contains account IDs and
raw upstream or filesystem errors and remains local-only.

Remote logs use fixed event codes as their bodies and typed attributes. The API
does not accept arbitrary bodies or `Record<string, unknown>`. Allowed fields are
the safe operation, provider, method, stage, reason, outcome, HTTP status,
bounded counters/durations, app/runtime metadata, diagnostic ID, and active OTel
context.

Expected operational failures are logs or analytics rather than Error Tracking
issues. Examples include invalid credentials, 401, 429, 529, user cancellation,
network timeout, and a provider being temporarily unavailable.

## Account-Setup Diagnostics

Account setup is not automatically traced. It emits an unsampled safe funnel so
the maintainer can see when and why setup breaks without observing user input.

Allowed providers and methods are:

- Anthropic through macOS Keychain;
- Anthropic through the Claude credentials file;
- Anthropic through manual token entry;
- OpenAI through manual token entry;
- OpenAI through device OAuth.

Allowed stages are:

- attempt start and credential-source selection;
- credential read;
- credential parse;
- token validation;
- device-code request;
- authorization polling;
- token exchange;
- access-token parse;
- persistence;
- final success, cancellation, or failure.

Known safe reason codes include:

- `not_found`;
- `permission_denied`;
- `malformed_credentials`;
- `invalid_token`;
- `unauthorized`;
- `forbidden`;
- `rate_limited`;
- `upstream_4xx`;
- `upstream_5xx`;
- `timeout`;
- `network_failure`;
- `unexpected_response_shape`;
- `persistence_failure`;
- `user_cancelled`.

Each diagnostic may include provider, method, stage, reason, exact HTTP status,
duration bucket, application version, OS family, installation UUID, and a
random diagnostic ID. It never includes an account ID, token, scope list,
device/user code, URL, OAuth response body, exception message, or prompt answer.

Setup helpers must retain raw causes for local error messages while attaching a
separate typed diagnostic classification for telemetry. Classification occurs
at the failure site rather than by parsing human-readable messages later.

## Exception Contract

PostHog automatic exception capture and its Express error middleware remain
disabled because both receive raw Error objects. Application code calls a single
sanitizer and passes only the newly constructed safe Error to
`posthog-node.captureException`.

A sanitized exception contains:

- a safe category and reason code;
- a built-in error kind or `unexpected_error`;
- an allowlisted Node system-error code or HTTP status when available;
- operation, provider, setup stage, and runtime mode enums;
- project-relative stack frames;
- a stable stack-based fingerprint;
- a random diagnostic ID also written to the detailed local log.

The sanitizer removes the original message, cause chain, custom properties,
code variables, source context, home-directory prefixes, current working
directory, absolute paths, URL-like text, and unrecognized frames. Project
frames are normalized to `dist/...`; dependency frames retain only
`node_modules/package-name/...`. The new Error message is a fixed safe reason
code.

Unknown failures are not reduced to a generic log and discarded. They are sent
as sanitized exceptions with the safe runtime metadata, normalized frames,
stable fingerprint, and diagnostic ID above. The fingerprint derives from safe
error kind, safe context, and normalized frames, so the same fault groups across
installations without hashing or exporting the raw message. The diagnostic ID
lets a user correlate the PostHog issue with their more detailed local log.

An attribute value outside a closed enum may map to `other`; the failure itself
is still captured.

A process-level `uncaughtExceptionMonitor` performs best-effort sanitized fatal
capture without changing Node's normal crash behavior. No
`uncaughtException` or `unhandledRejection` handler is installed merely to keep
the process alive. Handled exceptions are captured only at explicit boundaries.

## Analytics Events

Aptabase is removed. The existing lifecycle intent moves to typed PostHog
analytics events:

- first application start;
- account setup started, stage completed, succeeded, cancelled, or failed;
- proxy started;
- hourly proxy heartbeat.

Event names and properties are declared centrally. Every event disables person
profile processing. Setup and runtime failure logs may be queried alongside the
coarse analytics funnel, but analytics events do not carry raw log or exception
data. No `telemetry_disabled` event is emitted.

## Reliability and Shutdown

Telemetry initialization, capture, export, and shutdown are failure-isolated.
No telemetry exception propagates into proxy or CLI behavior. Export requests
have short timeouts, batches are bounded, timers are unreferenced where
possible, and exporter failures are not recursively reported remotely.

PostHog exporter requests are excluded from HTTP and Undici instrumentation to
prevent recursive spans. Optional SDK diagnostics remain local and are off by
default.

The PostHog Node client uses its custom `fetch` option as a final transport gate.
That function rechecks effective enablement immediately before any analytics or
exception request and returns a successful no-op response when disabled. A
`before_send` hook independently reconstructs analytics and SDK-generated
exception events from their closed outbound schemas, then drops an event if
telemetry is disabled or reconstruction fails. This second pass removes any
filesystem or source-context enrichment added inside the Error Tracking SDK.
Consequently,
PostHog-internal queued events receive the same late opt-out check as queued OTel
batches; only a request that already passed the gate and entered `fetch` is
considered in flight.

Graceful proxy shutdown saves tokens and stops refreshers as it does today, then
flushes enabled telemetry within a short fixed deadline. If telemetry became
disabled, pending queues are discarded without network activity. CLI setup
commands also perform a bounded flush before normal exit so short-lived failure
diagnostics are not routinely lost. A flush timeout never changes the command's
exit code.

Short-lived CLI analytics use `captureImmediate`, and handled short-lived
exceptions use `captureExceptionImmediate`, from a pinned `posthog-node` version
that supports those APIs. Fatal monitor capture remains best effort because the
monitor must not replace Node's crash semantics.

## Testing

### Privacy contract

Tests use distinctive canaries representing prompts, OAuth tokens, emails,
account IDs, hostnames, absolute paths, query strings, headers, raw upstream
responses, and exception messages. They pass those values through real
auto-instrumented HTTP, Express, and Undici flows and assert that the final
serialized OTLP trace/log bodies and PostHog SDK calls contain none of them.

Tests also prove that:

- only approved resource, span, log, analytics, and exception fields survive;
- generated span names and status descriptions are replaced;
- unknown instrumentation scopes are dropped;
- exception fingerprints remain stable across changing raw messages when the
  safe stack/context is unchanged;
- normalized stacks contain no home, workspace, or arbitrary dependency paths;
- unknown failures retain stack, grouping, safe context, and diagnostic ID;
- no account identifier is exported, including hashes.

### Enablement

Tests cover:

- fresh state defaults to enabled;
- existing enabled and disabled values are preserved;
- each environment kill switch prevents every outbound request;
- disabled startup initializes no SDK clients;
- turning off while records are queued makes gated exporters discard them;
- turning off sends no beacon;
- exporter and flush errors never escape.

### Tracing and propagation

Integration tests use local HTTP servers and a local OTLP capture server. They
prove that:

- supported automatic spans appear in the expected tree;
- excluded routes and exporter requests create no exported spans;
- malicious inbound trace headers cannot set IDs or force sampling;
- outbound provider requests receive no trace or baggage headers;
- deterministic trace IDs exercise sampled and unsampled decisions without
  probabilistic assertions;
- safe logs correlate when their trace is sampled;
- the built package's ESM bootstrap actually instruments Express and Undici.

### Setup diagnostics and errors

Tests exercise each account-add method and every meaningful failure stage. They
verify the expected provider/method/stage/reason tuple, diagnostic correlation,
expected-versus-unexpected split, and absence of raw response/error text.

Expected provider and validation failures must not create Error Tracking issues.
Unexpected parser, state, and persistence faults must create sanitized issues.

### Proxy transparency

Existing tests plus new integration coverage prove that instrumentation does not
consume or mutate requests, responses, SSE chunks, headers, status codes, chunk
ordering, timeouts, or concurrent stream behavior. Telemetry latency and export
failure cannot block request completion.

All Vitest, TypeScript lint, and production build checks must pass without
network access to PostHog.

## Documentation and Rollout

README, `docs/security.md`, CLI telemetry status output, the outbound-host list,
and the complete event inventory are updated in the same change. Documentation
states that telemetry is on by default, lists all three opt-outs, explains the
random installation UUID, describes every signal and allowed field category,
and discloses transport-level IP visibility.

PostHog Logs ingestion scrubbing is enabled as defense-in-depth, but the design
does not depend on it. Project settings are checked to ensure GeoIP/person
processing is disabled where applicable.

Before release, synthetic validation in the EU project confirms:

- sampled proxy waterfalls appear;
- approved logs correlate with sampled spans;
- setup failures form the expected stage/reason funnel;
- sanitized unknown exceptions group by safe fingerprint and expose a
  diagnostic ID;
- lifecycle events create no person profiles;
- deliberate canary secrets are absent from traces, logs, events, and Error
  Tracking.

The release is blocked if any canary appears remotely or if the packaged ESM
runtime does not produce the expected automatic spans.

## References

- [PostHog distributed tracing](https://posthog.com/docs/distributed-tracing/start-here)
- [PostHog Node.js tracing installation](https://posthog.com/docs/distributed-tracing/installation/nodejs)
- [PostHog Node.js logs installation](https://posthog.com/docs/logs/installation/nodejs)
- [PostHog Node.js error tracking](https://posthog.com/docs/error-tracking/installation/node)
- [PostHog Logs PII scrubbing](https://posthog.com/docs/logs/pii-scrubbing)
- [OpenTelemetry JavaScript instrumentation libraries](https://opentelemetry.io/docs/languages/js/libraries/)
