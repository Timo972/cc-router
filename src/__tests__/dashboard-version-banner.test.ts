import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../ui/Dashboard.js";
import { getCurrentVersion } from "../utils/self-update.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHealth(version?: string) {
  return {
    status: "ok",
    mode: "direct",
    target: "api.anthropic.com",
    ...(version !== undefined ? { version } : {}),
    uptime: 60_000,
    totalRequests: 0,
    totalErrors: 0,
    totalRefreshes: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    operational: {
      auth: { required: false },
      providers: {
        anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
      },
      endpoints: {
        health: "/cc-router/health",
        accounts: "/cc-router/accounts",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
      },
      routing: { anthropicAliases: [], openAIAliases: [] },
      capabilities: {
        anthropicMessages: true,
        openAIResponses: false,
        crossProviderMessages: false,
        dynamicModels: true,
        accountManagement: true,
      },
    },
    accounts: [],
    recentLogs: [],
  };
}

async function renderUntil(
  health: unknown,
  assertion: (output: string) => void,
  props: { baseUrl?: string } = {},
): Promise<string> {
  // A fresh Response per call: a body is single-use, and the dashboard polls —
  // a shared Response would flip the second poll into the error screen.
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json(health))));

  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  }) as unknown as NodeJS.ReadStream;
  const stdout = Object.assign(new PassThrough(), {
    columns: 240,
    rows: 100,
  }) as unknown as NodeJS.WriteStream;
  const stderr = Object.assign(new PassThrough(), {
    columns: 240,
    rows: 100,
  }) as unknown as NodeJS.WriteStream;
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });

  const instance = render(
    React.createElement(Dashboard, { port: 3456, ...props }),
    { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const exitResult = instance.waitUntilExit().then(
    () => ({ kind: "exit" as const }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  try {
    const rendered = vi.waitFor(
      () => assertion(output),
      { timeout: 1_000, interval: 10 },
    ).then(() => ({ kind: "rendered" as const }));

    const outcome = await Promise.race([rendered, exitResult]);
    if (outcome.kind === "error") throw outcome.error;
    expect(outcome.kind).toBe("rendered");
  } finally {
    instance.unmount();
    await exitResult;
  }
  return output;
}

describe("Dashboard version-mismatch banner", () => {
  it("warns when the daemon reports a different version than the dashboard", async () => {
    const output = await renderUntil(makeHealth("9.9.9-test"), out => {
      expect(out).toContain("VERSION MISMATCH");
    });

    expect(output).toContain("daemon v9.9.9-test");
    expect(output).toContain(`dashboard v${getCurrentVersion()}`);
    expect(output).toContain("cc-router stop --keep-config && cc-router start");
  });

  it("warns when the daemon predates version reporting entirely", async () => {
    // The exact failure this exists for: a launchd service still running a
    // build from before the health payload carried a version at all.
    const output = await renderUntil(makeHealth(undefined), out => {
      expect(out).toContain("VERSION MISMATCH");
    });

    expect(output).toContain("daemon version unreported (older build)");
    expect(output).toContain("cc-router stop --keep-config && cc-router start");
  });

  it("does not advise a local restart when pointed at a remote router", async () => {
    // A local `cc-router stop && start` can never clear drift against a
    // machine it does not run on.
    const output = await renderUntil(
      makeHealth("9.9.9-test"),
      out => { expect(out).toContain("VERSION MISMATCH"); },
      { baseUrl: "http://192.168.1.10:3456" },
    );

    expect(output).toContain("update and restart the daemon on http://192.168.1.10:3456");
    expect(output).not.toContain("cc-router stop");
  });

  it("shows no banner when daemon and dashboard versions match", async () => {
    const output = await renderUntil(makeHealth(getCurrentVersion()), out => {
      // Wait for the dashboard to have fully rendered its main sections
      // before judging the banner's absence.
      expect(out).toContain("RECENT ACTIVITY");
    });

    expect(output).not.toContain("VERSION MISMATCH");
  });
});
