# Claude Usage-Limit Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show banked Claude usage-limit resets in the dashboard `rst` column and redeem one with `Ctrl+R`, mirroring the ChatGPT flow.

**Architecture:**
- **Status read.** The Anthropic usage fetch adds `?cedar_ember=1` and a Claude Code User-Agent. `parseAnthropicUsage` stores a fail-closed `limitResets` state on the usage snapshot.
- **Claim.** A new provider module posts to `/api/organizations/{org}/reset_rate_limits`.
- **Route.** The existing `/:id/reset-usage` handler becomes provider-generic. A Claude-specific consumer pins the grant to the redemption id, so a retry can never spend a different grant.
- **Health view.** A sanitized summary goes out through the health view to the dashboard.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Express, Ink/React dashboard, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-claude-limit-reset-design.md`. Read it before starting any task.

## Global Constraints

- Usage endpoint: `https://api.anthropic.com/api/oauth/usage?cedar_ember=1`. Never send `skip_spend` (it drops `extra_usage`).
- User-Agent on Anthropic usage and claim calls: `claude-cli/${CLAUDE_CODE_UA_VERSION} (external, cli)`, with `CLAUDE_CODE_UA_VERSION = "2.1.280"`.
- Claim: `POST https://api.anthropic.com/api/organizations/{orgUuid}/reset_rate_limits`, body `{ program: "cedar_ember", grant_id, request_id }`.
- ID shapes:
  - grant id `^[a-z0-9_-]{1,40}$`
  - request id `^[A-Za-z0-9_-]{1,64}$`
  - org UUID `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive)
- Claim result codes: `reset | already_used | not_limited | cooldown | ineligible | unavailable`.
- Claim outcomes:
  - 401/403 → not submitted.
  - Network, timeout, 429, 5xx or unparseable → outcome unknown. Never retry automatically, and never read or log upstream bodies.
- Grant ids never leave the router process. Health/public views carry counts, dates and flags only.
- Never decrement or fabricate reset counts locally. Only a fresh usage snapshot changes the displayed count.
- A malformed `cedar_ember` block parses to `undefined` (unknown), never to zero resets.
- Tests must mock `fetch` and never touch `~/.cc-router/accounts.json`.
- Run the suite with `env -u FORCE_COLOR pnpm test`. Typecheck with `pnpm lint`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Retry after unknown outcome while `next_grant_id` changed.** A retry with the same redemption id must post the *original* grant id (Task 4 test).
2. **Account without a profile scope or cached org.** A missing org UUID must stop before any POST, with 503 "not submitted", not 502 "unknown" (Task 4 and Task 5 tests).
3. **Claude account benched on the 5h window.** After a confirmed reset and a fresh 0% snapshot, the account must route again. An unrelated overload hold must survive (Task 5 integration test).
4. **Server stops offering resets** (`eligible: false` with `cli_version`). The dashboard shows `—` and a banner naming the reason; Ctrl+R never posts (Task 6 test).
5. **Upstream sends a grant list with a bad id or unknown `clears` names.** Bad grants are dropped, and unknown window names never reach the dashboard (Task 1 test).

---

### Task 1: Parse the `cedar_ember` reset status

**Files:**
- Modify: `src/proxy/types.ts` (add types next to `AccountUsageSnapshot`, add field)
- Modify: `src/providers/anthropic/usage.ts` (parser + wire into `parseAnthropicUsage`)
- Test: `src/__tests__/anthropic-usage.test.ts` (append a `describe`)

**Interfaces:**
- Produces, in `src/proxy/types.ts`:
  ```ts
  export type LimitResetWindow = "five_hour" | "seven_day" | "seven_day_overage_included" | "seven_day_opus" | "seven_day_sonnet";
  export interface LimitResetGrant {
    id: string; resetsLeft: number; endsAt: number; clears: LimitResetWindow[];
    usableNow: boolean; useRequiresLimit: boolean; paused: boolean;
  }
  export interface LimitResetState {
    eligible: boolean; ineligibleReason?: string; grants: LimitResetGrant[];
    nextGrantId?: string; cooldownUntil: number;
  }
  // AccountUsageSnapshot gains: limitResets?: LimitResetState;
  ```
- Produces, in `usage.ts`: `export function parseLimitResets(value: unknown): LimitResetState | undefined`.

- [ ] **Step 1: Write the failing tests** (append to `src/__tests__/anthropic-usage.test.ts`; import `parseLimitResets` alongside `parseAnthropicUsage`)

```ts
describe("parseLimitResets (cedar_ember)", () => {
  const grant = {
    id: "opus55-launch-promax-20260921", label: "launch", resets_total: 1, resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00", ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false, usable_now: true, use_requires_limit: false,
    percent_used: { five_hour: 9 }, blocking: [],
  };
  const block = {
    eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], grants: [grant],
    next_grant_id: grant.id, weekly_resets_at: "2026-09-25T23:00:00+00:00", cooldown_until: null,
    event_props: { surface: "claude_code_cli" },
  };

  it("parses an eligible block", () => {
    expect(parseLimitResets(block)).toEqual({
      eligible: true,
      grants: [{
        id: grant.id, resetsLeft: 1, endsAt: 1_792_684_800,
        clears: ["five_hour", "seven_day", "seven_day_overage_included"],
        usableNow: true, useRequiresLimit: false, paused: false,
      }],
      nextGrantId: grant.id,
      cooldownUntil: 0,
    });
  });

  it("treats null/absent/malformed blocks as unknown, never as zero resets", () => {
    expect(parseLimitResets(null)).toBeUndefined();
    expect(parseLimitResets(undefined)).toBeUndefined();
    expect(parseLimitResets({ grants: [] })).toBeUndefined(); // eligible missing
    expect(parseLimitResets("nope")).toBeUndefined();
  });

  it("keeps a known ineligible reason and maps unknown ones to 'unknown'", () => {
    expect(parseLimitResets({ eligible: false, ineligible_reason: "cli_version" })?.ineligibleReason).toBe("cli_version");
    expect(parseLimitResets({ eligible: false, ineligible_reason: "brand_new" })?.ineligibleReason).toBe("unknown");
    expect(parseLimitResets({ eligible: false, ineligible_reason: null })?.ineligibleReason).toBeUndefined();
  });

  it("drops malformed grants, filters unknown windows, and ignores a dangling next_grant_id", () => {
    const parsed = parseLimitResets({
      ...block,
      grants: [
        { ...grant, id: "Bad Id!" },
        { ...grant, resets_left: -1 },
        { ...grant, id: "other", clears: ["five_hour", "mystery_window", 3] },
      ],
      next_grant_id: grant.id, // points at the dropped grant
    });
    expect(parsed?.grants).toEqual([expect.objectContaining({ id: "other", clears: ["five_hour"] })]);
    expect(parsed?.nextGrantId).toBeUndefined();
  });

  it("defaults use_requires_limit to true when absent (the conservative reading)", () => {
    const { use_requires_limit: _omit, ...rest } = grant;
    expect(parseLimitResets({ ...block, grants: [rest] })?.grants[0]?.useRequiresLimit).toBe(true);
  });

  it("is attached to the usage snapshot", () => {
    const snapshot = parseAnthropicUsage({ five_hour: { utilization: 5 }, cedar_ember: block }, 1);
    expect(snapshot?.limitResets?.nextGrantId).toBe(grant.id);
    expect(parseAnthropicUsage({ five_hour: { utilization: 5 }, cedar_ember: null }, 1)?.limitResets).toBeUndefined();
  });
});
```

`1_792_684_800` is `Date.parse("2026-10-22T16:00:00+00:00") / 1000`. Verify with `node -e 'console.log(Date.parse("2026-10-22T16:00:00+00:00")/1000)'` and fix the literal if it differs.

- [ ] **Step 2: Run to verify failure**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/anthropic-usage.test.ts`
Expected: FAIL (`parseLimitResets` is not exported).

