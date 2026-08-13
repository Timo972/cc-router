# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- OpenAI/Codex sticky session routing: sessions pin to one account for prompt-cache
  locality (`session_id` → `x-claude-code-session-id` → `prompt_cache_key`), with
  load- and headroom-aware selection for new sessions.
- Codex usage tracking from `x-codex-*` response headers: default 5h/weekly windows
  plus dynamically discovered model-scoped metered buckets, credits, and plan.
- Scoped cooldowns on upstream failures: bucket-scoped via `x-codex-active-limit`,
  account-global otherwise; local 429/503 responses when no account is eligible.
- Dashboard: OpenAI accounts now show 5h/weekly bars, per-bucket rows, credits,
  plan, request/error/in-flight/session counts, and cooldown state.

### Changed

- OpenAI account records persist `scopes`, `sessionLimitPercent`, and
  `weeklyLimitPercent`.
- The stateless OpenAI round-robin picker was removed in favor of
  `OpenAITokenPool`.

### Fixed

- An unexpected failure partway through an OpenAI request — an upstream
  connection error, a rejected token refresh, a mid-stream abort — no longer
  takes down the proxy. Both `/v1/responses` and the `/v1/messages` OpenAI
  branch awaited the upstream call without catching a rejection, so a single
  network blip could kill the daemon and lose every account's routing state.
- `/v1/messages` no longer reports an upstream OpenAI failure as a success. A
  stream ending in `response.failed`, an `error` event, a JSON error body, or
  no completion event at all — a stream that stopped mid-flight, or an
  event-stream response with no body — was translated into an empty Anthropic
  message with HTTP 200; each now surfaces as an error response, so a rate
  limit reads as a rate limit instead of an empty assistant turn. A non-2xx
  upstream response (401, 429, 5xx) is now relayed with its real status, error
  message, and safe headers — `Retry-After` included, so a client can honor the
  backoff the server asked for — instead of being parsed as an event stream and
  reported as a success or a generic failure; non-2xx Codex responses also keep
  their real content type instead of being rewritten to `text/event-stream`.
- A terminal event that carries no response object is no longer treated as a
  successful result. `{"type":"response.completed","response":null}` — or any
  other non-object payload — satisfied the completion check, so a
  non-streaming request got HTTP 200 with a `null` body, and `/v1/messages` got
  a fabricated empty assistant turn. Both now report the `502` that a stream
  ending without a terminal event already did.
- A single malformed SSE frame no longer truncates a `/v1/messages` stream.
  Parsing a chunk was all-or-nothing, so one bad frame discarded the valid
  events beside it and ended the response as a clean `200` the client could
  not tell apart from a complete answer.
- OpenAI credentials are written back to the accounts file the proxy was
  started with. Under `--accounts <path>` accounts were read from that file
  but every refresh, add, delete, and update wrote the default
  `accounts.json` — discarding the change and copying OAuth tokens into an
  unrelated file.
- OpenAI token refresh survives a malformed token response. A payload missing
  `expires_in` produced a `NaN` expiry that read as "never needs refreshing",
  so the account kept presenting a stale token indefinitely — as did a lifetime
  large enough to overflow into an infinite expiry, while a zero or negative
  one reported success on a token that was already due for another refresh.
  Each is now treated as the failed refresh it is; a failure to
  persist rotated credentials no longer fails the request that triggered the
  refresh, and the write is now retried on subsequent requests (and the
  background refresh loop) until it succeeds, so a rotated refresh token
  still reaches disk.
- `PATCH /cc-router/accounts/:id` works for OpenAI accounts instead of
  returning `404`, so a single OpenAI account can be enabled, disabled, or
  capped without toggling the whole provider. `POST /cc-router/accounts` now
  rejects an out-of-range percentage cap the same way `PATCH` does, rather
  than silently coercing it.
- A Codex response that ends as `response.incomplete` — e.g. hitting the
  output-token ceiling — is now delivered with its partial content and token
  usage instead of being discarded. `/v1/responses` treated only
  `response.completed` as a terminal event, so `response.incomplete` looked
  identical to a stream that stopped mid-flight and turned a usable partial
  answer into a `502 upstream_error`. A streamed `/v1/messages` turn that ends
  incomplete now closes properly too — the Anthropic translation emitted no
  `message_stop` for it, leaving the client waiting on a turn that was already
  over. Both `/v1/messages` paths, streamed or collected, now report
  `max_tokens` as the stop reason when the output-token ceiling was the cause,
  instead of an `end_turn` that made a truncated answer look deliberate.

