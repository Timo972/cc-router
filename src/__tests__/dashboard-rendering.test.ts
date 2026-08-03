import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../ui/Dashboard.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard rendering", () => {
  it("renders a model capacity row whose reset timestamp is zero", async () => {
    const health = {
      status: "ok",
      mode: "direct",
      target: "api.anthropic.com",
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
        routing: {
          anthropicAliases: [],
          openAIAliases: [],
        },
        capabilities: {
          anthropicMessages: true,
          openAIResponses: false,
          crossProviderMessages: false,
          dynamicModels: true,
          accountManagement: true,
        },
      },
      accounts: [{
        id: "max-developer",
        provider: "anthropic_subscription",
        healthy: true,
        busy: false,
        inFlightRequests: 0,
        activeSessions: 0,
        requestCount: 0,
        errorCount: 0,
        expiresInMs: 3_600_000,
        lastUsedMs: 0,
        lastRefreshMs: 0,
        enabled: true,
        sessionLimitPercent: 100,
        weeklyLimitPercent: 100,
        modelCooldowns: [],
        rateLimits: {
          status: "allowed",
          fiveHourUtil: 0,
          fiveHourReset: 0,
          sevenDayUtil: 0,
          sevenDayReset: 0,
          claim: "",
          plan: "max",
          requestsLimit: 0,
          lastUpdated: 0,
          usage: {
            fiveHour: { utilization: 0, resetAt: 0 },
            sevenDay: { utilization: 0, resetAt: 0 },
            modelLimits: [{
              modelFamily: "fable",
              displayName: "Claude Fable",
              utilization: 0,
              resetAt: 0,
              active: true,
              severity: "",
            }],
            extraUsage: { enabled: false, spendLimitReached: false, usable: false },
            fetchedAt: 1,
            fetchStatus: "fresh",
          },
        },
      }],
      recentLogs: [],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));

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
      React.createElement(Dashboard, { port: 3456 }),
      { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    const exitResult = instance.waitUntilExit().then(
      () => ({ kind: "exit" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    try {
      const rendered = vi.waitFor(
        () => expect(output).toContain("Claude Fable"),
        { timeout: 1_000, interval: 10 },
      ).then(() => ({ kind: "rendered" as const }));

      const outcome = await Promise.race([rendered, exitResult]);
      if (outcome.kind === "error") throw outcome.error;
      expect(outcome.kind).toBe("rendered");
    } finally {
      instance.unmount();
      await exitResult;
    }
  });
});
