# OpenTelemetry and PostHog Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Preserve
> RED/GREEN evidence for every task and do not combine privacy-boundary tasks.

**Goal:** Replace Aptabase with default-on, fully disableable, privacy-safe
OpenTelemetry traces/logs and PostHog EU analytics/error tracking, including
actionable account-setup failure diagnostics.

**Architecture:** A small ESM CLI bootstrap registers the OTel loader hook before
application imports. Proxy runtimes then start only the HTTP, Express, and Undici
instrumentations; setup commands start a lightweight logs/PostHog client. Typed
application helpers accept closed schemas, and final exporters reconstruct new
allowlisted records before any network call. A persistent random installation
UUID correlates repeated failures without creating PostHog Person profiles.

**Tech Stack:** TypeScript ESM, Node.js 22+, Express 4, native `fetch`,
OpenTelemetry JS, OTLP HTTP/protobuf traces, OTLP HTTP logs, `posthog-node`,
Vitest 4, pnpm.

**Design:**
`docs/superpowers/specs/2026-08-03-otel-posthog-telemetry-design.md`

## Global Constraints

- Prompts, message/tool content, request/response bodies, headers, URLs, query
  strings, credentials, OAuth payloads, account IDs, Claude session IDs,
  hostnames, absolute paths, raw error messages, and arbitrary properties must
  never reach a telemetry transport.
- Treat the final serialized OTLP/PostHog request as the privacy boundary. Type
  safety and in-place redaction are insufficient.
- Only HTTP, Express, and Undici automatic instrumentation is allowed. Do not
  install the broad Node auto-instrumentation bundle or console instrumentation.
- The only cross-event identity is the existing random installation UUID. Use
  it as PostHog `distinctId` and OTel `service.instance.id`; never call identify,
  alias, group, person-property, or replay APIs, and always set
  `$process_person_profile: false`.
- Disable GeoIP in PostHog configuration and on every analytics/exception event.
- Fresh telemetry state is enabled. Existing persisted `enabled: false` remains
  disabled. `DO_NOT_TRACK=1` and `CC_ROUTER_TELEMETRY=0` can only disable.
- Every capture, queue flush, exporter, and PostHog transport rechecks effective
  enablement. Turning telemetry off emits no beacon and drops queued data.
- Normal root traces use parent-based 10% trace-ID-ratio sampling. Safe logs,
  setup diagnostics, analytics, and sanitized exceptions are not sampled.
- Use a no-op network propagator. Never accept inbound trace context or inject
  trace/baggage headers into provider requests.
- Telemetry must not change status, headers, payload bytes, SSE chunk ordering,
  timing, retries, exit codes, or crash semantics.
- Telemetry initialization, capture, export, and shutdown failures are swallowed
  at the telemetry boundary and remain locally diagnosable only.
- No test may contact PostHog, Anthropic, OpenAI, or any other external service.
- All production changes begin with a focused failing test. Each task ends with
  a focused test, `pnpm lint`, and a small commit.

## Target Module Boundaries

Create `src/telemetry/` with these focused modules:

- `constants.ts`: EU endpoints, public project-token validation, timeouts, batch
  limits, signal names, and instrumentation scope names.
- `contracts.ts`: closed enums and discriminated payload types for resources,
  spans, logs, analytics events, setup diagnostics, and exceptions.
- `privacy.ts`: runtime validators, bounded-number helpers, model normalization,
  stack normalization, fingerprints, and record reconstruction.
- `posthog-client.ts`: lazy client ownership, `before_send`, gated `fetch`,
  immediate CLI capture, bounded flush, and shutdown.
- `otel-exporters.ts`: reconstructive span/log exporters that delegate only safe
  copies and drop unknown scopes or disabled batches.
- `runtime.ts`: SDK lifecycle, explicit resource, sampler, propagator,
  instrumentation configuration, active-span helpers, and fatal monitor.
- `facade.ts`: the only application-facing typed capture API.
- `setup-diagnostics.ts`: setup attempt context, typed failure classification,
  expected-failure logs, and unexpected sanitized exception capture.

