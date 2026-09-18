# Account sign-in, re-auth and refresh ergonomics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators sign Claude and OpenAI accounts in (and back in) from the CLI and the dashboard by driving `claude auth login` / `claude setup-token` and the OpenAI device page, and let `R` refresh one account instead of the whole pool.

**Architecture:** Claude credentials come from the Claude Code CLI run as a subprocess (login writes the Keychain/credentials file; setup-token prints a long-lived, refresh-less token that cc-router scans from mirrored stdout). Provider sign-in flows move into one shared module used by the CLI, the setup wizard and the dashboard's unmount-run-remount loop. The proxy gains a per-account refresh endpoint that the dashboard's `R` uses when an account is selected.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20/22, commander, `@inquirer/prompts`, Ink 5 + React, express, vitest. Tests live in `src/__tests__/`. Run one file with `pnpm vitest run src/__tests__/<file>.test.ts`; type-check with `pnpm lint`.

**Spec:** `docs/superpowers/specs/2026-09-18-account-reauth-ergonomics-design.md`

## Global Constraints

- Never log, print or persist a token beyond `redactToken()` output; tests must not contain the string of a token that reaches stdout unredacted.
- All imports of local modules end in `.js` (ESM build).
- Telemetry enums are closed lists in `src/telemetry/contracts.ts`; add new values there, never as ad-hoc strings.
- `accounts.json` records for other providers must be preserved by every write (existing `writeAnthropicAccountsPreservingOtherProviders`, `upsertAccountRecord`).
- The dashboard never runs inquirer while Ink is mounted; interactive flows run in `dashboardLoop` after `waitUntilExit()`.
- Breaking CLI changes are allowed but every removed command must be listed in the changelog with its replacement.
- Browser opening is best effort and is disabled when `CC_ROUTER_NO_BROWSER=1`.
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `src/proxy/types.ts` | `OAuthTokens.refreshToken` and `AccountRecord.refreshToken` become optional |
| `src/utils/token-extractor.ts` | parse credentials without a refresh token |
| `src/config/manager.ts` | serialize/deserialize without `refreshToken` |
| `src/proxy/token-refresher.ts` | skip refresh-less accounts; expire them into `authExpired` |
| `src/proxy/account-post-validation.ts` (new) | pure validation for `POST /cc-router/accounts` bodies |
| `src/providers/anthropic/usage-refresher.ts` | skip accounts without `user:profile` |
| `src/proxy/account-info-cache.ts` | skip sources without `user:profile` (needs `scopes` on the source) |
| `src/utils/browser.ts` (new) | cross-platform browser opener |
| `src/providers/openai/device-oauth.ts` | verification URL builder with `user_code` / `login_hint`; open browser |
| `src/providers/xai/device-oauth.ts` | open browser |
| `src/providers/anthropic/claude-cli.ts` (new) | drive `claude auth login` and `claude setup-token` |
| `src/telemetry/contracts.ts` | new setup methods |
| `src/cli/account-flows.ts` (new) | one function per provider sign-in / import; re-auth record collection |
| `src/cli/cmd-setup.ts` | delegate to `account-flows.ts` |
| `src/cli/cmd-accounts.ts` | `login` / `add` / `reauth`; `list` hints and `tokenOnly` |
| `src/proxy/server.ts` | `POST /cc-router/accounts/:id/refresh`; `tokenOnly` in account views; relaxed POST validation |
| `src/ui/accountsApi.ts` | `refreshAccount(id)` |
| `src/ui/Dashboard.tsx` | intent union, `l`, `R` routing, hint bar, token-only marker |
| `src/cli/cmd-status.ts` | handle the re-auth intent |
| docs, `CHANGELOG.md` | see Task 13 |

---

### Task 1: Refresh-less token shape

**Files:**
- Modify: `src/proxy/types.ts` (`OAuthTokens`, `AccountRecord`)
- Modify: `src/utils/token-extractor.ts` (`parseCredentialJson`)
- Modify: `src/config/manager.ts` (`serialize`, `deserialize`, `loadOpenAIAccounts`, `loadXaiAccounts`, `saveOpenAIAccountsToPath`)
- Test: `src/__tests__/token-extractor.test.ts`, `src/__tests__/manager.test.ts`

**Interfaces:**
- Produces: `OAuthTokens.refreshToken?: string`, `AccountRecord.refreshToken?: string`, and `export function isTokenOnly(tokens: { refreshToken?: string }): boolean` in `src/proxy/types.ts` (true when no refresh token).

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/token-extractor.test.ts` inside `describe("extractFromCredentialsFile")`:

```ts
  it("accepts a long-lived token with no refreshToken", () => {
    writeCreds({ claudeAiOauth: { accessToken: "sk-ant-oat01-longlived", expiresAt: 1_900_000_000_000, scopes: ["user:inference"] } });
    const tokens = extractFromCredentialsFile();
    expect(tokens).toEqual({
      accessToken: "sk-ant-oat01-longlived",
      refreshToken: undefined,
      expiresAt: 1_900_000_000_000,
      scopes: ["user:inference"],
    });
  });

  it("still rejects a missing accessToken even when a refreshToken is present", () => {
    writeCreds({ refreshToken: "sk-ant-ort01-x", expiresAt: 1 });
    expect(extractFromCredentialsFile()).toBeNull();
  });
```

(`writeCreds` is whatever helper the file already uses to write the temp credentials file; reuse it by name.)

Append to `src/__tests__/manager.test.ts`:

```ts
import { isTokenOnly } from "../proxy/types.js";

describe("refresh-less accounts", () => {
  it("round-trips an anthropic account without a refreshToken and omits the key on disk", () => {
    const account = deserializeForTest([{
      id: "long", provider: "anthropic_subscription",
      accessToken: "sk-ant-oat01-long", expiresAt: 1_900_000_000_000, scopes: ["user:inference"],
    }]);
    expect(account[0].tokens.refreshToken).toBeUndefined();
    expect(isTokenOnly(account[0].tokens)).toBe(true);
    const records = serialize(account);
    expect("refreshToken" in records[0]).toBe(false);
  });
});
```

If `manager.test.ts` has no deserialize access, export `deserialize` from `manager.ts` and import it instead of `deserializeForTest`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/__tests__/token-extractor.test.ts src/__tests__/manager.test.ts`
Expected: FAIL — the first returns `null`, the second fails type-check / `refreshToken` is `undefined` but serialized.

- [ ] **Step 3: Change the types**

In `src/proxy/types.ts`:

```ts
export interface OAuthTokens {
  accessToken: string;   // sk-ant-oat01-...
  /** Absent for a `claude setup-token` credential: long-lived, never refreshable. */
  refreshToken?: string; // sk-ant-ort01-...
  expiresAt: number;     // Unix timestamp in ms
  scopes: string[];      // ["user:inference", "user:profile"]
}

/** A credential with no refresh token can only be replaced, never refreshed. */
export function isTokenOnly(tokens: { refreshToken?: string }): boolean {
  return !tokens.refreshToken;
}
```

and in `AccountRecord`: `refreshToken?: string;` with the same comment.

- [ ] **Step 4: Relax the parser**

In `parseCredentialJson` (`src/utils/token-extractor.ts`) replace the guard:

```ts
    if (typeof accessToken !== "string" || !accessToken.startsWith("sk-ant-")) return null;
    if (refreshToken !== undefined && typeof refreshToken !== "string") return null;
```

and return `{ accessToken, refreshToken: typeof refreshToken === "string" ? refreshToken : undefined, expiresAt: expiresAtMs, scopes }`.

- [ ] **Step 5: Serialize without the key**

In `src/config/manager.ts` `serialize`, replace `refreshToken: a.tokens.refreshToken,` with `...(a.tokens.refreshToken ? { refreshToken: a.tokens.refreshToken } : {}),`. `deserialize` already copies `a.refreshToken` (now possibly undefined). `loadOpenAIAccounts`, `loadXaiAccounts`, `saveOpenAIAccountsToPath` and the `XaiSubscriptionAccount` / `OpenAISubscriptionAccount` types keep `refreshToken: string`; use `refreshToken: a.refreshToken ?? ""` at the two load sites so the type-checker is satisfied (those providers always have one).

- [ ] **Step 6: Fix the fallout**

Run `pnpm lint`. Every site that reads `tokens.refreshToken` as a `string` now errors. Expected sites: `src/proxy/token-refresher.ts` `_doRefresh` (leave for Task 2 — add a `!` there temporarily only if lint blocks you, Task 2 removes it), `src/cli/cmd-status.ts` `runAddAccountFlow` (pass `refreshToken: account.tokens.refreshToken` as-is; the field is optional now), `src/proxy/server.ts` replace/POST paths (Task 3 rewrites them; for now change `refreshToken: body.refreshToken` to `refreshToken: body.refreshToken ?? ""` in the OpenAI branches only and leave Anthropic ones as-is since the record type is optional). Do not change behaviour beyond types.

- [ ] **Step 7: Run tests and lint**

Run: `pnpm vitest run src/__tests__/token-extractor.test.ts src/__tests__/manager.test.ts && pnpm lint`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/types.ts src/utils/token-extractor.ts src/config/manager.ts src/__tests__/token-extractor.test.ts src/__tests__/manager.test.ts
git commit -m "feat: accept Claude credentials without a refresh token"
```

---

### Task 2: Refresh loop skips refresh-less accounts and expires them

**Files:**
- Modify: `src/proxy/token-refresher.ts` (`needsRefresh`, `refreshAccountsOnce`, `_doRefresh`)
- Test: `src/__tests__/token-refresher.test.ts`

**Interfaces:**
- Consumes: `isTokenOnly` from Task 1.
- Produces: `export function expireTokenOnlyAccount(account: Account, now?: number): boolean` — returns true when it flipped the account to `authExpired`.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/token-refresher.test.ts`:

```ts
function tokenOnlyAccount(expiresAt: number): Account {
  const account = makeAccount(expiresAt);
  delete account.tokens.refreshToken;
  return account;
}

describe("token-only accounts", () => {
  it("needsRefresh is false even inside the refresh window", () => {
    expect(needsRefresh(tokenOnlyAccount(Date.now() + 60_000))).toBe(false);
  });

  it("refreshAccountsOnce never calls the token endpoint for a token-only account", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const account = tokenOnlyAccount(Date.now() + 60_000);
    await refreshAccountsOnce([account]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(account.authExpired).toBeUndefined();
    expect(account.healthy).toBe(true);
  });

  it("refreshAccountsOnce marks an expired token-only account as needing re-auth, once", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const persist = vi.fn();
    const account = tokenOnlyAccount(Date.now() - 1_000);
    await refreshAccountsOnce([account], { persist });
    expect(account.authExpired).toBe(true);
    expect(account.healthy).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    await refreshAccountsOnce([account], { persist });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

`makeAccount` in that file lacks `rateLimits`/`enabled` fields today; if the type-checker complains, extend `makeAccount` with `rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100` and import `DEFAULT_RATE_LIMITS`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/token-refresher.test.ts -t "token-only"`
Expected: FAIL — `needsRefresh` returns true; expiry never flips.

- [ ] **Step 3: Implement**

In `src/proxy/token-refresher.ts`:

```ts
import { isTokenOnly } from "./types.js";

export function needsRefresh(account: Account): boolean {
  if (account.authExpired) return false;
  // A setup-token credential has nothing to POST; expiry is handled by
  // expireTokenOnlyAccount instead of the refresh loop.
  if (isTokenOnly(account.tokens)) return false;
  return ownedRefreshLocks.has(account) ||
    pendingDurability.has(account) ||
    (account.tokens.expiresAt - Date.now()) < REFRESH_BUFFER_MS;
}

/**
 * A long-lived token cannot be refreshed, so passing its expiry is the same
 * terminal state as a rejected refresh token: only a new sign-in restores it.
 * Returns true only on the tick that flips the account, so the caller can
 * persist and log exactly once.
 */
export function expireTokenOnlyAccount(account: Account, now: number = Date.now()): boolean {
  if (!isTokenOnly(account.tokens) || account.authExpired || account.tokens.expiresAt > now) return false;
  account.authExpired = true;
  account.healthy = false;
  console.error(
    `  Account ${account.id} needs re-authentication: its long-lived token has expired. Run: cc-router accounts reauth ${account.id}`,
  );
  return true;
}
```

