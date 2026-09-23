# CLI reference

```text
cc-router setup              Interactive wizard: extract tokens + configure Claude Code
cc-router setup --add        Add another account to an existing configuration

cc-router start              Start proxy (asks preferences on first run, then remembers)
cc-router start --foreground Run in the foreground (stays in terminal)
cc-router start --reconfigure  Re-ask run preferences (background/service/server mode)
cc-router start --litellm    Start with LiteLLM in Docker (advanced mode)

cc-router stop               Stop proxy (offers to remove auto-start / config)
cc-router stop --keep-config Stop proxy only (keep settings.json)
cc-router stop --full        Stop + remove auto-start + revert Claude Code (no prompts)
cc-router revert             Same as stop --full

cc-router status             Live dashboard (updates every 2s, press q to quit)
cc-router status --json      Print current stats as JSON and exit

cc-router models list        List models discovered live from provider APIs
cc-router models list --json Print discovered models + routing as JSON
cc-router models set --claude-model anthropic/claude-sonnet-4-6
cc-router models set --openai-model openai/gpt-5-codex

cc-router logs               View proxy logs (background mode)
cc-router logs -f            Follow log output in real time
cc-router logs --lines 100   Show last 100 lines

cc-router accounts list      List Claude, ChatGPT and Grok accounts (live stats and metadata when running)
cc-router accounts list --json  Same, as JSON
cc-router accounts login [claude|openai|grok]  Sign in in the browser (Claude: claude auth login, or --long-lived for claude setup-token)
cc-router accounts login claude --email you@example.com --id max-2
cc-router accounts add [claude|openai|grok]    Import credentials that already exist (Keychain, ~/.claude/.credentials.json, pasted tokens, OpenAI tokens, ~/.grok)
cc-router accounts reauth <id>  Sign an existing account in again under the same id, email prefilled
cc-router accounts rename <id> <new-id>  Rename an account
cc-router accounts remove <id>  Remove a Claude, OpenAI or Grok account

cc-router configure          (Re)write ~/.claude/settings.json
cc-router configure codex    (Re)write ~/.codex/config.toml for Codex CLI
cc-router configure codex --model openai/gpt-5-codex
cc-router configure models --claude-model claude-sonnet-4-6 --openai-model gpt-5-codex
cc-router configure --show   Show current Claude Code proxy settings
cc-router configure --remove Remove cc-router settings from Claude Code (proxy stays up)
cc-router configure codex --remove  Remove the Codex managed block (proxy stays up)

cc-router cli                Show whether Claude Code and Codex are routing through the proxy
cc-router cli claude start   Point Claude Code at the running proxy
cc-router cli claude stop    Restore Claude Code to native Anthropic auth (proxy stays up)
cc-router cli claude resume  Same as cli claude start
cc-router cli codex start    Point Codex CLI at the running proxy
cc-router cli codex stop     Restore Codex CLI to native OpenAI auth (proxy stays up)
cc-router cli codex resume   Same as cli codex start
cc-router claude … / cc-router codex …   Hidden shortcuts for the same commands

cc-router client connect <url>       Connect Claude Code to a remote CC-Router
cc-router client connect --desktop   Also configure Claude Desktop interception
cc-router client disconnect          Revert all client configuration
cc-router client status              Show connection + remote server health
cc-router client start-desktop       Start mitmproxy interceptor for Claude Desktop
cc-router client stop-desktop        Stop mitmproxy interceptor

cc-router telemetry status   Show whether anonymous telemetry is on (off by default)
cc-router telemetry on       Opt in to anonymous usage analytics
cc-router telemetry off      Opt back out

cc-router docker up          Start full Docker stack (cc-router + LiteLLM)
cc-router docker up --build  Rebuild cc-router image before starting
cc-router docker down        Stop Docker containers
cc-router docker logs        Tail all Docker logs
cc-router docker ps          Show container status
cc-router docker restart [service]  Restart a service
```

## Signing in

`cc-router accounts login` runs the provider's sign-in for you. For Claude it
hands the terminal to `claude auth login --claudeai`, which opens the browser
itself (`--long-lived` runs `claude setup-token` instead, for a one-year token
without a refresh token). For OpenAI and Grok it runs the device-code flow and
opens the verification page — with the one-time code already filled in for
OpenAI, plus the email on a re-auth. `cc-router accounts add` never opens
anything; it only imports credentials that already exist on the machine or that
you paste in.

`cc-router accounts reauth <id>` signs an existing account in again under the
same id, looking up its provider and cached email. The dashboard does the same
on `l` with an account selected — see [Status dashboard](dashboard.md).

## Environment variables

| Variable | Effect |
|---|---|
| `CC_ROUTER_NO_BROWSER=1` | Do not open a browser for the OpenAI and Grok device-code sign-ins. The verification URL and code are still printed, so you can open them yourself — useful over SSH or on a headless box. It does not reach `claude auth login`, which opens its own browser |
| `CC_ROUTER_TELEMETRY=0` | Disable anonymous telemetry (`DO_NOT_TRACK=1` does the same) — see [Telemetry](telemetry.md) |
| `CC_ROUTER_TOKEN` | Proxy secret used by the Codex CLI's managed config — see [Codex CLI & OpenAI](codex.md) |

## Toggling a CLI while the proxy stays up

`cc-router start` / `stop` control the proxy process. To send only one CLI back
to native auth — or point it at the proxy again — without tearing the router
down:

```bash
cc-router cli                 # Claude Code + Codex routing state
cc-router cli claude stop     # Claude Code → native Anthropic auth
cc-router cli claude resume   # Claude Code → running proxy (alias of start)
cc-router cli codex start     # Codex CLI → running proxy
cc-router cli codex stop      # Codex CLI → native OpenAI auth
```

`cc-router claude …` and `cc-router codex …` are shortcuts for the same commands.
`cli` is the grouping — not `provider`, which already means the Anthropic/OpenAI
account pool. `cc-router client` is remote client mode (connecting this machine
to another CC-Router), see [Client mode](client-mode.md).

These rewrite `~/.claude/settings.json` or the managed block in
`~/.codex/config.toml`. The proxy keeps listening. Restart any already-running
Claude Code or Codex process so it picks up the new config. From
`cc-router status`, `[c]` / `[x]` do the same toggles.

## Persistent token usage and savings

```bash
cc-router usage
cc-router usage --period day --date 2026-09-01
cc-router usage --period week --provider claude --provider openai
cc-router usage --period year --json

cc-router usage subscription set personal --monthly-usd 100 --from 2026-09-01
cc-router usage subscription set personal --monthly-usd 200 --from 2026-10-01
cc-router usage subscription end personal --on 2026-11-01
cc-router usage subscription list --json
```

`--period` accepts `day`, `week`, `month` (default), or `year`. `--date` selects
its containing period. Dates and boundaries are UTC; weeks begin on Monday.
Provider selectors accept `claude`/`anthropic`, `openai`, `grok`/`xai`, or the
full provider identifiers. Repeat `--provider` to select more than one.
`--port` selects the local service port. In client mode, all operations use the
configured remote server and its authentication; remote failures never fall
back to this machine's history. An older server must be upgraded first.

`--json` prints the full report and exits without starting Ink. Redirected
non-JSON output is a plain-text summary. When the local service is stopped,
reports can read local history; local subscription updates take an exclusive
writer lock. Authentication failures do not trigger an offline fallback.

### Dashboard controls

`Tab` cycles the period, `←`/`→` move through periods and `t` returns to the
current one. `1`/`2`/`3` toggle Claude, OpenAI and Grok. `m` stacks bars by
model instead of provider, and `l` lists each model's input, output, cache and
spend for the period. `s` switches the bar chart and daily grid between tokens
and frozen-rate API spend; `i` narrows either view to input only, output only,
or everything. `g` focuses the daily grid for arrow-key inspection. `?` shows
this list in the terminal. `Esc` closes the help or model view and otherwise
quits, like `q`. The chart shares the daily grid's width so the two line up.

### Subscription costs

Enter your own **monthly USD cost**, not a plan name. An annual subscription
can be entered as its monthly equivalent. Setting a later effective date closes
the preceding open interval. Dates are inclusive at the start and exclusive
at the end. Historical overlaps are rejected. Use the opaque account key from
`subscription list --json` to disambiguate retired accounts whose names were
reused. Removing an account does not cancel its subscription cost: end the
cost interval explicitly when payment ends.

Costs are prorated across each actual UTC calendar month, including inactive
days, and stop at the current time for an ongoing period. Provider filters
apply to both usage and costs. Model differentiation is visual only; it does
not allocate a subscription's cost between models.

### How the API-equivalent cost is estimated

The report prices every recorded token at the standard API rate frozen when it
was observed. Cached input and cache-write durations use their own rates.
These are token-cost estimates, not invoices: tool charges, taxes, negotiated
discounts, regional processing and fast-mode surcharges are not included.

Subscription costs and **net savings (API-equivalent cost − configured
subscription cost)** are still computed and returned in `--json` output
(`costs.subscriptionUsd`, `costs.savingsUsd`), but the dashboard and the
plain-text summary show only the API-equivalent value for now.

Missing model rates or subscription costs are marked partial/unconfigured, not
silently priced at zero. Incomplete tracking suppresses an authoritative net
savings figure while preserving priced subtotals. History starts when tracking
is installed; past activity cannot be recovered from the short status log.
Grok is currently an account overview, not routed token usage.

### Pricing overrides and storage

History lives in `~/.cc-router/usage/` (`USAGE_DIR` overrides the directory).
With a custom accounts file, the default is a sibling `usage/` directory.
Set the same `ACCOUNTS_PATH` or `USAGE_DIR` when reading that history offline.
Keep this directory on a persistent volume when using a container. API rates
are snapshotted with usage, so later rate changes do not rewrite old estimates.
To price an unsupported model, create `pricing.json` in that directory, then
restart the service:

```json
{
  "version": 1,
  "models": [{
    "provider": "openai_subscription",
    "model": "your-exact-model-id",
    "input": 2,
    "output": 8,
    "cacheRead": 0.2,
    "source": "user-configured",
    "effectiveDate": "2026-09-01"
  }]
}
```

The amounts above are **illustrative**, in USD per million tokens, not prices
for a real model. Optional `cacheWrite5m` and `cacheWrite1h` rates price the
corresponding duration subsets. `cacheWrite` prices only cache creation whose
duration is unknown. Unspecified categories with positive token counts remain
unpriced. Overrides use exact provider/model IDs and do not reprice history.

The usage journal is independent of telemetry consent. It does not store
prompts, response bodies, credentials, emails, or provider profile objects.
Usage is attributed to the UTC start time of each upstream attempt.
Graceful shutdown closes the writer. Abrupt termination can lose observations
that have not reached the journal; recovery and storage errors are surfaced
rather than presented as complete usage. A pending account-identity transition
requires recovery before read-only offline reports are available; restart the
router to recover it.