No application module may import `posthog-node`, an OTLP exporter, or an OTel
SDK package directly. OTel API-only imports are allowed only inside the facade
and runtime helpers.

---

### Task 1: Add Dependencies and Lock the Test Seams

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Create: `src/__tests__/telemetry-test-helpers.ts`

- [ ] **Step 1: Add the explicit runtime dependencies**

Run:

```bash
pnpm add \
  @opentelemetry/api \
  @opentelemetry/api-logs \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/instrumentation \
  @opentelemetry/instrumentation-express \
  @opentelemetry/instrumentation-http \
  @opentelemetry/instrumentation-undici \
  @opentelemetry/resources \
  @opentelemetry/sdk-logs \
  @opentelemetry/sdk-node \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/semantic-conventions \
  posthog-node
```

Use one compatible OTel release family in the lockfile. Do not add
`@opentelemetry/auto-instrumentations-node`.

- [ ] **Step 2: Create transport-capture test helpers**

Add helpers that start loopback HTTP servers, collect request method/headers/raw
bytes, expose parsed JSON when applicable, and fail if a request leaves
loopback. Add a canary set containing a fake prompt, bearer token, email,
account ID, hostname, home path, query string, header value, raw provider body,
and raw exception message.

- [ ] **Step 3: Add telemetry modules to coverage**

Extend `vitest.config.ts` coverage includes with `src/telemetry/**/*.ts`. Keep
CLI files excluded, but cover the bootstrap through a child-process integration
test later in the plan.

- [ ] **Step 4: Verify the dependency/test baseline**

```bash
pnpm install --frozen-lockfile
pnpm test -- src/__tests__/telemetry.test.ts
pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/__tests__/telemetry-test-helpers.ts
git commit -m "test: add telemetry transport harness"
```

---

### Task 2: Make Enablement Default-On Without Losing Opt-Outs

**Files:**

- Modify: `src/config/telemetry.ts`
- Modify: `src/__tests__/telemetry.test.ts`
- Modify: `src/cli/cmd-telemetry.ts`

- [ ] **Step 1: Replace opt-in assertions with migration tests**

Cover fresh/malformed state defaulting to enabled, missing `enabled` defaulting
to enabled, existing `true` and `false` preservation, stable install UUID,
atomic rewrites when fields are repaired, and both environment kill switches.
Prove environment values cannot force a persisted opt-out on.

- [ ] **Step 2: Run RED**

```bash
pnpm test -- src/__tests__/telemetry.test.ts
```

Expected: fresh and missing-field cases fail because the current default is
off.

- [ ] **Step 3: Implement one authoritative effective-state function**

Change `defaultState()` and missing-field migration to `enabled: true`. Preserve
valid stored booleans exactly. Keep malformed-state behavior equivalent to a
fresh install. Export a snapshot helper that returns persisted state plus the
effective enabled value so callers do not reimplement precedence.

- [ ] **Step 4: Update CLI status and live-disable messaging**

