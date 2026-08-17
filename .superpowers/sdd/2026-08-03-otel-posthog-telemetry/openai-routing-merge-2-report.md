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
