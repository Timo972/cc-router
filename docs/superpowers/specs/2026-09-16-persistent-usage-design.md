# Persistent usage and subscription savings

Date: 2026-09-16
Status: implemented and verified; see the implementation plan for evidence and boundaries.

## Goal

Add `cc-router usage`: persistent token accounting, API-equivalent cost and
subscription savings, an interactive stacked bar chart, and a GitHub-style
daily activity grid. Usage survives service restarts and is independent of
optional telemetry.

## Existing integration points

Rechecked against merged PR #44, `origin/main` at `c71c9a1`, including the
follow-up that removes unsupported billing intervals. Local `b9af6c9` has
the same tracked tree as that merge.

- `src/proxy/stats.ts` owns process-local counters and token application helpers.
- `src/proxy/anthropic-response-capture.ts` observes Anthropic response usage.
- `src/proxy/responses-server.ts` and `src/proxy/messages-cross-route.ts`
  apply OpenAI usage for native Responses and translated Messages traffic.
- `src/cli/cmd-status.ts` resolves local versus remote targets and launches Ink.
- `src/config/paths.ts` defines storage locations and environment overrides.
- `src/proxy/server.ts` enforces authentication for internal endpoints.
- `src/providers/account-info.ts` already defines and sanitizes `AccountInfo`,
  including provider identity, workspace, plan, subscription metadata and
  freshness. Reuse this contract for display; do not invent a second one.
- `src/providers/account-info-fetch.ts` fetches Claude profile information,
  ChatGPT workspace/usage information and Grok plan metadata. Do not add
  duplicate upstream metadata requests to usage capture or queries.
- `src/proxy/account-info-cache.ts` owns the memory-only metadata cache:
  five-minute successful-entry TTL, one-minute retry cadence, credential
  fingerprint invalidation and shutdown cancellation.
- `GET /cc-router/accounts` supplies cached private metadata with `no-store`;
  `/cc-router/refresh` already forces its refresh. Reuse
  `src/ui/accountsApi.ts` for account selection/display, and the existing
  `src/cli/cmd-accounts.ts` account-info presentation conventions.
- `src/proxy/account-rename.ts`, the account PATCH handler in
  `src/proxy/server.ts`, and `src/config/manager.ts` account mutations are
  lifecycle integration points for durable usage-account identity.

Keep existing status counters process-local for compatibility. Add historical
accounting alongside them rather than changing their meaning.

### What account metadata does and does not provide

Claude supplies account/workspace identity, plan, subscription status,
subscription creation date and trial end when available. ChatGPT supplies
identity/workspace/plan information, with token-claim fallbacks explicitly
treated as display hints. Stored Grok accounts currently supply plan only.

None of these integrations supplies the subscription amount paid. Billing
interval is intentionally unsupported. Claude `subscription.startedAt` is
subscription creation, not the current paid period start. Optional period and
renewal fields in the shared type do not imply that current fetchers populate
them. Therefore retain explicit effective-dated monthly USD cost configuration;
never derive paid cost or billing boundaries from plan names, token expiry,
usage resets or subscription creation dates.

The metadata cache is keyed by provider plus mutable account name, with a
credential fingerprint for invalidation. It is not a durable identity registry.
Provider account/workspace IDs are optional; email and token fingerprints must
not become historical keys. Introduce an opaque durable usage identity with
explicit alias lifecycle handling. Rename preserves it; deletion retains its
historical ledger; adding a new account under a deleted name does not
automatically inherit the previous ledger or subscription. Capture that
identity at attempt start so an in-flight rename cannot change attribution.
Integrate alias changes with existing rename rollback semantics rather than
performing an unrelated best-effort write.

Keep private profile metadata ephemeral, as PR #44 specifies. Enrich live
usage account labels from the authenticated accounts API; offline history
uses its local opaque identities/aliases and configured costs without
persisting email, workspace names, provider profile objects or credentials.
Unavailable/stale metadata must never block token capture, rewrite history,
or invalidate explicitly configured subscription costs.