State that telemetry is on by default, distinguish persisted versus environment
disablement, explain that turning an already-running daemon off stops new
outbound telemetry immediately, and explain that turning on a daemon that
started disabled requires restart. Keep opt-out free of telemetry calls.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry.test.ts
pnpm lint
git add src/config/telemetry.ts src/__tests__/telemetry.test.ts src/cli/cmd-telemetry.ts
git commit -m "feat: default anonymous telemetry to enabled"
```

---

### Task 3: Define Closed Schemas and the Reconstructive Privacy Contract

**Files:**

- Create: `src/telemetry/constants.ts`
- Create: `src/telemetry/contracts.ts`
- Create: `src/telemetry/privacy.ts`
- Create: `src/__tests__/telemetry-privacy.test.ts`

- [ ] **Step 1: Write table-driven schema rejection tests**

For every signal, pass extra keys, unknown enum values, overlong strings,
unbounded numbers, nested objects, arrays, canaries, URLs, and absolute paths.
Assert reconstruction either returns a new closed object or drops the record.
Assert the input object is never returned or mutated.

- [ ] **Step 2: Define exact contracts**

Declare unions for runtime mode, provider, route, request source, model family,
operation, method, setup stage/reason, outcome, stream outcome, error kind, and
severity. Define per-event interfaces rather than `Record<string, unknown>`.
Centralize bounded counters/durations and map only unknown attribute values to
`other`; never map an unknown failure itself to a discarded generic event.

- [ ] **Step 3: Reconstruct safe resource/span/log/event objects**

Allow only the resource and signal fields in the design. Replace operation
names. Discard original resource attributes, span events, links, status
descriptions, URLs, headers, network fields, and unknown instrumentation scopes.
Keep only normalized trace/span IDs and parent relationships needed for a
waterfall.

- [ ] **Step 4: Prove canary absence**

Serialize every reconstructed result and assert no canary occurs. Include an
account ID and its common digest encodings to prove no raw or hashed account
identity is accepted.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry-privacy.test.ts
pnpm lint
git add src/telemetry/constants.ts src/telemetry/contracts.ts src/telemetry/privacy.ts src/__tests__/telemetry-privacy.test.ts
git commit -m "feat: define closed telemetry privacy schemas"
```

---

### Task 4: Sanitize and Group Unknown Exceptions Safely

**Files:**

- Modify: `src/telemetry/contracts.ts`
- Modify: `src/telemetry/privacy.ts`
- Create: `src/__tests__/telemetry-exceptions.test.ts`

- [ ] **Step 1: Write failing exception-sanitizer tests**

Use Errors with secret messages, nested causes, enumerable secret properties,
system codes, HTTP statuses, home/workspace paths, URL-like frames, dependency
frames, and changing raw messages. Assert the returned object is a new `Error`
with a fixed safe message, no cause/custom properties, only normalized
`dist/...` or package-relative dependency frames, a random diagnostic ID, and a
stable fingerprint when safe stack/context is unchanged.

- [ ] **Step 2: Cover unknown failures explicitly**

Prove an unexpected parser/state/persistence failure retains safe kind,
operation, stage, normalized stack, fingerprint, and diagnostic ID. Prove it is
not collapsed to a bare `other` log and that the raw message has no influence on
grouping.

- [ ] **Step 3: Implement normalization and fingerprinting**

Build the fingerprint only from safe error kind, closed context, and normalized
frames. Allowlist Node system error codes and exact numeric HTTP status. Strip
source context, variables, file URLs, current working directory, and arbitrary
package paths. Write the diagnostic ID to the existing detailed local error log
at capture call sites, not inside remote properties only.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry-exceptions.test.ts
pnpm lint
git add src/telemetry/contracts.ts src/telemetry/privacy.ts src/__tests__/telemetry-exceptions.test.ts
git commit -m "feat: sanitize telemetry exceptions"
```

---

### Task 5: Build the Gated PostHog EU Client

**Files:**

- Create: `src/telemetry/posthog-client.ts`
- Create: `src/__tests__/posthog-client.test.ts`

- [ ] **Step 1: Obtain and validate the project token safely**

Before implementation, obtain the user's EU PostHog project's public `phc_`
project token. Add only that public project token to `constants.ts`; stop if the
provided value is a personal `phx_` key. Never print the token in test output.

- [ ] **Step 2: Write client-boundary tests with a fake transport**

Assert EU host selection, GeoIP disablement, install UUID `distinctId`,
`$process_person_profile: false`, no identify/alias/group calls, immediate CLI
capture, bounded flush, and swallowed initialization/transport errors. Queue an
event, persist telemetry off, then assert the custom `fetch` returns a successful
no-op without touching the network.

- [ ] **Step 3: Test `before_send` against real SDK output**

Feed typed analytics events and sanitized Errors through `posthog-node`, then
inspect the final event after `before_send`. Rebuild analytics properties from
the exact event schema. For exceptions retain only the SDK fields required by
PostHog Error Tracking, the sanitized frames/value/type, fingerprint, safe
context, diagnostic ID, install UUID, and privacy flags. Drop malformed or
unknown events.

- [ ] **Step 4: Implement lazy client lifecycle**

Expose typed capture methods, a final gated fetch, `flushWithin(deadlineMs)`,
`shutdownWithin(deadlineMs)`, and `discardPending()`. Disable exception
autocapture and Express error middleware. Exclude the PostHog host from later
HTTP/Undici instrumentation.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test -- src/__tests__/posthog-client.test.ts src/__tests__/telemetry-exceptions.test.ts
pnpm lint
git add src/telemetry/constants.ts src/telemetry/posthog-client.ts src/__tests__/posthog-client.test.ts
git commit -m "feat: add gated PostHog EU client"
```