- [ ] **Step 3: Add the types** to `src/proxy/types.ts` (exactly the Interfaces block above). Add `limitResets?: LimitResetState;` to `AccountUsageSnapshot`, with the doc comment `/** Banked usage-limit resets (cedar_ember). Absent means unknown. */`.

- [ ] **Step 4: Implement the parser** in `src/providers/anthropic/usage.ts`, below `parseExtraUsage`:

```ts
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const RESET_WINDOWS: readonly LimitResetWindow[] = [
  "five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus", "seven_day_sonnet",
];
const INELIGIBLE_REASONS = new Set([
  "config_off", "tier", "seat", "mobile", "surface", "cli_version", "no_grant",
  "tenure", "other_experiment", "unavailable",
]);

function parseResetGrant(value: unknown): LimitResetGrant | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" && GRANT_ID.test(value.id) ? value.id : undefined;
  const left = value.resets_left;
  if (!id || typeof left !== "number" || !Number.isInteger(left) || left < 0) return undefined;
  const clears = Array.isArray(value.clears)
    ? RESET_WINDOWS.filter(window => (value.clears as unknown[]).includes(window))
    : [];
  return {
    id,
    resetsLeft: left,
    endsAt: resetAt(value.ends_at),
    clears,
    usableNow: value.usable_now === true,
    useRequiresLimit: value.use_requires_limit !== false,
    paused: value.paused === true,
  };
}

/** Parse the cedar_ember block. Unknown or malformed → undefined, never "zero resets". */
export function parseLimitResets(value: unknown): LimitResetState | undefined {
  if (!isRecord(value) || typeof value.eligible !== "boolean") return undefined;
  const grants = (Array.isArray(value.grants) ? value.grants : [])
    .map(parseResetGrant)
    .filter((grant): grant is LimitResetGrant => grant !== undefined);
  const next = typeof value.next_grant_id === "string" && grants.some(grant => grant.id === value.next_grant_id)
    ? value.next_grant_id
    : undefined;
  const reason = stringValue(value.ineligible_reason);
  return {
    eligible: value.eligible,
    ...(reason ? { ineligibleReason: INELIGIBLE_REASONS.has(reason) ? reason : "unknown" } : {}),
    grants,
    ...(next ? { nextGrantId: next } : {}),
    cooldownUntil: resetAt(value.cooldown_until),
  };
}
```

Add `LimitResetGrant`, `LimitResetState`, `LimitResetWindow` to the type import at the top. In `parseAnthropicUsage`, after `extraUsage`:

```ts
  const limitResets = parseLimitResets(value.cedar_ember);
  if (limitResets) snapshot.limitResets = limitResets;
```

Do **not** add `cedar_ember` to `USAGE_FIELDS`. A payload with only `cedar_ember` is not a usage payload.

- [ ] **Step 5: Run to verify pass**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/anthropic-usage.test.ts && pnpm lint`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/types.ts src/providers/anthropic/usage.ts src/__tests__/anthropic-usage.test.ts
git commit -m "feat(anthropic): parse banked usage-limit reset status"
```

---

### Task 2: Request reset status on every Claude usage poll

**Files:**
- Modify: `src/providers/anthropic/usage.ts` (endpoint, UA header, exported constant)
- Modify: `src/__tests__/anthropic-usage-refresher.test.ts:74` (expected URL and headers)
- Modify: `src/__tests__/fixtures/account-info-server.ts:20`, `src/__tests__/fixtures/usage-anthropic-server.ts:36` (URL match)

**Interfaces:**
- Produces, in `usage.ts`:
  - `export const CLAUDE_CODE_UA_VERSION = "2.1.280";`
  - `export const CLAUDE_CODE_USER_AGENT = \`claude-cli/${CLAUDE_CODE_UA_VERSION} (external, cli)\`;`
  - `export const OAUTH_BETA_HEADER` (make the existing constant exported).
- Task 3 imports these three.

- [ ] **Step 1: Update the failing expectation** in `src/__tests__/anthropic-usage-refresher.test.ts` around line 74:

```ts
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", expect.objectContaining({
      headers: expect.objectContaining({
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.280 (external, cli)",
      }),
```

Keep whatever else the existing assertion checks. Add one standalone test in the same file:

```ts
  it("never asks the usage endpoint to skip spend data (router reads extra_usage)", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ five_hour: { utilization: 1 } }));
    await fetchAnthropicUsage(/* reuse the file's account factory */ makeAccount(), { fetch });
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("skip_spend");
  });
```

Use the account factory that already exists in that file. If it has another name, use that name.

- [ ] **Step 2: Run to verify failure**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/anthropic-usage-refresher.test.ts`
Expected: FAIL on the URL.

- [ ] **Step 3: Implement.** In `usage.ts`:

```ts
const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Reset status is only offered to the Claude Code surface; bump when the server answers `cli_version`. */
export const CLAUDE_CODE_UA_VERSION = "2.1.280";
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_UA_VERSION} (external, cli)`;
```

Add `"user-agent": CLAUDE_CODE_USER_AGENT,` to the fetch headers in `fetchAnthropicUsage`.

- [ ] **Step 4: Fix the fixtures.** In both fixture files, change `url === "https://api.anthropic.com/api/oauth/usage"` to `url.startsWith("https://api.anthropic.com/api/oauth/usage")`. Grep for any other exact match: `git grep -n 'api/oauth/usage"' src/__tests__`.

- [ ] **Step 5: Run the full suite**

Run: `env -u FORCE_COLOR pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/anthropic/usage.ts src/__tests__
git commit -m "feat(anthropic): request reset status with the Claude Code surface"
```