---

## [0.9.0] — 2026-08-04

### Added

- **Non-streaming `/v1/responses` requests are served correctly.** A caller that
  posts `stream: false` — the public Responses API default — now receives a
  single JSON Responses object. The Codex backend is SSE-only, so the router
  reconciles the forced event stream into one body instead of returning raw SSE
  bytes the client cannot parse. Streaming callers (the Codex CLI) are
  unaffected.
- A distinct `warn` activity type with its own `logWarn` console channel,
  rendered as its own row style on the status dashboard so advisories are
  visually separate from routing errors.

### Changed

- `/v1/responses` rejects an explicit `store: true` with a `400`
  `invalid_request_error` instead of silently rewriting it to `false`. The Codex
  subscription backend is stateless and cannot offer server-side response
  retrieval by id. An omitted `store` is still normalized to `false` silently.
- An explicit `max_output_tokens` is still dropped — the backend does not
  support it — but each drop now surfaces as a warning in both the console log
  and the dashboard activity feed, so the ignored cap is observable.

### Fixed

- Malformed upstream data from the Codex backend (a bad JSON body or a malformed
  SSE stream) maps to a `502 upstream_error` instead of throwing out of the
  async Express handler, which left the client connection hanging indefinitely.
- Non-2xx Codex passthrough preserves the upstream content-type instead of
  hardcoding `text/plain`, which broke SDK clients that parse errors by
  content-type.

---

## [0.8.3] — 2026-08-04

### Fixed

- Accounts added while the proxy is running (`accounts add`, `add-openai`,
  `login-openai`) are now loaded into the live pool immediately — routable and
  visible in `accounts list` without a restart. Previously only removals were
  applied at runtime; adds required restarting the proxy. When no proxy is
  running the add still falls back to a plain disk write.

---

## [0.8.2] — 2026-08-03

### Fixed

- The interactive status dashboard no longer crashes when model-scoped usage
  reports an unknown reset timestamp as zero.

### Internal

- GitHub Actions bumped to v7.
- The Codex config-path test uses the platform-native location instead of a
  hardcoded POSIX path.

---

## [0.8.1] — 2026-08-03

### Fixed

- Anthropic model-scoped usage rows using the current nested `scope.model`
  shape are parsed correctly, so exhausting Fable capacity no longer creates
  an account-global cooldown that also blocks Opus routing.

### Changed

- Hosting guidance about sharing accounts across a team was removed from the
  docs.

### Internal

- CI installs with pnpm and runs the suite across the supported Node versions.

---

## [0.8.0] — 2026-08-01

### Added

- **Model-aware Anthropic allowance routing.** Requested Messages models now
  participate in account eligibility and headroom ranking through dynamic
  model-scoped weekly limits. Account-based session affinity is retained while
  the bound account can serve the requested model.
- Authenticated dashboard, health, and accounts views now show safe global and
  model-scoped capacity, usage freshness, paid-extra state, and global or
  requested-model cooldown summaries.

### Changed

- Anthropic cooldowns, upstream quota exhaustion, disabled or unhealthy state,
  and invalid authentication are hard routing exclusions. The only fallback is
  an explicit bypass of configured per-account percentage caps when every
  otherwise eligible account is capped.
- Usage snapshots refresh in memory from Anthropic's internal OAuth usage
  endpoint with bounded concurrency, timeout, and backoff, while response
  headers remain the graceful-degradation source when that endpoint is
  unavailable.
- The README leads with the fork's positioning, and the account-sharing use
  case was dropped.

### Fixed

- When all accounts are hard-blocked, the router now returns a local
  Anthropic-shaped 429 when any blocker is rate-limit or quota related, adding
  the earliest trustworthy `Retry-After` only when known. A 503 is used only
  for entirely non-rate-limit unavailability. These local errors make no
  Anthropic Messages request, and fallback no longer sends requests to cooling
  or upstream-rate-limited accounts.
- `accounts remove` now removes the account from the running proxy instead of
  only rewriting `accounts.json`, so a removed account stops being routed
  without a restart.
- A per-account cap of 100% is no longer treated as over-cap at full
  utilization, so sessions on accounts running on paid extra usage stay sticky
  on their bound account.

### Internal

- Package management switched from npm to pnpm (`pnpm-lock.yaml`,
  `pnpm-workspace.yaml`).

---

## [0.7.0] — 2026-07-26