In `refreshAccountsOnce`, before `if (!needsRefresh(account)) continue;`:

```ts
    if (expireTokenOnlyAccount(account)) {
      try { options.persist?.(accounts); } catch (error) { (options.onError ?? console.error)(error); }
      continue;
    }
```

In `_doRefresh`, the body construction: `refresh_token: account.tokens.refreshToken ?? ""` is wrong — guard instead at the top of `refreshAccountToken`: `if (isTokenOnly(account.tokens)) return false;`, and keep `_doRefresh` typed with a local `const refreshToken = account.tokens.refreshToken; if (!refreshToken) return false;`. Remove any `!` you added in Task 1.

- [ ] **Step 4: Run tests and lint**

Run: `pnpm vitest run src/__tests__/token-refresher.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/token-refresher.ts src/__tests__/token-refresher.test.ts
git commit -m "feat: keep long-lived Claude tokens out of the refresh loop and expire them into re-auth"
```

---

### Task 3: Account POST accepts a refresh-less Anthropic record

**Files:**
- Create: `src/proxy/account-post-validation.ts`
- Modify: `src/proxy/server.ts` (`accountsRouter.post("/")`, `publicAnthropicAccountView`, `HealthAccountView`)
- Test: `src/__tests__/account-post-validation.test.ts`

**Interfaces:**
- Produces:

```ts
export type ValidatedAccountPost =
  | { ok: true; body: AccountRecord & { replace: boolean } }
  | { ok: false; status: 400; error: string };
export function validateAccountPostBody(raw: unknown): ValidatedAccountPost;
```
- Produces: `tokenOnly?: true` on `HealthAccountView` for Anthropic accounts without a refresh token (read by Tasks 9 and 11).

- [ ] **Step 1: Write the failing tests**

`src/__tests__/account-post-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateAccountPostBody } from "../proxy/account-post-validation.js";

const base = { id: "a", accessToken: "sk-ant-oat01-x", expiresAt: 1_900_000_000_000 };

describe("validateAccountPostBody", () => {
  it("accepts an anthropic record without a refreshToken", () => {
    const result = validateAccountPostBody(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.refreshToken).toBeUndefined();
      expect(result.body.replace).toBe(false);
    }
  });

  it("rejects an openai record without a refreshToken", () => {
    const result = validateAccountPostBody({ ...base, provider: "openai_subscription" });
    expect(result).toEqual({ ok: false, status: 400, error: "Missing required field: refreshToken" });
  });

  it("rejects an anthropic record whose refreshToken is not a string", () => {
    expect(validateAccountPostBody({ ...base, refreshToken: 5 }).ok).toBe(false);
  });

  it("rejects missing id / accessToken / expiresAt", () => {
    expect(validateAccountPostBody({ ...base, id: "" })).toMatchObject({ ok: false, error: "Missing required field: id" });
    expect(validateAccountPostBody({ ...base, accessToken: undefined })).toMatchObject({ ok: false, error: "Missing required field: accessToken" });
    expect(validateAccountPostBody({ ...base, expiresAt: "soon" })).toMatchObject({ ok: false, error: "Invalid field types on account record" });
  });

  it("reads the replace flag", () => {
    const result = validateAccountPostBody({ ...base, replace: true });
    expect(result.ok && result.body.replace).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/account-post-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

`src/proxy/account-post-validation.ts`:

```ts
import type { AccountRecord } from "./types.js";

export type ValidatedAccountPost =
  | { ok: true; body: AccountRecord & { replace: boolean } }
  | { ok: false; status: 400; error: string };

/**
 * Field validation for POST /cc-router/accounts, pulled out of the route so
 * the one behavioural exception is testable on its own: an Anthropic record
 * may omit `refreshToken` (a `claude setup-token` credential has none), every
 * other provider must send one.
 */
export function validateAccountPostBody(raw: unknown): ValidatedAccountPost {
  const body = (raw && typeof raw === "object" ? raw : {}) as Partial<AccountRecord> & { replace?: unknown };
  const isAnthropic = body.provider === undefined || body.provider === "anthropic_subscription";
  const required: (keyof AccountRecord)[] = isAnthropic
    ? ["id", "accessToken", "expiresAt"]
    : ["id", "accessToken", "refreshToken", "expiresAt"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return { ok: false, status: 400, error: `Missing required field: ${k}` };
    }
  }
  if (typeof body.id !== "string" || typeof body.accessToken !== "string" || typeof body.expiresAt !== "number"
    || (body.refreshToken !== undefined && typeof body.refreshToken !== "string")) {
    return { ok: false, status: 400, error: "Invalid field types on account record" };
  }
  return { ok: true, body: { ...(body as AccountRecord), replace: body.replace === true } };
}
```

- [ ] **Step 4: Use it in the route**

In `src/proxy/server.ts` `accountsRouter.post("/")`, replace everything from `const body = ...` through the `Invalid field types` return with:

```ts
    const validated = validateAccountPostBody(req.body);
    if (!validated.ok) { res.status(validated.status).json({ error: validated.error }); return; }
    const { replace: wantsReplace, ...body } = validated.body;
```

In the OpenAI replace/add branches use `refreshToken: body.refreshToken!` (the validator guarantees it for OpenAI). In the Anthropic replace and add branches pass `refreshToken: body.refreshToken` (optional). Add the import.

In `publicAnthropicAccountView`, next to the `authExpired` spread: `...(a.tokens.refreshToken ? {} : { tokenOnly: true as const }),` and add `tokenOnly?: true;` to `HealthAccountView`.

- [ ] **Step 5: Run tests and lint**

Run: `pnpm vitest run src/__tests__/account-post-validation.test.ts src/__tests__/server-health-accounts.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/account-post-validation.ts src/proxy/server.ts src/__tests__/account-post-validation.test.ts
git commit -m "feat: accept refresh-less Anthropic accounts on the account POST and flag them token-only"
```

---

### Task 4: Usage and identity fetches skip inference-only tokens

**Files:**
- Modify: `src/providers/anthropic/usage-refresher.ts`
- Modify: `src/providers/account-info-fetch.ts` (`AccountInfoSource.scopes?: string[]`), `src/proxy/account-info-cache.ts`, `src/proxy/server.ts` (`accountInfoSources` passes `scopes`)
- Test: `src/__tests__/anthropic-usage-refresher.test.ts`, `src/__tests__/account-info-cache.test.ts` (create if absent)

**Interfaces:**
- Produces: `export function canReadProfile(scopes: string[] | undefined): boolean` in `src/providers/anthropic/scopes.ts` (new, tiny): true when `scopes` includes `"user:profile"`. Anthropic-only; OpenAI and xAI sources always return true.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/anthropic-usage-refresher.test.ts`:

```ts
  it("does not fetch usage for an inference-only token and marks it unavailable", async () => {
    const fetchUsage = vi.fn(async () => usageResult());
    const pool = new TokenPool([account("inference-only")]);
    const refresher = new AnthropicUsageRefresher(pool, { fetchUsage, now: () => 1_000 });
    const result = await refresher.refreshNow(pool.getAll()[0]!);
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(pool.getAll()[0]!.rateLimits.usage).toMatchObject({ fetchStatus: "unavailable", modelLimits: [] });
  });
```

The `account()` helper in that file already builds `scopes: ["user:inference"]`; check the other tests still pass by giving them `["user:inference", "user:profile"]` where they expect a fetch (update the helper to take a `scopes` argument defaulting to both).

`src/__tests__/account-info-cache.test.ts` (create):

```ts
import { describe, expect, it, vi } from "vitest";
import { AccountInfoCache } from "../proxy/account-info-cache.js";

describe("AccountInfoCache scopes", () => {
  it("never fetches identity for an anthropic source without user:profile", async () => {
    const fetchInfo = vi.fn(async () => ({ accountType: "personal" as const, fetchStatus: "fresh" as const, fetchedAt: 1 }));
    const cache = new AccountInfoCache(() => [
      { id: "long", provider: "anthropic_subscription", accessToken: "a", expiresAt: 2_000, scopes: ["user:inference"] },
      { id: "full", provider: "anthropic_subscription", accessToken: "b", expiresAt: 2_000, scopes: ["user:inference", "user:profile"] },
    ], { now: () => 1, fetchInfo });
    await cache.refresh(true);
    expect(fetchInfo.mock.calls.map(([source]) => source.id)).toEqual(["full"]);
    cache.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/anthropic-usage-refresher.test.ts src/__tests__/account-info-cache.test.ts`
Expected: FAIL — fetch called for both.

- [ ] **Step 3: Implement**

`src/providers/anthropic/scopes.ts`:

```ts
/** The OAuth usage and profile endpoints need `user:profile`; a `claude
 *  setup-token` credential carries `user:inference` only. */
export function canReadProfile(scopes: string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes("user:profile");
}
```

In `AnthropicUsageRefresher`'s `fetchUsage` wrapper, before `withTelemetrySpan`:

```ts
      fetchUsage: account => canReadProfile(account.tokens.scopes)
        ? withTelemetrySpan(/* existing body unchanged */)
        : Promise.resolve<UsageFetchResult>({ ok: false, reason: "http", status: 403 }),
```

Check `UsageFetchFailureReason` in `src/providers/anthropic/usage.ts`; if `"http"` is not a member, use whichever member denotes an HTTP rejection. `applyResult` already writes `unavailable` for a failed first fetch.

In `AccountInfoSource` add `scopes?: string[];`. In `AccountInfoCache.run`, extend the `queue` filter with `&& (account.provider !== "anthropic_subscription" || canReadProfile(account.scopes))`. In `server.ts` `accountInfoSources`, add `scopes: account.tokens.scopes,` to the Anthropic mapping.

- [ ] **Step 4: Run tests and lint**

Run: `pnpm vitest run src/__tests__/anthropic-usage-refresher.test.ts src/__tests__/account-info-cache.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic/scopes.ts src/providers/anthropic/usage-refresher.ts src/providers/account-info-fetch.ts src/proxy/account-info-cache.ts src/proxy/server.ts src/__tests__/anthropic-usage-refresher.test.ts src/__tests__/account-info-cache.test.ts
git commit -m "feat: skip usage and identity fetches for inference-only Claude tokens"
```

---

### Task 5: Browser opener

**Files:**
- Create: `src/utils/browser.ts`
- Test: `src/__tests__/browser.test.ts`

**Interfaces:**
- Produces:

```ts
export function browserCommandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] };
export function openInBrowser(url: string, deps?: { execFile?: typeof execFile; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { browserCommandFor, openInBrowser } from "../utils/browser.js";

describe("browserCommandFor", () => {
  it("maps platforms to their opener", () => {
    expect(browserCommandFor("darwin", "https://x")).toEqual({ command: "open", args: ["https://x"] });
    expect(browserCommandFor("linux", "https://x")).toEqual({ command: "xdg-open", args: ["https://x"] });
    expect(browserCommandFor("win32", "https://x")).toEqual({ command: "cmd", args: ["/c", "start", "", "https://x"] });
  });
});

describe("openInBrowser", () => {
  it("resolves true when the opener exits cleanly", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (err: Error | null) => void) => cb(null)) as never;
    await expect(openInBrowser("https://x", { execFile, platform: "linux", env: {} })).resolves.toBe(true);
  });

  it("resolves false instead of throwing when the opener fails", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (err: Error | null) => void) => cb(new Error("ENOENT"))) as never;
    await expect(openInBrowser("https://x", { execFile, platform: "linux", env: {} })).resolves.toBe(false);
  });

  it("does nothing when CC_ROUTER_NO_BROWSER=1", async () => {
    const execFile = vi.fn() as never;
    await expect(openInBrowser("https://x", { execFile, platform: "darwin", env: { CC_ROUTER_NO_BROWSER: "1" } })).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/browser.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { execFile as nodeExecFile } from "node:child_process";

export function browserCommandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Best-effort: a headless box, a missing opener or an odd desktop must never
 * fail a sign-in. The caller always prints the URL as well.
 */
export function openInBrowser(
  url: string,
  deps: { execFile?: typeof nodeExecFile; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.CC_ROUTER_NO_BROWSER === "1") return Promise.resolve(false);
  const { command, args } = browserCommandFor(deps.platform ?? process.platform, url);
  const execFile = deps.execFile ?? nodeExecFile;
  return new Promise(resolve => {
    try {
      execFile(command, args, error => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}
```

