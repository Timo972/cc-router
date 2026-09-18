# Account sign-in, re-authentication and refresh ergonomics

**Date:** 2026-09-18
**Status:** Approved design, implementation pending

## Problem

Getting credentials into cc-router, and back in once a provider rejects
them, is the least ergonomic part of the tool:

- A Claude account can only be imported from wherever Claude Code already
  stored a login (Keychain, `~/.claude/.credentials.json`) or by pasting
  tokens. Claude Code 2.1 ships `claude auth login --claudeai --email <email>`
  and `claude setup-token`, and cc-router uses neither. Re-authenticating
  means logging Claude Code in by hand, then running `accounts add` and
  retyping the account id.
- `claude setup-token` produces a long-lived access token with no refresh
  token. The credential parser rejects it, so the only non-disruptive way to
  sign in a second Claude account is unusable.
- The OpenAI device flow prints a URL and a code and waits. Nothing opens the
  browser and nothing tells the operator which email the dead account was.
- The `accounts` subcommand tree grew one verb per provider and method:
  `add`, `add-openai`, `login-openai`, `add-grok`, `login-grok`. Re-auth is
  spread across three differently named commands and `list` has to know which
  one to point at.
- The dashboard can add an account (`n`) but cannot re-authenticate the one
  it is showing as `re-auth required`. `R` always reloads the whole pool even
  when the operator is looking at one account.

PR #47 already made re-auth possible at the pool level: the live add
endpoint replaces by id, and terminal auth failures are surfaced everywhere.
This design adds the flows that use it.

## Decisions taken during brainstorming

- **Credentials come from the Claude Code CLI, not a native OAuth
  implementation.** cc-router drives `claude auth login` and
  `claude setup-token` as subprocesses. This keeps the OAuth client, PKCE
  flow and callback handling in Claude Code, where Anthropic maintains them,
  and avoids deepening the client-id impersonation the README already
  disclaims. Cost: `claude` must be on `PATH`.
- **setup-token is driven, not just pasted.** cc-router runs the command and
  captures the token from its output. If nothing is captured the operator is
  asked to paste it, so the fragile part has a floor.
- **CLI shape:** `login` (browser sign-in), `add` (import existing
  credentials), `reauth <id>` (sign the same id in again). Breaking.
- **Dashboard re-auth key:** `l`.
- **OpenAI page prefill is best effort.** Parameters are tried against the
  live page during implementation and dropped if ignored.

## Two facts that shape everything below

1. `claude auth login` replaces the machine's active Claude Code login with
   the last account signed in. Claude Code routed through cc-router does not
   use that login (it authenticates to the proxy with the proxy secret), so
   this is a documented side effect, not a bug. cc-router does not attempt to
   restore the previous login.
2. A `claude setup-token` token carries the `user:inference` scope only and
   has no refresh token. Such an account routes normally but cannot fetch
   the OAuth usage endpoint or identity metadata. It relies on response
   headers for rate limiting and shows as `token-only` in the CLI and
   dashboard. Its lifetime is one year from creation.

## 1. Refresh-less Claude accounts

**Token shape.** `OAuthTokens.refreshToken` becomes optional
(`refreshToken?: string`). `parseCredentialJson` accepts an object without
one as long as `accessToken` starts with `sk-ant-`. Serialisation to
`accounts.json` omits the key when absent; the loader accepts both shapes.

**Refresh loop.** `needsRefresh(account)` returns `false` when the account
has no refresh token. A separate check in `refreshAccountsOnce` runs on the
same tick: a refresh-less account whose `expiresAt` has passed is marked
`authExpired = true` and `healthy = false` once, with the same operator log
line a rejected refresh token produces. `needsReauthentication` therefore
already reports it. Nothing is ever POSTed to the token endpoint for these
accounts.

**Expiry.** Set at capture time to now plus 365 days, matching what
`setup-token` prints. The prompt lets the operator override it, as the paste
flow does today.

**Proxy account POST.** `POST /cc-router/accounts` currently requires
`refreshToken`. It becomes optional for `anthropic_subscription` records
only; OpenAI records still require it. `replaceAnthropicAccountTransaction`
and the stored-file merge need no change beyond the type.

**Usage and identity.** The Anthropic usage refresher and the account-info
cache skip accounts whose `scopes` lack `user:profile`. The usage snapshot
for such an account carries `fetchStatus: "unavailable"` and no windows, so
existing routing falls back to response headers as it already does for an
account that has never been fetched. The dashboard account detail line and
`accounts list` show `token-only` for these accounts in place of the missing
metadata.

**Validation at setup.** `validateToken` (GET `/v1/models`) works with the
inference scope, so the existing validation step stays.

