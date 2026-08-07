import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { NoEligibleAccountError } from "../proxy/account-pool.js";
import { extractCodexSessionKey, sendOpenAINoEligibleResponse } from "../proxy/openai-routing.js";

function fakeRequest(headers: Record<string, string[]>): IncomingMessage {
  const rawHeaders: string[] = [];
  for (const [name, values] of Object.entries(headers)) {
    for (const value of values) rawHeaders.push(name, value);
  }
  return { headersDistinct: headers, rawHeaders } as unknown as IncomingMessage;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; },
  };
}

describe("extractCodexSessionKey", () => {
  it("prefers the Codex session_id header", () => {
    const request = fakeRequest({
      "session_id": ["codex-session"],
      "x-claude-code-session-id": ["claude-session"],
    });
    expect(extractCodexSessionKey(request, { prompt_cache_key: "cache-key" })).toBe("codex-session");
  });

  it("falls back to x-claude-code-session-id, then prompt_cache_key", () => {
    expect(extractCodexSessionKey(
      fakeRequest({ "x-claude-code-session-id": ["claude-session"] }),
      { prompt_cache_key: "cache-key" },
    )).toBe("claude-session");
    expect(extractCodexSessionKey(fakeRequest({}), { prompt_cache_key: "cache-key" })).toBe("cache-key");
    expect(extractCodexSessionKey(fakeRequest({}), {})).toBeUndefined();
  });

  it("ignores duplicated and oversized headers", () => {
    expect(extractCodexSessionKey(
      fakeRequest({ "session_id": ["one", "two"] }),
      {},
    )).toBeUndefined();
    expect(extractCodexSessionKey(
      fakeRequest({ "session_id": ["x".repeat(300)] }),
      {},
    )).toBeUndefined();
  });

  it("rejects non-string prompt_cache_key values", () => {
    expect(extractCodexSessionKey(fakeRequest({}), { prompt_cache_key: 42 })).toBeUndefined();
    expect(extractCodexSessionKey(fakeRequest({}), null)).toBeUndefined();
  });
});

describe("sendOpenAINoEligibleResponse", () => {
  it("sends a 429 with Retry-After in the OpenAI error envelope", () => {
    const response = fakeResponse();
    const error = new NoEligibleAccountError("rate_limited", 2, 1_754_000_060_000);
    sendOpenAINoEligibleResponse(error, response as never, 1_754_000_000_000);
    expect(response.statusCode).toBe(429);
    expect(response.headers["Retry-After"]).toBe("60");
    expect(response.body).toEqual({
      error: { type: "rate_limit_exceeded", message: expect.stringContaining("rate limited") },
    });
  });

  it("sends a 503 service_unavailable when no retry time is known", () => {
    const response = fakeResponse();
    sendOpenAINoEligibleResponse(new NoEligibleAccountError("unavailable", 1), response as never, 0);
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: { type: "service_unavailable", message: expect.any(String) },
    });
  });
});
