# Concurrent SSE Terminal Guard Design

## Problem

CC-Router forwards Anthropic Messages SSE responses transparently. It records a
request as successful as soon as upstream response headers arrive, but it does
not verify that the SSE body contains the required terminal `message_stop`
event.

The affected machine shows repeated responses that deliver content and a
terminal `message_delta` with `stop_reason`, then produce no further event.
Claude Code waits for `message_stop` and reports `Response stalled mid-stream`
at its five-minute watchdog boundary. Multiple concurrent sessions expose the
failure more frequently. Raising the timeout would only delay the same error.

## Chosen Approach

Add a streaming terminal-event guard to the existing Anthropic proxy response
path. It will observe SSE bytes while preserving immediate passthrough and keep
independent state for every response.

For each successful Anthropic SSE response, the guard will:

1. Parse event frames incrementally across arbitrary chunk boundaries.
2. Remember whether it has seen a terminal `message_delta` with a non-null
   `stop_reason` and whether it has seen `message_stop`.
3. Forward every upstream byte immediately and unchanged.
4. When a terminal `message_delta` arrives, allow a short one-second grace
   period for the normal `message_stop`. If it does not arrive, append a
   canonical `message_stop` SSE frame, end the downstream response, and release
   the stalled upstream stream.
5. If upstream ends before the grace timer after a terminal `message_delta`,
   append `message_stop` before ending the downstream response.
6. If upstream ends without either terminal signal, do not fabricate success;
   record the stream as incomplete and let the downstream client handle the
   truncated response.

The repair is intentionally narrow: a terminal `message_delta` proves that the
model finished and that only the protocol terminator is missing. The router
will not invent content, stop reasons, tool results, or successful completion
for an otherwise incomplete response.

## Integration

The guard will be a small, independently tested stream component rather than
additional ad hoc listeners inside `server.ts`. The Anthropic proxy will use it
only for successful `text/event-stream` responses. JSON responses, compressed
responses, OpenAI routes, and error status bodies retain their current paths.

Existing token-usage accounting will continue to observe the stream. Stream
completion will update the pending request log after the body finishes, so an
HTTP 200 with a truncated body is no longer indistinguishable from a complete
response.

Each guard instance owns its parser buffer and terminal flags. There is no
module-level stream state, so concurrent requests cannot affect one another.

## Error Handling

- Complete stream: forward unchanged and record normal completion.
- Terminal delta without `message_stop`: wait up to one second, append
  `message_stop`, record that the terminator was repaired, and end normally.
- Truncated before a terminal delta: forward what was received, mark the log as
  an incomplete-stream error, and do not claim completion.
- Upstream stream error: preserve the existing proxy error behavior and mark
  the request log with the connection error.
- Client disconnect: stop forwarding and release listeners/state without
  attempting a repair for a client that is no longer present.

## Testing

Regression tests will cover:

- A complete SSE stream remains byte-for-byte unchanged.
- A terminal `message_delta` followed by either EOF or silence receives exactly
  one synthesized `message_stop`.
- A stream already containing `message_stop` never receives a duplicate.
- SSE frames split across chunks are parsed correctly.
- A stream ending before any terminal delta is reported as incomplete and is
  not repaired.
- Several concurrent streams maintain isolated state, including a mixture of
  complete, repairable, and genuinely truncated responses.
- The focused tests, full Vitest suite, typecheck, and build all pass.

## Out of Scope

- Retrying or failing over a response after partial content has reached the
  client.
- Buffering full model responses.
- Changing account selection or rate-limit policy.
- Increasing timeouts as the primary fix.