- [ ] **Step 4: Run tests** — `pnpm vitest run src/__tests__/browser.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/browser.ts src/__tests__/browser.test.ts
git commit -m "feat: add a best-effort cross-platform browser opener"
```

---

### Task 6: Device-code logins open the browser; OpenAI URL carries code and email hint

**Files:**
- Modify: `src/providers/openai/device-oauth.ts`
- Modify: `src/providers/xai/device-oauth.ts`
- Test: `src/__tests__/openai-device-oauth.test.ts` (extend if present, else create)

**Interfaces:**
- Consumes: `openInBrowser` (Task 5).
- Produces: `export function buildOpenAIDeviceVerificationUrl(issuer: string, userCode: string, loginHint?: string): string`; `LoginOpenAIWithDeviceCodeOptions.loginHint?: string` and `.openBrowser?: (url: string) => Promise<boolean>`; same `openBrowser` option on `LoginXaiWithDeviceCodeOptions`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { buildOpenAIDeviceVerificationUrl, loginOpenAIWithDeviceCode } from "../providers/openai/device-oauth.js";

describe("buildOpenAIDeviceVerificationUrl", () => {
  it("carries the user code", () => {
    expect(buildOpenAIDeviceVerificationUrl("https://auth.openai.com", "ABCD-EFGH"))
      .toBe("https://auth.openai.com/codex/device?user_code=ABCD-EFGH");
  });
  it("adds the email as login_hint when known", () => {
    expect(buildOpenAIDeviceVerificationUrl("https://auth.openai.com", "ABCD-EFGH", "me@example.com"))
      .toBe("https://auth.openai.com/codex/device?user_code=ABCD-EFGH&login_hint=me%40example.com");
  });
});

describe("loginOpenAIWithDeviceCode browser opening", () => {
  it("opens the verification URL once, after reporting the device code", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "d", user_code: "CODE", interval: 0 });
      if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "c", code_challenge: "x", code_verifier: "y" });
      // token exchange
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
      return Response.json({ id_token: "i", access_token: jwt, refresh_token: "r" });
    }) as never;
    const openBrowser = vi.fn(async (url: string) => { calls.push(url); return true; });
    await loginOpenAIWithDeviceCode({
      accountId: "o", fetchImpl, loginHint: "me@example.com", openBrowser,
      onDeviceCode: () => calls.push("printed"), sleep: async () => {},
    });
    expect(calls).toEqual(["printed", "https://auth.openai.com/codex/device?user_code=CODE&login_hint=me%40example.com"]);
  });
});
```

Adjust the token-exchange stub to whatever path `exchangeOpenAIDeviceCodeForTokens` posts to (read the function; match on its URL suffix).

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/openai-device-oauth.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/providers/openai/device-oauth.ts`:

```ts
import { openInBrowser } from "../../utils/browser.js";

export function buildOpenAIDeviceVerificationUrl(issuer: string, userCode: string, loginHint?: string): string {
  const params = new URLSearchParams({ user_code: userCode });
  if (loginHint) params.set("login_hint", loginHint);
  return `${issuer.replace(/\/+$/, "")}/codex/device?${params.toString()}`;
}
```

`OpenAIDeviceOAuthOptions` gains `loginHint?: string`. In `requestOpenAIDeviceCode` return `verificationUrl: buildOpenAIDeviceVerificationUrl(issuer, userCode, opts.loginHint)`. `LoginOpenAIWithDeviceCodeOptions` gains `openBrowser?: (url: string) => Promise<boolean>`. In `loginOpenAIWithDeviceCode`, after `opts.onDeviceCode?.(deviceCode);` add `await (opts.openBrowser ?? openInBrowser)(deviceCode.verificationUrl);`.

Mirror the `openBrowser` option in `loginXaiWithDeviceCode` (`src/providers/xai/device-oauth.ts`) after its `onDeviceCode` call.

- [ ] **Step 4: Manual check (record the outcome in the commit message)**

Run `pnpm dev accounts login openai --email you@example.com` after Task 9 lands, or temporarily via `node -e` against `buildOpenAIDeviceVerificationUrl`, and open the resulting URL in a browser. Note whether the code field and the email field are prefilled. If a parameter is ignored, remove it from `buildOpenAIDeviceVerificationUrl`, update the test expectation, and say so in the commit body. This check may be deferred until Task 9 makes the command runnable; do not skip it.

- [ ] **Step 5: Run tests and lint** — `pnpm vitest run src/__tests__/openai-device-oauth.test.ts && pnpm lint` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/openai/device-oauth.ts src/providers/xai/device-oauth.ts src/__tests__/openai-device-oauth.test.ts
git commit -m "feat: open the device sign-in page and prefill the OpenAI code and email"
```

---

### Task 7: Drive the Claude Code CLI

**Files:**
- Create: `src/providers/anthropic/claude-cli.ts`
- Modify: `src/telemetry/contracts.ts` (`SETUP_METHODS`)
- Test: `src/__tests__/claude-cli.test.ts`

**Interfaces:**
- Consumes: `extractFromKeychainDetailed`, `extractFromCredentialsFileDetailed`, `CredentialExtractionResult` from `src/utils/token-extractor.ts`; `SetupDiagnosticError` from `src/telemetry/setup-diagnostics.ts`; `isMacos` from `src/utils/platform.ts`.
- Produces:

```ts
export const LONG_LIVED_TOKEN_TTL_MS: number; // 365 days
export interface ClaudeCliDeps {
  spawn?: typeof spawn;
  execFile?: typeof execFile;
  extract?: () => Promise<CredentialExtractionResult>;
  stdout?: NodeJS.WritableStream;
  now?: () => number;
}
export function resolveClaudeCli(deps?: ClaudeCliDeps): Promise<string>;          // "claude" or throws SetupDiagnosticError
export function extractLongLivedToken(output: string): string | null;
export function loginWithClaudeCli(options: { email?: string }, deps?: ClaudeCliDeps): Promise<OAuthTokens>;
export function createLongLivedTokenWithClaudeCli(deps?: ClaudeCliDeps): Promise<{ accessToken: string } | null>; // null = no token captured
```

- [ ] **Step 1: Add telemetry methods**

In `src/telemetry/contracts.ts` `SETUP_METHODS`, add `"claude_cli_login"` and `"claude_setup_token"` after `"device_oauth"`.

- [ ] **Step 2: Write the failing tests**

`src/__tests__/claude-cli.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createLongLivedTokenWithClaudeCli,
  extractLongLivedToken,
  loginWithClaudeCli,
  resolveClaudeCli,
} from "../providers/anthropic/claude-cli.js";
import type { OAuthTokens } from "../proxy/types.js";

const ok = (tokens: OAuthTokens) => async () => ({ ok: true as const, tokens });
const tokens = (accessToken: string): OAuthTokens => ({
  accessToken, refreshToken: "sk-ant-ort01-r", expiresAt: 1_900_000_000_000, scopes: ["user:inference", "user:profile"],
});

/** A fake child process: emits `exit` with `code` after the caller writes `stdoutChunks`. */
function fakeSpawn(code: number, stdoutChunks: string[] = []) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    setImmediate(() => {
      for (const chunk of stdoutChunks) child.stdout.write(chunk);
      child.stdout.end();
      child.emit("exit", code, null);
    });
    return child;
  }) as never;
  return { spawn, calls };
}

describe("extractLongLivedToken", () => {
  it("returns the last token across repeated ANSI-coloured frames", () => {
    const frame = (n: number) => `[33msk-ant-oat01-${"a".repeat(30)}${n}[39m\n`;
    expect(extractLongLivedToken(frame(1) + "Store this token securely\n" + frame(2))).toBe(`sk-ant-oat01-${"a".repeat(30)}2`);
  });
  it("returns null when nothing matches", () => {
    expect(extractLongLivedToken("Browser didn't open?\nsk-ant-ort01-not-an-access-token")).toBeNull();
  });
});

describe("resolveClaudeCli", () => {
  it("throws a not_found setup error when claude is missing", async () => {
    const execFile = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(Object.assign(new Error("nope"), { code: "ENOENT" }))) as never;
    await expect(resolveClaudeCli({ execFile })).rejects.toMatchObject({ diagnostic: { stage: "credential_read", reason: "not_found" } });
  });
});

describe("loginWithClaudeCli", () => {
  it("passes --claudeai and --email and returns the newly stored credentials", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const extract = vi.fn().mockResolvedValueOnce({ ok: true, tokens: tokens("sk-ant-oat01-old") })
      .mockResolvedValueOnce({ ok: true, tokens: tokens("sk-ant-oat01-new") });
    const result = await loginWithClaudeCli({ email: "me@example.com" }, { spawn, extract, execFile: okExecFile() });
    expect(result.accessToken).toBe("sk-ant-oat01-new");
    expect(calls[0]).toEqual({ command: "claude", args: ["auth", "login", "--claudeai", "--email", "me@example.com"] });
  });

  it("fails when login exits 0 but the stored token is unchanged", async () => {
    const { spawn } = fakeSpawn(0);
    const extract = ok(tokens("sk-ant-oat01-same"));
    await expect(loginWithClaudeCli({}, { spawn, extract, execFile: okExecFile() }))
      .rejects.toMatchObject({ diagnostic: { stage: "credential_read", reason: "not_found" } });
  });

  it("treats a non-zero exit as a cancellation", async () => {
    const { spawn } = fakeSpawn(1);
    await expect(loginWithClaudeCli({}, { spawn, extract: ok(tokens("x")), execFile: okExecFile() }))
      .rejects.toMatchObject({ diagnostic: { stage: "credential_read", reason: "user_cancelled" } });
  });
});

describe("createLongLivedTokenWithClaudeCli", () => {
  it("mirrors stdout and returns the captured token", async () => {
    const token = `sk-ant-oat01-${"b".repeat(40)}`;
    const { spawn, calls } = fakeSpawn(0, ["Creating...\n", `[33m${token}[39m\n`]);
    const mirrored = new PassThrough();
    let seen = "";
    mirrored.on("data", c => { seen += c; });
    const result = await createLongLivedTokenWithClaudeCli({ spawn, stdout: mirrored, execFile: okExecFile() });
    expect(result).toEqual({ accessToken: token });
    expect(seen).toContain("Creating...");
    expect(calls[0]).toEqual({ command: "claude", args: ["setup-token"] });
  });

  it("returns null when no token appears in the output", async () => {
    const { spawn } = fakeSpawn(0, ["nothing here\n"]);
    await expect(createLongLivedTokenWithClaudeCli({ spawn, stdout: new PassThrough(), execFile: okExecFile() })).resolves.toBeNull();
  });
});

function okExecFile() {
  return vi.fn((_c: string, _a: string[], cb: (e: Error | null, stdout: string) => void) => cb(null, "2.1.276\n")) as never;
}
```

Check how `SetupDiagnosticError` exposes its classification (`diagnostic` property or similar) in `src/telemetry/setup-diagnostics.ts` and adjust the `toMatchObject` paths.

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run src/__tests__/claude-cli.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`src/providers/anthropic/claude-cli.ts`:

```ts
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { OAuthTokens } from "../../proxy/types.js";
import { SetupDiagnosticError } from "../../telemetry/setup-diagnostics.js";
import {
  extractFromCredentialsFileDetailed,
  extractFromKeychainDetailed,
  type CredentialExtractionResult,
} from "../../utils/token-extractor.js";
import { isMacos } from "../../utils/platform.js";

export const LONG_LIVED_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CLAUDE = "claude";
const TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g;

export interface ClaudeCliDeps {
  spawn?: typeof nodeSpawn;
  execFile?: typeof nodeExecFile;
  extract?: () => Promise<CredentialExtractionResult>;
  stdout?: NodeJS.WritableStream;
  now?: () => number;
}

