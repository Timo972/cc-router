# OpenAI Responses Request Validation & Stream Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/v1/responses` validate incoming requests against the ChatGPT Codex backend's real contract — reconcile non-streaming requests into a single JSON object, reject the one thing we cannot honor (`store: true`) with a `400`, and surface the silently-dropped `max_output_tokens` as an observable warning.

**Architecture:** All changes are additive at the `/v1/responses` ingress (`src/proxy/responses-server.ts`). A new pure module collapses the backend's forced SSE stream into a single Responses JSON object for non-streaming callers; the streaming passthrough path is untouched. Two request-contract advisories (`store: true` rejection, `max_output_tokens` drop) are recorded through a new `"warn"` activity type that is visually distinct on the status dashboard and never inflates error counters. The `toCodexBackendRequest` normalization and the cross-route `/v1/messages` path are not modified.

**Tech Stack:** TypeScript (ESM, strict), Express, Vitest 4.x, Ink/React (status dashboard), chalk (console logging). Node runtime; global `fetch`/`Response`/`ReadableStream`/`TextEncoder`/`TextDecoder`.

## Global Constraints

- ESM: every relative import ends in `.js` (e.g. `import { stats } from "./stats.js"`), even for `.ts` sources.
- Tests live in `src/__tests__/**/*.test.ts`, use Vitest globals (`describe`/`it`/`expect`/`vi`), and import source modules with `.js` extensions.
- Run the whole suite with `npm test` (`vitest run`). Run one file with `npx vitest run src/__tests__/<file>.test.ts`. Typecheck with `npm run lint` (`tsc --noEmit`).
- Coverage thresholds: lines 80 / functions 80 / branches 70. `src/ui/**`, `src/cli/**`, and `src/__tests__/**` are excluded from coverage.
- All behavior changes are scoped to `/v1/responses`. Do NOT change `toCodexBackendRequest` (its `stream:true` / `store:false` / cap-strip normalization stays), and do NOT change the cross-route `/v1/messages` path.
- Every `warn` activity entry uses `type: "warn"` and `accountId: "-"`. A `warn` never touches `totalErrors` or any aggregate counter (only `addLog` is called).
- Commit after each task with the shown message.

---

### Task 1: `warn` activity type + `logWarn` console channel

**Files:**
- Modify: `src/proxy/stats.ts:7` (extend the `LogEntry.type` union)
- Modify: `src/proxy/logger.ts` (add `logWarn`)
- Test: `src/__tests__/logger.test.ts` (create)

**Interfaces:**
- Produces: `LogEntry.type` now accepts `"warn"`. `logWarn(context: string, message: string): void` — a chalk-yellow console line prefixed `[<HH:MM:SS>] [WARN] <context>: <message>`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/logger.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../proxy/logger.js";

describe("logWarn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a single [WARN] line carrying the context and message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logWarn("responses", "max_output_tokens dropped");

    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("[WARN]");
    expect(line).toContain("responses");
    expect(line).toContain("max_output_tokens dropped");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/logger.test.ts`
Expected: FAIL — `logWarn` is not exported from `../proxy/logger.js`.

- [ ] **Step 3: Add `logWarn` to the logger**

In `src/proxy/logger.ts`, add this function immediately after `logError` (after line 27):

```ts
export function logWarn(context: string, message: string): void {
  console.log(chalk.yellow(`[${ts()}] [WARN] ${context}: ${message}`));
}
```

- [ ] **Step 4: Extend the `LogEntry.type` union**

In `src/proxy/stats.ts`, change line 7 from:

```ts
  type: "route" | "refresh" | "error";
```

to:

```ts
  type: "route" | "refresh" | "error" | "warn";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors (the widened union compiles).

- [ ] **Step 7: Commit**

```bash
git add src/proxy/logger.ts src/proxy/stats.ts src/__tests__/logger.test.ts
git commit -m "feat: add warn activity type and logWarn console channel"
```

---

### Task 2: `collectCodexResponseStream` — collapse SSE into one Responses object

**Files:**
- Create: `src/protocol/openai-responses-collect.ts`
- Test: `src/__tests__/openai-responses-collect.test.ts` (create)

**Interfaces:**
- Consumes: `parseSseLines(input: string): { events: unknown[]; remainder: string }` from `../protocol/sse.js` (existing — keeps only `data: ` lines, skips `[DONE]`, `JSON.parse`s each).
- Produces:
  ```ts
  export type CollectedCodexResponse =
    | { kind: "json"; status: number; body: unknown }
    | { kind: "text"; status: number; body: string };
  export function collectCodexResponseStream(upstream: globalThis.Response): Promise<CollectedCodexResponse>;
  ```
  Outcome mapping: non-2xx → `{ kind: "text", status, body: <text> }`; 2xx `application/json` → `{ kind: "json", status, body: <parsed> }`; 2xx SSE with terminal `response.completed` → `{ kind: "json", status, body: <verbatim .response> }`; 2xx SSE ending without `response.completed` or emitting `response.failed`/`error` → `{ kind: "json", status: 502, body: { error: { type: "upstream_error", message } } }`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/openai-responses-collect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectCodexResponseStream } from "../protocol/openai-responses-collect.js";

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream as BodyInit, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

