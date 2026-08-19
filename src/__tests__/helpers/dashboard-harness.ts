import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { expect, vi } from "vitest";
import { Dashboard } from "../../ui/Dashboard.js";
import type { DashboardProps } from "../../ui/Dashboard.js";

export const KEY_UP = "[A";
export const KEY_DOWN = "[B";

export interface DashboardHarness {
  stdin: NodeJS.ReadStream;
  /** The most recent full frame Ink wrote (debug mode re-renders whole frames). */
  lastFrame(): string;
  /** Push a key `times` times, waiting for a render commit between presses —
   *  `useInput` captures state per render, so two keys in one tick would both
   *  run against the same closure. */
  press(sequence: string, times?: number): Promise<void>;
  /** Poll `assertion` until it passes, racing against an unexpected exit so a
   *  crashed dashboard fails the test with its own error, not a timeout. */
  waitUntil(assertion: () => void): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Render the Dashboard against a stubbed health endpoint.
 *
 * The fetch stub builds a fresh Response per call: a body is single-use, and
 * the dashboard polls — a shared Response would flip the second poll into the
 * error screen.
 */
export function renderDashboard(
  health: unknown,
  props: Partial<DashboardProps> = {},
  viewport: { columns?: number; rows?: number } = {},
): DashboardHarness {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json(health))));

  const columns = viewport.columns ?? 240;
  const rows = viewport.rows ?? 100;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  }) as unknown as NodeJS.ReadStream;
  const stdout = Object.assign(new PassThrough(), {
    columns,
    rows,
  }) as unknown as NodeJS.WriteStream;
  const stderr = Object.assign(new PassThrough(), {
    columns,
    rows,
  }) as unknown as NodeJS.WriteStream;

  const frames: string[] = [];
  stdout.on("data", chunk => { frames.push(chunk.toString()); });

  const instance = render(
    React.createElement(Dashboard, { port: 3456, ...props }),
    { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const exitResult = instance.waitUntilExit().then(
    () => ({ kind: "exit" as const }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  return {
    stdin,
    lastFrame: () => frames[frames.length - 1] ?? "",
    press: async (sequence, times = 1) => {
      for (let i = 0; i < times; i++) {
        (stdin as unknown as PassThrough).push(sequence);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    },
    waitUntil: async (assertion) => {
      const rendered = vi.waitFor(
        () => assertion(),
        { timeout: 5_000, interval: 10 },
      ).then(() => ({ kind: "rendered" as const }));
      const outcome = await Promise.race([rendered, exitResult]);
      if (outcome.kind === "error") throw outcome.error;
      expect(outcome.kind).toBe("rendered");
    },
    cleanup: async () => {
      instance.unmount();
      await exitResult;
    },
  };
}