function defaultExtract(): Promise<CredentialExtractionResult> {
  return isMacos() ? extractFromKeychainDetailed() : Promise.resolve(extractFromCredentialsFileDetailed());
}

/** Confirms the Claude Code CLI is runnable; the error message tells the operator the import fallback. */
export function resolveClaudeCli(deps: ClaudeCliDeps = {}): Promise<string> {
  const execFile = deps.execFile ?? nodeExecFile;
  return new Promise((resolve, reject) => {
    execFile(CLAUDE, ["--version"], error => {
      if (!error) { resolve(CLAUDE); return; }
      reject(new SetupDiagnosticError(
        "Claude Code CLI not found on PATH. Install it or use `cc-router accounts add claude` to import an existing login.",
        { stage: "credential_read", reason: "not_found", expected: true },
        { cause: error },
      ));
    });
  });
}

/** Last token in the (ANSI-stripped) output: Ink repaints the success frame several times. */
export function extractLongLivedToken(output: string): string | null {
  const matches = output.replace(ANSI, "").match(TOKEN_PATTERN);
  return matches ? matches[matches.length - 1]! : null;
}

function waitForExit(child: ReturnType<typeof nodeSpawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}

/**
 * `claude auth login --claudeai [--email]` with the terminal handed over to
 * Claude Code. The snapshot comparison is what stops a login that exited 0
 * without writing from re-importing the previous account.
 */
export async function loginWithClaudeCli(options: { email?: string }, deps: ClaudeCliDeps = {}): Promise<OAuthTokens> {
  const command = await resolveClaudeCli(deps);
  const extract = deps.extract ?? defaultExtract;
  const before = await extract();
  const args = ["auth", "login", "--claudeai", ...(options.email ? ["--email", options.email] : [])];
  const child = (deps.spawn ?? nodeSpawn)(command, args, { stdio: "inherit" });
  const code = await waitForExit(child);
  if (code !== 0) {
    throw new SetupDiagnosticError("claude auth login was cancelled or failed", {
      stage: "credential_read", reason: "user_cancelled", expected: true,
    });
  }
  const after = await extract();
  if (!after.ok) throw after.error;
  if (before.ok && before.tokens.accessToken === after.tokens.accessToken) {
    throw new SetupDiagnosticError("claude auth login finished but no new credentials were stored.", {
      stage: "credential_read", reason: "not_found", expected: true,
    });
  }
  return after.tokens;
}

/**
 * `claude setup-token` with stdout mirrored to the terminal and scanned for
 * the token line. Ink keys raw mode on stdin, which stays inherited, and its
 * cursor escapes pass through untouched, so the UI renders as usual. `null`
 * means the command ended without a recognisable token; the caller falls
 * back to a paste prompt.
 */
export async function createLongLivedTokenWithClaudeCli(deps: ClaudeCliDeps = {}): Promise<{ accessToken: string } | null> {
  const command = await resolveClaudeCli(deps);
  const mirror = deps.stdout ?? process.stdout;
  const child = (deps.spawn ?? nodeSpawn)(command, ["setup-token"], { stdio: ["inherit", "pipe", "inherit"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
    mirror.write(chunk);
  });
  const code = await waitForExit(child);
  if (code !== 0) return null;
  const accessToken = extractLongLivedToken(output);
  return accessToken ? { accessToken } : null;
}
```

Match `SetupDiagnosticError`'s constructor signature to what `src/telemetry/setup-diagnostics.ts` defines (the pattern used in `token-extractor.ts` is `new SetupDiagnosticError(message, { stage, reason, expected }, { cause })`).

- [ ] **Step 5: Manual check (record the outcome in the commit message)**

Run `pnpm tsx -e "import('./src/providers/anthropic/claude-cli.ts').then(m => m.createLongLivedTokenWithClaudeCli().then(r => console.log(r ? 'captured' : 'null')))"` on this machine, complete the browser flow, and confirm `captured` prints and the Ink UI rendered normally. If the token is not captured, inspect what `claude setup-token` printed and adjust `TOKEN_PATTERN` / ANSI stripping; state the result in the commit body. Do not paste the token anywhere.

- [ ] **Step 6: Run tests and lint** — `pnpm vitest run src/__tests__/claude-cli.test.ts && pnpm lint` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/anthropic/claude-cli.ts src/telemetry/contracts.ts src/__tests__/claude-cli.test.ts
git commit -m "feat: drive claude auth login and claude setup-token from cc-router"
```

---

### Task 8: Shared account flows module

**Files:**
- Create: `src/cli/account-flows.ts`
- Modify: `src/cli/cmd-setup.ts` (delete `setupSingleAccountWithAttempt`, `collectAnthropicAccount`, `promptManualTokens`; import from the new module)
- Modify: `src/cli/cmd-status.ts` (`runAddAccountFlow` imports the new function)
- Modify: `src/__tests__/cmd-accounts-add-replace.test.ts` (mock target moves)
- Test: `src/__tests__/account-flows.test.ts`

**Interfaces:**
- Consumes: Task 7 functions; `loginOpenAIWithDeviceCode` (Task 6 options); `loginXaiWithDeviceCode`; `importGrokCliAuth`; `createOpenAIAccountRecord`; `validateToken`; `redactToken`, `formatExpiry`.
- Produces:

```ts
export type ClaudeMethod = "cli_login" | "setup_token" | "keychain" | "credentials" | "manual";
export interface ClaudeFlowOptions {
  /** 1-based position used for the default id `max-account-N`. */
  index: number;
  /** Re-auth: id is fixed, no prompt. */
  fixedId?: string;
  /** Prefilled into `claude auth login --email`. */
  email?: string;
  /** Skip the picker. */
  method?: ClaudeMethod;
  /** Which methods the picker offers. Default "all". */
  offer?: "login" | "import" | "all";
}
export function collectClaudeAccount(options: ClaudeFlowOptions): Promise<{ account: Account | null; attempt: SetupAttempt }>;

export function loginOpenAIAccount(options: { accountId: string; email?: string }): Promise<{ record: OpenAIAccountRecord; attempt: SetupAttempt }>;
export function importOpenAIAccount(options: { accountId?: string }): Promise<{ record: OpenAIAccountRecord; attempt: SetupAttempt }>;
export function loginGrokAccount(options: { accountId?: string }): Promise<AccountRecord>;
export function importGrokAccount(options: { accountId?: string }): Promise<AccountRecord>;

export interface ReauthTarget { id: string; provider: "anthropic_subscription" | "openai_subscription"; email?: string }
/** Runs the provider's login with the id fixed. Returns null when the operator cancels. */
export function collectReauthRecord(target: ReauthTarget, options?: { longLived?: boolean }): Promise<{ record: AccountRecord; attempt: SetupAttempt } | null>;
export function accountToRecord(account: Account): AccountRecord;
```

`accountToRecord` is `serialize([account])[0]` from `manager.ts`.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/account-flows.test.ts` — mock prompts and the CLI module, test the Claude flow's method handling and the re-auth record collection:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), password: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);
const cli = vi.hoisted(() => ({ loginWithClaudeCli: vi.fn(), createLongLivedTokenWithClaudeCli: vi.fn(), LONG_LIVED_TOKEN_TTL_MS: 365 * 86_400_000 }));
vi.mock("../providers/anthropic/claude-cli.js", () => cli);
vi.mock("../utils/token-validator.js", () => ({ validateToken: async () => ({ valid: true }) }));
vi.mock("../telemetry/setup-diagnostics.js", async importOriginal => ({
  ...await importOriginal<typeof import("../telemetry/setup-diagnostics.js")>(),
  withSetupTelemetryFlush: (fn: () => Promise<unknown>) => fn(),
}));

import { collectClaudeAccount, collectReauthRecord } from "../cli/account-flows.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("collectClaudeAccount", () => {
  it("cli_login passes the email through and keeps the returned refresh token", async () => {
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-a", refreshToken: "sk-ant-ort01-a", expiresAt: 5, scopes: ["user:inference", "user:profile"] });
    prompts.input.mockResolvedValue("max-account-3");
    const { account } = await collectClaudeAccount({ index: 3, method: "cli_login", email: "me@example.com" });
    expect(cli.loginWithClaudeCli).toHaveBeenCalledWith({ email: "me@example.com" }, undefined);
    expect(account?.id).toBe("max-account-3");
    expect(account?.tokens.refreshToken).toBe("sk-ant-ort01-a");
  });

  it("setup_token stores an inference-only token with a one-year expiry and no refresh token", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-long" });
    prompts.input.mockResolvedValue("long");
    prompts.confirm.mockResolvedValue(true); // keep default expiry
    const before = Date.now();
    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token" });
    expect(account?.tokens).toMatchObject({ accessToken: "sk-ant-oat01-long", refreshToken: undefined, scopes: ["user:inference"] });
    expect(account!.tokens.expiresAt).toBeGreaterThanOrEqual(before + 365 * 86_400_000 - 1);
  });

  it("setup_token falls back to a paste prompt when nothing was captured", async () => {
    cli.createLongLivedTokenWithClaudeCli.mockResolvedValue(null);
    prompts.password.mockResolvedValue("sk-ant-oat01-pasted");
    prompts.input.mockResolvedValue("long");
    prompts.confirm.mockResolvedValue(true);
    const { account } = await collectClaudeAccount({ index: 1, method: "setup_token" });
    expect(account?.tokens.accessToken).toBe("sk-ant-oat01-pasted");
  });

  it("fixedId skips the id prompt", async () => {
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-b", refreshToken: "sk-ant-ort01-b", expiresAt: 5, scopes: [] });
    const { account } = await collectClaudeAccount({ index: 1, method: "cli_login", fixedId: "max-dead" });
    expect(prompts.input).not.toHaveBeenCalled();
    expect(account?.id).toBe("max-dead");
  });
});

describe("collectReauthRecord", () => {
  it("re-signs a Claude account under the same id with the email prefilled", async () => {
    prompts.select.mockResolvedValue("cli_login");
    cli.loginWithClaudeCli.mockResolvedValue({ accessToken: "sk-ant-oat01-c", refreshToken: "sk-ant-ort01-c", expiresAt: 5, scopes: [] });
    const result = await collectReauthRecord({ id: "max-dead", provider: "anthropic_subscription", email: "me@example.com" });
    expect(result?.record).toMatchObject({ id: "max-dead", provider: "anthropic_subscription", accessToken: "sk-ant-oat01-c" });
    expect(cli.loginWithClaudeCli).toHaveBeenCalledWith({ email: "me@example.com" }, undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/account-flows.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/cli/account-flows.ts`**

Move `setupSingleAccountWithAttempt`, `collectAnthropicAccount`, `promptManualTokens` and `printDiagnosticId` (if only used there) from `cmd-setup.ts` verbatim, then apply these changes:

```ts
export type ClaudeMethod = "cli_login" | "setup_token" | "keychain" | "credentials" | "manual";

const CLAUDE_METHOD_TELEMETRY: Record<ClaudeMethod, SetupMethod> = {
  cli_login: "claude_cli_login",
  setup_token: "claude_setup_token",
  keychain: "macos_keychain",
  credentials: "claude_credentials_file",
  manual: "manual_token",
};

function claudeMethodChoices(offer: "login" | "import" | "all"): Array<{ name: string; value: ClaudeMethod }> {
  const login: Array<{ name: string; value: ClaudeMethod }> = [
    { name: "Sign in with the browser  (claude auth login — recommended)", value: "cli_login" },
    { name: "Create a long-lived token (claude setup-token — does not change Claude Code's login)", value: "setup_token" },
  ];
  const imports: Array<{ name: string; value: ClaudeMethod }> = [
    ...(isMacos() ? [{ name: "Extract automatically from macOS Keychain", value: "keychain" as const }] : []),
    { name: "Read from ~/.claude/.credentials.json", value: "credentials" },
    { name: "Paste tokens manually", value: "manual" },
  ];
  return offer === "login" ? login : offer === "import" ? imports : [...login, ...imports];
}

export async function collectClaudeAccount(options: ClaudeFlowOptions): Promise<{ account: Account | null; attempt: SetupAttempt }> {
  const method = options.method ?? await select<ClaudeMethod>({
    message: "How do you want to add the account?",
    choices: claudeMethodChoices(options.offer ?? "all"),
  });
  const attempt = createSetupAttempt({ provider: "anthropic", method: CLAUDE_METHOD_TELEMETRY[method] });
  attempt.stageCompleted("credential_source_selection");
  const current = { attempt };
  let reached: SetupStage = "credential_read";
  try {
    return await collectAnthropicAccount(options, method, current, stage => { reached = stage; });
  } catch (error) {
    const outcome = failAttemptFromError(current.attempt, error, reached);
    if (outcome) printDiagnosticId(outcome);
    throw error;
  }
}
```

In `collectAnthropicAccount` (now taking `options: ClaudeFlowOptions` instead of `index`), add the two new branches before the keychain branch:

```ts
  if (method === "cli_login") {
    console.log(chalk.gray("\n  Handing the terminal to Claude Code. Sign in with the account you want to add.\n"));
    tokens = await loginWithClaudeCli({ email: options.email }, undefined);
    console.log(chalk.green(`  ✓ Signed in — token ${redactToken(tokens.accessToken)}, expires ${formatExpiry(tokens.expiresAt)}`));
    console.log(chalk.gray("  Note: Claude Code on this machine is now logged in as this account."));
  }

  if (method === "setup_token") {
    console.log(chalk.gray("\n  Handing the terminal to Claude Code to create a long-lived token.\n"));
    const captured = await createLongLivedTokenWithClaudeCli(undefined);
    let accessToken = captured?.accessToken;
    if (!accessToken) {
      console.log(chalk.yellow("\n  Could not read the token from claude setup-token's output."));
      accessToken = await password({
        message: "Paste the token (sk-ant-oat01-...):",
        mask: "•",
        validate: v => v.startsWith("sk-ant-oat01-") || "Must start with sk-ant-oat01-",
      });
    }
    const useDefaultExpiry = await confirm({ message: "Token valid for 1 year (default)?", default: true });
    const expiresAt = useDefaultExpiry
      ? Date.now() + LONG_LIVED_TOKEN_TTL_MS
      : new Date(await input({ message: "Paste expiresAt (ISO date or ms timestamp):" })).getTime();
    tokens = { accessToken, refreshToken: undefined, expiresAt, scopes: ["user:inference"] };
    console.log(chalk.gray("  This token has no refresh token and the inference scope only: usage and identity metadata are unavailable for it."));
  }
```

Replace the id prompt with:

```ts
  const accountId = options.fixedId ?? await input({
    message: "Account ID (press Enter to accept default):",
    default: `max-account-${options.index}`,
    validate: v => /^[a-zA-Z0-9_-]+$/.test(v) || "Only letters, numbers, _ and - allowed",
  });
```

The recursion on Keychain failure becomes `return collectClaudeAccount({ ...options, method: undefined })`. In `promptManualTokens` the refresh token prompt stays required (a pasted setup-token goes through the `setup_token` method).

Add the OpenAI/Grok flows by moving the bodies of the old `login-openai`, `add-openai`, `login-grok`, `add-grok` actions (from `cmd-accounts.ts`) into `loginOpenAIAccount`, `importOpenAIAccount`, `loginGrokAccount`, `importGrokAccount`, each returning the record instead of persisting. `loginOpenAIAccount` passes `loginHint: options.email` and prints the email in the device-code block:

```ts
    onDeviceCode: code => {
      console.log(chalk.bold("1. Open this URL (opening it for you if possible):"));
      console.log(`   ${chalk.cyan(code.verificationUrl)}`);
      console.log(chalk.bold("2. Enter this code if the page does not fill it in:"));
      console.log(`   ${chalk.cyan(code.userCode)}`);
      if (options.email) console.log(chalk.bold(`3. Sign in as ${chalk.cyan(options.email)}`));
      console.log(chalk.gray("\nWaiting for authorization..."));
    },
```

The default account id for these functions when `accountId` is absent is what the old commands used (`openai-account-N`, `grok` / `grok-N`), prompted with `input`.

Re-auth:

```ts
export async function collectReauthRecord(
  target: ReauthTarget,
  options: { longLived?: boolean } = {},
): Promise<{ record: AccountRecord; attempt: SetupAttempt } | null> {
  console.log(chalk.cyan(`\nRe-authenticating "${target.id}" (${target.provider === "openai_subscription" ? "openai" : "claude"})`
    + (target.email ? ` — sign in as ${chalk.bold(target.email)}` : "") + "\n"));
  if (target.provider === "openai_subscription") {
    const { record, attempt } = await loginOpenAIAccount({ accountId: target.id, email: target.email });
    return { record, attempt };
  }
  const { account, attempt } = await collectClaudeAccount({
    index: 1,
    fixedId: target.id,
    email: target.email,
    offer: "login",
    ...(options.longLived ? { method: "setup_token" as const } : {}),
  });
  return account ? { record: accountToRecord(account), attempt } : null;
}

export function accountToRecord(account: Account): AccountRecord {
  return serialize([account])[0]!;
}
```

- [ ] **Step 4: Rewire callers**

- `cmd-setup.ts`: delete the moved functions; `runSetupWizard` calls `collectClaudeAccount({ index: i + 1 + existingCount })`. Keep `printDone`, the banner, and the client-mode wizard.
- `cmd-status.ts` `runAddAccountFlow`: `const { collectClaudeAccount } = await import("./account-flows.js"); const setup = await collectClaudeAccount({ index: 1 });` and post `accountToRecord(account)` spread with the existing fields (drop the hand-built body).
- `cmd-accounts.ts` `add` action: `const { collectClaudeAccount } = await import("./account-flows.js");` in place of the `cmd-setup` import. Leave the command shape alone; Task 9 restructures it.
- `src/__tests__/cmd-accounts-add-replace.test.ts`: change `vi.mock("../cli/cmd-setup.js", ...)` to `vi.mock("../cli/account-flows.js", () => ({ collectClaudeAccount: async () => ({ account: reauthed, attempt: {...} }), accountToRecord: (a) => ({ id: a.id, provider: "anthropic_subscription", accessToken: a.tokens.accessToken, refreshToken: a.tokens.refreshToken, expiresAt: a.tokens.expiresAt, scopes: a.tokens.scopes }) }))` — keep the rest of that test unchanged.

- [ ] **Step 5: Run tests and lint**

Run: `pnpm vitest run src/__tests__/account-flows.test.ts src/__tests__/cmd-accounts-add-replace.test.ts src/__tests__/setup-command-diagnostics.test.ts && pnpm lint`
Expected: PASS. If `setup-command-diagnostics.test.ts` mocks `cmd-setup` internals, point its mocks at `account-flows.js`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/account-flows.ts src/cli/cmd-setup.ts src/cli/cmd-status.ts src/cli/cmd-accounts.ts src/__tests__/account-flows.test.ts src/__tests__/cmd-accounts-add-replace.test.ts
git commit -m "refactor: gather provider sign-in flows into account-flows and add the Claude CLI methods"
```

---

### Task 9: `accounts login` / `add` / `reauth`

**Files:**
- Modify: `src/cli/cmd-accounts.ts`
- Test: `src/__tests__/cmd-accounts-verbs.test.ts` (new), `src/__tests__/cmd-accounts-reauth.test.ts`, `src/__tests__/cmd-accounts-json.test.ts`

**Interfaces:**
- Consumes: everything Task 8 exports; `addAccountRuntimeAware`, `fetchLiveStats`, `mergeAccountInventory`.
- Produces: `export function resolveReauthTarget(id, live: LiveAccountSummary[] | null, stored: { anthropic: Account[]; openai: OpenAISubscriptionAccount[]; xai: XaiSubscriptionAccount[] }): ReauthTarget | { grok: true } | null` (pure, exported for tests); `export type ProviderArg = "claude" | "openai" | "grok"`; `export function parseProviderArg(value: string | undefined): ProviderArg | undefined` (throws on unknown).

- [ ] **Step 1: Write the failing tests**

`src/__tests__/cmd-accounts-verbs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const flows = vi.hoisted(() => ({
  collectClaudeAccount: vi.fn(), loginOpenAIAccount: vi.fn(), importOpenAIAccount: vi.fn(),
  loginGrokAccount: vi.fn(), importGrokAccount: vi.fn(), collectReauthRecord: vi.fn(),
  accountToRecord: (a: any) => ({ id: a.id, provider: "anthropic_subscription", accessToken: a.tokens.accessToken, refreshToken: a.tokens.refreshToken, expiresAt: a.tokens.expiresAt, scopes: a.tokens.scopes }),
}));
vi.mock("../cli/account-flows.js", () => flows);
const prompts = vi.hoisted(() => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), password: vi.fn() }));
vi.mock("@inquirer/prompts", () => prompts);
vi.mock("../config/manager.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/manager.js")>(),
  readConfig: () => ({}),
  accountsFileExists: () => true,
  loadAccounts: () => [],
  loadOpenAIAccounts: () => [],
  loadXaiAccounts: () => [],
  upsertAccountRecord: vi.fn(),
}));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no proxy"); }));

