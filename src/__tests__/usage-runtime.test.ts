import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUsageRuntime } from "../usage/runtime.js";
import { UsageStore } from "../usage/store.js";
import { applyAnthropicInputUsage, applyAnthropicOutputUsage, applyCodexUsage, setUsageModel, finishUsageAttempt, stats, type LogEntry } from "../proxy/stats.js";
const dirs: string[] = [];
const runtimes: ReturnType<typeof startUsageRuntime>[] = [];
const directory = () => { const d = mkdtempSync(join(tmpdir(), "usage-runtime-")); dirs.push(d); return d; };
const entry = (): LogEntry => ({ ts: Date.now(), accountId: "work", model: "requested-alias", type: "route" });
function runtime(dir = directory(), options = {}) { const r = startUsageRuntime(dir, [{ id: "work", provider: "openai_subscription" }, { id: "claude", provider: "anthropic_subscription" }], options); runtimes.push(r); return r; }
afterEach(() => { runtimes.splice(0).forEach(r => r.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.useRealTimers(); });
describe("persistent usage runtime", () => {
  it.each(["transition recovery", "account reconciliation"] as const)(
    "releases the usage writer when %s fails during initialization",
    failure => {
      const dir = directory();
      if (failure === "transition recovery") {
        const seed = UsageStore.open(dir);
        seed.account("openai_subscription", "old");
        seed.close();
        writeFileSync(join(dir, "account-transition.json"), JSON.stringify({
          version: 1,
          before: [{ id: "old", provider: "openai_subscription" }],
          after: [{ id: "new", provider: "openai_subscription" }],
          rename: { oldId: "old", newId: "new" },
        }));
      }
      const accounts = failure === "transition recovery"
        ? [{ id: "unexpected", provider: "openai_subscription" as const }]
        : [{ id: "invalid\nalias", provider: "openai_subscription" as const }];

      const failedRuntime = startUsageRuntime(dir, accounts);
      runtimes.push(failedRuntime);
      expect(() => failedRuntime.snapshot()).toThrow(/unavailable/i);

      expect(() => {
        const next = UsageStore.open(dir);
        next.close();
      }).not.toThrow();
    },
  );

  it("deduplicates cumulative OpenAI callbacks and finalizes only at settlement", () => {
    const r = runtime(); const e = entry(); r.bind(e, "openai_subscription"); setUsageModel(e, "gpt-5.2");
    applyCodexUsage(e, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 8 });
    applyCodexUsage(e, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 8 });
    expect(r.snapshot().observations).toHaveLength(1);
    expect(r.snapshot().observations[0]).toMatchObject({ complete: false, model: "gpt-5.2", tokens: { input: 40, cacheRead: 60, output: 8 } });
    finishUsageAttempt(e, true); finishUsageAttempt(e, true);
    expect(r.snapshot().observations[0]?.complete).toBe(true);
    expect(r.report({ period: "day" }).totals.input).toBe(40);
  });
  it("binds identity before rename and preserves split Anthropic duration usage on abort", () => {
    const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
    const key = r.snapshot().accounts.find(a => a.alias === "claude")!.key;
    r.rename("anthropic_subscription", "claude", "renamed"); e.accountId = "renamed";
    setUsageModel(e, "claude-sonnet-4-6");
    applyAnthropicInputUsage(e, { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } });
    finishUsageAttempt(e, false);
    expect(r.snapshot().observations[0]).toMatchObject({ accountKey: key, complete: false, tokens: { input: 10, output: 0, cacheWrite: 7, cacheWrite5m: 3, cacheWrite1h: 4 } });
  });
  it("keeps missing usage and output unknown, rather than inventing a completed zero", () => {
    const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
    applyAnthropicInputUsage(e, { input_tokens: 10 }); finishUsageAttempt(e, true);
    expect(r.snapshot().observations[0]).toMatchObject({ complete: false, model: "unknown" });
    const empty = entry(); r.bind(empty, "openai_subscription"); finishUsageAttempt(empty, true);
    expect(r.snapshot().observations).toHaveLength(2);
    expect(r.snapshot().observations[1]?.complete).toBe(false);
  });
  it("combines split Anthropic callbacks into one complete observation", () => {
    const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
    setUsageModel(e, "claude-sonnet-4-6"); applyAnthropicInputUsage(e, { input_tokens: 3 }); applyAnthropicOutputUsage(e, { output_tokens: 2 }); finishUsageAttempt(e, true);
    expect(r.snapshot().observations).toHaveLength(1); expect(r.snapshot().observations[0]?.complete).toBe(true);
  });
  it("compacts completed attempts periodically and closes the writer", () => {
    vi.useFakeTimers(); const dir = directory(); const r = runtime(dir, { compactIntervalMs: 1000 }); const e = entry(); r.bind(e, "openai_subscription");
    applyCodexUsage(e, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 8 }); finishUsageAttempt(e, true);
    vi.advanceTimersByTime(1000); expect(r.snapshot().observations).toHaveLength(0); expect(r.snapshot().aggregates).toHaveLength(1);
    r.close(); const reopened = UsageStore.open(dir); reopened.close();
  });
  it("keeps routing callbacks safe when storage is unavailable", () => {
    const dir = directory(); writeFileSync(join(dir, "blocked"), "x"); const r = runtime(join(dir, "blocked")); const e = entry();
    expect(() => { r.bind(e, "openai_subscription"); applyCodexUsage(e, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }); finishUsageAttempt(e, true); }).not.toThrow();
    expect(() => r.snapshot()).toThrow(/unavailable/i);
  });
  it("surfaces malformed pricing and never silently uses catalog prices", () => {
    const dir = directory(); writeFileSync(join(dir, "pricing.json"), "oops"); const r = runtime(dir); const e = entry(); r.bind(e, "openai_subscription"); setUsageModel(e, "gpt-5.2");
    applyCodexUsage(e, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 1 });
    expect(r.snapshot().observations[0]?.rates).toBeUndefined(); expect(r.snapshot().warnings.join(" ")).toMatch(/pricing/i);
  });
});