---

### Task 6: Add Reconstructive OTel Exporters

**Files:**

- Create: `src/telemetry/otel-exporters.ts`
- Create: `src/__tests__/otel-exporters.test.ts`

- [ ] **Step 1: Write fake-delegate exporter tests**

Pass unsafe `ReadableSpan` and log-record fixtures into wrapper exporters.
Assert delegates receive newly constructed records containing only approved
resource, timing, identity, trace linkage, operation, severity, body code, and
typed attributes. Assert unknown scopes and invalid records are dropped without
delegate calls.

- [ ] **Step 2: Test late opt-out and exporter failure**

Queue safe records, persist telemetry off before export, and prove the batch is
dropped. Make delegates throw/callback failure and prove no exception or
recursive telemetry escapes. Test force-flush/shutdown deadlines and disabled
queue discard.

- [ ] **Step 3: Add loopback serialization tests**

Point the official trace and log exporters at local capture servers. Send
reconstructed records through the real exporter stack and assert raw OTLP
request bytes contain the expected safe codes/IDs and none of the canaries.
Verify trace requests use HTTP/protobuf and log requests use the documented
HTTP transport.

- [ ] **Step 4: Implement EU delegates and wrappers**

Use full endpoints `https://eu.i.posthog.com/i/v1/traces` and
`https://eu.i.posthog.com/i/v1/logs` with bearer authentication. Keep endpoint
construction injectable for tests. Apply short timeouts and bounded batches.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test -- src/__tests__/otel-exporters.test.ts src/__tests__/telemetry-privacy.test.ts
pnpm lint
git add src/telemetry/otel-exporters.ts src/__tests__/otel-exporters.test.ts
git commit -m "feat: add privacy-safe OTLP exporters"
```

---

### Task 7: Start OTel Before ESM Application Imports

**Files:**

- Create: `src/cli/bootstrap.ts`
- Modify: `src/cli/index.ts`
- Create: `src/telemetry/runtime.ts`
- Modify: `src/cli/cmd-start.ts`
- Modify: `src/daemon/launcher.ts`
- Modify: `src/daemon/service.ts`
- Modify: `package.json`
- Create: `src/__tests__/telemetry-bootstrap.test.ts`

- [ ] **Step 1: Write the packaged-startup smoke test first**

Build and spawn the actual package binary against loopback Express and Undici
targets. Assert supported auto spans exist. Run a disabled variant and assert no
SDK/export requests occur. This test must execute compiled ESM, not `tsx` or a
direct import of telemetry modules.

- [ ] **Step 2: Implement a two-phase bootstrap**

Point `package.json#bin.cc-router` to `dist/cli/bootstrap.js`. In the bootstrap:

1. read only telemetry state and argv;
2. when an enabled `start` command may load the proxy, register
   `@opentelemetry/instrumentation/hook.mjs` through Node's supported ESM loader
   registration before importing CLI/application code;
3. dynamically import `index.js` and await an exported `runCli()`;
4. perform bounded lightweight flush in `finally` without changing exit status.

Change `index.ts` to export `runCli()` and use `parseAsync()`.

- [ ] **Step 3: Initialize the full SDK at the proxy boundary**