import { registerAccounts, resolveReauthTarget, parseProviderArg } from "../cli/cmd-accounts.js";

const attempt = { stageCompleted: vi.fn(), succeeded: vi.fn(), failed: vi.fn(), cancelled: vi.fn() };
function program() { const p = new Command(); p.exitOverride(); registerAccounts(p); return p; }

beforeEach(() => { vi.clearAllMocks(); });

describe("accounts login", () => {
  it("claude: runs the login picker with the id fixed by --id", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: { id: "x", tokens: { accessToken: "a", expiresAt: 1, scopes: [] } }, attempt });
    await program().parseAsync(["accounts", "login", "claude", "--id", "x", "--email", "me@example.com"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ fixedId: "x", email: "me@example.com", offer: "login" }));
  });
  it("claude --long-lived pins the setup-token method", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: null, attempt });
    await program().parseAsync(["accounts", "login", "claude", "--long-lived"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ method: "setup_token" }));
  });
  it("openai: forwards --id and --email to the device login", async () => {
    flows.loginOpenAIAccount.mockResolvedValue({ record: { id: "o", provider: "openai_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] }, attempt });
    await program().parseAsync(["accounts", "login", "openai", "--id", "o", "--email", "me@example.com"], { from: "user" });
    expect(flows.loginOpenAIAccount).toHaveBeenCalledWith({ accountId: "o", email: "me@example.com" });
  });
  it("prompts for the provider when omitted", async () => {
    prompts.select.mockResolvedValue("grok");
    flows.loginGrokAccount.mockResolvedValue({ id: "grok", provider: "xai_subscription", accessToken: "a", refreshToken: "r", expiresAt: 1, scopes: [] });
    await program().parseAsync(["accounts", "login"], { from: "user" });
    expect(flows.loginGrokAccount).toHaveBeenCalled();
  });
  it("rejects an unknown provider", () => {
    expect(() => parseProviderArg("bing")).toThrow(/claude, openai or grok/);
  });
});

describe("accounts add", () => {
  it("claude: offers import methods only", async () => {
    flows.collectClaudeAccount.mockResolvedValue({ account: null, attempt });
    await program().parseAsync(["accounts", "add", "claude"], { from: "user" });
    expect(flows.collectClaudeAccount).toHaveBeenCalledWith(expect.objectContaining({ offer: "import" }));
  });
});

describe("resolveReauthTarget", () => {
  it("prefers the live pool and carries the cached email", () => {
    const target = resolveReauthTarget("dead", [{ id: "dead", provider: "openai_subscription", accountInfo: { email: "me@example.com" } }], { anthropic: [], openai: [], xai: [] });
    expect(target).toEqual({ id: "dead", provider: "openai_subscription", email: "me@example.com" });
  });
  it("falls back to stored records without an email", () => {
    const target = resolveReauthTarget("stored", null, { anthropic: [{ id: "stored" } as any], openai: [], xai: [] });
    expect(target).toEqual({ id: "stored", provider: "anthropic_subscription" });
  });
  it("marks grok accounts", () => {
    expect(resolveReauthTarget("g", null, { anthropic: [], openai: [], xai: [{ id: "g" } as any] })).toEqual({ grok: true });
  });
  it("returns null for unknown ids", () => {
    expect(resolveReauthTarget("nope", null, { anthropic: [], openai: [], xai: [] })).toBeNull();
  });
});
```

Update `src/__tests__/cmd-accounts-reauth.test.ts` expectations from `cc-router accounts add` / `login-openai` hints to `cc-router accounts reauth <id>`. Update `cmd-accounts-json.test.ts` to expect `tokenOnly: true` for a stored Anthropic account without a refresh token (add one fixture).

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/cmd-accounts-verbs.test.ts src/__tests__/cmd-accounts-reauth.test.ts src/__tests__/cmd-accounts-json.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the verbs**

In `src/cli/cmd-accounts.ts` delete the `add`, `add-openai`, `login-openai`, `add-grok`, `login-grok` commands and add:

```ts
export type ProviderArg = "claude" | "openai" | "grok";

export function parseProviderArg(value: string | undefined): ProviderArg | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "openai" || value === "grok") return value;
  throw new Error(`Unknown provider "${value}" — use claude, openai or grok`);
}

