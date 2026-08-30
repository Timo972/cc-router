import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_SSE_LINE_BYTES,
  createStreamLifecycleTracker,
} from "../proxy/stream-lifecycle.js";

describe("createStreamLifecycleTracker", () => {
  it("observes a split message_stop without retaining payload content", () => {
    let current = 1_100;
    const tracker = createStreamLifecycleTracker(1_000, true, () => current);
    tracker.observeChunk(Buffer.from("event: message_stop\nda"));
    current = 1_200;
    tracker.observeChunk(Buffer.from("ta: {\"type\":\"message_stop\",\"secret\":\"not-retained\"}\n\n"));
    expect(tracker.state.sawMessageStop).toBe(true);
    expect(tracker.state.lastByteAt).toBe(1_200);
    expect(JSON.stringify(tracker.state)).not.toContain("not-retained");
  });

  it("discards an oversized incomplete line and detects the next message_stop", () => {
    const tracker = createStreamLifecycleTracker(1_000, true, () => 1_100);
    const oversizedTerminalLine = `data: {"type":"message_stop"}${" ".repeat(MAX_RETAINED_SSE_LINE_BYTES)}`;

    tracker.observeChunk(Buffer.from(oversizedTerminalLine));
    expect(tracker.state.sawMessageStop).toBe(false);

    tracker.observeChunk(Buffer.from("\n"));
    expect(tracker.state.sawMessageStop).toBe(false);

    tracker.observeChunk(Buffer.from('data: {"type":"message_stop"}\n'));
    expect(tracker.state.sawMessageStop).toBe(true);
  });

  it("clears an incomplete line on a terminal lifecycle event", () => {
    const tracker = createStreamLifecycleTracker(1_000, true, () => 1_100);
    const upstream = new EventEmitter();
    const downstream = new EventEmitter();
    tracker.attach(upstream, downstream);

    tracker.observeChunk(Buffer.from('data: {"type":"message_'));
    upstream.emit("end");
    tracker.observeChunk(Buffer.from('stop"}\n'));

    expect(tracker.state.sawMessageStop).toBe(false);
  });

  it("records upstream abort and downstream close", () => {
    let current = 2_000;
    const tracker = createStreamLifecycleTracker(1_000, false, () => current);
    const upstream = new EventEmitter();
    const downstream = new EventEmitter();
    tracker.attach(upstream, downstream);
    current = 2_100;
    upstream.emit("aborted");
    current = 2_200;
    upstream.emit("close");
    current = 2_300;
    downstream.emit("close");
    expect(tracker.state).toMatchObject({
      upstreamEnd: false,
      upstreamAborted: true,
      upstreamClose: true,
      downstreamFinish: false,
      downstreamClose: true,
      bodyDurationMs: 1_300,
    });
  });

  it("distinguishes successful upstream end and downstream finish", () => {
    let current = 5_000;
    const tracker = createStreamLifecycleTracker(4_000, false, () => current);
    const upstream = new EventEmitter();
    const downstream = new EventEmitter();
    tracker.attach(upstream, downstream);
    upstream.emit("end");
    current = 5_100;
    downstream.emit("finish");
    expect(tracker.state.upstreamEnd).toBe(true);
    expect(tracker.state.downstreamFinish).toBe(true);
    expect(tracker.state.bodyDurationMs).toBe(1_100);
  });
});