Immediately before `cmd-start.ts` dynamically imports `proxy/server.js`, call
`startProxyTelemetry(runtimeMode)`. Configure:

- explicit resource only and resource auto-detection disabled;
- parent-based `TraceIdRatioBasedSampler(0.1)`;
- no-op network propagator with local async context intact;
- only `HttpInstrumentation`, `ExpressInstrumentation`, and
  `UndiciInstrumentation`;
- ignore hooks for health/dashboard/account-management polling, updates,
  telemetry endpoints, and unrelated CLI traffic;
- reconstructive span/log processors from Task 6.

Registration may occur for a `start` launcher process, but the SDK must start
only when that process actually enters the foreground proxy path.

- [ ] **Step 4: Route every launch path through the bootstrap**

Update detached daemon, launchd, systemd, and Windows command construction to
use `bootstrap.js`. Add unit assertions for generated commands. Preserve all
existing port/accounts/server-mode arguments and environments.

- [ ] **Step 5: Add fatal monitoring without changing crashes**

Register `uncaughtExceptionMonitor` only while the proxy runtime is enabled.
Perform best-effort sanitized capture and never add an `uncaughtException` or
keep-alive `unhandledRejection` handler. Remove the monitor during shutdown.

- [ ] **Step 6: Verify and commit**

```bash
pnpm build
pnpm test -- src/__tests__/telemetry-bootstrap.test.ts
pnpm lint
git add package.json src/cli/bootstrap.ts src/cli/index.ts src/cli/cmd-start.ts src/daemon/launcher.ts src/daemon/service.ts src/telemetry/runtime.ts src/__tests__/telemetry-bootstrap.test.ts
git commit -m "feat: bootstrap OpenTelemetry before ESM imports"
```

---

### Task 8: Replace Aptabase With the Typed Telemetry Facade

**Files:**

- Create: `src/telemetry/facade.ts`
- Modify: `src/proxy/server.ts`
- Modify: `src/cli/index.ts`
- Delete: `src/utils/telemetry.ts`
- Modify: `src/__tests__/telemetry.test.ts`
- Modify: `src/__tests__/client-config-lifecycle.test.ts`

- [ ] **Step 1: Write facade tests**

Prove call sites cannot supply arbitrary event names/properties, disabled calls
are synchronous no-ops, first-start is emitted at most once by the process that
creates fresh telemetry state, proxy start/heartbeat use closed payloads,
heartbeat timers are unreferenced, and telemetry failures never escape. Prove
no `telemetry_disabled` event exists.

- [ ] **Step 2: Implement named facade methods**

Expose explicit methods for application start, proxy start, heartbeat, safe
log, setup stage, setup result, expected setup failure, unexpected exception,
active-span annotation, flush, and shutdown. Keep runtime dependencies behind
interfaces so tests use recorders without module mocking the SDK.

- [ ] **Step 3: Migrate lifecycle calls and remove Aptabase**