---

### Task 3: Claim a Claude reset (provider call)

**Files:**
- Create: `src/proxy/reset-errors.ts`
- Create: `src/providers/anthropic/usage-reset.ts`
- Test: `src/__tests__/anthropic-usage-reset.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_CODE_USER_AGENT` and `OAUTH_BETA_HEADER` from Task 2.
- Produces, in `src/proxy/reset-errors.ts`:
  ```ts
  /** The redemption was provably never sent (or rejected before spending); safe to report as "nothing used". */
  export class ResetNotSubmittedError extends Error {
    constructor(readonly status: 409 | 503, message: string) { super(message); this.name = "ResetNotSubmittedError"; }
  }
  export const RESET_OUTCOME_UNKNOWN = "Reset outcome unknown; retry with the same redemption ID";
  ```
- Produces, in `usage-reset.ts`:
  ```ts
  export type ClaudeResetCode = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";
  export interface ClaudeResetResult { code: ClaudeResetCode; resetsLeft?: number }
  export function consumeClaudeLimitReset(account: Pick<Account, "tokens">, orgUuid: string, grantId: string, requestId: string, options?: { fetch?: typeof globalThis.fetch }): Promise<ClaudeResetResult>
  ```

- [ ] **Step 1: Write the failing tests** (`src/__tests__/anthropic-usage-reset.test.ts`)

