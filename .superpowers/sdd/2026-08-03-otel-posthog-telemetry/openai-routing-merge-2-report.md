# OpenAI routing merge 2 report

Date: 2026-08-17
Branch: `agent/telemetry-rewrite`
Telemetry parent: `2a929a2e0ad508234788f28dc49ccde8b17fbba6`
OpenAI routing landing: `f1ab66dac55f58e8aa85eb88954800fafd0438fa`
Merged `origin/main` parent: `354445880bfcd9acec565eafc6b6d76728640d9b`
(the routing landing plus release-only changelog/version commits)
Merge commit: this merge commit (see Git metadata)

## Conflict decisions

| Conflict | Decision |
|---|---|
| `CHANGELOG.md` | Compose the telemetry and OpenAI routing notes in the same 0.10.0 release section, preserving the Added/Changed/Fixed categories from both parents. |
| `src/__tests__/openai-responses-collect.test.ts` | Keep main's terminal-event semantics and add back the telemetry parent's explicit byte/event bounds, cancellation, and classification-only observer shields. |
| `src/__tests__/openai-token-refresher.test.ts` | Keep main's rotated-credential dirty/retry, plan recomputation, and pool-health regressions; retain bounded shutdown/drain and privacy-safe telemetry regressions around the same lifecycle. |
| `src/config/manager.ts` | Keep main's scopes/caps and custom-path persistence, while retaining typed storage-read failures, atomic cross-provider uniqueness, and no overwrite on malformed storage. |
| `src/protocol/openai-responses-collect.ts` | Use main's completed/incomplete/failed/error semantics and shared terminal helpers, with the telemetry parent's 64 KiB streaming-event and 10 MiB collected-response bounds and classification-only streaming retention. |
| `src/providers/openai/codex-transport.ts` | Use main's abort-signal transport and non-OK content-type behavior; wrap the unchanged fetch lifecycle with closed provider telemetry only. |
| `src/providers/openai/token-refresher.ts` | Use main's pending-write durability, retry, plan, and recovery state machine; add closed telemetry at refresh boundaries and a bounded stopper that drains/aborts owned refresh work without changing dirty semantics. |
| `src/proxy/messages-cross-route.ts` | Use main's `runOpenAIIngress`, failure translation, cancellation, terminal semantics, and usage ownership; retain only route-level closed telemetry annotations at existing validation/relay seams. |
| `src/proxy/responses-server.ts` | Use main's `runOpenAIIngress`, safe header relay, cancellation, truthful final status, and single-read collectors; retain only route-level closed telemetry annotations and bounded observer behavior. |
| `src/proxy/server.ts` | Use main's OpenAI pool/router/health/account-state wiring and live persister; retain OTel lifecycle capture plus the idempotent update/signal exit coordinator, dual-provider persistence, bounded refresher drainage, and telemetry shutdown. |

## Auto-merge audit decisions

| File / area | Decision |
|---|---|
| `README.md`, telemetry docs, packaging | Retain PostHog/OTel privacy documentation, bootstrap artifacts, dependencies, and scripts; integrate main's OpenAI routing documentation without restoring Aptabase. |
| `src/__tests__/manager.test.ts` | Preserve both custom-path/caps coverage and typed-read/cross-provider-integrity shields. |
| `src/__tests__/responses-server.test.ts` | Preserve main's ingress/cancellation/terminal/header/routing regressions and adapt telemetry assertions to the centralized lifecycle without weakening body-read guarantees. |
| New OpenAI modules (`openai-ingress`, `openai-routing`, `failure-routing`, `account-state`, `token-pool`, `usage`) | Treat as main-owned state machines. Add observer-only telemetry at `openai-ingress`; do not duplicate routing, parsing, cooldown, persistence, or cancellation ownership. |

## RED/GREEN evidence

- The new composition regression was added before lifecycle adaptation. Its
  first run failed at import time because the in-progress merge still contained
  a token-refresher conflict marker; after the main state machine was selected
  and telemetry was added as a guarded observer, the composition/collector/
  refresher slice passed 51/51.
- OpenAI routing/state/ingress/collector/refresh/persistence/cancellation focused
  gate: 19 files, 343/343 tests passed.
