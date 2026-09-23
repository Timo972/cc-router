# Claude usage-limit reset — design

Status: draft for review · 2026-09-23

## Goal

Give Claude subscription accounts the same banked-reset support ChatGPT
accounts already have: the dashboard shows how many resets an account has
banked, and `Ctrl+R` spends one after confirmation.

Anthropic announced the feature on 2026-09-22 (Opus 5.5 launch: "Pro, Max, and
Team users get a reset to use anytime"). Claude Code 2.1.280 exposes it as
`/limit-reset`, internal program name `cedar_ember`, behind the
`tengu_cedar_ember` flag.

Success means an operator can, from the dashboard:

- see each Claude account's remaining resets and their use-by date,
- redeem one on a chosen account, including one that is not currently limited,
- retry a redemption with an unknown outcome without spending a second reset,
- see limits refilled and routing cooldowns released afterwards.

## Upstream contract (reverse-engineered, undocumented)

Taken from the Claude Code 2.1.280 bundle. On 2026-09-23 the status read was
confirmed against all six live accounts; nothing was claimed during research.

### Status

`GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`

The response is the normal usage payload plus a `cedar_ember` block. Claude
Code also adds `skip_spend=1`, which drops `extra_usage` and `spend`. We must
**not** send it, because the router parses `extra_usage`. Without
`cedar_ember=1` the block is `null`.

```json
"cedar_ember": {
  "eligible": true,
  "ineligible_reason": null,
  "at_limit": false,
  "exhausted": [],
  "grants": [{
    "id": "opus55-launch-promax-20260921",
    "label": "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
    "resets_total": 1, "resets_left": 1,
    "starts_at": "2026-09-22T16:00:00+00:00",
    "ends_at": "2026-10-22T16:00:00+00:00",
    "clears": ["five_hour", "seven_day", "seven_day_overage_included"],
    "paused": false, "usable_now": true, "use_requires_limit": false,
    "percent_used": { "five_hour": 9, "seven_day": 39 },
    "blocking": []
  }],
  "next_grant_id": "opus55-launch-promax-20260921",
  "weekly_resets_at": "2026-09-25T23:00:00+00:00",
  "cooldown_until": null,
  "event_props": { ... }
}
```

- **Surface gate.** Without a Claude Code User-Agent
  (`claude-cli/<version> (external, cli)`) the server answers
  `eligible: false, ineligible_reason: "surface"` with no grants.
- **Reason enum** (Claude Code's list): `config_off`, `tier`, `seat`, `mobile`,
  `surface`, `cli_version`, `no_grant`, `tenure`, `other_experiment`,
  `unavailable`.
- **ID shapes.** Grant id matches `^[a-z0-9_-]{1,40}$`. `next_grant_id` counts
  only when it names a grant in `grants`.

### Claim

`POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits`

The request uses the same bearer token, `anthropic-beta: oauth-2025-04-20`, and
the Claude Code User-Agent.

```json
{ "program": "cedar_ember", "grant_id": "<next_grant_id>", "request_id": "<uuid>" }
```

- **ID shape.** `request_id` matches `^[A-Za-z0-9_-]{1,64}$`. Claude Code
  generates a random UUID and reuses it when it retries an unconfirmed claim.
- **Response:**
  ```json
  {
    "result": "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable",
    "reason": "...",
    "resets_left": 0,
    "cleared": ["five_hour"],
    "weekly_resets_at": "...",
    "cooldown_until": "..."
  }
  ```
  Additional `reason` values: `paused`, `expired`, `unknown_grant`,
  `not_next_grant`, `grant_id_required`, `stamp_indeterminate`,
  `reset_unconfirmed`.
- **HTTP 429.** Claude Code treats a 429 as "couldn't confirm", not as "nothing
  used".
- **HTTP 401/403.** The call was not authorized, so nothing was spent.

## Decisions for review

1. **Present as Claude Code on usage and claim calls (recommended: yes).** The
   feature is unreachable otherwise.
   - This applies to *every* usage poll for Claude accounts, not only the
     redemption. The router already relays Claude Code traffic.
   - The version comes from a single pinned constant, `CLAUDE_CODE_UA_VERSION`,
     initially `2.1.280`.
   - If the server later answers `cli_version`, the dashboard says so, and
     bumping the constant is the fix.
   - Alternative: send the UA only on a dedicated status fetch. That doubles
     usage calls, and the claim needs the UA anyway.
2. **One fetch, not two.** Move the existing usage refresher to
   `?cedar_ember=1`. No separate status poll.
3. **Grant ids stay server-side.** The public snapshot carries counts, dates,
   and flags only. The route picks the grant.
4. **Only `cedar_ember`.** The bundle also has a `juniper_tide` program (a
   weekly session-reset experiment with `arm: control | reset`). Nothing in it
   applies to our accounts today, so it is out of scope.

## Design

### 1. Usage fetch and parse — `src/providers/anthropic/usage.ts`

- The endpoint becomes `…/api/oauth/usage?cedar_ember=1`.
- Headers gain `user-agent: claude-cli/${CLAUDE_CODE_UA_VERSION} (external, cli)`.
- `parseAnthropicUsage` gains `parseLimitResets(value.cedar_ember)`, which
  returns `LimitResetState | undefined`.
- **Fail closed.** A malformed block gives `undefined` (unknown), never a
  fabricated zero. A malformed grant is dropped. `next_grant_id` is kept only
  if it matches a parsed grant.
- **Snapshot field.** The result is stored on `AccountUsageSnapshot` as
  `limitResets?: LimitResetState` in `src/proxy/types.ts`:

  ```ts
  interface LimitResetGrant {
    id: string;              // server-side only
    resetsLeft: number;
    endsAt: number;          // unix s, 0 unknown
    clears: string[];        // window names, filtered to known ones
    usableNow: boolean;
    useRequiresLimit: boolean;
    paused: boolean;
  }
  interface LimitResetState {
    eligible: boolean;
    ineligibleReason?: string;   // known enum value or "unknown"
    grants: LimitResetGrant[];
    nextGrantId?: string;
    cooldownUntil: number;       // unix s, 0 none
  }
  ```

- **Memory only.** The usage snapshot lives only in memory. The 2026-09-16
  persistent store records token accounting, not rate-limit snapshots. Reset
  state is re-fetched on start like every other usage field; nothing is
  persisted.

### 2. Claim — `src/providers/anthropic/usage-reset.ts` (new)

```ts
export type ClaudeResetCode = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";
export interface ClaudeResetResult { code: ClaudeResetCode; resetsLeft?: number }
export class ResetNotSubmittedError extends Error {}   // 401/403: nothing spent

export async function consumeClaudeLimitReset(
  account: Pick<Account, "tokens">, orgUuid: string, grantId: string, requestId: string,
): Promise<ClaudeResetResult>
```

- **Before sending.** Validate `orgUuid`, `grantId`, and `requestId` against
  the shapes above. If any fails, throw `ResetNotSubmittedError` without
  sending.
- **Request.** 10 s timeout, `redirect: "error"`, and no body or error details
  in logs. This matches `consumeCodexResetCredit`.
- **401/403** → `ResetNotSubmittedError`.
- **2xx with a parseable `result`** → the mapped result.
- **Anything else is "outcome unknown"** (network, timeout, 429, 5xx,
  unparseable). This throws the same error as the ChatGPT path; the route turns
  it into a 502 and the caller retries with the **same** request id.

### 3. Route — generalize `src/proxy/account-usage-reset.ts`

`POST /cc-router/accounts/:id/reset-usage` stays the single endpoint.

- **Generic handler.** `createUsageResetHandler` becomes generic over the
  account type and result code:
  ```ts
  createUsageResetHandler<A extends object, R extends { code: string }>
  ```
  The in-flight guard, UUID validation, account-changed checks, and the
  refresh-after-spend flow stay as they are.
- **Dispatch.** `server.ts` registers one handler that dispatches by which pool
  owns `:id`: OpenAI accounts keep today's wiring, and Claude accounts get the
  new one.
- **Claude `prepare`:**
  - Refresh the OAuth token if `needsRefresh`. An `authExpired` or token-only
    account past expiry fails with 503 "not submitted".
  - Resolve the org UUID from `accountInfoCache.get(account).workspaceId`.
    Force `refreshOne` if it is missing, and fail with 503 if it is still
    missing.
- **Claude `consume`:**
  - The grant is chosen once per request id and remembered in the handler's
    existing per-account snapshot map.
  - On the first attempt it is `limitResets.nextGrantId` from the account's
    current snapshot. If there is none, reply 409 "No reset available" without
    sending.
  - On a replay of the same request id it reuses the original grant, even if
    `next_grant_id` has since moved. Otherwise a retry could spend a
    different grant.
- **Claude `refresh`:** force an Anthropic usage refresh through the existing
  `AnthropicUsageRefresher` (it plays the role `refreshAfterCurrent` plays for
  OpenAI).
- **Cooldowns.** No Claude-specific `captureReset`. A fresh usage snapshot
  showing refilled windows already retires usage-derived cooldowns (see
  `utilization()` in `usage.ts`). The plan must verify that with a test rather
  than assume it; if it doesn't hold, the plan adds the minimal release hook.
- **Response.** `{ reset: { provider, code, usageRefreshed, resetsLeft? } }`.
  The existing `CodexResetCode` responses gain `provider: "openai"`.

### 4. Public API — `server.ts` public mapping and `src/ui/accountsApi.ts`

`publicUsageSnapshot` adds:

```ts
limitResets?: {
  eligible: boolean;
  ineligibleReason?: string;   // sanitized enum
  available: number;           // sum of resets_left over non-paused grants, clamped 0..99
  usableNow: boolean;          // next grant usable_now
  requiresLimit: boolean;      // next grant use_requires_limit
  useBy: number;               // next grant ends_at, unix s
}
```

`accountsApi.resetUsage` accepts both code sets, keyed by `provider`.

### 5. Dashboard — `src/ui/Dashboard.tsx`

- **`rst` column** (`resetCreditsColumnLabel`) for Claude:
  - `available` when the account is eligible.
  - `—` when there is no status block or the account is ineligible.
  - Grok stays `—`.
- **`Ctrl+R`** is allowed for Claude accounts when
  `available > 0 && usableNow`, or when a pending retry id exists.
  - Ineligible: the banner states the reason. For `cli_version`: "Claude Code
    version too old for resets — update cc-router".
  - Usable only at a limit and the account isn't at one: "Reset only usable at
    a limit".
- **Confirmation line:**
  `Redeem 1 reset for "<id>"? Refills 5h + 7d limits · N left · use by <date>  [y] yes  [n/Esc] cancel`
  Window names come from the grant's `clears`.
- **Banner copy per Claude code:**
  - `reset` → "Limits reset for X · N left" (green)
  - `already_used` → "Reset already used for X · nothing more spent"
  - `not_limited` → "X is not at a limit · nothing used"
  - `cooldown` → "Resets are cooling down for X · try later"
  - `ineligible` / `unavailable` → "Reset unavailable for X · nothing used"
- **Unchanged ChatGPT flow.** Unknown-outcome and refresh-failed banners stay as
  they are. The retry-id-per-session behaviour is shared.

### 6. Docs

- `docs/dashboard.md`: rename the section to "Redeeming a usage reset" and
  cover both providers. The `rst` column row and the `Ctrl+R` keybinding stop
  saying "ChatGPT only".
- `CHANGELOG.md` entry. Note that the Claude contract is reverse-engineered and
  may break.

## Error handling summary

| Situation | Spent? | HTTP from route | UI |
|---|---|---|---|
| No grant / ineligible (pre-check) | no | 409 | yellow banner, reason |
| Token or org UUID unavailable | no | 503 | "credentials unavailable; reset not submitted" |
| Upstream 401/403 | no | 503 | same |
| Upstream result parsed | per `code` | 200 | per-code banner |
| Network / timeout / 429 / 5xx / unparseable | unknown | 502 | red "outcome unknown; Ctrl+R retries the same redemption" |
| Refresh after spend fails | yes | 200, `usageRefreshed: false` | "— usage refresh failed; reload with R" |

## Testing

- **`usage.ts` parse:**
  - Valid block.
  - `null` block.
  - Malformed block gives `undefined`, not zero.
  - A malformed grant is dropped.
  - A dangling `next_grant_id` is ignored.
  - Unknown `clears` entries are filtered out.
  - Fetch sends `?cedar_ember=1` and the UA, and never sends `skip_spend`.
- **`usage-reset.ts`:**
  - Request shape: URL, body, headers, `redirect: "error"`.
  - Each `result` maps to its code.
  - 401/403 give not-submitted.
  - 429, 5xx, network, and bad JSON give unknown.
  - Malformed ids never send.
- **Route:**
  - Claude dispatch.
  - Org UUID resolution, including the forced refresh.
  - A replay reuses the original grant after `next_grant_id` changes.
  - The in-flight guard.
  - Refresh after `reset`.
  - OpenAI behaviour unchanged (existing tests stay green).
- **Cooldown release:** a Claude account benched on the 5h window is released by
  a post-reset snapshot showing 0% utilization.
- **Public mapping:** clamping, and grant ids never exposed.
- **Dashboard:**
  - `rst` label for Claude when eligible, ineligible, or without status.
  - `Ctrl+R` gating and banners.
  - Confirm text.
- **Test isolation:** tests must mock network and account persistence. See the
  memory note on tests touching the real `accounts.json`.

## Out of scope

- The `juniper_tide` program, and automatic reset-on-limit (Claude Code's
  auto-continue).
- Auto-redeeming from the router when every account is limited. This could be a
  later option, but spending entitlements without the operator should be an
  explicit opt-in feature of its own.
- A CLI command (`cc-router accounts reset <id>`). The dashboard is the only
  entry point, as for ChatGPT.
