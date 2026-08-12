import { afterEach, describe, expect, it } from "vitest";

describe("runtime automatic span classification", () => {
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
  });

  it("classifies only the real provider hosts for every approved operation", async () => {
    const { classifyOutgoingTelemetryOperation } = await import("../telemetry/runtime.js");
    const approved = [
      ["api.anthropic.com", "/v1/messages", "POST", "provider.inference"],
      ["chatgpt.com", "/backend-api/codex/responses", "POST", "provider.inference"],
      ["auth.openai.com", "/oauth/token", "POST", "oauth.refresh"],
      ["claude.ai", "/v1/oauth/token", "POST", "oauth.refresh"],
      ["api.anthropic.com", "/api/oauth/usage", "GET", "provider.usage_refresh"],
      ["api.anthropic.com", "/v1/models", "GET", "model.discovery"],
      ["chatgpt.com", "/backend-api/codex/models", "GET", "model.discovery"],
    ] as const;
    for (const [host, path, method, operation] of approved) {
      expect(classifyOutgoingTelemetryOperation(host, path, method)?.operation).toBe(operation);
    }

    const decoyPaths = [
      ["/v1/messages", "POST"],
      ["/backend-api/codex/responses", "POST"],
      ["/oauth/token", "POST"],
      ["/api/oauth/usage", "GET"],
      ["/v1/models", "GET"],
      ["/backend-api/codex/models", "GET"],
      ["/i/v1/traces", "POST"],
      ["/i/v1/logs", "POST"],
      ["/batch/", "POST"],
    ] as const;
    for (const [path, method] of decoyPaths) {
      expect(classifyOutgoingTelemetryOperation("decoy.invalid", path, method)).toBeUndefined();
    }
    expect(classifyOutgoingTelemetryOperation(undefined, "/v1/messages", "POST")).toBeUndefined();
    expect(classifyOutgoingTelemetryOperation(
      "explicit-proxy.internal",
      "/v1/messages",
      "POST",
      "explicit-proxy.internal",
    )?.operation).toBe("provider.inference");
    expect(classifyOutgoingTelemetryOperation(
      "decoy.invalid",
      "/v1/messages",
      "POST",
      "explicit-proxy.internal",
    )).toBeUndefined();
  });

  it("allows literal loopback provider targets only in tests", async () => {
    const { classifyOutgoingTelemetryOperation } = await import("../telemetry/runtime.js");
    process.env["NODE_ENV"] = "test";
    const loopbackOperations = [
      ["127.0.0.1", "/v1/messages", "POST", "provider.inference"],
      ["127.0.0.1", "/backend-api/codex/responses", "POST", "provider.inference"],
      ["127.0.0.1", "/oauth/token", "POST", "oauth.refresh"],
      ["::1", "/v1/oauth/token", "POST", "oauth.refresh"],
      ["::1", "/api/oauth/usage", "GET", "provider.usage_refresh"],
      ["::1", "/v1/models", "GET", "model.discovery"],
      ["::1", "/backend-api/codex/models", "GET", "model.discovery"],
    ] as const;
    for (const [host, path, method, operation] of loopbackOperations) {
      expect(classifyOutgoingTelemetryOperation(host, path, method)?.operation).toBe(operation);
    }
    expect(classifyOutgoingTelemetryOperation(
      "[::1]:4318",
      "/backend-api/codex/responses",
      "POST",
    )?.operation).toBe("provider.inference");
    expect(classifyOutgoingTelemetryOperation("127.0.0.1", "/i/v1/traces", "POST")).toBeUndefined();
    expect(classifyOutgoingTelemetryOperation("127.0.0.1", "/i/v1/logs", "POST")).toBeUndefined();
    expect(classifyOutgoingTelemetryOperation("127.0.0.1", "/batch/", "POST")).toBeUndefined();
    expect(classifyOutgoingTelemetryOperation(
      "localhost",
      "/backend-api/codex/responses",
      "POST",
    )).toBeUndefined();

    process.env["NODE_ENV"] = "production";
    expect(classifyOutgoingTelemetryOperation(
      "127.0.0.1",
      "/backend-api/codex/responses",
      "POST",
    )).toBeUndefined();
  });
});