## 2. Driving the Claude Code CLI

New module `src/providers/anthropic/claude-cli.ts`.

**Locating the binary.** `resolveClaudeCli()` runs `claude --version` via
`execFile` and returns the command name on success. On failure it throws a
`SetupDiagnosticError` at stage `credential_read`, reason `not_found`, with
the message "Claude Code CLI not found on PATH. Install it or use
`accounts add claude` to import an existing login."

**Full sign-in.** `loginWithClaudeCli({ email? })`:

1. Snapshot the current credentials with the platform extractor (Keychain on
   macOS, credentials file elsewhere). A missing snapshot is fine.
2. Spawn `claude auth login --claudeai [--email <email>]` with all stdio
   inherited. Claude Code owns the terminal for the duration; it opens the
   browser and handles the paste-code fallback itself.
3. A non-zero exit or a signal is a cancellation: throw a
   `SetupDiagnosticError` at stage `credential_read`, reason `cancelled`,
   `expected: true`.
4. Re-run the extractor. If it fails, or the access token equals the
   snapshot's, throw at `credential_read`, reason `not_found`, message
   "claude auth login finished but no new credentials were stored."
5. Return the extracted `OAuthTokens`.

The snapshot comparison is the only defence against reading the previous
login when Claude Code exits 0 without writing (for example after the
operator closes the browser tab and Claude Code treats that as done).

**Long-lived token.** `createLongLivedTokenWithClaudeCli()`:

1. Spawn `claude setup-token` with `stdio: ["inherit", "pipe", "inherit"]`.
   Every stdout chunk is written through to `process.stdout` unchanged, so
   the Ink UI still renders (Ink keys raw mode on stdin, which stays a TTY;
   its cursor-control escapes pass through unmodified).
2. A pure scanner, `extractLongLivedToken(chunks: string[]): string | null`,
   is fed the concatenated output after exit. It strips ANSI escapes and
   returns the last match of `sk-ant-oat01-[A-Za-z0-9_-]{20,}`. Taking the
   last match matters because Ink re-renders the success frame several
   times.
3. Exit 0 with a match returns
   `{ accessToken, expiresAt: now + 365 d, scopes: ["user:inference"] }`.
4. Exit 0 without a match, or a non-zero exit, falls back to a masked paste
   prompt for the token. The operator sees why: "Could not read the token
   from claude setup-token's output. Paste it here." A cancelled paste is a
   cancellation of the whole step.

The fallback exists because the token line is a UI detail of Claude Code,
not a contract. It is verified against the installed version during
implementation and recorded in the plan as a manual check.

**Telemetry.** `SETUP_METHODS` gains `"claude_cli_login"` and
`"claude_setup_token"`. Stages are the existing ones: the subprocess is
`credential_read`, token scanning is `credential_parse`.

**Setup wizard integration.** The Claude account flow (today
`setupSingleAccountWithAttempt` in `cmd-setup.ts`, moved to
`account-flows.ts` per section 4) gains two method choices, listed first:

```
Sign in with the browser  (claude auth login — recommended)
Create a long-lived token (claude setup-token — does not change Claude Code's login)
Extract automatically from macOS Keychain
Read from ~/.claude/.credentials.json
Paste tokens manually
```

The function takes an optional `{ email?, fixedId?, method? }` so the
re-auth flow can prefill the email, pin the account id, and skip the picker.
When `fixedId` is set the id prompt is skipped and no `max-account-N`
default is offered.

## 3. Browser opening and OpenAI prefill

**Opener.** `src/utils/browser.ts` exports
`openInBrowser(url): Promise<boolean>`. macOS: `open <url>`. Linux:
`xdg-open <url>`. Windows: `cmd /c start "" <url>`. Uses `execFile`, never
throws, resolves `false` on any failure, and is skipped when
`CC_ROUTER_NO_BROWSER=1` is set (tests and headless hosts). A pure
`browserCommandFor(platform, url)` returns the argv so the mapping is unit
tested.

**OpenAI device flow.** `requestOpenAIDeviceCode` gains an optional
`loginHint?: string`. `verificationUrl` is built as
`${issuer}/codex/device` plus a query string of `user_code=<code>` and, when
a hint is given, `login_hint=<email>`. Both parameters are checked against
the live page during implementation; any the page ignores is removed from
the builder before merge, and the builder's test pins whichever set
survives. The URL is opened with `openInBrowser` after the device code is
printed. The terminal always prints the URL, the code, and the email to sign
in with when one is known, so nothing depends on the browser or the
parameters.