async function chooseProvider(given: string | undefined): Promise<ProviderArg> {
  const parsed = parseProviderArg(given);
  if (parsed) return parsed;
  const { select } = await import("@inquirer/prompts");
  return select<ProviderArg>({
    message: "Which provider?",
    choices: [
      { name: "Claude (Claude Max / Pro subscription)", value: "claude" },
      { name: "OpenAI (ChatGPT / Codex subscription)", value: "openai" },
      { name: "Grok (xAI)", value: "grok" },
    ],
  });
}

async function persistClaude(account: Account, attempt: SetupAttempt): Promise<void> {
  const { accountToRecord } = await import("./account-flows.js");
  const existing = accountsFileExists() ? loadAccounts() : [];
  const merged = [...existing.filter(a => a.id !== account.id), account];
  let mode: "live" | "stored";
  try {
    ({ mode } = await addAccountRuntimeAware(accountToRecord(account), { addStored: () => saveAccounts(merged) }));
  } catch (error) {
    endFailedAttempt(attempt, error, "persistence");
    throw error;
  }
  attempt.stageCompleted("persistence");
  attempt.succeeded();
  console.log(chalk.green(`\n✓ Account "${account.id}" saved (${merged.length} Claude accounts).\n`));
  printAddOutcome(mode);
}

async function persistRecord(record: AccountRecord, attempt: SetupAttempt | undefined, label: string): Promise<void> {
  let mode: "live" | "stored";
  try {
    ({ mode } = await addAccountRuntimeAware(record));
  } catch (error) {
    if (attempt) endFailedAttempt(attempt, error, "persistence");
    throw error;
  }
  attempt?.stageCompleted("persistence");
  attempt?.succeeded();
  console.log(chalk.green(`\n✓ ${label} "${record.id}" saved.\n`));
  printAddOutcome(mode);
}

accounts
  .command("login [provider]")
  .description("Sign in to a Claude, OpenAI or Grok account in the browser (provider: claude | openai | grok)")
  .option("--id <id>", "Account id to store the credentials under")
  .option("--email <email>", "Email to prefill on the sign-in page")
  .option("--long-lived", "Claude only: create a long-lived token with claude setup-token instead of a full sign-in")
  .action(async (providerArg: string | undefined, opts: { id?: string; email?: string; longLived?: boolean }) =>
    withSetupTelemetryFlush(async () => {
      const provider = await chooseProvider(providerArg);
      const flows = await import("./account-flows.js");
      if (provider === "claude") {
        const { account, attempt } = await flows.collectClaudeAccount({
          index: (accountsFileExists() ? loadAccounts().length : 0) + 1,
          fixedId: opts.id, email: opts.email, offer: "login",
          ...(opts.longLived ? { method: "setup_token" as const } : {}),
        });
        if (!account) { console.log(chalk.yellow("\nNo account added.\n")); return; }
        await persistClaude(account, attempt);
        return;
      }
      if (provider === "openai") {
        const accountId = opts.id ?? await promptOpenAIId();
        const { record, attempt } = await flows.loginOpenAIAccount({ accountId, email: opts.email });
        await persistRecord(record, attempt, "OpenAI account");
        return;
      }
      const record = await flows.loginGrokAccount({ accountId: opts.id });
      upsertAccountRecord(record);
      console.log(chalk.green(`\n✓ Grok account "${record.id}" saved via device login.\n`));
      printAddOutcome("stored");
    }));

accounts
  .command("add [provider]")
  .description("Import credentials that already exist: Claude Keychain / credentials file / pasted tokens, OpenAI tokens, or ~/.grok")
  .option("--id <id>", "Account id to store the credentials under")
  .action(async (providerArg: string | undefined, opts: { id?: string }) => withSetupTelemetryFlush(async () => {
    const provider = await chooseProvider(providerArg);
    const flows = await import("./account-flows.js");
    if (provider === "claude") {
      const { account, attempt } = await flows.collectClaudeAccount({
        index: (accountsFileExists() ? loadAccounts().length : 0) + 1, fixedId: opts.id, offer: "import",
      });
      if (!account) { console.log(chalk.yellow("\nNo account added.\n")); return; }
      await persistClaude(account, attempt);
      return;
    }
    if (provider === "openai") {
      const { record, attempt } = await flows.importOpenAIAccount({ accountId: opts.id });
      await persistRecord(record, attempt, "OpenAI account");
      return;
    }
    const record = await flows.importGrokAccount({ accountId: opts.id });
    upsertAccountRecord(record);
    console.log(chalk.green(`\n✓ Grok account "${record.id}" imported from ~/.grok.\n`));
    printAddOutcome("stored");
  }));

accounts
  .command("reauth <id>")
  .description("Sign an existing account in again under the same id (its provider and email are looked up for you)")
  .option("--email <email>", "Override the email to prefill on the sign-in page")
  .option("--long-lived", "Claude only: use claude setup-token")
  .action(async (id: string, opts: { email?: string; longLived?: boolean }) => withSetupTelemetryFlush(async () => {
    const live = await fetchLiveStats();
    const target = resolveReauthTarget(id, live, {
      anthropic: accountsFileExists() ? loadAccounts() : [],
      openai: loadOpenAIAccounts(),
      xai: loadXaiAccounts(),
    });
    if (!target) {
      const { ids } = mergeAccountInventory(loadAccounts().map(a => a.id), loadOpenAIAccounts().map(a => a.id), live, loadXaiAccounts().map(a => a.id));
      console.log(chalk.red(`✗ Account "${id}" not found.`));
      console.log(chalk.gray(`  Available: ${ids.join(", ")}`));
      process.exit(1);
    }
    if ("grok" in target) {
      console.log(chalk.yellow(`Grok credentials live in ~/.grok. Run ${chalk.white("grok login")}, then ${chalk.white("cc-router accounts add grok")}.`));
      process.exit(1);
    }
    const flows = await import("./account-flows.js");
    const result = await flows.collectReauthRecord({ ...target, ...(opts.email ? { email: opts.email } : {}) }, { longLived: opts.longLived });
    if (!result) { console.log(chalk.yellow("\nNo account re-authenticated.\n")); return; }
    await persistRecord(result.record, result.attempt, target.provider === "openai_subscription" ? "OpenAI account" : "Account");
  }));
```

`promptOpenAIId` is the existing id prompt (`openai-account-N` default) extracted into a helper. `resolveReauthTarget`:

```ts
export function resolveReauthTarget(
  id: string,
  live: Array<LiveAccountSummary & { accountInfo?: AccountInfo }> | null,
  stored: { anthropic: Account[]; openai: OpenAISubscriptionAccount[]; xai: Array<{ id: string }> },
): ReauthTarget | { grok: true } | null {
  const liveMatch = live?.find(a => a.id === id);
  if (liveMatch) {
    if (liveMatch.provider === "xai_subscription") return { grok: true };
    return {
      id,
      provider: liveMatch.provider === "openai_subscription" ? "openai_subscription" : "anthropic_subscription",
      ...(liveMatch.accountInfo?.email ? { email: liveMatch.accountInfo.email } : {}),
    };
  }
  if (stored.xai.some(a => a.id === id)) return { grok: true };
  if (stored.openai.some(a => a.id === id)) return { id, provider: "openai_subscription" };
  if (stored.anthropic.some(a => a.id === id)) return { id, provider: "anthropic_subscription" };
  return null;
}
```

Change `reauthCommand()` to `return \`cc-router accounts reauth ${id}\`` (takes the id, drop the provider branch) and update its callers. In `list`, for stored Anthropic accounts print `token-only` in place of the scopes when `isTokenOnly(a.tokens)`; for live rows print it after the status when `s.tokenOnly`. In `buildStoredAccountsJson` add `...(isTokenOnly(a.tokens) ? { tokenOnly: true as const } : {})` and `tokenOnly?: true` to the return type. Extend `fetchLiveStats`'s row type with `tokenOnly?: boolean`.

- [ ] **Step 4: Run tests and lint**

Run: `pnpm vitest run src/__tests__/cmd-accounts-verbs.test.ts src/__tests__/cmd-accounts-reauth.test.ts src/__tests__/cmd-accounts-json.test.ts src/__tests__/cmd-accounts-info.test.ts src/__tests__/cmd-accounts-add-replace.test.ts && pnpm lint`
Expected: PASS. `cmd-accounts-add-replace.test.ts` drives `accounts add`; it now needs `["accounts", "add", "claude"]` and a `select` mock is not needed since the provider is given.

- [ ] **Step 5: Manual check**

`pnpm dev accounts login openai --email <your email>` — confirm the browser opens and note prefill results (closes Task 6 Step 4). `pnpm dev accounts reauth <a real id>` against the running proxy — confirm the email is printed and the replacement lands (`accounts list` shows healthy).

- [ ] **Step 6: Commit**

```bash
git add src/cli/cmd-accounts.ts src/__tests__/cmd-accounts-verbs.test.ts src/__tests__/cmd-accounts-reauth.test.ts src/__tests__/cmd-accounts-json.test.ts src/__tests__/cmd-accounts-add-replace.test.ts
git commit -m "feat!: replace provider-suffixed account commands with login, add and reauth"
```

---

### Task 10: Per-account refresh endpoint and client

**Files:**
- Create: `src/proxy/account-refresh.ts`
- Modify: `src/proxy/server.ts` (mount route), `src/ui/accountsApi.ts`
- Test: `src/__tests__/account-refresh.test.ts`, `src/__tests__/accounts-api.test.ts` (extend if present, else create)

**Interfaces:**
- Produces:

```ts
// src/proxy/account-refresh.ts
export interface AccountRefreshResult { id: string; tokenRefreshed: boolean | null; usageRefreshed: boolean; durationMs: number }
export interface AccountRefreshHooks {
  findAnthropic(id: string): Account | null;
  findOpenAI(id: string): OpenAIAccount | undefined;
  refreshAnthropicToken(account: Account): Promise<boolean>;   // only called when due
  anthropicTokenDue(account: Account): boolean;
  refreshAnthropicUsage(account: Account): Promise<{ ok: boolean }>;
  refreshOpenAIToken(account: OpenAIAccount): Promise<boolean>;
  openAITokenDue(account: OpenAIAccount): boolean;
  refreshOpenAIUsage(account: OpenAIAccount): Promise<{ ok: boolean }>;
  refreshIdentity(): Promise<void>;
  now?: () => number;
}
export function createAccountRefreshRunner(hooks: AccountRefreshHooks): (id: string) => Promise<AccountRefreshResult | null>; // null = unknown id; single-flight per id
// src/ui/accountsApi.ts
refreshAccount(id: string): Promise<AccountRefreshResult>;
```

- [ ] **Step 1: Write the failing tests**

