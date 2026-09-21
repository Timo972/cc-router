# Persistent Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship restart-persistent token history and subscription savings through `cc-router usage`, with period tabs, filtered stacked bars and a daily activity grid.

**Architecture:** A local journal stores cumulative attempt observations and compacts settled attempts into hourly aggregates. A pure query layer prices usage from frozen rates and prorates effective-dated subscription costs. The proxy is the single writer; the CLI queries its authenticated API or reads the local store offline. Account metadata remains private and ephemeral.

**Tech Stack:** TypeScript, Node >=22, existing React 18 / Ink 5, Commander and Vitest. No native database or new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-16-persistent-usage-design.md`

## Global Constraints

- Preserve routing and process-local health counter semantics; never make a persistence failure fail an upstream request.
- Persist no credentials, profile objects, email, workspace names, prompts or response bodies.
- UTC calendar boundaries, Monday-start weeks, current month by default; USD estimates only.
- Cache reads are separate from uncached input. Unknown rates or costs are never zero.
- Stored API rates are immutable historical snapshots. Negative savings are visible.
- Changes stay in the isolated worktree. No commits, pushes, merges or live daemon changes without a separate request.
- Test-first for each feature slice; record red and green commands. Agent workers edit files directly, list changed paths and do not spawn children.

## Task 1: Journal, identities, subscriptions and query model

**Files:** create `src/usage/{types,store,query,subscriptions}.ts` and `src/__tests__/usage-{store,query,subscriptions}.test.ts`. Pricing is injected through records; `src/usage/pricing.ts` is owned by the controller.

**Interfaces:** Define and export shared types from `types.ts`: `UsageProvider = "anthropic_subscription" | "openai_subscription" | "xai_subscription"`, `UsagePeriod`, `TokenCounts` (input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h), `UsageRates` (per-million rates for those categories, optional cache rates, source, effectiveDate), `UsageObservation` (version, attemptId, revision, ts, accountKey, provider, model, tokens, rates?, complete), `UsageAccount` (key, alias, provider, retired?), `Subscription` (accountKey, provider, monthlyUsd, from, to?), `UsageQuery` (period, date?, providers?), `UsageReport` (period, start, end, now, trackingSince?, buckets, days, totals, costs, accounts, warnings). Buckets carry `start`, `end`, `tokens`, and `series` keyed by provider/model. Costs expose pricedApiUsd, subscriptionUsd, nullable savingsUsd/percent and coverage counts/flags. Choose final exact shapes once, document exports in report, and use them throughout.

`UsageStore` provides synchronous `open(directory)`, static `read(directory)` without writes, `observe(observation)`, `account(provider, alias)`, `rename(provider, oldAlias, newAlias)`, `retire(provider, alias)`, `setSubscription(alias, amount, from)`, `endSubscription(alias, on)`, `snapshot()`, `compact()`, `close()`. Store constructor/open failures are caught by integration. All writes serialize synchronously; this deliberately avoids an asynchronous unbounded queue. `queryUsage(snapshot, query, now)` is pure. Data is validated at disk/API boundaries. Compaction retains active attempts, converts completed observations to hourly aggregates, and publishes an atomic manifest before retiring old segments; readers retry manifest changes. Store lock rejects concurrent writers and recovers only demonstrably dead local PIDs. Report storage failures/corruption explicitly. A torn last line can be recovered only by writer; offline readers do not repair files.

- [x] Write tests for replay/dedup, cumulative deltas, lock contention, torn tail and corruption, compaction restart, invalid numeric data, stable rename/retirement/name reuse, and subscription intervals. For example:
```ts
const first = UsageStore.open(dir);
const account = first.account("openai_subscription", "personal");
first.observe({ version: 1, attemptId: "a", revision: 1, ts: now,
  accountKey: account.key, provider: account.provider, model: "fixture", complete: false,
  tokens: { input: 40, output: 0, cacheRead: 60, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
first.close();
expect(UsageStore.read(dir).observations[0].tokens.input).toBe(40);
```
- [x] Run `pnpm exec vitest run src/__tests__/usage-store.test.ts` before implementation; record the missing-module/export failure.
- [x] Implement owner-only storage with versioned validated records, immutable generations and atomic manifest publication. Deduplicate by attempt/revision and reject malformed or decreasing token totals instead of manufacturing negative deltas. Bound model/alias and journal record sizes.
- [x] Write query tests using exact fixture rates: one million input at $2/million plus one million output at $8/million yields $10 API equivalent; a $31 subscription costs $1 for one full January day. Test leap-year February, Monday week, year boundary, incomplete current day, zero traffic with subscriptions, unknown pricing and unconfigured accounts.
- [x] Implement bucket generation, complete selected-year daily grid, provider/model series, frozen-price summation, UTC prorating and coverage. Providers with no observations but configured costs still contribute costs. An empty provider list means explicit empty selection; omitted means all.
- [x] Run all three new test files and `pnpm lint`; hand off exact type/API exports and limitations for independent review.

## Task 2: Pricing catalog and safe proxy integration

**Files:** create `src/usage/{pricing,runtime,http}.ts`, tests `usage-{pricing,runtime,http}.test.ts`; modify `src/config/paths.ts`, `src/proxy/{stats,server,anthropic-response-capture,usage-capture,account-rename}.ts` and request route modules only where necessary. Reuse account management paths rather than inventing profile fetches.

**Interfaces:** `lookupUsageRates(provider, model, tokens?)` returns a frozen `UsageRates | undefined`; exact model match/explicit documented aliases only. `startUsageRuntime(directory, accounts)` returns runtime with observation capture, snapshot/report, lifecycle alias methods and close. It wires a passive observer to token helpers with a WeakMap per LogEntry; attempt identity/provider/account key is bound at route attempt creation, not after response completion. `createUsageRouter(runtime)` mounts GET `/` and subscription list/set/end endpoints under authenticated `/cc-router/usage`.

- [x] Verify official API pricing with source/effective dates; if access fails, keep unknown models unpriced and support explicit local overrides rather than guess. Price tests use fixed fixtures, never fetched network data.
- [x] Write a failing runtime test: apply 100 total / 60 cached OpenAI input twice to one entry; persistent history must contain 40 uncached and 60 cached once. Anthropic split input/output produces one cumulative attempt. Output-less aborted streams preserve observed input.
- [x] Implement passive observation at existing usage helpers. Preserve nested Anthropic cache-write durations and actual response model when available. Complete attempts at settled/end boundaries, not merely first input callback. Do not silently treat xAI overview or LiteLLM metrics as measured token usage.
- [x] Integrate durable aliases with server account add/rename/delete and offline account rename handling. A rename write failure must roll back both sides; a crash between separate files requires a recoverable pending transition. Do not identify accounts by optional profile IDs or token hashes.
- [x] Write server tests for bearer authentication, invalid dates/providers, bounded query output, subscription interval conflicts, unsupported old server behavior and storage unavailable. Verify no private profile data is added to health/telemetry/history.
- [x] Wire service shutdown to sync/close writer; open failure exposes unavailable history without stopping routing. Register usage data path override and initial active aliases. Mark unsupported provider coverage explicitly.
- [x] Run targeted route/account/usage tests, plus lint. Review this task before final acceptance.

## Task 3: CLI and terminal dashboard

**Files:** create `src/cli/cmd-usage.ts`, `src/ui/{UsageDashboard,usage-chart}.tsx` (pure chart utilities may instead use `.ts`), `src/__tests__/usage-{cli,ui}.test.ts`; modify `src/cli/index.ts` to register command.

**Interfaces:** consume `UsageReport` and `queryUsage`; remote target resolution reuses `resolveStatusTarget`. `UsageDashboard` receives `load(query): Promise<UsageReport>`, initial query, and exit callback; it must not know filesystem details. CLI subscription commands match spec. JSON/static output avoid Ink initialization.

- [x] Write parser tests for period/date/provider validation and set/end/list subcommands. Test local offline reading, remote failure without local fallback and old-server 404 distinction.
- [x] Implement `cc-router usage [--period ...] [--date ...] [--provider ...] [--json] [--port ...]`. Prefer authenticated server and fall back locally only for local connection refusal/unreachable service, not auth or malformed responses. Use server endpoints for remote subscription writes; offline local writes require store lock.
- [x] Write deterministic chart tests: all stacked series conserve token totals, provider/model toggle changes stack grouping not totals, zero selection, legend overflow Other, leap-year day layout, narrow width and huge/small numbers.
- [x] Implement keyboard controls: Tab cycles period, arrows navigate periods, t returns current, provider-number toggles filter, m changes model differentiation, grid focus keys inspect a day, q exits. Show key help. Headers and warnings remain visible at small sizes. No uncontrolled wrap or periodic overlapping loads; stale query replies cannot overwrite newer selection.
- [x] Implement stacked Unicode bars and a Monday-first heatmap with zero/untracked/future distinctions and increasing brightness. Render exact focused day totals. Use stable colors, compact labels and bounded model legends.
- [x] Run targeted CLI/UI tests and lint; perform PTY checks at wide and narrow sizes, exercising all keys and checking clean exit/raw-mode restoration.

## Task 4: End-to-end review and documentation

**Files:** update `README.md`, `docs/{cli-reference,dashboard,architecture}.md`; add end-to-end fixture/tests under `src/__tests__` if needed. No changes to user credentials or live services.

- [x] Start an isolated fixture server with fake provider responses and temporary USAGE_DIR, issue usage-bearing requests, stop and restart, then compare JSON report totals and frozen costs. Verify local offline CLI sees the same totals.
- [x] Document subscription commands, per-period queries, filters/model controls, UTC, storage, pricing overrides, no backfill, partial coverage and sync durability.
- [x] Dispatch independent whole-diff review emphasizing lifecycle, account identity, journal corruption/compaction and financial-estimate correctness; fix findings with regression tests.
- [x] Run `pnpm lint && pnpm build && pnpm test && git diff --check`. Record exact counts and any unsupported runtime boundary.
- [x] Handoff worktree/branch, implemented capabilities, tests and residual limits. Do not commit, merge, push, publish or modify the installed daemon.


## Implementation outcome and verification

Implemented on `feat/persistent-usage`, based on `c71c9a1`, in the isolated
`.worktrees/persistent-usage` checkout. No commits, push, merge, publication or
installed-daemon changes were performed.

- Production typecheck: `pnpm lint` passed.
- Build: `pnpm build` passed.
- Full suite: `pnpm test` passed **109 files / 1,383 tests**.
- `git diff --check` passed.
- Independent core, pricing, CLI/UI and whole-branch reviews completed; all
  reported P2 findings were fixed and re-reviewed. No unresolved P1/P2 findings
  were established in the reviewed changes.
- Full-server OpenAI native/translated requests, authenticated subscription
  updates, rename, graceful restart, and real offline CLI execution preserve
  normalized tokens and frozen API estimates.
- Full-server native Anthropic loopback tests exclude token-count preflights,
  verify cumulative process/history output, preserve output reported before
  abort, and verify post-shutdown compaction/replay. This is not a second
  native-provider server-start test.
- Real PTY checks at 110x32 and 48x16 exercised filtering, model stacks, period
  switching, compact day inspection, keyboard help and clean exit. Focused Ink
  tests additionally cover resizing and full model-name inspection.
- The optional test-source typecheck has the identical **30 pre-existing errors**
  on base main and the feature checkout; no new test-source errors remain.

### Final contract refinements

- `UsageObservation.ts` uses canonical ISO UTC strings. Capture attributes
  usage to the upstream attempt start time.
- Optional `settled: true` distinguishes ended-incomplete attempts from active
  attempts. Compaction retains their measured tokens and a provider-scoped daily
  coverage gap rather than pretending the usage was complete.
- Account transitions have explicit recovery intent; read-only offline reports
  refuse unresolved transitions. Offline mutations recover/reconcile aliases
  before changing subscriptions.
- `l` opens a full model-name inspector; `?` opens keyboard help. Unique stack
  patterns supplement stable colors for monochrome terminals and color collisions.
- Non-inference preflights and unsent retry candidates never create inference
  gaps. Anthropic cumulative fields update process counters by difference.

### Remaining boundaries

API values are standard token-price estimates, not invoices. Missing prices,
unknown usage and unconfigured subscription intervals remain explicit. No
live-provider billing/OAuth, Windows/NFS, physical power-loss or sustained-load
acceptance was performed. Journal writes/fsync are synchronous; one local
200-attempt smoke measured approximately 8 ms per OpenAI attempt's capture.
Completed-attempt deduplication metadata remains retained indefinitely.
