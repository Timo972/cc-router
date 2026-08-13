import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeSseEvent, parseSseLines } from "../protocol/sse.js";
import { createStreamLifecycleTracker } from "../proxy/stream-lifecycle.js";

describe("SSE helpers", () => {
  it("parses complete data events and keeps partial line remainder", () => {
    const parsed = parseSseLines("data: {\"type\":\"one\"}\n\ndata: {\"type\"");

    expect(parsed.events).toEqual([{ type: "one" }]);
    expect(parsed.remainder).toBe("data: {\"type\"");
  });

  it("encodes JSON events in SSE data format", () => {
    expect(encodeSseEvent({ type: "response.completed" })).toBe(
      "data: {\"type\":\"response.completed\"}\n\n",
    );
  });

  it.each(["enabled", "disabled", "failing"] as const)(
    "observes split terminal events without changing input bytes when telemetry is %s",
    mode => {
      const chunks = [
        Buffer.from("event: content_block_delta\ndata: {\"delta\":{\"text\":\"Hi\"}}\n\n"),
        Buffer.from("event: message_stop\nda"),
        Buffer.from("ta: {\"type\":\"message_stop\"}\n\n"),
      ];
      const originals = chunks.map(chunk => Buffer.from(chunk));
      const terminals: string[] = [];
      const tracker = createStreamLifecycleTracker(100, true, () => 125, terminal => {
        if (mode === "failing") throw new Error("telemetry callback failed");
        if (mode === "enabled") terminals.push(terminal.outcome);
      });

      for (const chunk of chunks) tracker.observeChunk(chunk);
      expect(chunks).toEqual(originals);
      expect(Buffer.concat(chunks)).toEqual(Buffer.concat(originals));
      expect(tracker.state.sawMessageStop).toBe(true);
      const upstream = new EventEmitter();
      const downstream = new EventEmitter();
      tracker.attach(upstream, downstream);
      downstream.emit("finish");
      expect(terminals).toEqual(mode === "enabled" ? ["complete"] : []);
    },
  );
});