**Grok.** xAI already returns `verification_uri_complete`. It is opened the
same way. No prefill.

## 4. Accounts CLI

```
cc-router accounts list [--json]
cc-router accounts login  [claude|openai|grok] [--id <id>] [--email <email>] [--long-lived]
cc-router accounts add    [claude|openai|grok] [--id <id>]
cc-router accounts reauth <id> [--email <email>] [--long-lived]
cc-router accounts remove <id>
cc-router accounts rename <id> <new-id>
```

Removed: `add-openai`, `login-openai`, `add-grok`, `login-grok`. The
changelog marks this breaking and lists the replacements.

**Provider argument.** Optional on `login` and `add`. When omitted, a select
prompt offers Claude, OpenAI and Grok, Claude first.

**`login`** is a browser sign-in that produces new credentials.

- Claude: prompts between full sign-in and long-lived token unless
  `--long-lived` is given. Runs the flow from section 2 under the chosen
  method, then the id prompt (default `max-account-N`, or `--id`) and token
  validation.
- OpenAI: the device flow with browser opening and `--email` as the hint.
- Grok: the xAI device flow with browser opening.

**`add`** imports credentials that already exist.

- Claude: picker among Keychain (macOS only), credentials file, paste.
- OpenAI: the manual token prompts that `add-openai` runs today.
- Grok: import from `~/.grok/auth.json`, as `add-grok` does today.

**`reauth <id>`** signs the same account in again.

1. Resolve the account from the running proxy first (`/cc-router/accounts`),
   then from `accounts.json`. Unknown id: error listing available ids, exit 1.
2. Take the provider from the record and the email from the live
   `accountInfo.email` when present. `--email` overrides.
3. Grok: print that credentials live in `~/.grok` and to run `grok login`
   followed by `accounts add grok`, exit 1. Grok is never routed and its
   record is an import.
4. Print what is about to happen: "Re-authenticating `<id>` (openai) —
   sign in as `<email>`."
5. Run the provider's `login` flow with the id fixed and the email prefilled.
   For Claude the method prompt still applies unless `--long-lived` is set.
6. Persist through `addAccountRuntimeAware`, which already asks the live
   pool to replace by id.

**`list`** replaces its per-provider re-auth hints with one line per
account: `cc-router accounts reauth <id>`. Token-only accounts show
`token-only` where scopes are printed today. The `--json` shape gains
`tokenOnly: true` on those accounts, following the `authExpired` pattern of
only adding a boolean.

**Shared flows.** The provider login and import flows move out of
`cmd-accounts.ts` into `src/cli/account-flows.ts`, exporting one function
per provider and method that returns an `AccountRecord` plus its
`SetupAttempt`. `cmd-accounts.ts`, `cmd-setup.ts` and the dashboard loop
call these; none of them own prompt sequences of their own any more.
`cmd-accounts.ts` keeps `list`, `remove`, `rename`, the inventory helpers and
the runtime-aware persistence functions.

## 5. Dashboard

**Intent type.** `onIntent` moves from a string union to

```ts
type DashboardIntent =
  | { kind: "quit" }
  | { kind: "addAccount" }
  | { kind: "reauth"; id: string; provider: "anthropic_subscription" | "openai_subscription"; email?: string };
```

**`l` key.** With ACCOUNTS focused and a selected account: Claude or OpenAI
sends the re-auth intent (email from `accountInfo.email`) and exits Ink.
Grok shows the banner "Grok credentials live in ~/.grok — run grok login,
then cc-router accounts add grok". With any other focus, or no account, the
key is ignored. The accounts hint bar gains `l re-auth`.

**Outer loop.** `dashboardLoop` handles the new intent the way it handles
`addAccount`: after Ink unmounts and stdin is restored, it prints
"→ Re-authenticating `<id>`…", runs the same re-auth flow `accounts reauth`
uses, and POSTs the record to the connected target with `replace: true`. The
target may be a remote proxy in client mode; the POST goes wherever `n`
posts today. Success and failure each print one line before the dashboard
re-renders.

**`R` key.** Routing rule:

| Focus | Selection | Action |
|---|---|---|
| ACCOUNTS | Claude or OpenAI account | `api.refreshAccount(id)`; banner "Refreshed `<id>` — usage fresh" or the failure reason |
| ACCOUNTS | Grok account | local Grok snapshot refresh only; banner "Refreshed `<id>`" |
| ACCOUNTS | none | whole-pool refresh (today's behaviour) |
| LOGS / MODELS | any | whole-pool refresh (today's behaviour) |

The per-account path is guarded by its own in-flight ref, separate from the
whole-pool one, so pressing `R` on two accounts in turn queues nothing and
double-pressing one is a no-op with the "already running" banner.

**Accounts API.** `AccountsApi` gains
`refreshAccount(id): Promise<AccountRefreshResult>` with a 30 s timeout
(one token refresh at 15 s plus one usage fetch at 10 s, with margin).

## 6. Proxy endpoint: per-account refresh

`POST /cc-router/accounts/:id/refresh`, mounted on the authenticated
accounts router.

- Unknown id: 404 `{ error: "Account \"<id>\" not found" }`.
- Anthropic account: run `refreshAccountIfCurrent` if `needsRefresh` is
  true, then `usageRefresher.refreshNow(account)`, then
  `accountInfoCache.refresh(true)`. A refresh-less account skips the token
  step; an account without `user:profile` skips usage and identity.
- OpenAI account: the OpenAI refresher's per-account token refresh if due,
  then `openAIUsageRefresher.refreshNow(account)`, then the identity refresh.
- Response:

```json
{ "refresh": { "id": "max-1", "tokenRefreshed": true, "usageRefreshed": true, "durationMs": 812 } }
```

`tokenRefreshed` is `null` when no refresh was due or possible,
`usageRefreshed` is `false` when skipped or failed. Failures of individual
steps do not fail the request; only an unexpected throw returns 500.

- Single-flight per id: a second request for an id already refreshing joins
  the running one, mirroring the whole-pool endpoint.
- One activity log entry: `manual refresh <id> — usage fresh` or the failure
  summary.

## 7. Error handling summary

| Situation | Behaviour |
|---|---|
| `claude` not on PATH | Setup error at `credential_read`, points at `accounts add claude` |
| Operator cancels the browser flow | Non-zero exit → cancelled attempt, no diagnostic id |
| Login exits 0 but stores nothing | Error, no account written |
| setup-token output unparseable | Paste prompt |
| Browser cannot be opened | Silent; URL is printed regardless |
| Re-auth of a Grok account | Explains `grok login` + `accounts add grok`, exit 1 |
| Live pool rejects the replacement | Existing HTTP error surfaces; nothing written to disk |
| Token-only account expires | Marked `authExpired`, shown as re-auth required |

## 8. Testing

Unit, in `src/__tests__/`:

- `token-extractor`: parse without refresh token; still rejects a non
  `sk-ant-` access token.
- `token-refresher`: refresh-less account never hits the token endpoint;
  flips to `authExpired` once past expiry; stays healthy before it.
- `manager`: round-trips an account without `refreshToken`.
- `account-add`: POST accepts an Anthropic record without a refresh token
  and rejects an OpenAI one.
- `anthropic-usage-refresher` and `account-info-cache`: skip accounts
  without `user:profile`.
- `claude-cli`: `extractLongLivedToken` over ANSI-laden chunks with repeated
  frames; `loginWithClaudeCli` with injected spawn and extractor covering
  exit 0 with new token, exit 0 with unchanged token, non-zero exit,
  missing binary.
- `browser`: `browserCommandFor` per platform; env opt-out.
- `device-oauth`: verification URL with and without hint.
- `cmd-accounts`: commander wiring for `login`, `add`, `reauth` with the flow
  functions mocked; `reauth` provider and email resolution; Grok refusal;
  `list` hint and `tokenOnly` JSON.
- `accountsApi`: `refreshAccount` request shape and result parsing.
- Dashboard (Ink render, existing pattern): `R` with account selected calls
  `refreshAccount`, with none calls `refreshAll`, with Grok calls neither;
  `l` emits the re-auth intent for Claude and OpenAI and banners for Grok.
- Server: per-account refresh endpoint 404, single-flight, response shape,
  and that a refresh-less account does not call the token endpoint.

Manual checks recorded in the plan:

- `claude setup-token` capture on the installed Claude Code version.
- `claude auth login --email` prefill and the snapshot comparison.
- Which of `user_code` and `login_hint` the OpenAI device page honours.

## 9. Documentation

- `docs/cli-reference.md`: the new subcommand table.
- `docs/dashboard.md`: `l` in the accounts table; `R` row updated to
  describe the per-account behaviour.
- `docs/oauth-tokens.md`: token-only accounts, their one-year lifetime,
  missing usage metadata, and the Claude Code login side effect.
- `README.md` quickstart: mention `cc-router accounts login`.
- `CHANGELOG.md`: breaking-change entry listing removed commands and their
  replacements.

## Out of scope

- Restoring the previous Claude Code login after `claude auth login`.
- A native OAuth implementation.
- Re-authenticating Grok from within cc-router.
- Refreshing a token-only account automatically; it needs a new sign-in.