Replace `trackEvent`/`startHeartbeat` calls in `server.ts`, update affected test
mocks, and delete the Aptabase endpoint/key/client. Do not emit account count if
it bypasses the closed schema; retain the existing count only as a clamped
non-negative integer with a fixed upper bound.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry.test.ts src/__tests__/client-config-lifecycle.test.ts
pnpm lint
git add src/telemetry/facade.ts src/proxy/server.ts src/cli/index.ts src/__tests__/telemetry.test.ts src/__tests__/client-config-lifecycle.test.ts
git add -u src/utils/telemetry.ts
git commit -m "feat: replace Aptabase with typed PostHog telemetry"
```

---

### Task 9: Instrument Every Account-Setup Method at the Failure Site

**Files:**

- Create: `src/telemetry/setup-diagnostics.ts`
- Modify: `src/utils/token-extractor.ts`
- Modify: `src/utils/token-validator.ts`
- Modify: `src/providers/openai/account-record.ts`
- Modify: `src/providers/openai/device-oauth.ts`
- Modify: `src/cli/cmd-setup.ts`
- Modify: `src/cli/cmd-accounts.ts`
- Modify: `src/cli/cmd-status.ts`
- Modify: `src/__tests__/token-extractor.test.ts`
- Modify: `src/__tests__/openai-device-oauth.test.ts`
- Create: `src/__tests__/setup-diagnostics.test.ts`

- [ ] **Step 1: Add stage/reason matrix tests**

Cover Anthropic Keychain, credentials file, and manual token flows plus OpenAI
manual and device OAuth flows. Exercise source selection, read, parse,
validation, device-code request, authorization polling, token exchange, access
token parse, persistence, success, explicit cancellation, and unexpected
failure.

- [ ] **Step 2: Make low-level failures typed without losing local detail**

Return or throw a typed diagnostic classification at the failure site while
retaining the original cause/message solely for local UI/logging. Do not parse
human-readable error messages later. Include exact safe HTTP status and map
expected failures to the approved reason union.

For token extraction, add detailed result APIs while retaining compatibility
wrappers if other callers still need `OAuthTokens | null`. For device OAuth,
replace raw response-text-derived classification with typed stage/reason/status
errors; raw bodies may remain only in the local cause.

- [ ] **Step 3: Wrap setup attempts with one diagnostic context**

Generate one random diagnostic ID per add-account attempt. Emit unsampled stage
events/logs, success/cancellation/failure outcome, provider, method, duration
bucket, and safe reason. Never emit the prompted account ID, tokens, scopes,
device/user code, verification URL, filesystem path, or prompt answer.

- [ ] **Step 4: Split expected and unexpected failures**

Known validation/provider/user-cancellation failures create logs/funnel events,
not Error Tracking issues. Unexpected parser/state/persistence failures create a
sanitized exception with the same diagnostic ID and also print that ID beside
the detailed local error so a user can correlate a report.

- [ ] **Step 5: Flush short-lived commands safely**

Ensure `setup`, `accounts add`, `accounts add-openai`, `accounts login-openai`,
and the status UI's add-account path call bounded flush in `finally`. A flush
timeout or disabled state must not alter their exit code.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test -- src/__tests__/setup-diagnostics.test.ts src/__tests__/token-extractor.test.ts src/__tests__/openai-device-oauth.test.ts
pnpm lint
git add src/telemetry/setup-diagnostics.ts src/utils/token-extractor.ts src/utils/token-validator.ts src/providers/openai/account-record.ts src/providers/openai/device-oauth.ts src/cli/cmd-setup.ts src/cli/cmd-accounts.ts src/cli/cmd-status.ts src/__tests__/token-extractor.test.ts src/__tests__/openai-device-oauth.test.ts src/__tests__/setup-diagnostics.test.ts
git commit -m "feat: diagnose account setup failures safely"
```

---

### Task 10: Add Safe Proxy Trace Context and Runtime Diagnostics

**Files:**

- Modify: `src/telemetry/runtime.ts`
- Modify: `src/telemetry/facade.ts`
- Modify: `src/proxy/server.ts`
- Modify: `src/proxy/anthropic-proxy.ts`
- Modify: `src/proxy/responses-server.ts`
- Modify: `src/proxy/messages-cross-route.ts`
- Modify: `src/proxy/stream-lifecycle.ts`
- Modify: `src/proxy/token-refresher.ts`
- Modify: `src/providers/openai/codex-transport.ts`
- Modify: `src/providers/openai/token-refresher.ts`
- Modify: `src/providers/anthropic/usage-refresher.ts`
- Modify: `src/providers/model-discovery.ts`
- Create: `src/__tests__/telemetry-runtime.test.ts`

- [ ] **Step 1: Write deterministic trace and propagation tests**

Inject deterministic trace IDs on both sides of the 10% threshold. Prove roots
sample as expected and children inherit. Send malicious `traceparent`,
`tracestate`, and baggage headers to the local proxy; assert they cannot choose
the trace ID or force sampling. Assert outbound provider requests contain no
trace or baggage headers.

- [ ] **Step 2: Classify automatic spans locally**