- Telemetry runtime/privacy/bootstrap/setup/shutdown focused gate: 15 files,
  286/286 tests passed after updating stale pre-routing expectations to the
  authoritative local-502 and pool-cooldown behavior.
- The exact prior CI regressions both pass independently: Anthropic usage
  refresher staged timer (1/1) and installed packed-artifact ESM/offline
  bootstrap (1/1).

## Verification

- `NO_UPDATE_NOTIFIER=1 pnpm test`: 67 files, 1049/1049 tests passed (single
  full-suite run).
- `pnpm lint`: passed. `pnpm build`: passed.
- `src/__tests__/telemetry-bootstrap.test.ts`: 27/27 passed; its harness builds
  a clean tarball, installs it with `pnpm --offline`, launches through the ESM
  hook, and enforces literal-loopback-only telemetry capture and wire canaries.
- `git diff --check`: passed. Conflict-marker and stale-routing-import searches
  returned clean.

## Self-review

- Compared the resolution to both parents: main remains the owner of sticky
  selection, pool/account state, cooldowns, refresh retry/durability, request
  cancellation, response terminal semantics, and Retry-After/Codex headers.
- Telemetry observes only existing ingress/transport/refresh boundaries. Leaf
  ownership flags prevent duplicate diagnostics; injected/failing telemetry is
  swallowed and cannot change routing.
- Streaming relays and collected paths each have one body reader. The passive
  usage observer retains at most one 64 KiB line and recovers after a dropped
  oversized/malformed frame; collected responses are capped at 10 MiB.
- Client header relay is a closed allowlist (`content-type`, `retry-after`, and
  bounded Codex usage/cooldown families), independent of telemetry.
- Shutdown stops acceptance and refresh activity, drains both refresh loops,
  persists providers independently through the live OpenAI custom-path
  persister, then performs bounded telemetry shutdown; update and signals share
  the same idempotent coordinator.

## Concerns

No unresolved merge concern. The suite emits Node's existing `DEP0060`
deprecation warning. No real provider or PostHog endpoint was contacted; all
network validation used literal-loopback guards as required.

## Fix Round 1 — streaming delivery and bounded Messages translation

Date: 2026-08-17

### Review decisions

| Finding | Resolution |
|---|---|
| Native Responses and translated Messages ignored `write() === false` | Added one shared response-write primitive that waits for `drain`, races close/abort/error, removes listeners after settlement, and leaves upstream-reader cancellation with each relay. Both relays now stop reads and writes during backpressure, preserve byte/event order, and cancel once delivery terminates. |
| Messages retained unbounded non-SSE bodies, SSE remainder, and collected output | Reused the authoritative 10 MiB collected-response and 64 KiB event limits. All body branches use the same single-reader bounded read; Messages SSE now parses bytes incrementally, emits one event at a time, caps total collected bytes and translated output, cancels on overflow, and returns only closed safe failures. Streaming retains one bounded line plus closed terminal/usage state. |
| Bodyless 2xx Responses SSE could lose upstream ownership to a concurrent disconnect | Latch `upstreamReportedFailure` before either streaming or collected relay starts. Both modes retain an effective 502, increment account failure state once, avoid inventing a generic-502 cooldown, and emit only closed upstream-failure telemetry. |
| Same-ID OpenAI refresh-lock replacement | Confirmed inherited and intentionally left for its separate follow-up, per the round scope. |

### RED/GREEN evidence

- RED: 13 mechanism failures reproduced before production fixes: four
  backpressure/read-ahead failures, seven Messages bounds/privacy failures,
  and two bodyless ownership failures. Three split completed/incomplete/failed
  terminal shields were already green and remained unchanged.
- GREEN: all 18 added regressions pass, including drain resume, disconnect
  cancellation, non-OK/JSON/text bounds, unterminated-frame and collected-
  output overflow, split terminals, streamed overflow, bodyless streaming and
  collected accounting, and final telemetry-wire canaries.
- Complete relay gate: 2 files, 99/99 tests passed.
- OpenAI ingress/routing/state/response plus telemetry focused gate: 18 files,
  355/355 tests passed.

### Verification and audit

