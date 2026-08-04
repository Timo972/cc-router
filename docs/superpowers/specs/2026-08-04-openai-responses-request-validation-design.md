# OpenAI Responses Request Validation & Stream Reconciliation Design

## Problem

The `/v1/responses` ingress forwards to the ChatGPT Codex backend
(`https://chatgpt.com/backend-api/codex/responses`), which is SSE-only and
operates statelessly. To satisfy that contract, `toCodexBackendRequest`
(`src/providers/openai/codex-transport.ts`) unconditionally rewrites every
request: it forces `stream: true`, forces `store: false`, and strips
`max_output_tokens`. The transport then always returns a `text/event-stream`
body — `ensureEventStreamContentType` even relabels the content-type on error
responses.

The `/v1/responses` handler (`src/proxy/responses-server.ts`) pipes those SSE
bytes straight back to the caller via `sendUpstreamResponse`, regardless of
what the caller asked for. This produces three silent behaviors that a client
cannot see or control:

1. A client that posts `stream: false` (the public Responses API default) still
   receives an SSE byte stream it cannot parse. There is no reconciliation on
   this path, unlike the cross-route `/v1/messages` path, which already
   collapses a forced SSE stream back into a single JSON body for
   non-streaming callers (`collectOpenAIStreamAsAnthropicMessage`).
2. A client that sets `store: true` — expecting server-side response retrieval
   by id — has it silently flipped to `false`. We cannot honor `store: true`;
   the backend does not persist responses in subscription mode.
3. A client that sets `max_output_tokens` has its output cap silently dropped.
   The response can therefore exceed the requested bound with no signal.

The intended and realistic client of `/v1/responses` is the Codex CLI, which
always streams, never sets `store: true`, and does not send
`max_output_tokens`. None of the above bites Codex today. This work hardens the
path for correctness and transparency toward any other Responses client, and
makes the one thing we truly cannot honor (`store: true`) an explicit error
rather than a silent rewrite.

## Goals

- Serve non-streaming `/v1/responses` requests correctly: when a caller does
  not request streaming, return a single JSON Responses object instead of raw
  SSE bytes.
- Reject an explicit `store: true` with `400`, because the Codex backend cannot
  provide server-side response storage.
- Keep dropping an unsupported `max_output_tokens`, but surface each drop as a
  warning in both the console log and the status-dashboard activity feed, so
  the ignored cap is observable.
- Introduce a distinct `warn` activity type so advisories are visually separate
  from routing errors on the dashboard.
- Preserve existing behavior for streaming `/v1/responses` callers (Codex CLI)
  and for the cross-route `/v1/messages` path.

## Non-Goals

- Sticky session routing, shared-account limits, and per-model limits for the
  OpenAI provider. These remain deferred and are tracked separately.
- Changing the cross-route `/v1/messages` translation or its handling of the
  always-present, translated Anthropic `max_tokens` cap.
- Changing the `store: false` / `stream: true` normalization inside
  `toCodexBackendRequest`; it remains the single enforcement point for the
  backend contract.
- Any change to account selection, token refresh, or the round-robin picker.

## Request Validation and Normalization Boundary

The three rewrites are not equivalent, and the design treats them by severity:

- **`stream`** — forcing it produces unusable output for a non-streaming
  client. It is reconciled (Change 1), not rejected: the request is
  serviceable, so the router absorbs the backend's SSE-only constraint rather
  than failing the call.
- **`store: true`** — genuinely impossible to honor. It becomes an explicit
  `400` (Change 2). Only an explicit `true` is rejected; an omitted `store` is
  not a client request and is still normalized to `false` silently.
- **`max_output_tokens`** — a near-ubiquitous field whose drop yields a
  possibly-longer, not broken, response. It is kept as a silent normalization
  at the transport, but the responses handler emits an observable warning when
  the client set it explicitly (Change 3). Hard-rejecting it would be
  user-hostile.

All three changes are scoped to `/v1/responses`. The cross-route
`/v1/messages` path is unaffected: an Anthropic Messages request carries no
`store` field, and its `max_output_tokens` is the required, translated
Anthropic `max_tokens` (`anthropicToOpenAIResponses` sets
`max_output_tokens: req.max_tokens`). Warning on that translated cap would fire
on 100% of Claude traffic, so it stays silent.

## Change 1 — Reconcile `stream: false` into a JSON Responses object

The `/v1/responses` handler branches on `req.body.stream === true`:

- `true` → forward and pipe the SSE body unchanged, exactly as today
  (`sendUpstreamResponse`). The Codex CLI path is untouched.
- `false` or omitted → forward (the transport still forces `stream: true`
  upstream), then collect the SSE stream into a single JSON body and return it
  with `content-type: application/json`.

A new module `src/protocol/openai-responses-collect.ts` exports
`collectCodexResponseStream(upstream)`. It:

- Reads the upstream body and parses SSE events with the existing
  `parseSseLines` (`src/protocol/sse.ts`).
- Captures the terminal `response.completed` event's `.response` object
  **verbatim** and returns it as the response body. Passing the backend's own
  object through preserves tool calls, reasoning, and usage without lossy
  reconstruction. (This differs deliberately from the cross-route collector,
  which must additionally translate to an Anthropic message and so
  reconstructs a minimal shape.)
- Watches for `response.failed` and error events.
- Returns a `CollectedCodexResponse`, a two-variant discriminated union on
  `kind` that the handler mirrors directly:
  - `{ kind: "json", status, body }` → handler sends `res.status(status).json(body)`.
  - `{ kind: "text", status, body }` → handler sends
    `res.status(status).type("text/plain").send(body)`.

The collector maps upstream outcomes to those variants:

