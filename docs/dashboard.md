# Status dashboard

```bash
cc-router status
```

![CC-Router dashboard](../assets/dashboard.png)

Press `q` to quit. The view refreshes every 2 seconds.

The dashboard is also a control surface. In local mode it controls the local
proxy; in client mode it controls the remote CC-Router configured by
`cc-router client connect`.

## Reading the screen

### Header

`CC-Router · <mode> · up <uptime> · <n> req <n> err · cache <n>% hit (<label>)`

The cache badge is the fleet-wide prompt-cache hit rate — cached input tokens as
a share of all input tokens. It is the single number that tells you whether
session affinity is doing its job:

| Hit rate | Label | Reading |
|---|---|---|
| ≥ 70% | `healthy` | Conversations are staying on their accounts |
| 30–69% | `fair` | Some churn — failover, restarts, or lots of new sessions |
| < 30% | `poor` | Little cache reuse; see [Session routing](session-routing.md) |

The badge is hidden until the router has seen some token usage.

### OPERATIONS

Base URL, whether proxy auth is set (`auth open` / `auth protected`), per-provider
healthy/total counts, cross-route readiness, and which CLIs are currently pointed
at the router. Grok appears here with its own count because it is tracked but
never routed — see [Grok / xAI](grok.md).

### ACCOUNTS

Accounts are grouped by provider. Claude and ChatGPT rows carry routing and usage
data; Grok rows are an overview only.

| Column | Meaning |
|---|---|
| status dot | `●` green healthy · `●` red unhealthy · `◌` yellow busy · `⊘` red rate-limited · `⊘` grey disabled (row dimmed) |
| `req` | Requests served by this account |
| `s·n` | Bound sessions, and — when any are in flight — `sessions·in-flight` |
| `5h` / `7d` | Utilisation of the 5-hour and 7-day windows |
| `note` | Model-scoped allowance state, e.g. `Fable 23%`, plus `extra off` when paid extra exists but cannot be spent |
| `↻5h` / `↻7d` | Time until each window resets |
| `rst` | Banked usage-limit reset credits (ChatGPT only; `—` elsewhere) |

Account IDs are truncated to 22 characters in this column.

Authenticated account views include dynamic model-scoped allowance rows, their
reset times, applicable global or requested-model cooldowns, paid-extra state,
and whether the usage snapshot is fresh, stale or unavailable. **A stale row is
shown as unknown rather than as authoritative available capacity.**

### TOTALS

Request, error and refresh counts, the same cache badge, and a token breakdown:

`input <total> (cached <n> + new <n> + uncached <n>) · output <n> · total <n>`

`cached` is cache reads, `new` is cache *writes* (tokens paid for once to create
the cache entry), and `uncached` never touched the cache. A healthy long session
grows `cached` while `new` stays flat.

### RECENT ACTIVITY

One line per request: time, client (`cli` for Claude Code, `cdx` for Codex),
account, method and path, status, duration, then `↑<n>%` — that request's own
cache hit rate — and `<n>↑ <n>↓` input/output tokens. The trailing word is the
routing decision: `sticky`, `new-session`, `failover`, `unscoped`, or a
`no-eligible:*` local response.

Rows whose path column reads `route` are router events rather than proxied
requests — a cooldown expiring, for example. They carry no client tag, status or
token counts.

## Keybindings

With **ACCOUNTS** focused, the selected account's detail line shows its email,
personal/workspace type, workspace name, and plan when available. Claude accounts
can also show subscription status and a **Since** date. This is the subscription's
creation date, not the start of its current billing period.

Metadata is cached in memory and refreshed in the background. **R** requests an
immediate refresh alongside usage and credentials — for the selected account
alone when ACCOUNTS is focused, for the whole pool otherwise. Failed lookups
retain the last successful data with a stale marker; an initial lookup may show
unavailable.
Billing interval is not supported. Missing renewal dates are not guessed from
token expiry or usage resets. Stored Grok accounts currently supply plan metadata only.

Identity metadata is retrieved through the authenticated account endpoint, never
through health responses or telemetry. It is not written to `accounts.json`.

Focus moves between three panels — logs, accounts and models — and some keys
depend on which has focus.

| Key | Action |
|---|---|
| `Tab` | Cycle focus: logs → accounts → models (skips logs in compact view) |
| `↑` / `↓` | Move the selection within the focused panel |
| `Esc` | Return to logs, or quit if logs already has focus |
| `q` | Quit |
| `z` | Compact view — hides TOTALS and RECENT ACTIVITY so more accounts fit |
| `R` | Reload usage and credentials for the selected account when ACCOUNTS is focused; otherwise reload every account, metadata and models |
| `m` | Load discovered provider models |
| `n` | Add an account |
| `c` | Toggle Claude Code routing — or set the Claude default when MODELS is focused |
| `x` | Toggle Codex CLI routing (proxy stays up) |

With **ACCOUNTS** focused:

| Key | Action |
|---|---|
| `e` | Enable/disable the selected account |
| `a` / `o` / `g` | Enable/disable *every* Claude / ChatGPT / Grok account at once |
| `w` / `s` | Set the selected account's 7-day / 5-hour cap |
| `d` | Delete the selected account |
| `l` | Re-authenticate the selected account (Claude or ChatGPT) — the dashboard hands over to the sign-in flow and returns afterwards |
| `Ctrl+R` | Redeem one banked usage-limit reset (ChatGPT accounts only) |

With **MODELS** focused:

| Key | Action |
|---|---|
| `r` | Refresh the discovered model list |
| `c` | Set the selected model as the Claude default |
| `o` | Set the selected `openai/*` model as the OpenAI default |

Grok accounts accept none of the account actions. `e`, `w`, `s`, `d` and `l` each
explain why instead of acting: Grok is read-only here, caps do not apply to a
provider that is never routed, and the credentials live in `~/.grok`, so adding
or removing one means `grok login` / `grok logout`. `l` says the same: re-sign in
with `grok login`, then import the result with `cc-router accounts add grok`.

## Redeeming a ChatGPT usage reset

Press `Tab` to focus accounts, select the account with the arrow keys, then press
`Ctrl+R` and confirm with `y` (`n` or `Esc` cancels). The `rst` column shows
banked reset credits. Accounts with zero or unknown credits cannot start a new
redemption.

> **This spends a real reset credit.** It is not the same as refreshing usage
> with uppercase `R`.

Press **Control + R** — not Command + R or Shift + R. This uses the standard
terminal Ctrl+R sequence and does not require a custom Meta/Option key mapping.

Redemption targets only that account and refreshes its usage afterwards. If the
network outcome is unknown, keep the dashboard open and retry the shortcut: it
reuses the same redemption ID instead of spending another credit. Those retry IDs
are held for the current dashboard session only — after restarting it, inspect
usage before requesting another reset. A successful redemption with a failed
usage refresh is reported separately.

Confirmed resets plus fresh usage clear only superseded quota cooldowns. Overload
holds, unreported or exhausted limits, and newer quota signals are preserved.

## JSON output

```bash
cc-router status --json
```

Prints current stats and exits. The JSON includes an `operational` block with
capabilities, endpoints, provider readiness, auth status and model routing.
Secrets and account tokens are never included.

## Managing models

List and change models without waiting for a package update:

```bash
cc-router models list
cc-router models set --claude-model anthropic/claude-sonnet-4-6
cc-router models set --openai-model openai/gpt-5-codex
```

When the proxy is running, `models set` updates the live router and persists the
new defaults. If the proxy is offline, it writes the configuration for the next
start.