`src/__tests__/account-refresh.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAccountRefreshRunner, type AccountRefreshHooks } from "../proxy/account-refresh.js";
import { DEFAULT_RATE_LIMITS, type Account } from "../proxy/types.js";

const anthropic: Account = {
  id: "a", tokens: { accessToken: "x", refreshToken: "r", expiresAt: 10, scopes: ["user:inference", "user:profile"] },
  healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
  rateLimits: { ...DEFAULT_RATE_LIMITS }, enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
};

function hooks(over: Partial<AccountRefreshHooks> = {}): AccountRefreshHooks {
  return {
    findAnthropic: id => (id === "a" ? anthropic : null),
    findOpenAI: () => undefined,
    anthropicTokenDue: () => false,
    refreshAnthropicToken: vi.fn(async () => true),
    refreshAnthropicUsage: vi.fn(async () => ({ ok: true })),
    openAITokenDue: () => false,
    refreshOpenAIToken: vi.fn(async () => true),
    refreshOpenAIUsage: vi.fn(async () => ({ ok: true })),
    refreshIdentity: vi.fn(async () => {}),
    now: () => 0,
    ...over,
  };
}

describe("createAccountRefreshRunner", () => {
  it("returns null for an unknown id", async () => {
    await expect(createAccountRefreshRunner(hooks())("nope")).resolves.toBeNull();
  });

  it("refreshes usage and identity, and reports tokenRefreshed null when no refresh was due", async () => {
    const h = hooks();
    const result = await createAccountRefreshRunner(h)("a");
    expect(result).toEqual({ id: "a", tokenRefreshed: null, usageRefreshed: true, durationMs: 0 });
    expect(h.refreshAnthropicToken).not.toHaveBeenCalled();
    expect(h.refreshIdentity).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token first when due", async () => {
    const h = hooks({ anthropicTokenDue: () => true });
    const result = await createAccountRefreshRunner(h)("a");
    expect(result?.tokenRefreshed).toBe(true);
    expect(h.refreshAnthropicToken).toHaveBeenCalledWith(anthropic);
  });

  it("does not fail the whole refresh when usage fails", async () => {
    const h = hooks({ refreshAnthropicUsage: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(createAccountRefreshRunner(h)("a")).resolves.toMatchObject({ usageRefreshed: false });
  });

  it("single-flights concurrent refreshes of one id", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = hooks({ refreshAnthropicUsage: vi.fn(async () => { await gate; return { ok: true }; }) });
    const run = createAccountRefreshRunner(h);
    const first = run("a"); const second = run("a");
    release();
    await Promise.all([first, second]);
    expect(h.refreshAnthropicUsage).toHaveBeenCalledTimes(1);
  });
});
```

For `accountsApi`, add to the existing accounts-api test file (or create one):

```ts
  it("posts /cc-router/accounts/:id/refresh and parses the result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ refresh: { id: "a b", tokenRefreshed: null, usageRefreshed: true, durationMs: 12 } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createAccountsApi("http://x", "s");
    await expect(api.refreshAccount("a b")).resolves.toEqual({ id: "a b", tokenRefreshed: null, usageRefreshed: true, durationMs: 12 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://x/cc-router/accounts/a%20b/refresh");
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/account-refresh.test.ts src/__tests__/accounts-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the runner**

`src/proxy/account-refresh.ts`:

```ts
import type { Account } from "./types.js";
import type { OpenAIAccount } from "../providers/openai/account-state.js";

export interface AccountRefreshResult { id: string; tokenRefreshed: boolean | null; usageRefreshed: boolean; durationMs: number }

export interface AccountRefreshHooks { /* as in Interfaces above */ }

/**
 * One account's worth of `POST /cc-router/refresh`: token if due, usage, then
 * identity. Step failures are reported, never thrown — only an unexpected
 * throw escapes so the route can answer 500. Single-flighted per id so a
 * second press joins the running pass instead of stacking a second fetch.
 */
export function createAccountRefreshRunner(hooks: AccountRefreshHooks): (id: string) => Promise<AccountRefreshResult | null> {
  const now = hooks.now ?? Date.now;
  const inFlight = new Map<string, Promise<AccountRefreshResult | null>>();
  const attempt = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  return id => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const run = (async (): Promise<AccountRefreshResult | null> => {
      const started = now();
      const anthropic = hooks.findAnthropic(id);
      const openai = anthropic ? undefined : hooks.findOpenAI(id);
      if (!anthropic && !openai) return null;
      let tokenRefreshed: boolean | null = null;
      let usageRefreshed = false;
      if (anthropic) {
        if (hooks.anthropicTokenDue(anthropic)) tokenRefreshed = await attempt(() => hooks.refreshAnthropicToken(anthropic), false);
        usageRefreshed = (await attempt(() => hooks.refreshAnthropicUsage(anthropic), { ok: false })).ok;
      } else if (openai) {
        if (hooks.openAITokenDue(openai)) tokenRefreshed = await attempt(() => hooks.refreshOpenAIToken(openai), false);
        usageRefreshed = (await attempt(() => hooks.refreshOpenAIUsage(openai), { ok: false })).ok;
      }
      await attempt(() => hooks.refreshIdentity(), undefined);
      return { id, tokenRefreshed, usageRefreshed, durationMs: Math.max(0, now() - started) };
    })().finally(() => { if (inFlight.get(id) === run) inFlight.delete(id); });
    inFlight.set(id, run);
    return run;
  };
}
```

- [ ] **Step 4: Mount the route**

In `src/proxy/server.ts`, next to the `/:id/reset-usage` route:

```ts
  const runAccountRefresh = createAccountRefreshRunner({
    findAnthropic: id => pool.findById(id),
    findOpenAI: id => openAIAccounts.find(account => account.id === id),
    anthropicTokenDue: account => needsRefresh(account),
    refreshAnthropicToken: account => refreshAccountIfCurrent(account, pool, { persist: persistAnthropicAccounts }),
    refreshAnthropicUsage: account => usageRefresher.refreshNow(account),
    openAITokenDue: account => needsOpenAIRefresh(account),
    refreshOpenAIToken: account => refreshAndPersistOpenAIAccount(account, openAIAccounts, persistOpenAIAccounts),
    refreshOpenAIUsage: account => openAIUsageRefresher.refreshNow(account),
    refreshIdentity: () => accountInfoCache.refresh(true),
  });
  accountsRouter.post("/:id/refresh", async (req, res) => {
    const id = req.params.id;
    let result: AccountRefreshResult | null;
    try {
      result = await runAccountRefresh(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("refresh", 0, `manual refresh of ${id} failed: ${message}`);
      res.status(500).json({ error: `Refresh failed: ${message}` });
      return;
    }
    if (!result) { res.status(404).json({ error: `Account "${id}" not found` }); return; }
    stats.addLog({
      ts: Date.now(), accountId: id, model: "-", type: "refresh",
      details: `manual refresh ${id} — ${result.usageRefreshed ? "usage fresh" : "usage fetch failed"}${result.tokenRefreshed === false ? ", token refresh failed" : ""}`,
    });
    res.json({ refresh: result });
  });
```

Import `needsOpenAIRefresh` and `refreshAndPersistOpenAIAccount` from `../providers/openai/token-refresher.js` if not already imported. Also expose the endpoint in the health `operational.endpoints` map as `accountRefresh: "/cc-router/accounts/:id/refresh"` (find the object that lists `refresh: "/cc-router/refresh"`).

- [ ] **Step 5: Client**

In `src/ui/accountsApi.ts`:

```ts
export interface AccountRefreshResult { id: string; tokenRefreshed: boolean | null; usageRefreshed: boolean; durationMs: number }
const REFRESH_ONE_TIMEOUT_MS = 30_000;
// in AccountsApi:
  /** Refresh one account: its token if due, its usage, and identity metadata. */
  refreshAccount(id: string): Promise<AccountRefreshResult>;
// implementation:
    async refreshAccount(id) {
      const res = await fetch(`${base}/${encodeURIComponent(id)}/refresh`, {
        method: "POST", headers: authHeaders, signal: AbortSignal.timeout(REFRESH_ONE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as { refresh?: unknown };
      const r = isRecord(payload.refresh) ? payload.refresh : {};
      return {
        id: publicText(r.id, 128, id),
        tokenRefreshed: r.tokenRefreshed === true ? true : r.tokenRefreshed === false ? false : null,
        usageRefreshed: r.usageRefreshed === true,
        durationMs: publicInteger(r.durationMs),
      };
    },
```

- [ ] **Step 6: Extend the server fixture test**

In `src/__tests__/account-info-server.test.ts`, after the whole-pool refresh assertions add:

```ts
    const one = await fetch(`${base}/cc-router/accounts/fixture/refresh`, { method: "POST", headers });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ refresh: { id: "fixture", usageRefreshed: true } });
    expect((await fetch(`${base}/cc-router/accounts/nope/refresh`, { method: "POST", headers })).status).toBe(404);
```

(The fixture's fake fetch answers the usage endpoint with `{}`; if `fetchAnthropicUsage` treats `{}` as `ok: false`, assert `usageRefreshed: false` instead and say so in the commit body.)

- [ ] **Step 7: Run tests and lint**

Run: `pnpm vitest run src/__tests__/account-refresh.test.ts src/__tests__/accounts-api.test.ts src/__tests__/account-info-server.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/account-refresh.ts src/proxy/server.ts src/ui/accountsApi.ts src/__tests__/account-refresh.test.ts src/__tests__/accounts-api.test.ts src/__tests__/account-info-server.test.ts
git commit -m "feat: add a per-account refresh endpoint and client"
```

---

### Task 11: Dashboard — `l` re-auth intent, per-account `R`, token-only marker

**Files:**
- Modify: `src/ui/Dashboard.tsx`
- Modify: `src/cli/cmd-status.ts`
- Test: `src/__tests__/dashboard-reload-key.test.ts`, `src/__tests__/dashboard-reauth-key.test.ts` (new)

**Interfaces:**
- Consumes: `AccountsApi.refreshAccount` (Task 10); `collectReauthRecord`, `ReauthTarget` (Task 8); `tokenOnly` on health rows (Task 3).
- Produces:

```ts
export type DashboardIntent =
  | { kind: "quit" }
  | { kind: "addAccount" }
  | { kind: "reauth"; id: string; provider: "anthropic_subscription" | "openai_subscription"; email?: string };
// DashboardProps.onIntent?: (intent: DashboardIntent) => void
```

- [ ] **Step 1: Write the failing tests**

`src/__tests__/dashboard-reauth-key.test.ts` (copy the `health()` and mock preamble from `dashboard-reload-key.test.ts`; give the health account `authExpired: true` so the row shows as re-auth required):

```ts
describe("dashboard re-auth key", () => {
  it("l with a Claude account focused emits the re-auth intent with the cached email and exits", async () => {
    const onIntent = vi.fn();
    const dash = renderDashboard(health(), { onIntent }, { rows: 40, columns: 220 });
    try {
      vi.mocked(globalThis.fetch).mockImplementation(input => {
        if (String(input).endsWith("/cc-router/accounts")) return Promise.resolve(Response.json({
          accounts: [{ id: "max-account-1", provider: "anthropic_subscription", accountInfo: { accountType: "personal", email: "me@example.com", fetchStatus: "fresh", fetchedAt: Date.now() } }],
        }));
        return Promise.resolve(Response.json(health()));
      });
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[l] re-auth"));
      await dash.press("\t");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("me@example.com"));
      await dash.press("l");
      await vi.waitFor(() => expect(onIntent).toHaveBeenCalledWith({ kind: "reauth", id: "max-account-1", provider: "anthropic_subscription", email: "me@example.com" }));
    } finally {
      await dash.cleanup();
    }
  });

  it("l with logs focused does nothing", async () => {
    const onIntent = vi.fn();
    const dash = renderDashboard(health(), { onIntent }, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      await dash.press("l");
      await new Promise(r => setTimeout(r, 150));
      expect(onIntent).not.toHaveBeenCalled();
    } finally {
      await dash.cleanup();
    }
  });
});
```

Add to `dashboard-reload-key.test.ts`:

```ts
  it("R with an account focused refreshes only that account", async () => {
    const dash = renderDashboard(health(), {}, { rows: 40, columns: 220 });
    try {
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("[R] reload"));
      const fetchMock = vi.mocked(globalThis.fetch);
      const posted: string[] = [];
      fetchMock.mockImplementation((input, init) => {
        const url = String(input);
        if (init?.method === "POST") { posted.push(url); return Promise.resolve(Response.json({ refresh: { id: "max-account-1", tokenRefreshed: null, usageRefreshed: true, durationMs: 5 } })); }
        return Promise.resolve(Response.json(health()));
      });
      await dash.press("\t");
      await dash.press("R");
      await dash.waitUntil(() => expect(dash.lastFrame()).toContain("Refreshed max-account-1"));
      expect(posted).toEqual([expect.stringMatching(/\/cc-router\/accounts\/max-account-1\/refresh$/)]);
    } finally {
      await dash.cleanup();
    }
  });