First release of `@timo972/cc-router`, an independently maintained fork of
[VictorMinemu/CC-Router](https://github.com/VictorMinemu/CC-Router). Adds
cache-aware session routing and a round of security hardening.

### ⚠️ Breaking

- **The package moved to `@timo972/cc-router`.** The old package name is no
  longer used by this project. Reinstall rather than upgrade in place:

  ```bash
  npm uninstall -g ai-cc-router
  npm install -g @timo972/cc-router
  ```

  Update checks and the CLI's install hints now resolve against the new name.
  Existing `~/.cc-router` configuration and accounts are unaffected.

- **Auto-update is off by default.** New releases are announced but not
  installed. Opt back in with `autoUpdate: true` in `~/.cc-router/config.json`
  or `CC_ROUTER_AUTO_UPDATE=1`.

- **Server mode now requires a proxy secret.** The "skip — no password" option
  is gone, and the router refuses to bind a non-loopback interface without a
  secret. Loopback-only setups are unchanged.

- **Telemetry is opt-in.** Nothing is sent unless you run
  `cc-router telemetry on`.

### Added

- **Cache-aware session routing.** Requests from one Claude Code session stay on
  one account, preserving prompt-cache locality instead of scattering a
  conversation's shared prefix across per-account caches. New sessions are
  placed by fewest in-flight requests, then fewest bound sessions, then most
  rate-limit headroom, with a rotating round-robin tie-break.
- **Load-aware account leases** with ownership-checked acquisition and release,
  so concurrent streams cannot corrupt each other's account state.
- **Passive stream lifecycle diagnostics** on `cc-router status --json` and
  `/cc-router/health`, for diagnosing stalled streams without buffering or
  altering response bytes.
- **[docs/session-routing.md](docs/session-routing.md)** — operational guide for
  running the router across a team.

### Changed

- Streaming stays byte-transparent: no synthetic `message_stop`, and no retry
  once response bytes have started. `proxyRequestTimeoutMs` now covers only the
  pre-header phase and is disarmed once a response begins, so long thinking
  pauses are no longer cut off.
- `cc-router configure` manages Claude Code's event- and byte-level stream idle
  watchdogs at 30 minutes. Restart running Claude Code processes to pick them up.
- Unauthenticated `/cc-router/health` returns only `{status}`; the account
  inventory and recent logs require the proxy secret.
- `~/.cc-router` is created `0700`; `accounts.json` and `config.json` are written
  `0600`, so other local users can no longer read OAuth tokens or the secret.

### Fixed

- Concurrent SSE streams are routed per Claude session rather than sharing state.
- Token refresh serializes account ownership and joins an in-flight refresh
  during request preparation, instead of racing a second refresh.
- Refresh ownership is reserved across account deletion.
- Claude config mutations are guarded and schema-validated, and watchdog backups
  survive the config lifecycle.
- Idle session counts expire on read rather than accumulating.
- SSE lifecycle line retention is bounded.
- Deflaked the started-stream timeout assertion, which allowed only 50 ms for the
  upstream response and failed under parallel CI load.

### Security

- Strict semver validation on registry responses before the version reaches a
  child process, and `shell:true` dropped from the update spawn — closes a
  Windows command-injection path.
- Release pipeline publishes with `--provenance` under least-privilege
  permissions, with actions pinned by commit SHA.
- mitmproxy root CA can now be removed at teardown (`cc-router client disconnect`)
  instead of leaving a trusted root installed permanently.
- Docker runs as non-root with digest-pinned images, `cap_drop: ALL`,
  `no-new-privileges`, loopback-bound ports, and a required `LITELLM_MASTER_KEY`.
  `--detailed_debug` was dropped — it logged the injected OAuth bearer.
- `docs/security.md` corrected on telemetry, file permissions, and TLS.
- `http-proxy-middleware` 3.0.5 → 3.0.7 for GHSA-gcq2-9pq2-cxqm (high). The
  affected APIs are not used here.

[0.9.0]: https://github.com/Timo972/cc-router/releases/tag/v0.9.0
[0.8.3]: https://github.com/Timo972/cc-router/releases/tag/v0.8.3
[0.8.2]: https://github.com/Timo972/cc-router/releases/tag/v0.8.2
[0.8.1]: https://github.com/Timo972/cc-router/releases/tag/v0.8.1
[0.8.0]: https://github.com/Timo972/cc-router/releases/tag/v0.8.0
[0.7.0]: https://github.com/Timo972/cc-router/releases/tag/v0.7.0