## Storage and capture

Use a versioned append-only JSONL journal under `~/.cc-router/usage/`, with a
`USAGE_DIR` override. Only the service writes usage. Offline CLI reads must
never repair, truncate, or compact files.

Persist bounded records containing request/attempt identity, timestamp,
provider, stable account identity, served model, normalized token categories,
pricing snapshot, and observation completeness. Do not persist credentials,
prompts, responses, arbitrary error messages, or request bodies.

Capture usage from actual provider observations, not requested output limits
or estimates. Anthropic input, cache reads, and cache creation are disjoint.
OpenAI cached input is subtracted from total input before recording the
uncached category. Preserve cache-write duration categories when supplied.
Unavailable usage is unknown, not zero.

Treat observations as cumulative snapshots keyed by attempt and revision.
Apply only the difference from the previous snapshot, including across replay;
repeated callbacks must not double-count. Persist input observations even
when an output stream later aborts. Count distinct upstream attempts when each
reports usage, but never count the same attempt twice through translation.
Attribute by actual provider/served model rather than model-name guesses.

Use a serialized, bounded writer with explicit persistence-health reporting.
Drain and sync pending writes on graceful shutdown. Unexpected termination can
lose unflushed observations; expose the durability boundary rather than claim
crash-proof capture. A storage failure must not fail a routed request, and
must make historical totals visibly incomplete.

Replay valid records after restart. Ignore only a torn final line, with a
visible recovery warning; other corruption must be reported, not silently
discarded. Do not overwrite unreadable history.

Compact completed journal segments into hourly aggregates by provider,
account, model, token category, and pricing snapshot. Publish an atomic
manifest pointing to immutable aggregate and journal generations; only then
retire covered segments. Readers use a consistent generation. Retain the
active segment and its deduplication state. Refuse a competing writer for the
same store rather than permit double counting or corruption.

Hourly aggregates use UTC; all calendar queries and labels use UTC in v1.
This makes historical boundaries independent of machine timezone and DST.
Do not offer arbitrary timezone rebucketing from hourly aggregates.

## Pricing and subscription configuration

API-equivalent cost uses separate uncached input, cached input, cache-write
and output rates, expressed in USD per million tokens. Seed a versioned price
catalog only from official provider sources, with source URLs and effective
dates verified during implementation. Permit explicit model-rate overrides.
Store the applied rates with observations; catalog changes must not reprice
history. Do not infer unsupported model rates or cache-duration rates.

Subscription configuration contains account identity, provider, monthly USD
cost and effective start/end timestamps. Validate finite nonnegative costs,
date ordering, and non-overlapping entries for an account. Preserve historical
entries when an account is renamed or deleted. Account renames must not create
new subscriptions or erase historical attribution.

Expose configuration through:

```text
cc-router usage subscription set <account> --monthly-usd <amount> --from <YYYY-MM-DD>
cc-router usage subscription end <account> --on <YYYY-MM-DD>
cc-router usage subscription list
```

`set` closes the preceding interval at the new effective date and creates its
successor; ambiguous overlapping historical edits are rejected. These commands
write separate owner-only subscription configuration, not authentication data.
In client mode they target the authenticated remote service, never local
subscription files. Local updates while stopped use exclusive access and
atomic replacement.

Prorate a monthly subscription across the actual length of each UTC calendar
month, then intersect its active interval with the requested period and now.
Include configured subscription costs on inactive days. Do not infer costs
from plan names or assume accounts with no configuration are free.

```text
net savings = API-equivalent cost - prorated subscription cost
savings percent = 100 * net savings / API-equivalent cost
```

Savings percentage is unavailable when API-equivalent cost is zero. Negative
savings remain negative. Missing rates or subscription configuration yield
explicit partial/unknown totals and suppress an authoritative net-savings
figure. Show priced subtotals and the reason coverage is incomplete.

History starts when tracking is enabled; do not fabricate past usage from the
100-entry activity log. Mark periods before that boundary as unavailable.
Periods intersecting known collection gaps show incomplete coverage.

