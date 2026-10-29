import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSessionResolveRequest,
  registerSessionResolveRoute,
  resolveSessionBinding,
} from "../proxy/session-resolve.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  cleanup.splice(0).reverse().forEach(dispose => dispose());
});

describe("parseSessionResolveRequest", () => {
  it("accepts exact provider values and normalizes bounded session IDs", () => {
    expect(parseSessionResolveRequest({
      provider: "anthropic",
      sessionId: " session-a ",
    })).toEqual({
      ok: true,
      request: {
        provider: "anthropic",
        sessionId: "session-a",
      },
    });
    expect(parseSessionResolveRequest({
      provider: "openai",
      sessionId: "session-b",
    })).toMatchObject({ ok: true });
  });

  it.each([
    null,
    [],
    "session-a",
    {},
    { provider: "anthropic" },
    { sessionId: "session-a" },
    { provider: "xai", sessionId: "session-a" },
    { provider: "Anthropic", sessionId: "session-a" },
    { provider: "anthropic", sessionId: "" },
    { provider: "anthropic", sessionId: " ".repeat(10) },
    { provider: "anthropic", sessionId: ["session-a"] },
    { provider: "anthropic", sessionId: "a".repeat(257) },
    { provider: "anthropic", sessionId: "session-a", extra: true },
  ])("rejects invalid input %#", (body) => {
    expect(parseSessionResolveRequest(body)).toEqual({
      ok: false,
      error: "Invalid session resolve request",
    });
  });
});

describe("resolveSessionBinding", () => {
  it("keeps provider routers separate and returns only the safe response fields", () => {
    const anthropicRouter = {
      resolve: vi.fn(() => ({ accountId: "claude-private", lastSeenAt: 123 })),
    };
    const openAIRouter = {
      resolve: vi.fn(() => ({ accountId: "codex-work", lastSeenAt: 456 })),
    };

    const result = resolveSessionBinding({
      provider: "openai",
      sessionId: "secret-session",
    }, { anthropicRouter, openAIRouter });

    expect(result).toEqual({
      status: 200,
      body: {
        accountId: "codex-work",
        provider: "openai",
        lastSeenAt: 456,
      },
    });
    expect(openAIRouter.resolve).toHaveBeenCalledWith("secret-session");
    expect(anthropicRouter.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-session");
  });

  it("returns not found without disclosing the session ID", () => {
    const result = resolveSessionBinding({
      provider: "anthropic",
      sessionId: "secret-session",
    }, {
      anthropicRouter: { resolve: () => undefined },
      openAIRouter: { resolve: () => undefined },
    });

    expect(result).toEqual({
      status: 404,
      body: { error: "Session binding not found" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-session");
  });
});

async function fixture() {
  const anthropicRouter = {
    resolve: vi.fn((sessionId: unknown) => (
      sessionId === "claude-session"
        ? { accountId: "info-private", lastSeenAt: 100 }
        : undefined
    )),
  };
  const openAIRouter = {
    resolve: vi.fn((sessionId: unknown) => (
      sessionId === "codex-session"
        ? { accountId: "work", lastSeenAt: 200 }
        : undefined
    )),
  };
  const app = express();
  registerSessionResolveRoute(app, { anthropicRouter, openAIRouter });
  const server: Server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/cc-router/sessions/resolve`;
  const request = (body: string | object) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { request };
}

describe("POST /cc-router/sessions/resolve", () => {
  it("returns 400 for malformed, invalid, and oversized input", async () => {
    const { request } = await fixture();

    expect((await request("{")).status).toBe(400);
    expect((await request({ provider: "xai", sessionId: "session-a" })).status).toBe(400);
    expect((await request({
      provider: "anthropic",
      sessionId: "session-a",
      padding: "x".repeat(2_000),
    })).status).toBe(400);
  });

  it("returns 404 for an unknown binding without echoing the session ID", async () => {
    const { request } = await fixture();
    const response = await request({
      provider: "anthropic",
      sessionId: "unknown-secret-session",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session binding not found" });
  });

  it("returns one safe provider-specific binding view", async () => {
    const { request } = await fixture();
    const response = await request({
      provider: "anthropic",
      sessionId: "claude-session",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      accountId: "info-private",
      provider: "anthropic",
      lastSeenAt: 100,
    });
    expect(JSON.stringify(body)).not.toContain("claude-session");
    expect(JSON.stringify(body)).not.toMatch(/generation|binding|sessionId/);
  });
});
