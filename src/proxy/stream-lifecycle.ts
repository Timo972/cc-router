export interface StreamLifecycleState {
  sawMessageStop: boolean;
  upstreamEnd: boolean;
  upstreamAborted: boolean;
  upstreamClose: boolean;
  downstreamFinish: boolean;
  downstreamClose: boolean;
  lastByteAt?: number;
  bodyDurationMs?: number;
}

export interface LifecycleEmitter {
  once(event: string, listener: () => void): unknown;
}

export interface StreamLifecycleTracker {
  readonly state: StreamLifecycleState;
  observeChunk(chunk: Buffer): void;
  attach(upstream: LifecycleEmitter, downstream: LifecycleEmitter): void;
}

export const MAX_RETAINED_SSE_LINE_BYTES = 64 * 1024;

export function createStreamLifecycleTracker(
  startedAt: number,
  inspectSse: boolean,
  now: () => number = Date.now,
): StreamLifecycleTracker {
  const state: StreamLifecycleState = {
    sawMessageStop: false,
    upstreamEnd: false,
    upstreamAborted: false,
    upstreamClose: false,
    downstreamFinish: false,
    downstreamClose: false,
  };
  let lineBuffer = Buffer.alloc(0);
  let discardingOversizedLine = false;
  const clearParserState = () => {
    lineBuffer = Buffer.alloc(0);
    discardingOversizedLine = false;
  };
  const inspectLine = (line: Buffer) => {
    const text = line.toString("utf8");
    if (!text.startsWith("data: ")) return;
    try {
      const event = JSON.parse(text.slice(6)) as { type?: string };
      if (event.type === "message_stop") {
        state.sawMessageStop = true;
        clearParserState();
      }
    } catch {
      // Complete non-JSON data lines are irrelevant to terminal tracking.
    }
  };
  const terminal = () => {
    clearParserState();
    state.bodyDurationMs = Math.max(0, now() - startedAt);
  };
  return {
    state,
    observeChunk(chunk) {
      state.lastByteAt = now();
      if (!inspectSse || state.sawMessageStop) return;

      let offset = 0;
      while (offset < chunk.length) {
        const newlineAt = chunk.indexOf(0x0a, offset);

        if (discardingOversizedLine) {
          if (newlineAt === -1) return;
          discardingOversizedLine = false;
          offset = newlineAt + 1;
          continue;
        }

        const fragmentEnd = newlineAt === -1 ? chunk.length : newlineAt;
        const fragment = chunk.subarray(offset, fragmentEnd);
        const retainedBytes = lineBuffer.length + fragment.length;

        if (retainedBytes > MAX_RETAINED_SSE_LINE_BYTES) {
          lineBuffer = Buffer.alloc(0);
          discardingOversizedLine = newlineAt === -1;
        } else {
          lineBuffer = lineBuffer.length === 0
            ? Buffer.from(fragment)
            : Buffer.concat([lineBuffer, fragment], retainedBytes);
          if (newlineAt !== -1) {
            inspectLine(lineBuffer);
            lineBuffer = Buffer.alloc(0);
            if (state.sawMessageStop) return;
          }
        }

        if (newlineAt === -1) return;
        offset = newlineAt + 1;
      }
    },
    attach(upstream, downstream) {
      upstream.once("end", () => { state.upstreamEnd = true; terminal(); });
      upstream.once("aborted", () => { state.upstreamAborted = true; terminal(); });
      upstream.once("close", () => { state.upstreamClose = true; terminal(); });
      downstream.once("finish", () => { state.downstreamFinish = true; terminal(); });
      downstream.once("close", () => { state.downstreamClose = true; terminal(); });
    },
  };
}
