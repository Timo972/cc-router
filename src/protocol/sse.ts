export interface ParsedSse {
  events: unknown[];
  remainder: string;
}

export interface ParseSseOptions {
  /**
   * Skip individual `data:` lines that are not valid JSON instead of throwing.
   *
   * Parsing is per line, so one malformed frame never discards the valid
   * events that arrived in the same chunk. Use this wherever parsing is
   * advisory — passive usage observation, or a relay that must keep streaming
   * whatever else it can. Leave it off where a malformed stream must surface
   * as an upstream error (e.g. `collectCodexResponseStream`).
   */
  tolerant?: boolean;
}

export type BoundedSseParseResult = "ok" | "overflow" | "stopped";

export interface BoundedSseLineParser {
  push(
    chunk: Uint8Array,
    onEvent: (event: unknown) => void | boolean | Promise<void | boolean>,
  ): Promise<BoundedSseParseResult>;
  finish(
    onEvent: (event: unknown) => void | boolean | Promise<void | boolean>,
  ): Promise<BoundedSseParseResult>;
}

/**
 * Incrementally parse JSON `data:` lines while retaining at most one bounded
 * line. Events are delivered one at a time so a large upstream chunk cannot
 * turn into an equally large in-memory event array, and an async consumer can
 * apply downstream backpressure before parsing the next line.
 */
export function createBoundedSseLineParser(
  maxLineBytes: number,
  options: ParseSseOptions = {},
): BoundedSseLineParser {
  let fragments: Buffer[] = [];
  let retainedBytes = 0;
  let overflowed = false;
  let stopped = false;

  const clearLine = (): void => {
    fragments = [];
    retainedBytes = 0;
  };
  const emitLine = async (
    onEvent: (event: unknown) => void | boolean | Promise<void | boolean>,
  ): Promise<boolean> => {
    const line = Buffer.concat(fragments, retainedBytes).toString("utf8");
    clearLine();
    if (!line.startsWith("data: ")) return true;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return true;
    let event: unknown;
    try {
      event = JSON.parse(payload) as unknown;
    } catch (error) {
      if (options.tolerant) return true;
      throw error;
    }
    return await onEvent(event) !== false;
  };
  const currentResult = (): BoundedSseParseResult => overflowed
    ? "overflow"
    : stopped ? "stopped" : "ok";

  return {
    async push(chunk, onEvent) {
      if (overflowed || stopped) return currentResult();
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newlineAt = chunk.indexOf(0x0a, offset);
        const fragmentEnd = newlineAt === -1 ? chunk.byteLength : newlineAt;
        const fragment = chunk.subarray(offset, fragmentEnd);
        if (retainedBytes + fragment.byteLength > maxLineBytes) {
          overflowed = true;
          clearLine();
          return "overflow";
        }
        if (fragment.byteLength > 0) {
          fragments.push(Buffer.from(fragment));
          retainedBytes += fragment.byteLength;
        }
        if (newlineAt === -1) break;
        if (!await emitLine(onEvent)) {
          stopped = true;
          return "stopped";
        }
        offset = newlineAt + 1;
      }
      return "ok";
    },
    async finish(onEvent) {
      if (overflowed || stopped) return currentResult();
      if (retainedBytes > 0 && !await emitLine(onEvent)) {
        stopped = true;
        return "stopped";
      }
      return "ok";
    },
  };
}

export function parseSseLines(input: string, options: ParseSseOptions = {}): ParsedSse {
  const lines = input.split("\n");
  const remainder = lines.pop() ?? "";
  const events: unknown[] = [];

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    if (options.tolerant) {
      try {
        events.push(JSON.parse(payload));
      } catch {
        // Advisory parse — drop just this frame, keep the rest of the chunk.
      }
      continue;
    }
    events.push(JSON.parse(payload));
  }

  return { events, remainder };
}

export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