```

Also add a rendering assertion in `dashboard-rendering.test.ts` (or the new file) that a health row with `tokenOnly: true` renders `token-only` in the accounts panel when selected.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/dashboard-reauth-key.test.ts src/__tests__/dashboard-reload-key.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement in `Dashboard.tsx`**

Replace both `onIntent?: (intent: "quit" | "addAccount") => void` declarations with `onIntent?: (intent: DashboardIntent) => void` and export the `DashboardIntent` type. Update the three call sites: `onIntent?.({ kind: "quit" })`, `onIntent({ kind: "addAccount" })`.

Per-account refresh callback (next to `doRefreshAll`):

```tsx
  const refreshOneInFlightRef = useRef(false);
  const doRefreshSelected = useCallback(async () => {
    if (!selectedAccount) return;
    if (refreshOneInFlightRef.current) { showBanner("Refresh already running…", "gray"); return; }
    refreshOneInFlightRef.current = true;
    showBanner(`Refreshing ${selectedAccount.id}…`, "cyan", REFRESH_ALL_BANNER_MS);
    try {
      if (isXaiAccount(selectedAccount)) {
        await onRefreshAll?.();
        showBanner(`Refreshed ${selectedAccount.id}`, "green");
        return;
      }
      const result = await api.refreshAccount(selectedAccount.id);
      const problems = [
        result.usageRefreshed ? "" : "usage fetch failed",
        result.tokenRefreshed === false ? "token refresh failed" : "",
      ].filter(Boolean);
      showBanner(
        `Refreshed ${result.id} — ${problems.length ? problems.join(", ") : "usage fresh"}`,
        problems.length ? "yellow" : "green",
      );
    } catch (err) {
      showBanner(`Refresh error: ${errMsg(err)}`, "red");
    } finally {
      refreshOneInFlightRef.current = false;
    }
  }, [api, onRefreshAll, selectedAccount, showBanner]);
```

Key handling: replace `if (input === "R") { void doRefreshAll(); return; }` with

```tsx
    if (input === "R") {
      if (focus === "accounts" && selectedAccount) void doRefreshSelected();
      else void doRefreshAll();
      return;
    }
```

Inside the `focus === "accounts"` block, with the other account actions:

```tsx
      if (input === "l") {
        if (!selectedAccount) return;
        if (isXaiAccount(selectedAccount)) {
          showBanner("Grok credentials live in ~/.grok — run grok login, then cc-router accounts add grok", "yellow");
          return;
        }
        if (!onIntent) return;
        const provider = selectedAccount.provider === "openai_subscription" ? "openai_subscription" : "anthropic_subscription";
        onIntent({ kind: "reauth", id: selectedAccount.id, provider, email: selectedAccount.accountInfo?.email });
        exit();
        return;
      }
```

Check how the selected account's `accountInfo` is held in state (it comes from the `/cc-router/accounts` poll; find the variable used for the detail line and read `email` from it). Hint bar: insert ` [l] re-auth` after ` [n] add` in the accounts line. Token-only marker: where the detail line prints `formatAccountInfo(...)`, prefix `token-only · ` when the health row has `tokenOnly` (extend the `AccountStat` type with `tokenOnly?: boolean`).

- [ ] **Step 4: Handle the intent in `cmd-status.ts`**

```ts
    let pendingIntent: DashboardIntent = { kind: "quit" };
    // onIntent: (i) => { pendingIntent = i; }
    ...
    if (pendingIntent.kind === "quit") return;
    if (pendingIntent.kind === "addAccount") { /* existing add flow */ continue; }
    console.log();
    console.log(chalk.cyan(`→ Re-authenticating ${pendingIntent.id}...`));
    const reauthed = await runReauthFlow(target, pendingIntent);
    console.log(reauthed
      ? chalk.green(`\n✓ Account "${reauthed}" re-authenticated. Returning to dashboard...\n`)
      : chalk.yellow("\n  No account re-authenticated. Returning to dashboard...\n"));
```

```ts
async function runReauthFlow(target: StatusTarget, intent: Extract<DashboardIntent, { kind: "reauth" }>): Promise<string | null> {
  let attempt: SetupAttempt | undefined;
  try {
    const { collectReauthRecord } = await import("./account-flows.js");
    const result = await collectReauthRecord({ id: intent.id, provider: intent.provider, email: intent.email });
    if (!result) return null;
    attempt = result.attempt;
    const res = await fetch(`${target.baseUrl}/cc-router/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify({ ...result.record, replace: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(chalk.red(`\n✗ Server rejected the replacement: HTTP ${res.status}`));
      if (text) console.error(chalk.gray(`  ${text}`));
      attempt.failed(classifyHttpSetupFailure("persistence", res.status, "dashboard re-auth rejected"), "persistence");
      return null;
    }
    attempt.stageCompleted("persistence");
    attempt.succeeded();
    return result.record.id;
  } catch (err) {
    console.error(chalk.red(`\n✗ Re-authentication failed: ${(err as Error).message}`));
    if (attempt) {
      const outcome = failAttemptFromError(attempt, err, "persistence");
      if (outcome?.unexpected) console.error(chalk.gray(`  Diagnostic ID: ${outcome.diagnosticId}`));
    }
    return null;
  }
}
```

- [ ] **Step 5: Run the dashboard tests and lint**

Run: `pnpm vitest run src/__tests__/dashboard-*.test.ts && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Manual check**

`pnpm dev status` against the running proxy: Tab to accounts, `R` shows the per-account banner; Esc to logs, `R` shows the whole-pool banner; select an account and press `l`, confirm the dashboard unmounts, the re-auth prompt prints the email, and the dashboard returns afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Dashboard.tsx src/cli/cmd-status.ts src/__tests__/dashboard-reauth-key.test.ts src/__tests__/dashboard-reload-key.test.ts src/__tests__/dashboard-rendering.test.ts
git commit -m "feat: dashboard re-auth key and per-account reload"
```

---

### Task 12: Full test run and cleanup

**Files:** none new.

- [ ] **Step 1: Run everything**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all PASS, no type errors, `dist/` builds.

- [ ] **Step 2: Grep for stale references**

Run: `grep -rn "login-openai\|add-openai\|login-grok\|add-grok\|setupSingleAccountWithAttempt" src docs README.md`
Expected: no hits in `src/`; docs hits are handled in Task 13.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A src
git commit -m "test: stabilise the account re-auth suite"
```

(Skip the commit if nothing changed.)

---

### Task 13: Documentation and changelog

**Files:**
- Modify: `docs/cli-reference.md`, `docs/dashboard.md`, `docs/oauth-tokens.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: CLI reference**

Replace the `accounts` block in `docs/cli-reference.md` with:

```text
cc-router accounts list      List Claude, ChatGPT and Grok accounts (live stats and metadata when running)
cc-router accounts list --json  Same, as JSON
cc-router accounts login [claude|openai|grok]  Sign in in the browser (Claude: claude auth login, or --long-lived for claude setup-token)
cc-router accounts login claude --email you@example.com --id max-2
cc-router accounts add [claude|openai|grok]    Import credentials that already exist (Keychain, ~/.claude/.credentials.json, pasted tokens, OpenAI tokens, ~/.grok)
cc-router accounts reauth <id>  Sign an existing account in again under the same id, email prefilled
cc-router accounts rename <id> <new-id>  Rename an account
cc-router accounts remove <id>  Remove a Claude, OpenAI or Grok account
```

- [ ] **Step 2: Dashboard keybindings**

In `docs/dashboard.md`: change the `R` row to "Reload usage and credentials for the selected account when ACCOUNTS is focused; otherwise reload every account, metadata and models"; add `| \`l\` | Re-authenticate the selected account (Claude or ChatGPT) — the dashboard hands over to the sign-in flow and returns afterwards |` to the ACCOUNTS table; add to the Grok paragraph that `l` explains `grok login` instead.

- [ ] **Step 3: OAuth tokens page**

Add a section after "Adding multiple accounts":

```markdown
## Signing in from cc-router

`cc-router accounts login claude` runs `claude auth login --claudeai` for you and
imports the result. Claude Code on this machine ends up logged in as the last
account you signed in; Claude Code routed through cc-router does not use that
login, so nothing breaks, but `claude` run directly will act as that account.

`cc-router accounts login claude --long-lived` runs `claude setup-token` instead.
The resulting token is valid for one year, has no refresh token and carries the
`user:inference` scope only. Such an account routes normally, shows as
`token-only`, gets no usage snapshot or identity metadata (rate limiting falls
back to response headers), and needs a new sign-in when it expires — cc-router
marks it `re-auth required` at that point.

`cc-router accounts reauth <id>` looks up the account's provider and cached
email and runs the matching sign-in with the email prefilled. In the dashboard,
select the account and press `l`.
```

Replace the manual "log out, log in, extract" sequence in "Adding multiple accounts" with a pointer to `accounts login`.

- [ ] **Step 4: README**

In the quickstart paragraph, change "Adding more accounts is `cc-router setup --add`" to "Adding more accounts is `cc-router accounts login`, re-signing one in is `cc-router accounts reauth <id>`".

- [ ] **Step 5: Changelog**

Under the unreleased heading in `CHANGELOG.md`:

```markdown
### Breaking

- `cc-router accounts add-openai`, `login-openai`, `add-grok` and `login-grok`
  are gone. Use `accounts login openai`, `accounts add openai`,
  `accounts login grok` and `accounts add grok`. `accounts add` now takes the
  provider as its first argument (`accounts add claude` for the old behaviour)
  and only imports existing credentials; browser sign-in is `accounts login`.
- The dashboard's `onIntent` callback receives an object (`{ kind: "quit" }`,
  `{ kind: "addAccount" }`, `{ kind: "reauth", ... }`) instead of a string.

### Added

- `cc-router accounts login claude` drives `claude auth login --claudeai`
  (with `--email` prefill) and imports the new credentials; `--long-lived`
  drives `claude setup-token` for a one-year, refresh-less token.
- `cc-router accounts reauth <id>` re-signs an account in under the same id,
  looking up its provider and cached email. The dashboard does the same on
  `l` with an account selected.
- Device-code sign-ins (OpenAI, Grok) open the verification page in the
  browser; the OpenAI page receives the code and, on re-auth, the email.
- Claude accounts without a refresh token (`claude setup-token`) are
  accepted, never refreshed, skipped by the usage and identity fetchers, and
  marked `token-only`; they flip to `re-auth required` when they expire.
- `POST /cc-router/accounts/:id/refresh` refreshes one account. The
  dashboard's `R` uses it when an account is selected and reloads the whole
  pool otherwise.
```

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/dashboard.md docs/oauth-tokens.md README.md CHANGELOG.md
git commit -m "docs: account login, reauth and per-account reload"
```

---

## Self-review notes

- Spec §1 → Tasks 1–4. §2 → Task 7 (+ wizard integration in Task 8). §3 → Tasks 5–6. §4 → Tasks 8–9. §5 → Task 11. §6 → Task 10. §7 (error table) → covered by Tasks 7, 9, 11 branches. §8 → each task's tests plus manual checks in Tasks 6, 7, 9, 11. §9 → Task 13.
- Names used across tasks: `isTokenOnly` (T1→T2,T9), `canReadProfile` (T4), `openInBrowser` (T5→T6), `buildOpenAIDeviceVerificationUrl` (T6), `loginWithClaudeCli` / `createLongLivedTokenWithClaudeCli` / `LONG_LIVED_TOKEN_TTL_MS` (T7→T8), `collectClaudeAccount` / `collectReauthRecord` / `accountToRecord` / `ReauthTarget` (T8→T9,T11), `createAccountRefreshRunner` / `AccountRefreshResult` / `refreshAccount` (T10→T11), `DashboardIntent` (T11), `tokenOnly` (T3→T9,T11).