- upstream **not** 2xx → `{ kind: "text", status: <upstream>, body: <upstream text> }`.
  The true content-type was clobbered to `text/event-stream` upstream, so the
  body is read as text and returned as `text/plain` rather than parsed.
- upstream 2xx with an `application/json` body →
  `{ kind: "json", status: 200, body: <parsed JSON> }`. This handles a genuine
  JSON 200 and keeps the existing non-SSE handler tests (model-prefix strip,
  aliases, refresh) valid.
- upstream 2xx SSE with a terminal `response.completed` →
  `{ kind: "json", status: 200, body: <verbatim .response> }`.
- upstream 2xx SSE that ends with no `response.completed`, or emits
  `response.failed` / `error` →
  `{ kind: "json", status: 502, body: { error: { type: "upstream_error", message } } }`.

Content-type is consulted only to distinguish a genuine JSON 200 from an SSE
200. That is safe because `ensureEventStreamContentType` only ever *adds* an
event-stream label (it never mislabels a real SSE stream as JSON), and the
dangerous case — a clobbered non-2xx error mislabeled as event-stream — is
handled first by the not-ok branch.

`ensureEventStreamContentType` is left unchanged; the streaming passthrough
path still relies on it. Only the reconcile path bypasses content-type.

## Change 2 — Reject an explicit `store: true`

In the `/v1/responses` handler, after the `isResponsesRequest` shape check and
before account selection (this is a pure request-validity check that needs no
account), if `req.body.store === true` the handler responds:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "store:true is not supported: the Codex subscription backend operates only in stateless (store:false) mode."
  }
}
```

with HTTP `400`. An omitted or `false` `store` proceeds untouched; the
transport continues to normalize it to `false`.

The rejection also records one `warn` activity entry (see Change 4) —
`accountId: "-"`, `statusCode: 400`, a `details` string naming the reason — and
a console warning. It is recorded as a `warn`, not an `error`, because it is an
expected client-contract rejection rather than a routing or upstream failure,
and should not inflate error counts or the error feed.

## Change 3 — Warn on dropped `max_output_tokens`

The strip stays where it is, centralized in `toCodexBackendRequest`. In the
`/v1/responses` handler, after validation, if
`req.body.max_output_tokens !== undefined`, the handler emits one `warn`
(console + activity) stating that `max_output_tokens` is unsupported by the
Codex backend and was ignored, then forwards the request normally.

This fires only on the responses path and only when the client set the field
explicitly. The cross-route path stays silent, as established in the validation
boundary section.

## Change 4 — A `warn` activity type

`src/proxy/stats.ts` extends the `LogEntry.type` union from
`"route" | "refresh" | "error"` to
`"route" | "refresh" | "error" | "warn"`. Both advisories above write through
the existing `stats.addLog(...)` singleton with `type: "warn"`,
`accountId: "-"`, and a `details` string (plus `statusCode: 400` for the
`store` rejection). Aggregate counters (`totalErrors`, etc.) are not touched by
`warn` entries.

`src/ui/Dashboard.tsx` renders `warn` rows with their own color (yellow),
including any type legend and detail-panel handling that currently switches on
`LogEntry.type`.

`src/proxy/logger.ts` gains a small `logWarn(context, message)` chalk-yellow
console wrapper, parallel to the existing `logError`, so the console side has a
single consistent warning channel instead of ad-hoc `console.warn`.

`src/proxy/responses-server.ts` does not import `stats` today; this work adds
`import { stats } from "./stats.js"` (same directory) and the `logWarn` import,
since nothing in the OpenAI Responses path currently writes to the activity
feed.

## Data Flow

```text
POST /v1/responses
  -> isResponsesRequest shape check (400 on malformed)
  -> store === true ? -> 400 invalid_request_error + warn activity  [Change 2]
  -> max_output_tokens set ? -> warn activity + console warn         [Change 3]
  -> select route / account / prepare token (unchanged)
  -> forwardOpenAI (transport forces stream:true, store:false, strips cap)
  -> stream === true ?
       yes -> sendUpstreamResponse (SSE passthrough, unchanged)
       no  -> collectCodexResponseStream(upstream)                   [Change 1]
                ok  -> 200 application/json (verbatim response object)
                !ok -> passthrough non-2xx, or 502 upstream_error
```

## Testing

- **Collector unit tests** (`openai-responses-collect`): an SSE fixture with
  `response.created` + `response.output_text.delta` + `response.completed`
  returns the verbatim completed `.response`; a stream that ends with no
  completed event returns `ok: false` mapped to `502`; a non-2xx upstream is
  passed through with its status and body.
- **Handler tests** (`responses-server`): `stream` omitted returns a JSON body
  with `content-type: application/json`; `stream: true` still yields an SSE
  passthrough unchanged; `store: true` returns `400` and records exactly one
  `warn` activity entry; an explicit `max_output_tokens` still forwards and
  succeeds, the cap is absent in the upstream request body, and exactly one
  `warn` entry is recorded. Assertions spy on `stats.addLog`.
- **Regression:** existing cross-route `/v1/messages` tests emit no new `warn`
  entries, and existing streaming and byte-transparency behavior stays green.
  Full Vitest, lint, and build must pass.

## Files Touched

- `src/proxy/responses-server.ts` — `store: true` rejection, `max_output_tokens`
  warning, and the `stream: false` reconcile branch; new `stats`/`logWarn`
  imports.
- `src/protocol/openai-responses-collect.ts` — new `collectCodexResponseStream`.
- `src/proxy/stats.ts` — add `"warn"` to the `LogEntry.type` union.
- `src/ui/Dashboard.tsx` — render `warn` rows.
- `src/proxy/logger.ts` — add `logWarn`.
- Tests alongside the collector and the responses handler.
