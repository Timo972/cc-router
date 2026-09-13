# Status dashboard

```bash
cc-router status
```

![CC-Router dashboard](../assets/dashboard.png)

Press `q` to quit. The view refreshes every 2 seconds. Accounts are grouped by
provider, with per-account request counts, in-flight and bound-session counts,
5-hour and 7-day utilisation, model-scoped allowance notes, cooldown timers and
banked reset credits.

The dashboard is also a control surface. In local mode it controls the local
proxy; in client mode it controls the remote CC-Router configured by
`cc-router client connect`.

Accounts are shown in per-provider groups. Claude and ChatGPT rows carry
routing and usage data; Grok rows are an overview — plan, code access, active
sessions and token health — because Grok is not a routed provider. See
[Grok / xAI](grok.md).

Authenticated account views include dynamic model-scoped allowance rows, their
reset times, applicable global or requested-model cooldowns, paid-extra state,
and whether the usage snapshot is fresh, stale or unavailable. **A stale row is
shown as unknown rather than as authoritative available capacity.**

## Keybindings

| Key | Action |
|---|---|
| `Tab` | Switch focus between logs, accounts, and models |
| `n` | Add a Claude account |
| `e` | Enable/disable selected Claude account |
| `w` / `s` | Change selected Claude account weekly/session cap |
| `d` | Delete selected Claude account |
| `Ctrl+R` | Confirm redeeming one banked usage-limit reset for the focused ChatGPT account |
| `R` | Reload account usage and due credentials without restarting the router |
| `m` / `r` | Load or refresh discovered provider models |
| `c` | Toggle Claude Code routing (or set the Claude model default when MODELS is focused) |
| `x` | Toggle Codex CLI routing (proxy stays up) |
| `o` | Set the selected `openai/*` model as the OpenAI default |

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
