import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isEscapeKey, withEscapeCancel } from "../cli/prompt-cancel.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A stdin stand-in that readline can decode keypresses from. */
function fakeStdin(): NodeJS.ReadStream {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} }) as unknown as NodeJS.ReadStream;
}

/** Runs the flow until the signal aborts; resolves "completed" if `done` fires first. */
function flowUntilAbort(done: Promise<void>) {
  return (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
    void done.then(() => resolve("completed"));
  });
}

describe("isEscapeKey", () => {
  it("is the decoded Escape key only", () => {
    expect(isEscapeKey({ name: "escape", sequence: "\x1b" })).toBe(true);
    expect(isEscapeKey({ name: "down", sequence: "\x1b[B" })).toBe(false);
    expect(isEscapeKey({ name: "b", sequence: "\x1bb", meta: true })).toBe(false); // Alt+b
    expect(isEscapeKey({ name: "q", sequence: "q" })).toBe(false);
    expect(isEscapeKey(undefined)).toBe(false);
  });
});

describe("withEscapeCancel", () => {
  it("aborts on a lone Escape and removes its listener afterwards", async () => {
    const stdin = fakeStdin();
    const run = withEscapeCancel(flowUntilAbort(sleep(2_000)), stdin);
    expect(stdin.listenerCount("keypress")).toBe(1);
    stdin.write("\x1b");
    await expect(run).rejects.toThrow("aborted");
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("does not abort on an arrow key, even when its escape sequence arrives in two chunks", async () => {
    const stdin = fakeStdin();
    const done = sleep(800);
    const run = withEscapeCancel(flowUntilAbort(done), stdin);
    stdin.write("\x1b[A");
    stdin.write("\x1b");
    await sleep(10);
    stdin.write("[B");
    await expect(run).resolves.toBe("completed");
  });

  it("removes the listener when the flow completes normally", async () => {
    const stdin = fakeStdin();
    await expect(withEscapeCancel(async () => "done", stdin)).resolves.toBe("done");
    expect(stdin.listenerCount("keypress")).toBe(0);
  });
});