## Query and CLI contract

```text
cc-router usage
cc-router usage --period day|week|month|year --date YYYY-MM-DD
cc-router usage --provider <provider> --json
```

`--date` selects the containing calendar period. Weeks start Monday. Default
to the current month. Repeated provider flags select a subset; no flags select
all providers. Unknown values fail with an actionable error.

Expose a validated, authenticated `GET /cc-router/usage` endpoint returning
period boundaries, chart buckets, daily activity, normalized token totals,
cost totals, pricing/subscription coverage and storage health. Bound query
parameters and response size. Reuse the existing remote target and bearer
secret handling; do not leak history through unauthenticated health.

Local mode can read persisted history when the daemon is stopped. Client mode
never silently falls back to local data. Unsupported older servers and
unavailable remote servers produce distinct errors. `--json` returns the same
query model and exits without initializing Ink; non-TTY use emits readable
static output without raw keyboard handling.

## Terminal UI

Use existing Ink and React dependencies; do not add a browser dashboard.

- Header: selected period, tracking coverage and persistence health.
- Tabs: Day / Week / Month / Year; left/right navigation selects adjacent
  periods, and a shortcut returns to the current period.
- Summary: input, output, cache reads, cache writes, total tokens,
  API equivalent, subscription cost, net savings and savings percentage.
- Stacked bars: hourly for day; daily for week/month; monthly for year.
- Provider legend: individually toggleable providers; filter applies to all
  totals, bars, and heatmap. Allow an empty selection with an explicit state.
- Model differentiation toggle: split provider stacks by served model without
  changing totals or allocating subscription costs between models.
- Daily activity grid: selected calendar year, Monday-first week columns,
  month labels and a muted-to-bright token-intensity legend. Highlight the
  selected period and distinguish future/untracked days from known zero days.
- Keyboard focus on a grid day reveals exact date and token totals.
- Quit restores terminal input mode. Loading, empty, error, partial and
  unconfigured states are distinct.

Use stable colors and labels, not color alone. Bound legend rows and group
overflow models as Other without dropping their totals. Adapt to terminal
width/height; narrow terminals use a shorter heatmap window and compact chart
rather than wrap uncontrollably or hide controls.

Provider filters include all configured subscriptions for those providers,
including accounts without traffic. Model differentiation is visual only.

## Validation and acceptance

1. Replay across process restart produces identical totals and price snapshots.
2. Duplicate snapshots, repeated terminal events, retries, translated requests
   and aborted streams do not double-count or discard observed usage.
3. Torn-tail recovery, interior corruption, disk-write errors, writer contention,
   and interrupted compaction have explicit tested outcomes.
4. Test all supported routing paths; providers without real token observations
   show unsupported coverage instead of fabricated usage.
5. Test leap years, month/year boundaries, Monday weeks, partial current days,
   subscription changes, inactive paid days and missing prices/costs.
6. Provider filtering changes costs and tokens consistently; model stacks
   conserve totals. Zero baselines never produce NaN or infinity.
7. Test authenticated remote access, offline local reads, JSON/non-TTY output,
   invalid flags and subscription updates.
8. Exercise the TUI in a PTY: tabs, period navigation, toggles, heatmap focus,
   narrow/short resize, reconnect and clean quit.
9. Run the full test suite, type check, build and diff whitespace check.
10. Update CLI reference, dashboard documentation and README with configuration,
    estimation limits, durability and the no-historical-backfill boundary.
11. Preserve account-info privacy tests: neither health nor telemetry contains
    identity metadata; usage journals and aggregates do not copy profile data.
    Test cache expiry, credential rotation, unavailable metadata, in-flight
    rename, rename rollback, deletion/name reuse and workspace differentiation
    without treating optional provider IDs as a universal durable key.

## Non-goals

No telemetry requirement, automatic billing import, exchange-rate conversion,
subscription invoice reconciliation, fabricated pre-installation history,
arbitrary-timezone queries, or model-level subscription allocation.
