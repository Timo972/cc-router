# Stream Idle Timeout Hardening Design

## Problem

CC-Router configures `http-proxy-middleware` with the same
`proxyRequestTimeoutMs` value for both the upstream Anthropic socket and the
downstream Claude Code socket. The generated default is 300,000 ms.

Production session records show repeated failures 300.568-301.608 seconds
after the last streamed event. Claude Code 2.1.215 and 2.1.216 independently
apply a 300,000 ms stream-idle watchdog and emit:

```text
API Error: Response stalled mid-stream. The response above may be incomplete.
```

The matching router timeout makes the failure worse. After an HTTP 200 and a
partial SSE body, `node-http-proxy` aborts the upstream request when its socket
has been quiet for the configured interval. The downstream receives an
incomplete 200 response followed by a connection reset. This timeout path does
not emit HPM's normal proxy `error` callback, so current health data records a
successful 200 with zero errors.

Native Claude Code does not insert this HPM timeout between itself and
Anthropic. CC-Router must not terminate an already-started Anthropic stream at
the legacy five-minute boundary, and the Claude client needs enough idle
headroom for routed long-thinking responses.

## Goals

- Preserve the existing pre-response connection safety timeout.
- Disable router socket inactivity deadlines after upstream response headers
  arrive, allowing an SSE or JSON body to finish naturally.
- Configure Claude Code's event-level and byte-level stream idle watchdogs to
  1,800,000 ms (30 minutes) while CC-Router manages its proxy settings.
- Restore any pre-existing Claude timeout values when CC-Router settings are
  removed.
- Expose passive response lifecycle diagnostics that distinguish a complete
  stream from upstream abort, downstream close, and a missing `message_stop`.
- Preserve upstream status, headers, body bytes, chunk ordering, and timing.

## Non-Goals

- Synthesizing SSE comments, pings, `message_stop`, or any other response bytes.
- Retrying a response after any body bytes have been delivered.
- Claiming that a network, Anthropic, or client failure can never occur.
- Waiting forever in Claude Code. Its watchdog remains enabled with a bounded
  30-minute idle interval.
- Changing cache-aware account selection or session affinity.

## Transport Timeout Semantics

`proxyRequestTimeoutMs` remains the maximum socket inactivity allowed while
waiting for upstream response headers. The default remains 300,000 ms for that
pre-response phase, preserving protection against connection attempts that
never produce a response.

When the upstream `ClientRequest` emits `response`, the Anthropic proxy clears:

1. the upstream `ClientRequest` timeout installed by `proxyTimeout`; and
2. the downstream request socket timeout installed by `timeout`.

The response continues through HPM's native pipe with
`selfHandleResponse: false`. No response buffering or transformation is added.
Requests that fail before response headers retain the existing timeout and
error handling.

This behavior applies to the Anthropic transport only. Other proxy routes keep
their current timeout semantics.

## Claude Code Watchdog Configuration

When `writeClaudeSettings` configures a local or remote CC-Router endpoint, it
also writes:

```json
{
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "1800000",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS": "1800000"
}
```

Both are strings because Claude Code environment values are serialized in the
`env` object. `API_TIMEOUT_MS` is not changed; inspection of Claude Code shows
that it is not the watchdog producing this streaming error.

Before managing these two variables for the first time, CC-Router stores
whether each key existed and its prior string value in `config.json`. Repeated
configuration does not overwrite the original backup. During removal:

- if the current value is still CC-Router's managed value, restore the backed
  up value or remove the key when it was originally absent;
- if the user changed the value after configuration, preserve the user's new
  value;
- clear the backup after restoration or preservation.

Existing unrelated Claude settings and environment variables remain
unchanged. Running Claude Code processes must be restarted before they inherit
the new watchdog values.

## Passive Stream Diagnostics

The existing response listener may observe bytes for accounting but must never
mutate, pause, buffer, or replace the native pipe. Each recent route log gains
bounded lifecycle metadata:

- whether an SSE `message_stop` event was observed;
- whether the upstream response emitted `end`, `aborted`, and `close`;
- whether the downstream response emitted `finish` and `close`;
- the timestamp of the last upstream body byte;
- total body lifetime from request start to the latest terminal event.

The parser continues far enough to detect `message_stop` even after input and
output usage have been captured. It stores no body text, tool input, session
identifier, request identifier, or raw error object.

An intentional downstream cancellation is diagnostic state, not automatically
an account error. Existing account cooldown and affinity invalidation behavior
therefore remains unchanged.

## Data Flow

```text
Claude request
  -> pre-response 5-minute socket safety timeout
  -> Anthropic response headers
  -> clear both router socket inactivity timers
  -> native byte-exact HPM response pipe
  -> passive lifecycle/terminal-event observation
  -> upstream end or downstream close releases the existing route lease
```

Claude Code separately enforces the managed 30-minute event/byte idle
watchdogs. Router and client deadlines no longer race at five minutes.

## Testing

Transport integration tests will use a real local upstream and downstream
server with a deliberately tiny configured timeout. They will prove that:

- silence before response headers still triggers the configured timeout;
- after headers and one SSE chunk, a pause longer than the configured timeout
  does not abort either side;
- the later upstream suffix, including exactly one `message_stop`, arrives
  downstream byte-for-byte;
- concurrent streams retain the same behavior.

Claude settings tests will prove that configuration writes both 1,800,000 ms
values, backs up and restores existing values, does not replace the first
backup on repeated writes, preserves user changes made after configuration,
and removes only CC-Router-managed values.

Lifecycle tests will prove complete, aborted, and downstream-closed outcomes
without logging payload content. Existing byte-transparency, sticky routing,
lease, refresh, full Vitest, lint, and build checks must remain green.

## Local Rollout

After verification, the feature branch will be packed and force-installed into
the existing global pnpm package. The launch service will be restarted against
the newly installed store path. The existing account database, proxy secret,
client configuration, and unrelated Claude settings will be preserved.

Live validation must confirm the health endpoint, four configured accounts,
the managed 30-minute Claude settings, and the new lifecycle fields. Existing
Claude Code sessions must then be restarted to load the new environment.