it("captures actual Anthropic model, nested cache duration and terminal completeness from compressed bytes", async () => {
  const { attachAnthropicResponseCapture } = await import("../proxy/anthropic-response-capture.js");
  const { EventEmitter } = await import("node:events"); const { gzipSync } = await import("node:zlib");
  const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  const upstream = Object.assign(new EventEmitter(), { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } });
  const downstream = new EventEmitter(); attachAnthropicResponseCapture(upstream, downstream, e, Date.now());
  const bytes = gzipSync(Buffer.from([
    { type: "message_start", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, cache_creation_input_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 4 } } } },
    { type: "message_delta", usage: { output_tokens: 9 } }, { type: "message_stop" },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join("")));
  for (let i = 0; i < bytes.length; i += 7) upstream.emit("data", bytes.subarray(i, i + 7)); upstream.emit("end");
  await vi.waitFor(() => expect(r.snapshot().observations[0]).toMatchObject({ complete: true, model: "claude-sonnet-4-6", tokens: { input: 10, output: 9, cacheWrite1h: 4 } }));
});
it("settles a truncated Anthropic stream as partial with its observed input", async () => {
  const { attachAnthropicResponseCapture } = await import("../proxy/anthropic-response-capture.js"); const { EventEmitter } = await import("node:events");
  const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  const upstream = Object.assign(new EventEmitter(), { headers: { "content-type": "text/event-stream" } });
  attachAnthropicResponseCapture(upstream, new EventEmitter(), e, Date.now());
  upstream.emit("data", Buffer.from('data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":4}}}\n\n')); upstream.emit("close");
  expect(r.snapshot().observations[0]).toMatchObject({ complete: false, model: "claude-sonnet-4-6", tokens: { input: 4 } });
});