- `NO_UPDATE_NOTIFIER=1 pnpm test`: final gate passed 67 files and 1067/1067
  tests; the prior Anthropic staged-timer regression remains green. A prior
  completion run exposed an arbitrary 20 ms close in the new overflow test
  double under full-suite contention; replacing it with pull-driven EOF made
  cancellation deterministic without changing production behavior.
- `pnpm lint`, `pnpm build`, and `git diff --check`: passed.
- Packed offline bootstrap and final privacy-boundary audit: 2 files, 32/32
  tests passed. The installed tarball remains ESM-first, offline-installable,
  literal-loopback guarded, and free of request/upstream/account canaries.
- Self-review found one body reader per path, no duplicate translation or
  persistence/shutdown ownership, no direct relay writes outside the shared
  helper, no raw SSE/body/header/error/URL/identifier telemetry, and no change
  to main-owned sticky routing, failure routing, Retry-After, cooldown/LRU,
  refresh durability, cancellation, or terminal semantics.

### Fix Round 1 concerns

No unresolved round concern. The inherited same-ID refresh-lock observation is
still separate. Validation emitted only the existing Node `DEP0060` warning;
no external provider or PostHog traffic was permitted.

## Fix Round 2 — cancellation ownership and collected-delta cleanup

Date: 2026-08-17

### Review decisions

| Finding | Resolution |
|---|---|
| Client-aborted bounded JSON/text reads were reported as upstream failures | Threaded the ingress-owned abort signal into the existing single-reader body collector and added a closed `cancelled` result. Abort now cancels and joins the reader once, returns without synthesizing a response, and leaves final cancellation/account ownership with `runOpenAIIngress`; a reader rejection without that signal remains one safe upstream 502. |
| Non-string collected deltas could throw before reader cleanup | Validate every output-text delta before byte counting or concatenation. Number, object, array, or missing deltas stop collection as a closed malformed-upstream result, use one idempotent awaited cancellation path, and cannot reach response, console, safe-log, or exception fields. Normal string deltas and completed/incomplete/failed terminals retain the landed routing semantics. |
| Telemetry evidence was not injectable at the Messages composition boundary | Added the same test-only ingress telemetry dependency already supported by `runOpenAIIngress`. Regressions prove client abort emits cancellation annotations with zero failure diagnostics, while true reader/malformed failures emit exactly one closed safe log and zero exception/raw-value records. |

### RED/GREEN evidence

- RED: five mechanism failures before production adaptation: two client-abort
  cases missed reader cancellation and three non-string delta cases escaped
  before cancellation. The true-reader-fault control was already green.
- The five corresponding final-boundary assertions were then RED until the
  route passed its injected telemetry dependency through to the ingress.
- GREEN: all six added cases pass (JSON/text abort, true reader fault, and
  number/object/array deltas), including deferred cancellation join, lease and
  account/cooldown ownership, exact diagnostics, privacy canaries, and a
  normal completed string-delta control.

### Verification and audit

- Response/Messages/ingress/cancellation/telemetry focus: 60 suites, 433/433
  tests passed. Final full gate: 225 suites, 1073/1073 tests passed with
  `NO_UPDATE_NOTIFIER=1`.
- One attempted full command forwarded an unintended literal `--`; its JSON
  pipe exited before tests completed and Vitest ended with `EPIPE`. The corrected
  direct Vitest invocation above is the completed full-suite evidence.
- `pnpm lint`, `pnpm build`, and `git diff --check`: passed. Packed offline
  bootstrap/privacy gate: 6 suites, 32/32 tests passed with literal-loopback
  guards; no provider or PostHog endpoint was contacted.
- Self-review reconfirmed one body reader per path; idempotent cancellation and
  abort-listener cleanup; no read-ahead during backpressure; bodyless and
  explicit terminal failure ownership; bounded framing/body/output retention;
  and no changes to sticky routing, Retry-After, cooldown/LRU, refresh
  durability, persistence, or shutdown ownership.

### Fix Round 2 concerns

No unresolved round concern. The inherited same-ID refresh-lock observation
remains the separate follow-up required by the review ruling. Validation emitted
only the existing Node `DEP0060` warning.