```ts
import { describe, expect, it, vi } from "vitest";
import { consumeClaudeLimitReset } from "../providers/anthropic/usage-reset.js";
import { ResetNotSubmittedError } from "../proxy/reset-errors.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const GRANT = "opus55-launch-promax-20260921";
const REQ = "12345678-1234-4234-8234-123456789abc";
const account = { tokens: { accessToken: "sk-ant-oat01-secret", expiresAt: 0, scopes: [] } };

describe("Claude reset redemption", () => {
  it("posts the program, grant and request id with the Claude Code surface", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] }));
    expect(await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).toEqual({ code: "reset", resetsLeft: 0 });
    expect(fetch).toHaveBeenCalledWith(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`, expect.objectContaining({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ program: "cedar_ember", grant_id: GRANT, request_id: REQ }),
      headers: expect.objectContaining({
        authorization: "Bearer sk-ant-oat01-secret",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.280 (external, cli)",
        "content-type": "application/json",
      }),
    }));
  });

  it.each(["already_used", "not_limited", "cooldown", "ineligible", "unavailable"])("preserves %s", async code => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: code }));
    expect(await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).toEqual({ code });
  });

  it.each([401, 403])("reports %i as not submitted", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response("secret body", { status }));
    const error = await consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(503);
    expect(String(error.message)).not.toContain("secret");
  });

  it.each([
    () => new Response("secret", { status: 429 }),
    () => new Response("secret", { status: 500 }),
    () => new Response("not json"),
    () => Response.json({ result: "surprise" }),
  ])("treats unrecognised responses as outcome unknown", async make => {
    const fetch = vi.fn().mockResolvedValue(make());
    await expect(consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).rejects.toThrow("outcome unknown");
  });

  it("does not retry a network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("sk-ant-oat01-secret"));
    await expect(consumeClaudeLimitReset(account, ORG, GRANT, REQ, { fetch })).rejects.toThrow("outcome unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([["not-a-uuid", GRANT, REQ], [ORG, "Bad Grant", REQ], [ORG, GRANT, "has space"]])
    ("never sends with malformed identifiers", async (org, grant, req) => {
      const fetch = vi.fn();
      await expect(consumeClaudeLimitReset(account, org, grant, req, { fetch })).rejects.toBeInstanceOf(ResetNotSubmittedError);
      expect(fetch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/anthropic-usage-reset.test.ts`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Create `src/proxy/reset-errors.ts`** with exactly the Interfaces block above.

- [ ] **Step 4: Create `src/providers/anthropic/usage-reset.ts`**

```ts
import type { Account } from "../../proxy/types.js";
import { ResetNotSubmittedError, RESET_OUTCOME_UNKNOWN } from "../../proxy/reset-errors.js";
import { CLAUDE_CODE_USER_AGENT, OAUTH_BETA_HEADER } from "./usage.js";

export type ClaudeResetCode = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";
export interface ClaudeResetResult { code: ClaudeResetCode; resetsLeft?: number }

const CODES: readonly ClaudeResetCode[] = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"];
const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function consumeClaudeLimitReset(
  account: Pick<Account, "tokens">,
  orgUuid: string,
  grantId: string,
  requestId: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<ClaudeResetResult> {
  // Contract: Claude Code 2.1.280 `/limit-reset` (program "cedar_ember").
  // Undocumented; reverse-engineered from the CLI bundle on 2026-09-23.
  if (!ORG_UUID.test(orgUuid) || !GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId)) {
    throw new ResetNotSubmittedError(503, "Reset request malformed; reset not submitted");
  }
  const request = options.fetch ?? globalThis.fetch;
  // Never retry a spend with a fresh ID: a lost response may have consumed it.
  try {
    const response = await request(`https://api.anthropic.com/api/organizations/${orgUuid}/reset_rate_limits`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.tokens.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "user-agent": CLAUDE_CODE_USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      throw new ResetNotSubmittedError(503, "Account credentials rejected; reset not submitted");
    }
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "result" in body) {
        const code = (body as { result: unknown }).result;
        const left = (body as { resets_left?: unknown }).resets_left;
        if (CODES.includes(code as ClaudeResetCode)) {
          return {
            code: code as ClaudeResetCode,
            ...(typeof left === "number" && Number.isInteger(left) && left >= 0 ? { resetsLeft: left } : {}),
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof ResetNotSubmittedError) throw error;
    // Do not relay upstream bodies, credentials, or network error details.
  }
  throw new Error(RESET_OUTCOME_UNKNOWN);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/anthropic-usage-reset.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/reset-errors.ts src/providers/anthropic/usage-reset.ts src/__tests__/anthropic-usage-reset.test.ts
git commit -m "feat(anthropic): claim a banked usage-limit reset"
```

---

### Task 4: Provider-generic reset route + Claude grant pinning

**Files:**
- Modify: `src/proxy/account-usage-reset.ts`
- Create: `src/proxy/claude-usage-reset.ts`
- Modify: `src/__tests__/account-usage-reset.test.ts` (response shape now includes `provider`)
- Test: `src/__tests__/claude-usage-reset.test.ts`

**Interfaces:**
- Consumes:
  - `ResetNotSubmittedError`, `RESET_OUTCOME_UNKNOWN` (Task 3).
  - `consumeClaudeLimitReset`, `ClaudeResetResult` (Task 3).
  - `LimitResetState` (Task 1).
- Produces:
  - A new generic signature (see Step 3). OpenAI wiring must still compile with no casts beyond passing `provider: "openai"`.
  - In `claude-usage-reset.ts`:
    ```ts
    export interface ClaudeResetConsumerDeps {
      orgUuid(account: Account): Promise<string | undefined>;
      consume?: typeof consumeClaudeLimitReset;
    }
    export function createClaudeResetConsumer(deps: ClaudeResetConsumerDeps): (account: Account, requestId: string) => Promise<ClaudeResetResult>;
    ```

- [ ] **Step 1: Update the existing route tests.** In `src/__tests__/account-usage-reset.test.ts`:
  - The `setup()` helper passes `provider: "openai"` into `createUsageResetHandler`.
  - Every `{ reset: { code: ..., usageRefreshed: ... } }` expectation becomes `{ reset: { provider: "openai", code: ..., usageRefreshed: ... } }`.

  Add:

```ts
  it("reports a provably unsent redemption with its own status, not as unknown", async () => {
    const { post, refresh } = await setup({ consume: async () => { throw new ResetNotSubmittedError(409, "No reset available for this account"); } });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "No reset available for this account" });
    expect(refresh).not.toHaveBeenCalled();
  });
```

Import `ResetNotSubmittedError` from `../proxy/reset-errors.js`.

- [ ] **Step 2: Write the Claude consumer tests** (`src/__tests__/claude-usage-reset.test.ts`)

```ts
import { describe, expect, it, vi } from "vitest";
import { createClaudeResetConsumer } from "../proxy/claude-usage-reset.js";
import { ResetNotSubmittedError } from "../proxy/reset-errors.js";
import { DEFAULT_RATE_LIMITS, type Account, type LimitResetState } from "../proxy/types.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const R1 = "12345678-1234-4234-8234-123456789abc";
const R2 = "12345678-1234-4234-8234-123456789abd";

function claude(limitResets?: LimitResetState): Account {
  return {
    id: "claude-1",
    tokens: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-x", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference", "user:profile"] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS, usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh", ...(limitResets ? { limitResets } : {}) } },
    enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
  };
}
const state = (next: string): LimitResetState => ({
  eligible: true, nextGrantId: next, cooldownUntil: 0,
  grants: [{ id: next, resetsLeft: 1, endsAt: 0, clears: ["five_hour"], usableNow: true, useRequiresLimit: false, paused: false }],
});

describe("Claude reset consumer", () => {
  it("claims the snapshot's next grant for the account's organization", async () => {
    const consume = vi.fn().mockResolvedValue({ code: "reset" });
    const a = claude(state("grant-a"));
    await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(a, R1);
    expect(consume).toHaveBeenCalledWith(a, ORG, "grant-a", R1);
  });

  it("replays the ORIGINAL grant for the same redemption id even after next_grant_id moved", async () => {
    const consume = vi.fn().mockRejectedValueOnce(new Error("outcome unknown")).mockResolvedValue({ code: "already_used" });
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1)).rejects.toThrow();
    a.rateLimits.usage!.limitResets = state("grant-b");
    await run(a, R1);
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", R1);
    await run(a, R2); // a new redemption picks the new grant
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-b", R2);
  });

  it.each([
    ["no status", undefined],
    ["ineligible", { eligible: false, ineligibleReason: "surface", grants: [], cooldownUntil: 0 } as LimitResetState],
    ["no next grant", { eligible: true, grants: [], cooldownUntil: 0 } as LimitResetState],
  ])("refuses with 409 before sending when there is %s", async (_label, resets) => {
    const consume = vi.fn();
    const error = await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(claude(resets), R1).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses with 503 before sending when the organization is unknown", async () => {
    const consume = vi.fn();
    const error = await createClaudeResetConsumer({ orgUuid: async () => undefined, consume })(claude(state("grant-a")), R1).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(503);
    expect(consume).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Generalize the handler.** Replace the options and signature in `src/proxy/account-usage-reset.ts`. Keep the body logic as is, except where noted.

```ts
import type { RequestHandler } from "express";
import type { CodexRateLimitsUpdate } from "../providers/openai/usage.js";
import { ResetNotSubmittedError, RESET_OUTCOME_UNKNOWN } from "./reset-errors.js";

export interface UsageResetOptions<A extends object, R extends { code: string }> {
  provider: "openai" | "anthropic";
  findAccount(id: string): A | undefined;
  prepare(account: A): Promise<boolean>;
  consume(account: A, requestId: string): Promise<R>;
  refresh(account: A): Promise<{ ok: boolean }>;
  /** OpenAI only: reconcile quota cooldowns from the evidence captured before the spend. */
  captureReset?(account: A): (update: CodexRateLimitsUpdate) => void;
}
export function createUsageResetHandler<A extends object, R extends { code: string }>(options: UsageResetOptions<A, R>): RequestHandler {
```

Changes inside the body:
- The `WeakSet`/`WeakMap` use `A`.
- 404 messages: `"Account not found"` and `"Account changed; reset not submitted"`.
- Reconcile: keep the `usage.ok && ... snapshot.reconcile?.(usage.update)` path, now typed as `(usage as { ok: true; update: CodexRateLimitsUpdate })`. It only runs when `captureReset` was supplied, so Claude never reaches it.
- The success response is `res.json({ reset: { provider: options.provider, ...result, usageRefreshed } });`.
- The `catch` becomes:
  ```ts
    } catch (error) {
      if (error instanceof ResetNotSubmittedError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(502).json({ error: RESET_OUTCOME_UNKNOWN });
    }
  ```

In `server.ts`, the existing OpenAI registration gains `provider: "openai",`. Task 5 rewires registration; for now only add the field so it compiles.

- [ ] **Step 4: Create `src/proxy/claude-usage-reset.ts`**

```ts
import type { Account } from "./types.js";
import { ResetNotSubmittedError } from "./reset-errors.js";
import { consumeClaudeLimitReset, type ClaudeResetResult } from "../providers/anthropic/usage-reset.js";

export interface ClaudeResetConsumerDeps {
  orgUuid(account: Account): Promise<string | undefined>;
  consume?: typeof consumeClaudeLimitReset;
}

/**
 * Binds each redemption id to the grant it first targeted. A replay after an
 * unknown outcome must hit the same grant, or a moved `next_grant_id` would
 * turn "retry" into "spend a second reset".
 */
export function createClaudeResetConsumer(deps: ClaudeResetConsumerDeps) {
  const consume = deps.consume ?? consumeClaudeLimitReset;
  const pinned = new WeakMap<Account, { requestId: string; grantId: string }>();
  return async (account: Account, requestId: string): Promise<ClaudeResetResult> => {
    const prior = pinned.get(account);
    let grantId = prior?.requestId === requestId ? prior.grantId : undefined;
    if (!grantId) {
      const resets = account.rateLimits.usage?.limitResets;
      grantId = resets?.eligible ? resets.nextGrantId : undefined;
      if (!grantId) throw new ResetNotSubmittedError(409, "No reset available for this account");
    }
    const org = await deps.orgUuid(account);
    if (!org) throw new ResetNotSubmittedError(503, "Organization unknown; reset not submitted");
    pinned.set(account, { requestId, grantId });
    return consume(account, org, grantId, requestId);
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/account-usage-reset.test.ts src/__tests__/claude-usage-reset.test.ts && pnpm lint`
Expected: PASS, including every pre-existing OpenAI test (the reconcile/replay suites).

- [ ] **Step 6: Commit**

```bash
git add src/proxy/account-usage-reset.ts src/proxy/claude-usage-reset.ts src/proxy/server.ts src/__tests__/account-usage-reset.test.ts src/__tests__/claude-usage-reset.test.ts
git commit -m "feat: provider-generic reset route with Claude grant pinning"
```

---

### Task 5: Wire Claude resets into the server and health view

**Files:**
- Create: `src/proxy/public-limit-resets.ts`
- Modify: `src/proxy/server.ts`:
  - reset route registration (~line 982)
  - `PublicUsageSnapshot` (~line 201)
  - `publicUsageSnapshot()` (~line 417)
- Test: `src/__tests__/public-limit-resets.test.ts`
- Test: `src/__tests__/claude-reset-recovery.test.ts`

**Interfaces:**
- Consumes: `createUsageResetHandler` (generic), `createClaudeResetConsumer` (Task 4), and `LimitResetState` (Task 1).
- Produces, in `src/proxy/public-limit-resets.ts`:
  ```ts
  export interface PublicLimitResets {
    eligible: boolean; ineligibleReason?: string; available: number;
    usableNow: boolean; requiresLimit: boolean; useBy: number; clears: string[];
  }
  export function publicLimitResets(state: LimitResetState): PublicLimitResets;
  ```
- `PublicUsageSnapshot` gains `limitResets?: PublicLimitResets`, which Task 6 reads.

- [ ] **Step 1: Write the public-mapping tests** (`src/__tests__/public-limit-resets.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { publicLimitResets } from "../proxy/public-limit-resets.js";
import type { LimitResetGrant } from "../proxy/types.js";

const g = (over: Partial<LimitResetGrant>): LimitResetGrant => ({
  id: "grant-a", resetsLeft: 1, endsAt: 1_792_684_800, clears: ["five_hour", "seven_day"],
  usableNow: true, useRequiresLimit: false, paused: false, ...over,
});

describe("publicLimitResets", () => {
  it("summarises the next grant without exposing any grant id", () => {
    const view = publicLimitResets({ eligible: true, grants: [g({}), g({ id: "grant-b", resetsLeft: 2 })], nextGrantId: "grant-a", cooldownUntil: 0 });
    expect(view).toEqual({ eligible: true, available: 3, usableNow: true, requiresLimit: false, useBy: 1_792_684_800, clears: ["five_hour", "seven_day"] });
    expect(JSON.stringify(view)).not.toContain("grant-");
  });
  it("excludes paused grants from the count and clamps to 99", () => {
    expect(publicLimitResets({ eligible: true, grants: [g({ paused: true }), g({ id: "b", resetsLeft: 500 })], nextGrantId: "b", cooldownUntil: 0 }).available).toBe(99);
  });
  it("reports an ineligible account with no usable grant", () => {
    expect(publicLimitResets({ eligible: false, ineligibleReason: "cli_version", grants: [], cooldownUntil: 0 }))
      .toEqual({ eligible: false, ineligibleReason: "cli_version", available: 0, usableNow: false, requiresLimit: true, useBy: 0, clears: [] });
  });
});
```

- [ ] **Step 2: Write the recovery integration test** (`src/__tests__/claude-reset-recovery.test.ts`). It uses the real `TokenPool`, `AnthropicUsageRefresher`, generic handler and Claude consumer, and follows the harness pattern in `src/__tests__/cooldown-usage-supersede.test.ts`.

```ts
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenPool } from "../proxy/token-pool.js";
import { AnthropicUsageRefresher } from "../providers/anthropic/usage-refresher.js";
import { parseAnthropicUsage } from "../providers/anthropic/usage.js";
import { createUsageResetHandler } from "../proxy/account-usage-reset.js";
import { createClaudeResetConsumer } from "../proxy/claude-usage-reset.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });
const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const REQ = "12345678-1234-4234-8234-123456789abc";
const START = 1_000_000_000_000;
const block = { eligible: true, grants: [{ id: "grant-a", resets_left: 1, clears: ["five_hour", "seven_day"], usable_now: true, use_requires_limit: false }], next_grant_id: "grant-a" };

function makeAccount(): Account { /* copy makeAccount from cooldown-usage-supersede.test.ts with id "claude-1" */ }

async function run(kind: "quota" | "overload") {
  const clock = { now: START, seq: 0 };
  const a = makeAccount();
  const pool = new TokenPool([a], { now: () => clock.now, nextSequence: () => ++clock.seq });
  a.rateLimits.usage = parseAnthropicUsage({ five_hour: { utilization: 100 }, cedar_ember: block }, clock.now, ++clock.seq)!;
  pool.setGlobalCooldownForAccount(a, 3_600_000, "five_hour");
  if (kind === "overload") pool.setGlobalCooldownForAccount(a, 30_000); // unscoped overload hold
  expect(pool.tryAcquire(a.id)).toBeNull();
  const refresher = new AnthropicUsageRefresher(pool, {
    now: () => clock.now,
    fetchUsage: async () => ({ ok: true, snapshot: parseAnthropicUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 }, cedar_ember: { ...block, grants: [] } }, clock.now, ++clock.seq)! }),
  });
  const consume = vi.fn().mockResolvedValue({ code: "reset", resetsLeft: 0 });
  const app = express(); app.use(express.json());
  app.post("/:id/reset-usage", createUsageResetHandler({
    provider: "anthropic",
    findAccount: id => pool.findById(id) ?? undefined,
    prepare: async () => true,
    consume: createClaudeResetConsumer({ orgUuid: async () => ORG, consume }),
    refresh: account => refresher.refreshAfterCurrent(account),
  }));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/${a.id}/reset-usage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redeemRequestId: REQ }),
  });
  return { a, pool, clock, response, consume };
}

describe("confirmed Claude reset routing recovery", () => {
  it("releases a five-hour quota cooldown once fresh usage shows headroom", async () => {
    const { a, pool, response, consume } = await run("quota");
    expect(await response.json()).toEqual({ reset: { provider: "anthropic", code: "reset", resetsLeft: 0, usageRefreshed: true } });
    expect(consume).toHaveBeenCalledWith(a, ORG, "grant-a", REQ);
    const lease = pool.tryAcquire(a.id);
    expect(lease).not.toBeNull();
    lease?.release();
  });
  it("keeps an unrelated overload hold", async () => {
    const { a, pool, clock } = await run("overload");
    expect(pool.tryAcquire(a.id)).toBeNull();
    clock.now += 31_000;
    const lease = pool.tryAcquire(a.id);
    expect(lease).not.toBeNull();
    lease?.release();
  });
});
```

If the quota case fails because the pool does not release the scoped cooldown, check `releaseCooldownsSupersededByUsage` in `src/proxy/token-pool.ts:846`, specifically when it runs. The test must still reflect the spec behaviour. Report back **before** adding any release hook (the spec requires the minimal one, and only if needed).

- [ ] **Step 3: Run to verify failure**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/public-limit-resets.test.ts src/__tests__/claude-reset-recovery.test.ts`
Expected: FAIL (`public-limit-resets.js` does not exist). The recovery test may already pass; that is fine, because it pins behaviour.

- [ ] **Step 4: Create `src/proxy/public-limit-resets.ts`**

```ts
import type { LimitResetState } from "./types.js";

export interface PublicLimitResets {
  eligible: boolean;
  ineligibleReason?: string;
  available: number;
  usableNow: boolean;
  requiresLimit: boolean;
  useBy: number;
  clears: string[];
}

/** Disclosure-safe summary: counts, dates and flags only — grant ids stay in-process. */
export function publicLimitResets(state: LimitResetState): PublicLimitResets {
  const next = state.grants.find(grant => grant.id === state.nextGrantId);
  const available = state.grants.filter(grant => !grant.paused).reduce((sum, grant) => sum + grant.resetsLeft, 0);
  return {
    eligible: state.eligible === true,
    ...(state.ineligibleReason ? { ineligibleReason: state.ineligibleReason } : {}),
    available: Math.max(0, Math.min(99, Math.floor(available))),
    usableNow: next?.usableNow === true,
    requiresLimit: next?.useRequiresLimit !== false,
    useBy: next && next.endsAt > 0 ? next.endsAt : 0,
    clears: next ? [...next.clears] : [],
  };
}
```

`ineligibleReason` is already enum-sanitized by the parser (Task 1).

- [ ] **Step 5: Expose it in `server.ts`.**
  - Add `limitResets?: PublicLimitResets;` to `PublicUsageSnapshot`.
  - In `publicUsageSnapshot()`, before `fetchedAt`:
    ```ts
    ...(usage.limitResets ? { limitResets: publicLimitResets(usage.limitResets) } : {}),
    ```

- [ ] **Step 6: Register the Claude route in `server.ts`** (replace the single OpenAI registration at ~line 982). Imports: `createClaudeResetConsumer` and `publicLimitResets`. `needsRefresh`, `refreshAccountIfCurrent`, `isTokenOnly` and `persistAnthropicAccounts` are already in scope; confirm with grep.

```ts
  const openAIReset = createUsageResetHandler({
    provider: "openai",
    findAccount: id => openAIAccounts.find(account => account.id === id),
    prepare: account => prepareOpenAIAccountForRequest(account, openAIAccounts, persistOpenAIAccounts),
    consume: consumeCodexResetCredit,
    captureReset: account => openAIPool.captureUsageReset(account),
    refresh: account => openAIUsageRefresher.refreshAfterCurrent(account),
  });
  // The org UUID is identity metadata the profile fetch already caches.
  const claudeOrgUuid = async (account: Account): Promise<string | undefined> => {
    const source = () => accountInfoSources().find(row => row.provider === "anthropic_subscription" && row.id === account.id);
    const first = source();
    if (!first) return undefined;
    const cached = accountInfoCache.get(first).workspaceId;
    if (cached) return cached;
    await accountInfoCache.refreshOne({ id: account.id, provider: "anthropic_subscription" });
    const again = source();
    return again ? accountInfoCache.get(again).workspaceId : undefined;
  };
  const claudeReset = createUsageResetHandler({
    provider: "anthropic",
    findAccount: id => pool.findById(id) ?? undefined,
    prepare: async account => {
      if (account.authExpired) return false;
      if (needsRefresh(account)) await refreshAccountIfCurrent(account, pool, { persist: persistAnthropicAccounts });
      return !account.authExpired && account.tokens.expiresAt > Date.now();
    },
    consume: createClaudeResetConsumer({ orgUuid: claudeOrgUuid }),
    refresh: account => usageRefresher.refreshAfterCurrent(account),
  });
  accountsRouter.post("/:id/reset-usage", (req, res, next) => {
    const id = req.params.id;
    if (openAIAccounts.some(account => account.id === id)) return openAIReset(req, res, next);
    if (pool.findById(id)) return claudeReset(req, res, next);
    res.status(404).json({ error: "Account not found" });
  });
```

Adjust names to what `server.ts` actually uses. In particular, check whether `persistAnthropicAccounts` and `Account` are imported there, and whether `accountInfoSources` is declared before this point; move the declaration up if it isn't. The dispatcher must keep the handlers' own 400 validation, so it only picks a handler and doesn't validate itself.

- [ ] **Step 7: Run everything**

Run: `env -u FORCE_COLOR pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/public-limit-resets.ts src/proxy/server.ts src/__tests__/public-limit-resets.test.ts src/__tests__/claude-reset-recovery.test.ts
git commit -m "feat: redeem Claude resets through the account reset route"
```

---

### Task 6: Dashboard — count, gating, confirmation and banners

**Files:**
- Modify: `src/ui/accountsApi.ts` (`UsageResetResult`, `resetUsage` parsing)
- Modify: `src/ui/Dashboard.tsx`:
  - `AccountUsageView` (~line 72)
  - `resetCreditsColumnLabel` (~line 368)
  - `doResetUsage` (~line 1334)
  - Ctrl+R handler (~line 1425)
  - confirm line (~line 1624)
  - footer hint (~line 1790)
- Test: `src/__tests__/dashboard-groups.test.ts`, `src/__tests__/dashboard-reset-key.test.ts`, and the accountsApi test file if one exists (`git grep -ln resetUsage src/__tests__`)

**Interfaces:**
- Consumes: health JSON `rateLimits.usage.limitResets: PublicLimitResets` (Task 5), and the route response `{ reset: { provider, code, usageRefreshed, resetsLeft? } }`.
- Produces:
  ```ts
  // accountsApi.ts
  export type UsageResetResult =
    | { provider: "openai"; code: CodexResetCode; usageRefreshed: boolean }
    | { provider: "anthropic"; code: ClaudeResetCode; usageRefreshed: boolean; resetsLeft?: number };
  // Dashboard.tsx (exported for tests)
  export function claudeResetBlocker(account: Pick<AccountStat, "rateLimits">): string | undefined;
  export function claudeResetConfirmText(id: string, resets: LimitResetsView): string;
  ```
  Here `LimitResetsView` is a local interface in `Dashboard.tsx` with the same fields as `PublicLimitResets`.

- [ ] **Step 1: Write the failing unit tests** (append to `src/__tests__/dashboard-groups.test.ts`; reuse its `claude()` factory and add usage to it)

```ts
describe("Claude limit resets in the dashboard", () => {
  const withResets = (limitResets: object) => ({
    ...claude("max-1"),
    rateLimits: { ...claude("max-1").rateLimits!, usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh" as const, limitResets } },
  });
  const ok = { eligible: true, available: 1, usableNow: true, requiresLimit: false, useBy: 1_792_684_800, clears: ["five_hour", "seven_day", "seven_day_overage_included"] };

  it("shows the banked count, or an em dash when unknown or ineligible", () => {
    expect(resetCreditsColumnLabel(withResets(ok))).toBe("1");
    expect(resetCreditsColumnLabel(withResets({ ...ok, available: 0 }))).toBe("0");
    expect(resetCreditsColumnLabel(withResets({ ...ok, eligible: false, ineligibleReason: "surface", available: 0 }))).toBe("—");
    expect(resetCreditsColumnLabel(claude("no-usage"))).toBe("—");
  });

  it("explains why a reset cannot start", () => {
    expect(claudeResetBlocker(withResets(ok))).toBeUndefined();
    expect(claudeResetBlocker(claude("no-usage"))).toBe("Reset status unknown — reload with R");
    expect(claudeResetBlocker(withResets({ ...ok, eligible: false, ineligibleReason: "cli_version" })))
      .toBe("Claude Code version too old for resets — update cc-router");
    expect(claudeResetBlocker(withResets({ ...ok, eligible: false, ineligibleReason: "tier" }))).toBe("Resets unavailable for this account (tier)");
    expect(claudeResetBlocker(withResets({ ...ok, available: 0 }))).toBe("No resets available");
    expect(claudeResetBlocker(withResets({ ...ok, usableNow: false, requiresLimit: true }))).toBe("Reset only usable at a limit");
  });

  it("names the refilled windows, count and deadline in the confirmation", () => {
    expect(claudeResetConfirmText("max-1", ok))
      .toBe('Redeem 1 reset for "max-1"? Refills 5h + 7d limits · 1 left · use by 2026-10-22');
  });
});
```

Import `claudeResetBlocker` and `claudeResetConfirmText` from `../ui/Dashboard.js`.

- [ ] **Step 2: Extend the key test** (`src/__tests__/dashboard-reset-key.test.ts`). Copy the existing ChatGPT redemption test into a Claude variant:
  - The health account is `{ id: "claude-1", provider: "anthropic_subscription", rateLimits: { ...DEFAULT-like fields, usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh", limitResets: ok } } }`.
  - The mocked reset response is `{ reset: { provider: "anthropic", code: "reset", resetsLeft: 0, usageRefreshed: true } }`.
  - Assert the frame shows `Refills 5h + 7d limits`, and after `y`, `Limits reset for claude-1 · 0 left`.
  - Second case: `limitResets: { ...ok, eligible: false, ineligibleReason: "cli_version" }` shows `Claude Code version too old for resets` and makes **no** POST (the fetch stub has no call to `/reset-usage`).

  Follow the existing test's harness calls (`renderDashboard`, `dash.waitUntil`, stdin writes). Ctrl+R is `"\x12"` in the harness; check how the existing test sends it.

- [ ] **Step 3: Run to verify failure**

Run: `env -u FORCE_COLOR pnpm vitest run src/__tests__/dashboard-groups.test.ts src/__tests__/dashboard-reset-key.test.ts`
Expected: FAIL.

- [ ] **Step 4: Update `accountsApi.ts`.** Import `ClaudeResetCode` as a type. Replace `UsageResetResult` with the union above. Replace the body of `resetUsage` after `const reset = …`:

```ts
      const openai = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"];
      const claude = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"];
      if (!isRecord(reset) || typeof reset.code !== "string" || typeof reset.usageRefreshed !== "boolean") throw new Error("Invalid reset response");
      if (reset.provider === "anthropic" && claude.includes(reset.code)) {
        return {
          provider: "anthropic", code: reset.code as ClaudeResetCode, usageRefreshed: reset.usageRefreshed,
          ...(typeof reset.resetsLeft === "number" ? { resetsLeft: publicInteger(reset.resetsLeft) } : {}),
        };
      }
      if (reset.provider === "openai" && openai.includes(reset.code)) {
        return { provider: "openai", code: reset.code as CodexResetCode, usageRefreshed: reset.usageRefreshed };
      }
      throw new Error("Invalid reset response");
```

The non-2xx path keeps throwing `HTTP <status>`. The dashboard needs to show a 409/503 body message, so read it there: before the `throw`, if the body parses and has a string `error`, throw `new Error(publicText(body.error, 160, \`HTTP ${response.status}\`))`. For 502, keep the message `HTTP 502`, because the dashboard maps that to "outcome unknown".

- [ ] **Step 5: Update `Dashboard.tsx`.**

(a) Add to `AccountUsageView`:

```ts
  limitResets?: LimitResetsView;
```

and define the view:

```ts
interface LimitResetsView {
  eligible: boolean; ineligibleReason?: string; available: number;
  usableNow: boolean; requiresLimit: boolean; useBy: number; clears: string[];
}
```

(b) `resetCreditsColumnLabel`: widen the `Pick` to include `"rateLimits"`. The body becomes:

```ts
  if (isOpenAIAccount(account)) return String(account.codexRateLimits?.resetCredits?.available ?? 0);
  if (!isClaudeAccount(account)) return "—";
  const resets = account.rateLimits?.usage?.limitResets;
  return resets?.eligible ? String(resets.available) : "—";
```

Update its doc comment ("banked usage-limit resets; Grok and unknown Claude status are an em dash"). Fix the existing test in `dashboard-groups.test.ts:185` that expects Claude to be `—`: it still passes, because `claude()` has no usage. Leave it.

(c) Add, next to it:

```ts
const RESET_WINDOW_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "7d" };

export function claudeResetBlocker(account: Pick<AccountStat, "rateLimits">): string | undefined {
  const resets = account.rateLimits?.usage?.limitResets;
  if (!resets) return "Reset status unknown — reload with R";
  if (!resets.eligible) {
    return resets.ineligibleReason === "cli_version"
      ? "Claude Code version too old for resets — update cc-router"
      : `Resets unavailable for this account (${resets.ineligibleReason ?? "unknown"})`;
  }
  if (resets.available <= 0) return "No resets available";
  if (!resets.usableNow) return resets.requiresLimit ? "Reset only usable at a limit" : "Reset not usable right now";
  return undefined;
}

export function claudeResetConfirmText(id: string, resets: LimitResetsView): string {
  const windows = resets.clears.map(window => RESET_WINDOW_LABELS[window]).filter(Boolean);
  const refills = windows.length > 0 ? `Refills ${windows.join(" + ")} limits` : "Refills your limits";
  const useBy = resets.useBy > 0 ? ` · use by ${new Date(resets.useBy * 1000).toISOString().slice(0, 10)}` : "";
  return `Redeem 1 reset for "${id}"? ${refills} · ${resets.available} left${useBy}`;
}
```

(d) Ctrl+R handler: replace the ChatGPT-only guard.

```ts
      const pending = resetSession.pendingIds.has(selectedAccount.id);
      if (isClaudeAccount(selectedAccount)) {
        const blocker = pending ? undefined : claudeResetBlocker(selectedAccount);
        if (blocker) { showBanner(blocker, "yellow"); return; }
      } else if (selectedAccount.provider !== "openai_subscription") {
        showBanner("Usage resets are not available for Grok accounts", "yellow"); return;
      } else if (!pending && (selectedAccount.codexRateLimits?.resetCredits?.available ?? 0) <= 0) {
        showBanner("No reset credits available", "yellow"); return;
      }
```

`isClaudeAccount` returns true for an absent provider (legacy Anthropic), which is intended.

(e) Confirm line: when the target is a Claude account with `limitResets`, render `claudeResetConfirmText(resetTarget, resets) + "  [y] yes  [n/Esc] cancel"`. Otherwise keep the current ChatGPT text. Look the account up from the same accounts array that `selectedAccount` comes from.

(f) `doResetUsage` banners: branch on `result.provider`.

```ts
      const text = result.provider === "anthropic"
        ? ({
            reset: `Limits reset for ${id}${result.resetsLeft !== undefined ? ` · ${result.resetsLeft} left` : ""}`,
            already_used: `Reset already used for ${id} · nothing more spent`,
            not_limited: `${id} is not at a limit · nothing used`,
            cooldown: `Resets are cooling down for ${id} · try later`,
            ineligible: `Reset unavailable for ${id} · nothing used`,
            unavailable: `Reset unavailable for ${id} · nothing used`,
          })[result.code]
        : ({
            reset: `Usage reset redeemed for ${id}`,
            already_redeemed: `Usage reset already redeemed for ${id}`,
            nothing_to_reset: `Nothing to reset for ${id}`,
            no_credit: `No reset credits available for ${id}`,
          })[result.code];
      const confirmed = result.code === "reset" || result.code === "already_redeemed" || result.code === "already_used";
      showBanner(text + (result.usageRefreshed ? "" : " — usage refresh failed; reload with R"),
        result.usageRefreshed && confirmed ? "green" : "yellow");
```

In the `catch`: if the error message is not `HTTP 502` (so it's a 409/503/400 body message from Step 4, meaning nothing was sent), drop the pending id and show it in yellow:

```ts
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message && message !== "HTTP 502" && !message.startsWith("HTTP 5") && !message.includes("aborted") && !message.includes("timeout")) {
        resetSession.pendingIds.delete(id);
        showBanner(`${message} (${id})`, "yellow");
      } else {
        showBanner(`Reset outcome unknown for ${id}; Ctrl+R retries the same redemption (keep dashboard open)`, "red");
      }
    }
```

A dropped connection or timeout must stay "unknown". Add one case to the key test: a 409 `{ error: "No reset available for this account" }` shows that text in yellow, and the next Ctrl+R uses a **new** redemption id. Assert on the request bodies.

(g) The footer hint text is unchanged (`[Ctrl+R] reset` already exists).

- [ ] **Step 6: Run to verify pass**

Run: `env -u FORCE_COLOR pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui src/__tests__
git commit -m "feat(dashboard): show and redeem Claude usage-limit resets"
```

---

### Task 7: Docs and changelog

**Files:**
- Modify: `docs/dashboard.md`:
  - `rst` row (~line 53)
  - `Ctrl+R` row (~line 127)
  - section "Redeeming a ChatGPT usage reset" (~line 143)
- Modify: `docs/README.md:23`
- Modify: `CHANGELOG.md` (top "Unreleased" section; create it in the file's existing style if absent)

- [ ] **Step 1: Edit `docs/dashboard.md`.**
  - `rst` row: `Banked usage-limit resets (ChatGPT credits, Claude resets; — when unknown or ineligible)`.
  - `Ctrl+R` row: `Redeem one banked usage-limit reset (ChatGPT and Claude accounts)`.
  - Rename the section to `## Redeeming a usage reset` and keep the ChatGPT text. Add a Claude paragraph:

    > Claude Pro, Max and Team accounts can hold resets granted by Anthropic (for example the Opus 5.5 launch reset). A reset refills the windows it names — the confirmation lists them, with the count left and the use-by date — and does not move your weekly reset day. Some resets can be used at any time; others only while the account is at a limit, and the dashboard says so instead of sending the request. Status comes from the same usage poll as the `5h`/`7d` columns, so press `R` if the count looks stale. If `rst` shows `—` and `Ctrl+R` reports an old Claude Code version, update cc-router.

  - Add the caveat: this uses the same undocumented endpoint as Claude Code's `/limit-reset`, and may stop working if Anthropic changes it.

- [ ] **Step 2: Edit `docs/README.md:23`.** Replace "ChatGPT usage resets" with "usage resets".

- [ ] **Step 3: Add the changelog entry**

```markdown
- Dashboard `rst` column and `Ctrl+R` now cover Claude accounts: banked
  usage-limit resets (e.g. the Opus 5.5 launch reset) are shown and can be
  redeemed after confirmation. Claude usage polls now identify as Claude Code,
  which Anthropic requires before offering resets. The redemption endpoint is
  undocumented and may change.
```

- [ ] **Step 4: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs: Claude usage-limit resets"
```

---

## Final verification (after all tasks)

- `env -u FORCE_COLOR pnpm test && pnpm lint && pnpm build` all pass.
- `git grep -n "grant_id\|nextGrantId" src/proxy/server.ts src/ui` finds no grant id in the public/health mapping or the UI.
- Manual read-only check: rebuild, restart the daemon, and run `cc-router status --json`. Each Claude account shows `usage.limitResets` with `available: 1` and `eligible: true`. **Do not** press `Ctrl+R` on a real account without the user's say-so.