it.each(["responses-json", "responses-stream", "messages-json", "messages-stream", "responses-stream-json", "responses-refresh-failed"])("captures actual OpenAI usage through %s with identity fixed before prepare awaits", async (mode) => {
  const express = (await import("express")).default;
  const { mountResponsesRoutes } = await import("../proxy/responses-server.js");
  const { mountMessagesCrossProviderRoute } = await import("../proxy/messages-cross-route.js");
  const { SessionRouter } = await import("../proxy/session-router.js"); const { OpenAITokenPool } = await import("../providers/openai/token-pool.js");
  const { createOpenAIAccount } = await import("../providers/openai/account-state.js");
  const r = runtime(); const oldKey = r.snapshot().accounts.find(a => a.alias === "work")!.key;
  const account = createOpenAIAccount({ id: "work", provider: "openai_subscription", accessToken: "fixture", refreshToken: "fixture", expiresAt: Date.now() + 3600000, enabled: true });
  const pool = new OpenAITokenPool([account]); const router = new SessionRouter(pool);
  const payload = { id: "resp_fixture", model: "gpt-5.2", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 7 } };
  const bytes = `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`;
  const app = express();
  const opts = { openAIPool: pool, openAIRouter: router, usageRuntime: r, prepareOpenAIAccount: async () => {
    r.rename("openai_subscription", "work", "renamed"); pool.renameAccount("work", "renamed"); return mode !== "responses-refresh-failed";
  }, forwardOpenAI: async () => mode === "responses-stream-json" ? new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }) : new Response(bytes, { headers: { "content-type": "text/event-stream" } }) };
  if (mode.startsWith("messages")) mountMessagesCrossProviderRoute(app, opts); else mountResponsesRoutes(app, opts);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/${mode.startsWith("messages") ? "messages" : "responses"}`;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.2", input: [], messages: [], max_tokens: 20, stream: mode.includes("stream") }) });
    const body = await response.text();
    if (mode === "responses-refresh-failed") { expect(response.status).toBe(401); expect(r.snapshot().observations).toHaveLength(0); return; }
    expect(response.status, body).toBe(200);
    if (mode === "responses-stream") expect(body).toBe(bytes);
    if (mode === "responses-stream-json") expect(body).toBe(JSON.stringify(payload));
    expect(r.snapshot().accounts.filter(a => a.provider === "openai_subscription")).toHaveLength(1);
    expect(r.snapshot().observations).toHaveLength(1);
    expect(r.snapshot().observations[0]).toMatchObject({ accountKey: oldKey, model: "gpt-5.2", complete: true, tokens: { input: 40, cacheRead: 60, output: 7 } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("keeps one timestamp across delayed split usage and completion", () => {
  vi.useFakeTimers(); const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  applyAnthropicInputUsage(e, { input_tokens: 3 }); const ts = r.snapshot().observations[0]!.ts;
  vi.advanceTimersByTime(250); applyAnthropicOutputUsage(e, { output_tokens: 9 }); vi.advanceTimersByTime(250); finishUsageAttempt(e, true);
  expect(r.snapshot().observations[0]).toMatchObject({ ts, complete: true });
});
it("rejects decreasing provider counters without disabling other attempts or accepting completeness", () => {
  const r = runtime(); const e = entry(); r.bind(e, "openai_subscription");
  applyCodexUsage(e, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 8 });
  applyCodexUsage(e, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }); finishUsageAttempt(e, true);
  const other = entry(); r.bind(other, "openai_subscription"); applyCodexUsage(other, { inputTokens: 2, cachedInputTokens: 0, outputTokens: 2 }); finishUsageAttempt(other, true);
  expect(r.snapshot().observations).toHaveLength(2); expect(r.snapshot().observations[0]).toMatchObject({ complete: false, tokens: { input: 40, cacheRead: 60, output: 8 } });
});
it("does not silently fabricate missing output from raw OpenAI usage", async () => {
  const { captureCodexResponse } = await import("../proxy/stats.js"); const r = runtime(); const e = entry(); r.bind(e, "openai_subscription");
  captureCodexResponse(e, { model: "gpt-5.2", usage: { input_tokens: 10 } }); applyCodexUsage(e, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 }); finishUsageAttempt(e, true);
  expect(r.snapshot().observations[0]).toMatchObject({ complete: false, tokens: { input: 10, output: 0 } });
});
it("suppresses unmeasured provider savings only when that provider is selected and configured", () => {
  const dir = directory(); const r = startUsageRuntime(dir, [{ id: "grok", provider: "xai_subscription" }, { id: "work", provider: "openai_subscription" }]); runtimes.push(r);
  r.setSubscription("grok", 30, "2026-01-01"); r.setSubscription("work", 20, "2026-01-01");
  const all = r.report({ period: "day" }); expect(all.costs.coverage.pricingComplete).toBe(false); expect(all.costs.savingsUsd).toBeNull(); expect(all.warnings.join(" ")).toMatch(/unmeasured/i);
  const measured = r.report({ period: "day", providers: ["openai_subscription"] }); expect(measured.costs.coverage.pricingComplete).toBe(true); expect(measured.warnings.join(" ")).not.toMatch(/Grok|LiteLLM|unmeasured/i);
  expect(runtime().report({ period: "day" }).warnings.join(" ")).not.toMatch(/Grok|LiteLLM|unmeasured/i);
});
it("does not record LiteLLM Anthropic attribution and marks selected coverage partial", () => {
  const dir = directory(); const r = startUsageRuntime(dir, [{ id: "claude", provider: "anthropic_subscription" }], { unmeasuredProviders: ["anthropic_subscription"] }); runtimes.push(r);
  const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription"); applyAnthropicInputUsage(e, { input_tokens: 10 }); finishUsageAttempt(e, true);
  expect(r.snapshot().observations[0]).toMatchObject({ complete: false, settled: true, model: "unmeasured", tokens: { input: 0, output: 0 } }); expect(r.report({ period: "day" }).costs.coverage.pricingComplete).toBe(false);
});

it("drains already received compressed input on upstream abort instead of destroying the decoder copy", async () => {
  const { attachAnthropicResponseCapture } = await import("../proxy/anthropic-response-capture.js"); const { EventEmitter } = await import("node:events"); const { gzipSync } = await import("node:zlib");
  const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  const upstream = Object.assign(new EventEmitter(), { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } });
  attachAnthropicResponseCapture(upstream, new EventEmitter(), e, Date.now());
  const bytes = gzipSync(Buffer.from('data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":4}}}\n\n'));
  upstream.emit("data", bytes.subarray(0, -8)); upstream.emit("close");
  await vi.waitFor(() => expect(r.snapshot().observations[0]).toMatchObject({ complete: false, model: "claude-sonnet-4-6", tokens: { input: 4 } }));
});
it("captures cumulative Anthropic output revisions through terminal stop", async () => {
  const beforeOutput = stats.totalOutputTokens;
  const { attachAnthropicResponseCapture } = await import("../proxy/anthropic-response-capture.js"); const { EventEmitter } = await import("node:events");
  const r = runtime(); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  const upstream = Object.assign(new EventEmitter(), { headers: { "content-type": "text/event-stream" } }); attachAnthropicResponseCapture(upstream, new EventEmitter(), e, Date.now());
  for (const evt of [{ type: "message_start", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 2 } } }, { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_delta", usage: { output_tokens: 8 } }, { type: "message_delta", usage: { output_tokens: 8 } }, { type: "message_stop" }]) upstream.emit("data", Buffer.from(`data: ${JSON.stringify(evt)}\n\n`));
  expect(r.snapshot().observations[0]).toMatchObject({ complete: true, tokens: { input: 2, output: 8 } });
  expect(stats.totalOutputTokens - beforeOutput).toBe(8);
});
it("closes in-flight no-usage attempts as unknown, never as completed zero", () => {
  const dir = directory(); const r = runtime(dir); const e = entry(); r.bind(e, "openai_subscription"); r.close();
  expect(UsageStore.read(dir).observations[0]).toMatchObject({ complete: false, model: "unknown" });
});

it("marks only finished attempts settled and compacts ended-incomplete usage without claiming complete", () => {
  vi.useFakeTimers(); const r = runtime(directory(), { compactIntervalMs: 1000 }); const e = entry(); r.bind(e, "openai_subscription");
  applyCodexUsage(e, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 });
  expect(r.snapshot().observations[0]).not.toHaveProperty("settled"); finishUsageAttempt(e, false);
  expect(r.snapshot().observations[0]).toMatchObject({ complete: false, settled: true });
  vi.advanceTimersByTime(1000); expect(r.snapshot().observations).toHaveLength(0); expect(r.report({ period: "day" }).totals.input).toBe(10); expect(r.report({ period: "day" }).costs.savingsUsd).toBeNull();
});

it("preserves LiteLLM uncertainty offline after compaction without persisting its reported token counts", async () => {
  vi.useFakeTimers(); const { queryRuntimeUsage } = await import("../usage/runtime.js"); const dir = directory();
  const r = startUsageRuntime(dir, [{ id: "claude", provider: "anthropic_subscription" }], { compactIntervalMs: 1000, unmeasuredProviders: ["anthropic_subscription"] }); runtimes.push(r);
  const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription"); setUsageModel(e, "claude-sonnet-4-6"); applyAnthropicInputUsage(e, { input_tokens: 9000 }); applyAnthropicOutputUsage(e, { output_tokens: 9000 }); finishUsageAttempt(e, true);
  vi.advanceTimersByTime(1000); expect(r.snapshot().observations).toHaveLength(0); r.close();
  const snapshot = UsageStore.read(dir); const report = queryRuntimeUsage(snapshot, { period: "day", providers: ["anthropic_subscription"] }, Date.now());
  expect(report.totals.input).toBe(0); expect(report.totals.output).toBe(0); expect(report.costs.savingsUsd).toBeNull(); expect(snapshot.gaps?.some(gap => /incomplete|unmeasured|usage/i.test(gap.reason))).toBe(true);
});

it("normalizes each reported cumulative Anthropic input/cache field independently", () => {
  const e = entry(); const before = { input: stats.totalInputTokens, read: stats.totalCacheReadTokens, write: stats.totalCacheCreationTokens };
  applyAnthropicInputUsage(e, { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });
  applyAnthropicInputUsage(e, { input_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 });
  applyAnthropicInputUsage(e, { input_tokens: 8 });
  expect(e).toMatchObject({ inputTokens: 8, cacheReadTokens: 5, cacheCreationTokens: 4 });
  expect({ input: stats.totalInputTokens - before.input, read: stats.totalCacheReadTokens - before.read, write: stats.totalCacheCreationTokens - before.write }).toEqual({ input: 8, read: 5, write: 4 });
});

it.each([false, true])("preserves message_start output through abort/compaction/replay (later cumulative output=%s)", async later => {
  vi.useFakeTimers(); const { attachAnthropicResponseCapture } = await import("../proxy/anthropic-response-capture.js"); const { EventEmitter } = await import("node:events");
  const dir = directory(); const r = runtime(dir, { compactIntervalMs: 1000 }); const e = { ...entry(), accountId: "claude" }; r.bind(e, "anthropic_subscription");
  const upstream = Object.assign(new EventEmitter(), { headers: { "content-type": "text/event-stream" } }); attachAnthropicResponseCapture(upstream, new EventEmitter(), e, Date.now());
  const beforeOutput = stats.totalOutputTokens;
  upstream.emit("data", Buffer.from('data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}\n\n'));
  expect(r.snapshot().observations[0]?.tokens.output).toBe(1);
  if (later) upstream.emit("data", Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":8}}\n\n'));
  upstream.emit("close"); const output = later ? 8 : 1;
  expect(r.snapshot().observations[0]).toMatchObject({ complete: false, settled: true, tokens: { input: 10, output } });
  expect(stats.totalOutputTokens - beforeOutput).toBe(output);
  vi.advanceTimersByTime(1000); expect(r.snapshot().observations).toHaveLength(0); r.close();
  expect(UsageStore.read(dir).aggregates[0]?.tokens.output).toBe(output);
});

it.each([false, true])("discard releases capture without fabricating an inference gap (usage already observed=%s)", async observed => {
  const { discardUsageAttempt } = await import("../proxy/stats.js"); const dir = directory(); const r = runtime(dir); const e = entry(); r.bind(e, "openai_subscription");
  if (observed) applyCodexUsage(e, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 });
  discardUsageAttempt(e); finishUsageAttempt(e, false); r.close();
  const snapshot = UsageStore.read(dir);
  if (observed) expect(snapshot.observations[0]).toMatchObject({ complete: false, settled: true, tokens: { input: 10, output: 2 } });
  else { expect(snapshot.observations).toHaveLength(0); expect(snapshot.gaps).toEqual([]); }
});
