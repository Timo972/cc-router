import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../ui/Dashboard.js";
import { getCurrentVersion } from "../utils/self-update.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard rendering", () => {
  it("renders a model capacity row whose reset timestamp is zero", async () => {
    const health = {
      status: "ok",
      // Matching the dashboard's own version keeps these renders on the
      // pre-banner layout; drift is dashboard-version-banner.test.ts's job.
      version: getCurrentVersion(),
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

    // A fresh Response per poll — a body is single-use, and a shared one
    // would flip the dashboard's second poll into the error screen.
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

  it("renders a warn activity row with the warn glyph and details", async () => {
    const health = {
      status: "ok",
      // Matching the dashboard's own version keeps these renders on the
      // pre-banner layout; drift is dashboard-version-banner.test.ts's job.
      version: getCurrentVersion(),
      mode: "direct",
      target: "chatgpt.com",
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
          anthropic: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
          openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
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
          openAIResponses: true,
          crossProviderMessages: false,
          dynamicModels: true,
          accountManagement: true,
        },
      },
      accounts: [],
      recentLogs: [{
        ts: 1,
        accountId: "-",
        model: "gpt-5.5",
        type: "warn",
        details: "max_output_tokens ignored — unsupported by the Codex backend",
      }],
    };

    // A fresh Response per poll — a body is single-use, and a shared one
    // would flip the dashboard's second poll into the error screen.
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
      React.createElement(Dashboard, { port: 3456 }),
      { stdin, stdout, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    const exitResult = instance.waitUntilExit().then(
      () => ({ kind: "exit" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    try {
      const rendered = vi.waitFor(
        () => {
          expect(output).toContain("⚠");
          expect(output).toContain("max_output_tokens ignored");
        },
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

  it("toggles an OpenAI account with the same PATCH the Claude path uses", async () => {
    const health = {
      status: "ok",
      // Matching the dashboard's own version keeps these renders on the
      // pre-banner layout; drift is dashboard-version-banner.test.ts's job.
      version: getCurrentVersion(),
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
          anthropic: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
          openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
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
          openAIResponses: true,
          crossProviderMessages: true,
          dynamicModels: true,
          accountManagement: true,
        },
      },
      accounts: [{
        id: "plus-timo-personal",
        provider: "openai_subscription",
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
      }],
      recentLogs: [],
    };

    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        ...(init?.method ? { method: init.method } : {}),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return Promise.resolve(Response.json(health));
    }));

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    }) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), { columns: 240, rows: 100 }) as unknown as NodeJS.WriteStream;
    const stderr = Object.assign(new PassThrough(), { columns: 240, rows: 100 }) as unknown as NodeJS.WriteStream;
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
      await vi.waitFor(() => expect(output).toContain("plus-timo-personal"), { timeout: 1_000, interval: 10 });

      // Account actions require focus on the accounts panel; the dashboard
      // starts focused on logs.
      stdin.push("\t");
      // The focus change has to be committed before the next key: `useInput`
      // captures `focus` per render, so two keys in one tick both run against
      // the pre-Tab closure.
      await new Promise(resolve => setTimeout(resolve, 60));

      // `e` on the selected account. This used to answer "OpenAI accounts are
      // managed from the CLI" and issue nothing, even though the endpoint
      // supports the operation.
      stdin.push("e");

      await vi.waitFor(() => {
        const patch = calls.find(call => call.method === "PATCH");
        expect(patch?.url).toContain("/cc-router/accounts/plus-timo-personal");
        expect(patch?.body).toEqual({ enabled: false });
      }, { timeout: 1_000, interval: 10 });

      // Delete had three gates, not one: the `d` key, and `doDelete` itself.
      // Removing only the first walked the operator into the confirmation
      // dialog and then refused there.
      stdin.push("d");
      await new Promise(resolve => setTimeout(resolve, 60));
      stdin.push("y");

      await vi.waitFor(() => {
        const del = calls.find(call => call.method === "DELETE");
        expect(del?.url).toContain("/cc-router/accounts/plus-timo-personal");
      }, { timeout: 1_000, interval: 10 });
    } finally {
      instance.unmount();
      await exitResult;
    }
  });
});
