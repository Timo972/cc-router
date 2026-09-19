import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isEscapeKey, withEscapeCancel } from "../cli/prompt-cancel.js";

describe("isEscapeKey", () => {
  it("is a lone escape byte only", () => {
    expect(isEscapeKey(Buffer.from("\x1b"))).toBe(true);
    expect(isEscapeKey("\x1b")).toBe(true);
    expect(isEscapeKey("\x1b[A")).toBe(false); // arrow key
    expect(isEscapeKey("\x1bOA")).toBe(false); // arrow key, application mode
    expect(isEscapeKey("q")).toBe(false);
    expect(isEscapeKey("")).toBe(false);
  });
});

describe("withEscapeCancel", () => {
  it("aborts the signal on Escape and removes its listener afterwards", async () => {
    const stdin = new EventEmitter();
    let seen: AbortSignal | undefined;
    const run = withEscapeCancel(async signal => {
      seen = signal;
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }, stdin as unknown as NodeJS.ReadStream);
    expect(stdin.listenerCount("data")).toBe(1);
    stdin.emit("data", Buffer.from("\x1b[B"));
    expect(seen?.aborted).toBe(false);
    stdin.emit("data", Buffer.from("\x1b"));
    await expect(run).rejects.toThrow("aborted");
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("removes the listener when the flow completes normally", async () => {
    const stdin = new EventEmitter();
    await expect(withEscapeCancel(async () => "done", stdin as unknown as NodeJS.ReadStream)).resolves.toBe("done");
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