Use instrumentation hooks and typed facade annotations to mark only approved
operations: proxy request, provider inference, OAuth refresh, usage refresh,
and model discovery. Derive route/provider/model family/request source/stream
flag locally, then pass only enums and bounded values. The reconstructive
exporter replaces auto-generated span names and drops unclassified spans.

- [ ] **Step 3: Record outcomes at existing lifecycle seams**

Annotate routing selection, upstream status, refresh result, usage result,
bounded token counts, duration, and terminal stream outcome where the code
already knows them. Never add body parsing solely for telemetry and never read
or buffer an extra byte. Expected 401/403/429/529/timeouts remain safe logs;
unexpected explicit boundaries also capture sanitized exceptions.

- [ ] **Step 4: Correlate logs only through active OTel context**

When a sampled trace is active, allow the OTel logger to attach trace/span IDs.
Do not synthesize a remote session ID. Outside a sampled trace, emit the same
safe standalone warning/error record.

- [ ] **Step 5: Make shutdown bounded and opt-out aware**

After existing token persistence and refresher stops, flush telemetry within a
short fixed deadline. If telemetry became disabled, discard all queues without
network calls. Preserve current SIGINT/SIGTERM behavior and exit status.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry-runtime.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/responses-server.test.ts src/__tests__/messages-cross-route.test.ts src/__tests__/stream-lifecycle.test.ts
pnpm lint
git add src/telemetry/runtime.ts src/telemetry/facade.ts src/proxy/server.ts src/proxy/anthropic-proxy.ts src/proxy/responses-server.ts src/proxy/messages-cross-route.ts src/proxy/stream-lifecycle.ts src/proxy/token-refresher.ts src/providers/openai/codex-transport.ts src/providers/openai/token-refresher.ts src/providers/anthropic/usage-refresher.ts src/providers/model-discovery.ts src/__tests__/telemetry-runtime.test.ts
git commit -m "feat: add sampled proxy runtime telemetry"
```

---

### Task 11: Prove End-to-End Privacy and Proxy Transparency

**Files:**

- Create: `src/__tests__/telemetry-privacy-integration.test.ts`
- Modify: `src/__tests__/telemetry-bootstrap.test.ts`
- Modify: `src/__tests__/anthropic-proxy.test.ts`
- Modify: `src/__tests__/responses-server.test.ts`
- Modify: `src/__tests__/messages-cross-route.test.ts`
- Modify: `src/__tests__/sse.test.ts`

- [ ] **Step 1: Drive canaries through real automatic instrumentation**

Run local HTTP/Express/Undici flows containing every canary in URL, query,
headers, body, response, account object, session header, hostname, error, and
stack path. Capture final OTLP/PostHog requests and assert no canary appears in
raw bytes or parsed payloads. Assert only approved endpoints are contacted.

- [ ] **Step 2: Exercise live disablement under queue pressure**

Hold exporter requests, enqueue traces/logs/events/exceptions, persist telemetry
off, release the queue, and prove no new request starts. Confirm an already
in-flight request is merely allowed to finish and is not described as
recallable. Confirm opt-out itself emits nothing.

- [ ] **Step 3: Prove repeat-failure correlation without profiles**

Capture the same sanitized exception twice with one install UUID and once with a
different UUID. Assert the first pair shares `distinctId` and fingerprint, the
third shares fingerprint but not `distinctId`, and all events set
`$process_person_profile: false`. Assert OTel resources use the corresponding
`service.instance.id`.

- [ ] **Step 4: Re-run byte-transparency coverage with telemetry enabled**

Compare status, headers, request bodies, non-stream responses, SSE bytes, chunk
order, terminal events, aborts, timeouts, and concurrent streams with recording
telemetry enabled, disabled, and failing. No assertion may normalize or re-emit
the stream.

- [ ] **Step 5: Test the packed artifact**

Run `pnpm pack`, install the tarball into a temporary prefix, start through the
installed `cc-router` binary, and prove ESM auto spans appear at the loopback
collector. Run again with each kill switch and prove silence. Inspect the
tarball to ensure bootstrap/hook-dependent runtime files and docs are included.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test -- src/__tests__/telemetry-privacy-integration.test.ts src/__tests__/telemetry-bootstrap.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/responses-server.test.ts src/__tests__/messages-cross-route.test.ts src/__tests__/sse.test.ts
pnpm lint
pnpm build
git add src/__tests__/telemetry-privacy-integration.test.ts src/__tests__/telemetry-bootstrap.test.ts src/__tests__/anthropic-proxy.test.ts src/__tests__/responses-server.test.ts src/__tests__/messages-cross-route.test.ts src/__tests__/sse.test.ts
git commit -m "test: prove telemetry privacy and transparency"
```

