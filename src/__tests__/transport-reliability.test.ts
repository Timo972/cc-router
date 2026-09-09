import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardOpenAICodexResponse } from "../providers/openai/codex-transport.js";
import {
  createHeaderDeadline,
  waitForWritable,
  withStreamIdleTimeout,
} from "../proxy/transport-timing.js";
import {
  createCorrelationId,
  formatTransportDiagnostic,
  safeCauseCode,
} from "../proxy/transport-diagnostics.js";

const ACCOUNT = {
  id: "openai-test",
  provider: "openai_subscription" as const,
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3_600_000,
  enabled: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transport deadlines", () => {
  it("aborts a stalled header exchange with a TimeoutError", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const pending = forwardOpenAICodexResponse({
      account: ACCOUNT,
      body: { model: "gpt-5.5", input: [] },
      stream: true,
      timeoutMs: 50,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("lets a progressing stream run longer than the header deadline", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>(resolve => {
          setTimeout(() => {
            chunk++;
            controller.enqueue(encoder.encode(String(chunk)));
            if (chunk === 4) controller.close();
            resolve();
          }, 40);
        });
      },
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const upstream = await forwardOpenAICodexResponse({
      account: ACCOUNT,
      body: { model: "gpt-5.5", input: [] },
      stream: true,
      timeoutMs: 50,
    });
    const textPromise = upstream.text();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(40);

    await expect(textPromise).resolves.toBe("1234");
  });

  it("rejects and cancels a body whose next chunk stalls", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel,
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const upstream = await forwardOpenAICodexResponse({
      account: ACCOUNT,
      body: { model: "gpt-5.5", input: [] },
      stream: true,
      timeoutMs: 50,
    });
    const textPromise = upstream.text();
    const assertion = expect(textPromise).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("keeps the idle timer stopped until downstream asks for another chunk", async () => {
    vi.useFakeTimers();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(Uint8Array.of(pulls));
      },
    }, { highWaterMark: 0 });
    const wrapped = withStreamIdleTimeout(body, 25);
    if (!wrapped) throw new Error("wrapped body missing");
    const reader = wrapped.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: Uint8Array.of(1) });
    expect(pulls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(pulls).toBe(1);
    await expect(reader.read()).resolves.toEqual({ done: false, value: Uint8Array.of(2) });

    await reader.cancel();
    expect(body.locked).toBe(false);
  });

  it("propagates parent cancellation even when the idle timeout is disabled", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel,
    }, { highWaterMark: 0 });
    const parent = new AbortController();
    const wrapped = withStreamIdleTimeout(body, undefined, parent.signal);
    if (!wrapped) throw new Error("wrapped body missing");
    const pending = wrapped.getReader().read();
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    parent.abort(new DOMException("client left", "AbortError"));
    await assertion;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(body.locked).toBe(false);
  });

  it("removes every drain waiter when a writable closes or errors", async () => {
    class WritableProbe extends EventEmitter {
      destroyed = false;
    }
    const closed = new WritableProbe();
    const closeWait = waitForWritable(closed);
    closed.emit("close");
    await expect(closeWait).resolves.toBe(false);
    expect(closed.eventNames()).toEqual([]);

    const errored = new WritableProbe();
    const errorWait = waitForWritable(errored);
    errored.emit("error");
    await expect(errorWait).resolves.toBe(false);
    expect(errored.eventNames()).toEqual([]);

    const drained = new WritableProbe();
    const drainWait = waitForWritable(drained);
    drained.emit("drain");
    await expect(drainWait).resolves.toBe(true);
    expect(drained.eventNames()).toEqual([]);
  });

  it("disposes the header timer and its temporary parent listener", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createHeaderDeadline(50, parent.signal);
    deadline.dispose();
    parent.abort();
    vi.advanceTimersByTime(100);
    expect(deadline.signal?.aborted).toBe(false);
  });
});

describe("transport diagnostics", () => {
  it("keeps a safe nested network code and drops messages, bodies, and unsafe fields", () => {
    const error = new Error("fetch failed: bearer secret-token", {
      cause: {
        cause: { code: "UND_ERR_SOCKET", responseBody: "secret response" },
      },
    });
    const diagnostic = formatTransportDiagnostic({
      correlationId: createCorrelationId(),
      operation: "forward",
      causeCode: safeCauseCode(error),
    });

    expect(diagnostic).toMatch(/^correlation=oai-[a-f0-9]{8} operation=forward cause=UND_ERR_SOCKET$/);
    expect(diagnostic).not.toContain("secret");
    expect(diagnostic).not.toContain("fetch failed");
  });

  it("rejects caller-supplied diagnostic fields that could inject log content", () => {
    const diagnostic = formatTransportDiagnostic({
      correlationId: "bad\nrefresh-token=secret",
      operation: "refresh",
      status: Number.NaN,
      causeCode: "ECONNRESET\nsecret=token",
    });

    expect(diagnostic).toBe("correlation=invalid operation=refresh");
  });
});
