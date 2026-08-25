import { describe, expect, it, vi } from "vitest";
import {
  createProxyExitCoordinator,
  scheduleProcessExit,
  saveProviderAccountsOnShutdown,
} from "../proxy/shutdown-persistence.js";

describe("shutdown account persistence", () => {
  it("lets the event loop drain before a bounded forced process exit", () => {
    const setExitCode = vi.fn();
    const forceExit = vi.fn();
    const unref = vi.fn();
    let forceExitCallback: (() => void) | undefined;
    const setTimeout = vi.fn((callback: () => void) => {
      forceExitCallback = callback;
      return { unref };
    });

    scheduleProcessExit(0, { setExitCode, forceExit, setTimeout });

    expect(setExitCode).toHaveBeenCalledWith(0);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(unref).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();

    forceExitCallback?.();
    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it("attempts the OpenAI save even when the Anthropic save fails", () => {
    const saveAnthropic = vi.fn(() => { throw new Error("anthropic disk failure"); });
    const saveOpenAI = vi.fn();

    expect(() => saveProviderAccountsOnShutdown([], [], {
      saveAnthropic,
      saveOpenAI,
    })).not.toThrow();

    expect(saveAnthropic).toHaveBeenCalledWith([]);
    expect(saveOpenAI).toHaveBeenCalledWith([]);
  });

  it("quiesces refresh, persists both providers, and drains telemetry before an update restart", async () => {
    const events: string[] = [];
    let releaseRefresh: (() => void) | undefined;
    let releaseTelemetry: (() => void) | undefined;
    const refreshBarrier = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const telemetryBarrier = new Promise<void>(resolve => { releaseTelemetry = resolve; });
    const saveAnthropic = vi.fn(() => events.push("save-anthropic"));
    const saveOpenAI = vi.fn(() => events.push("save-openai"));
    const restart = vi.fn(() => events.push("restart"));

    const coordinator = createProxyExitCoordinator({
      stopAccepting: () => events.push("stop-accepting"),
      stopUsageRefresh: () => events.push("stop-usage"),
      removePid: () => events.push("remove-pid"),
      drainRefresh: async () => {
        events.push("drain-refresh-start");
        await refreshBarrier;
        events.push("drain-refresh-end");
      },
      persistAccounts: () => saveProviderAccountsOnShutdown([], [], {
        saveAnthropic,
        saveOpenAI,
      }),
      shutdownTelemetry: async () => {
        events.push("telemetry-start");
        await telemetryBarrier;
        events.push("telemetry-end");
      },
    });

    const finishing = coordinator.finish(restart);
    await vi.waitFor(() => expect(events).toContain("drain-refresh-start"));
    expect(restart).not.toHaveBeenCalled();
    releaseRefresh?.();
    await vi.waitFor(() => expect(events).toContain("telemetry-start"));
    expect(saveAnthropic).toHaveBeenCalledWith([]);
    expect(saveOpenAI).toHaveBeenCalledWith([]);
    expect(restart).not.toHaveBeenCalled();
    releaseTelemetry?.();
    await finishing;

    expect(events).toEqual([
      "stop-accepting",
      "stop-usage",
      "remove-pid",
      "drain-refresh-start",
      "drain-refresh-end",
      "save-anthropic",
      "save-openai",
      "telemetry-start",
      "telemetry-end",
      "restart",
    ]);
  });
});
