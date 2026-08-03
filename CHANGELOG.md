# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

### Fixed

- The interactive status dashboard no longer crashes when model-scoped usage
  reports an unknown reset timestamp as zero.
- Anthropic model-scoped usage rows using the current nested `scope.model`
  shape are parsed correctly, so exhausting Fable capacity no longer creates
  an account-global cooldown that also blocks Opus routing.
- When all accounts are hard-blocked, the router now returns a local
  Anthropic-shaped 429 when any blocker is rate-limit or quota related, adding
  the earliest trustworthy `Retry-After` only when known. A 503 is used only
  for entirely non-rate-limit unavailability. These local errors make no
  Anthropic Messages request, and fallback no longer sends requests to cooling
  or upstream-rate-limited accounts.

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

[0.7.0]: https://github.com/Timo972/cc-router/releases/tag/v0.7.0