---

### Task 12: Document the Inventory and Validate the EU Project

**Files:**

- Modify: `README.md`
- Modify: `docs/security.md`
- Modify: `docs/troubleshooting.md`
- Modify: `CHANGELOG.md`
- Modify: `src/cli/cmd-telemetry.ts`
- Create: `docs/telemetry.md`

- [ ] **Step 1: Replace all Aptabase/opt-in documentation**

Document default-on behavior, persisted/env opt-outs, EU hosts, transport-level
source-IP visibility, install-level correlation, no Person profiles, no GeoIP,
10% normal-trace sampling, unsampled safe diagnostics, and the restart behavior
after enabling a daemon that started disabled.

- [ ] **Step 2: Publish the complete closed event inventory**

List every analytics event, log code, operation, setup provider/method/stage/
reason, exception field category, resource field, and bounded counter category.
Explicitly list forbidden data and explain that existing console/detailed local
logs are not forwarded.

- [ ] **Step 3: Update outbound-host and troubleshooting guidance**

Remove `eu.aptabase.com`; add only the PostHog EU ingestion hosts actually used.
Explain how a user can quote a diagnostic ID with their local log when reporting
an unknown failure. State that PostHog-side PII scrubbing is defense-in-depth,
not the primary filter.

- [ ] **Step 4: Run the complete offline gate**

```bash
pnpm test
pnpm lint
pnpm build
TELEMETRY_PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$TELEMETRY_PACK_DIR"
git status --short
```

Expected: all checks pass without external telemetry traffic and the worktree
contains only the intended documentation changes before the final commit.

- [ ] **Step 5: Validate synthetic data in the user's EU PostHog project**

With explicit project access and canary fixtures only:

1. enable Logs ingestion PII scrubbing as defense-in-depth;
2. confirm GeoIP/person processing is disabled where applicable;
3. verify a sampled proxy waterfall and correlated safe log;
4. verify setup stage/reason funnels for each add-account method;
5. verify repeated sanitized unknown exceptions share fingerprint and install
   `distinctId` while creating no Person profile;
6. search traces, logs, events, and Error Tracking for every canary;
7. block release if any canary appears or the packaged ESM span is missing.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/security.md docs/troubleshooting.md docs/telemetry.md CHANGELOG.md src/cli/cmd-telemetry.ts
git commit -m "docs: document privacy-safe telemetry"
```

## Final Verification and Handoff

- [ ] Re-run `pnpm test`, `pnpm lint`, and `pnpm build` from a clean worktree.
- [ ] Inspect `git diff main...HEAD` for accidental tokens, credentials, raw
  fixtures, generated archives, or unrelated changes.
- [ ] Confirm every telemetry import from application code goes through the
  facade/setup helpers; use `rg` to prove no direct PostHog/exporter imports.
- [ ] Confirm `rg -n "Aptabase|aptabase|telemetry_disabled"` returns only
  historical changelog context if intentionally retained.
- [ ] Confirm both disabled-start and live-opt-out tests observe zero new
  outbound requests.
- [ ] Record the EU project validation evidence without committing project
  credentials, user data, screenshots containing identifiers, or canary values.
- [ ] Use `superpowers:requesting-code-review`, address findings, then use
  `superpowers:finishing-a-development-branch` for delivery.