describe("collectCodexResponseStream", () => {
  it("returns the verbatim response.completed object as JSON", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[{"type":"message"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 200,
      body: {
        id: "resp_1",
        model: "gpt-5.5",
        output: [{ type: "message" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  });

  it("passes a genuine application/json 200 body straight through", async () => {
    const upstream = new Response(JSON.stringify({ id: "resp_json" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({ kind: "json", status: 200, body: { id: "resp_json" } });
  });

  it("passes a non-2xx upstream through as text with its status", async () => {
    const upstream = new Response("rate limited", {
      status: 429,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({ kind: "text", status: 429, body: "rate limited" });
  });

  it("maps a stream that never completes to a 502 upstream_error", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "Stream ended before response.completed" } },
    });
  });

  it("maps a response.failed event to a 502 upstream_error carrying its message", async () => {
    const upstream = sseResponse([
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    ]);

    const result = await collectCodexResponseStream(upstream);

    expect(result).toEqual({
      kind: "json",
      status: 502,
      body: { error: { type: "upstream_error", message: "boom" } },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/openai-responses-collect.test.ts`
Expected: FAIL — module `../protocol/openai-responses-collect.js` does not exist.

- [ ] **Step 3: Implement the collector**

Create `src/protocol/openai-responses-collect.ts`:

```ts
import { parseSseLines } from "./sse.js";

export type CollectedCodexResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; body: string };

interface CodexStreamEvent {
  type?: string;
  response?: unknown;
  error?: { message?: string };
}

function upstreamError(message: string): CollectedCodexResponse {
  return { kind: "json", status: 502, body: { error: { type: "upstream_error", message } } };
}

/**
 * Collapse the Codex backend's forced SSE stream into a single Responses
 * object for callers that did not ask to stream. The backend's terminal
 * `response.completed` payload is returned verbatim, preserving tool calls,
 * reasoning, and usage.
 */
export async function collectCodexResponseStream(
  upstream: globalThis.Response,
): Promise<CollectedCodexResponse> {
  if (!upstream.ok) {
    return { kind: "text", status: upstream.status, body: await upstream.text() };
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return { kind: "json", status: upstream.status, body: await upstream.json() };
  }

  const reader = upstream.body?.getReader();
  if (!reader) return upstreamError("Empty upstream body");

  const decoder = new TextDecoder();
  let remainder = "";
  let completed: unknown | undefined;
  let failure: string | undefined;

  const applyEvent = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const e = event as CodexStreamEvent;
    if (e.type === "response.completed") {
      completed = e.response;
    } else if (e.type === "response.failed") {
      const err = (e.response as { error?: { message?: string } } | undefined)?.error;
      failure = err?.message ?? "Response failed";
    } else if (e.type === "error") {
      failure = e.error?.message ?? "Upstream error event";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSseLines(remainder + decoder.decode(value, { stream: true }));
    remainder = parsed.remainder;
    for (const event of parsed.events) applyEvent(event);
  }
  const tail = remainder + decoder.decode();
  if (tail.length > 0) {
    for (const event of parseSseLines(tail + "\n").events) applyEvent(event);
  }

  if (failure !== undefined) return upstreamError(failure);
  if (completed === undefined) return upstreamError("Stream ended before response.completed");
  return { kind: "json", status: upstream.status, body: completed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/openai-responses-collect.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/openai-responses-collect.ts src/__tests__/openai-responses-collect.test.ts
git commit -m "feat: add collectCodexResponseStream to reconcile Codex SSE into JSON"
```

---

### Task 3: Reject explicit `store: true` + `recordActivity` DI

**Files:**
- Modify: `src/proxy/responses-server.ts` (imports, `recordActivity` option, `store:true` rejection)
- Test: `src/__tests__/responses-server.test.ts` (add a `withServer` helper + one test)

**Interfaces:**
- Consumes: `LogEntry` and `stats` from `./stats.js` (Task 1's widened union); `logWarn` from `./logger.js` (Task 1).
- Produces: `ResponsesRoutesOptions.recordActivity?: (entry: LogEntry) => void` — defaults to `(entry) => stats.addLog(entry)`; injectable so tests can spy on activity writes. A local test helper `withServer(app, fn)` (defined in this task's test) that binds an ephemeral port, hands `fn` the base URL, and always closes the server — reused by Tasks 4 and 5.

- [ ] **Step 1: Write the failing test**

At the top of `src/__tests__/responses-server.test.ts`, add this helper immediately after the existing `import` lines (after line 6). It is used by the new tests in this task and in Tasks 4–5 (leave the four existing tests, which inline their own boilerplate, unchanged):

```ts
async function withServer(
  app: ReturnType<typeof express>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}
```

Then add this test inside the existing `describe("mountResponsesRoutes", ...)` block:

```ts
it("rejects an explicit store:true with 400 and records exactly one warn entry", async () => {
  const record = vi.fn();
  const forward = vi.fn();
  const app = express();

  mountResponsesRoutes(app, {
    getOpenAIAccount: () => ({
      id: "openai-victor",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    }),
    forwardOpenAI: forward,
    recordActivity: record,
  });

  await withServer(app, async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [], store: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("store:true"),
      },
    });
    expect(forward).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warn", statusCode: 400, accountId: "-" }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "store:true"`
Expected: FAIL — `recordActivity` is not a known option and `store:true` is currently forwarded (no 400).

- [ ] **Step 3: Add imports to the handler**

In `src/proxy/responses-server.ts`, add these imports after the existing import block (after line 7):

```ts
import { stats } from "./stats.js";
import type { LogEntry } from "./stats.js";
import { logWarn } from "./logger.js";
```

- [ ] **Step 4: Add the `recordActivity` option**

In `ResponsesRoutesOptions` (lines 11–16), add one field:

```ts
  recordActivity?: (entry: LogEntry) => void;
```

- [ ] **Step 5: Resolve the option and add the `store:true` rejection**

In `mountResponsesRoutes`, after the existing `prepareOpenAIAccount` default (line 56), add:

```ts
  const recordActivity = opts.recordActivity ?? ((entry: LogEntry) => stats.addLog(entry));
```

Then, inside the handler, immediately after the `isResponsesRequest` guard block (after line 67, before `selectRoute`), add:

```ts
    if (req.body.store === true) {
      recordActivity({
        ts: Date.now(),
        accountId: "-",
        model: req.body.model,
        type: "warn",
        statusCode: 400,
        details: "store:true rejected — Codex backend is stateless (store:false only)",
      });
      logWarn("responses", "store:true is not supported by the Codex backend; rejecting request");
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "store:true is not supported: the Codex subscription backend operates only in stateless (store:false) mode.",
        },
      });
      return;
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "store:true"`
Expected: PASS.

- [ ] **Step 7: Run the whole responses-server file to confirm no regressions**

Run: `npx vitest run src/__tests__/responses-server.test.ts`
Expected: PASS (the four pre-existing tests still pass — they send `store` unset).

- [ ] **Step 8: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/proxy/responses-server.ts src/__tests__/responses-server.test.ts
git commit -m "feat: reject store:true on /v1/responses with an activity warning"
```

---

### Task 4: Warn on dropped `max_output_tokens`

**Files:**
- Modify: `src/proxy/responses-server.ts` (add the `max_output_tokens` warn)
- Test: `src/__tests__/responses-server.test.ts` (add one test)

**Interfaces:**
- Consumes: `recordActivity` option and `logWarn` (Task 3); `withServer` helper (Task 3).
- Produces: nothing new. Note: the transport-level strip is already asserted by the existing `describe("toCodexBackendRequest")` test at `src/__tests__/responses-server.test.ts:67` — do NOT re-assert it here. An injected `forwardOpenAI` bypasses `toCodexBackendRequest`, so the handler receives the body with `max_output_tokens` still present; the handler only warns and forwards, it does not strip.

- [ ] **Step 1: Write the failing test**

Add this test inside `describe("mountResponsesRoutes", ...)`:

```ts
it("warns on an explicit max_output_tokens, then forwards and reconciles", async () => {
  const record = vi.fn();
  const forward = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "resp_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const app = express();

  mountResponsesRoutes(app, {
    getOpenAIAccount: () => ({
      id: "openai-victor",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      enabled: true,
    }),
    forwardOpenAI: forward,
    recordActivity: record,
  });

  await withServer(app, async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [], max_output_tokens: 256 }),
    });

    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        accountId: "-",
        details: expect.stringContaining("max_output_tokens"),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "max_output_tokens"`
Expected: FAIL — no `warn` entry is recorded (`record` called 0 times).

- [ ] **Step 3: Add the `max_output_tokens` warn**

In `src/proxy/responses-server.ts`, immediately after the `store:true` rejection block added in Task 3 (still before `selectRoute`), add:

```ts
    if (req.body.max_output_tokens !== undefined) {
      recordActivity({
        ts: Date.now(),
        accountId: "-",
        model: req.body.model,
        type: "warn",
        details: "max_output_tokens ignored — unsupported by the Codex backend",
      });
      logWarn("responses", "max_output_tokens is unsupported by the Codex backend and was dropped");
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "max_output_tokens"`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/responses-server.ts src/__tests__/responses-server.test.ts
git commit -m "feat: warn when max_output_tokens is dropped on /v1/responses"
```

---

### Task 5: Reconcile `stream: false` into a JSON body

**Files:**
- Modify: `src/proxy/responses-server.ts` (import the collector; branch the response handling)
- Test: `src/__tests__/responses-server.test.ts` (add two tests)

**Interfaces:**
- Consumes: `collectCodexResponseStream` / `CollectedCodexResponse` from `../protocol/openai-responses-collect.js` (Task 2); `withServer` helper (Task 3).
- Produces: nothing new. After this task, a request with `stream !== true` receives `application/json` (reconciled) or `text/plain` (non-2xx passthrough); `stream: true` still streams SSE unchanged.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside `describe("mountResponsesRoutes", ...)`:

```ts
it("reconciles a non-streaming request into a single JSON body", async () => {
  const app = express();

  mountResponsesRoutes(app, {
    getOpenAIAccount: () => ({
      id: "openai-victor",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    }),
    forwardOpenAI: async () => new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","output":[]}}\n\n'));
          controller.close();
        },
      }) as BodyInit,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  await withServer(app, async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "resp_1", model: "gpt-5.5", output: [] });
  });
});

it("passes a non-2xx upstream through as text on the non-streaming path", async () => {
  const app = express();

  mountResponsesRoutes(app, {
    getOpenAIAccount: () => ({
      id: "openai-victor",
      provider: "openai_subscription",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      enabled: true,
    }),
    forwardOpenAI: async () => new Response("upstream boom", {
      status: 429,
      headers: { "content-type": "text/event-stream" },
    }),
  });

  await withServer(app, async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", input: [] }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("upstream boom");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "non-streaming"`
Expected: FAIL — the current handler pipes raw SSE bytes back, so the reconcile test gets `text/event-stream` (not JSON) and `res.json()` throws; the non-2xx test gets `text/event-stream` instead of `text/plain`.

- [ ] **Step 3: Import the collector**

In `src/proxy/responses-server.ts`, add to the import block (near the other `../protocol/...` import at line 5):

```ts
import { collectCodexResponseStream } from "../protocol/openai-responses-collect.js";
```

- [ ] **Step 4: Branch the response handling**

Replace the current tail of the handler (lines 106–111):

```ts
    const upstream = await forwardOpenAI({
      account,
      body,
      stream: body.stream === true,
    });
    await sendUpstreamResponse(upstream, res);
```

with:

```ts
    const upstream = await forwardOpenAI({
      account,
      body,
      stream: body.stream === true,
    });

    if (body.stream === true) {
      await sendUpstreamResponse(upstream, res);
      return;
    }

    const collected = await collectCodexResponseStream(upstream);
    if (collected.kind === "json") {
      res.status(collected.status).json(collected.body);
    } else {
      res.status(collected.status).type("text/plain").send(collected.body);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/responses-server.test.ts -t "non-streaming"`
Expected: PASS.

- [ ] **Step 6: Run the whole file to confirm the streaming passthrough still works**

Run: `npx vitest run src/__tests__/responses-server.test.ts`
Expected: PASS — including the existing `"streams upstream Responses SSE chunks without waiting for the full body"` test (`stream: true` still hits `sendUpstreamResponse`) and the three existing JSON-upstream tests (now reconciled through the collector's `application/json` fast-path, unchanged results).

- [ ] **Step 7: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/responses-server.ts src/__tests__/responses-server.test.ts
git commit -m "feat: reconcile non-streaming /v1/responses requests into JSON"
```

---

### Task 6: Render `warn` rows on the status dashboard

**Files:**
- Modify: `src/ui/Dashboard.tsx:1085-1088` (LogRow color/glyph), `src/ui/Dashboard.tsx:1155` and `:1167` (DetailPanel title color)
- Test: `src/__tests__/dashboard-rendering.test.ts` (add one render test)

**Interfaces:**
- Consumes: `LogEntry.type === "warn"` (Task 1).
- Produces: `warn` log rows render with a yellow `⚠` glyph; the row's generic type label (`log.type.padEnd(9)` at line 1126) and the detail panel's `Type` field (`value={log.type}` at line 1180) already print `"warn"` unchanged, so only the color/glyph ternaries need extending.

Note: `src/ui/**` is excluded from coverage, so this test is for behavioral confidence, not coverage. The `Dashboard` component renders its recent-activity log feed on mount (the existing test asserts on rendered account rows via the same harness), so a `warn` entry in `recentLogs` renders on first paint.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/dashboard-rendering.test.ts`, add this test inside the existing `describe("Dashboard rendering", ...)` block. It reuses the same Ink harness as the existing test but injects one `warn` log:

```ts
it("renders a warn activity row with the warn glyph and details", async () => {
  const health = {
    status: "ok",
    mode: "direct",
    target: "chatgpt.com",
    uptime: 60_000,
    totalRequests: 0,
    totalErrors: 0,
    totalRefreshes: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    operational: {
      auth: { required: false },
      providers: {
        anthropic: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
        openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: { anthropicAliases: [], openAIAliases: [] },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: true,
        crossProviderMessages: false,
        dynamicModels: true,
        accountManagement: true,
      },
    },
    accounts: [],
    recentLogs: [{
      ts: 1,
      accountId: "-",
      model: "gpt-5.5",
      type: "warn",
      details: "max_output_tokens ignored — unsupported by the Codex backend",
    }],
  };

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));

  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  }) as unknown as NodeJS.ReadStream;
  const stdout = Object.assign(new PassThrough(), {
    columns: 240,
    rows: 100,
  }) as unknown as NodeJS.WriteStream;
  const stderr = Object.assign(new PassThrough(), {
    columns: 240,
    rows: 100,
  }) as unknown as NodeJS.WriteStream;
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });

  const instance = render(
    React.createElement(Dashboard, { port: 3456 }),
    { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const exitResult = instance.waitUntilExit().then(
    () => ({ kind: "exit" as const }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  try {
    const rendered = vi.waitFor(
      () => {
        expect(output).toContain("⚠");
        expect(output).toContain("max_output_tokens ignored");
      },
      { timeout: 1_000, interval: 10 },
    ).then(() => ({ kind: "rendered" as const }));

    const outcome = await Promise.race([rendered, exitResult]);
    if (outcome.kind === "error") throw outcome.error;
    expect(outcome.kind).toBe("rendered");
  } finally {
    instance.unmount();
    await exitResult;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/dashboard-rendering.test.ts -t "warn activity row"`
Expected: FAIL — the `⚠` glyph is not emitted; a `warn` row currently falls through to the `→` gray default in `LogRow`.

- [ ] **Step 3: Extend the LogRow color/glyph**

In `src/ui/Dashboard.tsx`, replace lines 1085–1088:

```tsx
  const isError = log.type === "error";
  const isRefresh = log.type === "refresh";
  const typeColor = isError ? "red" : isRefresh ? "yellow" : "gray";
  const typeIcon = isError ? "✗" : isRefresh ? "↻" : "→";
```

with:

```tsx
  const isError = log.type === "error";
  const isRefresh = log.type === "refresh";
  const isWarn = log.type === "warn";
  const typeColor = isError ? "red" : isWarn ? "yellow" : isRefresh ? "yellow" : "gray";
  const typeIcon = isError ? "✗" : isWarn ? "⚠" : isRefresh ? "↻" : "→";
```

- [ ] **Step 4: Extend the DetailPanel title color**

In `src/ui/Dashboard.tsx`, replace line 1155:

```tsx
  const isError = log.type === "error";
```

with:

```tsx
  const isError = log.type === "error";
  const isWarn = log.type === "warn";
```

Then replace line 1167:

```tsx
      <Text bold color={isError ? "red" : "cyan"}> DETAILS </Text>
```

with:

```tsx
      <Text bold color={isError ? "red" : isWarn ? "yellow" : "cyan"}> DETAILS </Text>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/dashboard-rendering.test.ts -t "warn activity row"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Dashboard.tsx src/__tests__/dashboard-rendering.test.ts
git commit -m "feat: render warn activity rows on the status dashboard"
```

---

## Final Verification

- [ ] Run the full suite: `npm test` — all tests pass.
- [ ] Typecheck: `npm run lint` — no errors.
- [ ] Confirm no regression in the cross-route `/v1/messages` tests (they emit no `warn` entries and are untouched).
