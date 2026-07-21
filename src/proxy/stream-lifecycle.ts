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
  let lineBuffer = "";
  const terminal = () => { state.bodyDurationMs = Math.max(0, now() - startedAt); };
  return {
    state,
    observeChunk(chunk) {
      state.lastByteAt = now();
      if (!inspectSse || state.sawMessageStop) return;
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6)) as { type?: string };
          if (event.type === "message_stop") {
            state.sawMessageStop = true;
            lineBuffer = "";
            break;
          }
        } catch {
          // Complete non-JSON data lines are irrelevant to terminal tracking.
        }
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
