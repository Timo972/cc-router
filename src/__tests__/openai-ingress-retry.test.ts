import { describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import { mountResponsesRoutes } from "../proxy/responses-server.js";
import type { ResponsesRoutesOptions } from "../proxy/responses-server.js";
import type { OpenAIResponsesRequest } from "../protocol/openai-responses-types.js";
import { SessionRouter } from "../proxy/session-router.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import { createOpenAIAccount, type OpenAIAccount } from "../providers/openai/account-state.js";
import type { LogEntry } from "../proxy/stats.js";

type ForwardOpenAI = (opts: {
  account: OpenAIAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
  signal?: AbortSignal;
}) => Promise<Response>;

async function withServer(
  app: ReturnType<typeof express>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function makeRuntimeAccount(id: string): OpenAIAccount {
  return createOpenAIAccount({
    id,
    provider: "openai_subscription",
    accessToken: "header.e30.sig",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    enabled: true,
  });
}

function mountWithPool(
  accounts: OpenAIAccount[],
  forwardOpenAI: ForwardOpenAI,
  extra: Partial<ResponsesRoutesOptions> = {},
) {
  const app = express();
  const openAIPool = new OpenAITokenPool(accounts);
  const openAIRouter = new SessionRouter<OpenAIAccount>(openAIPool);
  const activity: LogEntry[] = [];
  mountResponsesRoutes(app, {
    openAIRouter,
    openAIPool,
    forwardOpenAI,
    recordActivity: entry => activity.push(entry),
    sameAccountRetryDelayMs: 5,
    ...extra,
  });
  return { app, openAIPool, openAIRouter, activity };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function postResponses(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", session_id: "codex-session-1" },
    body: JSON.stringify({ model: "openai/gpt-5.5", input: [], ...body }),
  });
}

describe("runOpenAIIngress upstream retry", () => {
  it("fails a 429 over to a different account and relays only the successful response", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      if (attempts.length === 1) {
        return jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "60" });
      }
      return jsonResponse(200, { id: "resp_ok", output: [], usage: {} });
    };
    const accounts = [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")];
    const { app, openAIPool, activity } = mountWithPool(accounts, forward);

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "resp_ok", output: [], usage: {} });
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    const failed = accounts.find(a => a.id === attempts[0])!;
    expect(failed.errorCount).toBe(1);
    expect(openAIPool.getCooldownView(failed.id).globalUntilMs).toBeGreaterThan(Date.now());

    expect(activity).toHaveLength(2);
    expect(activity[0]).toEqual(expect.objectContaining({
      type: "error",
      statusCode: 429,
      accountId: attempts[0],
      details: expect.stringContaining(":will-retry"),
    }));
    expect(activity[1]).toEqual(expect.objectContaining({
      type: "route",
      statusCode: 200,
      accountId: attempts[1],
    }));
  });

  it("retries a 500 on the same account and succeeds", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      if (attempts.length === 1) return jsonResponse(500, { error: { message: "boom" } });
      return jsonResponse(200, { id: "resp_ok", output: [], usage: {} });
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-solo")], forward);

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(200);
    });

    expect(attempts).toEqual(["openai-solo", "openai-solo"]);
    expect(activity[0]).toEqual(expect.objectContaining({
      type: "error",
      statusCode: 500,
      details: expect.stringContaining(":will-retry"),
    }));
    expect(activity[1]).toEqual(expect.objectContaining({ type: "route", statusCode: 200 }));
  });

  it("relays the original 429 unchanged when no other account is eligible", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      return jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "60" });
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-solo")], forward);

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toEqual({ error: { message: "rate limited" } });
    });

    // The single account's 429 cooldown makes re-acquisition throw, so exactly
    // one upstream attempt happens and the response passes through unchanged.
    expect(attempts).toEqual(["openai-solo"]);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toEqual(expect.objectContaining({ type: "error", statusCode: 429 }));
    expect(activity[0]!.details).not.toContain(":will-retry");
  });

  it("stops after the attempt budget and relays the final failure", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      return jsonResponse(500, { error: { message: "boom" } });
    };
    const { app, activity } = mountWithPool([makeRuntimeAccount("openai-solo")], forward);

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(500);
    });

    expect(attempts).toEqual(["openai-solo", "openai-solo", "openai-solo"]);
    expect(activity).toHaveLength(3);
    expect(activity[0]!.details).toContain(":will-retry");
    expect(activity[1]!.details).toContain(":will-retry");
    expect(activity[2]!.details).not.toContain(":will-retry");
  });

  it("relays the held failure when the failover account's prepare stalls", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      return jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "60" });
    };
    const prepare = vi.fn((): Promise<boolean> =>
      prepare.mock.calls.length === 1 ? Promise.resolve(true) : new Promise(() => {}));
    const { app, activity } = mountWithPool(
      [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")],
      forward,
      { prepareOpenAIAccount: prepare, retryRefreshTimeoutMs: 50 },
    );

    await withServer(app, async baseUrl => {
      const start = Date.now();
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(Date.now() - start).toBeLessThan(5_000);
    });

    // The idle second account was acquired, but its stalled token prepare
    // must not withhold the ready 429 — one upstream attempt, relayed as-is.
    expect(attempts).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(activity.at(-1)).toEqual(expect.objectContaining({ type: "error", statusCode: 429 }));
  }, 10_000);

  it("relays every failure unchanged when maxAttempts is 1 (autoFailover: false)", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      return jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "60" });
    };
    const { app, activity } = mountWithPool(
      [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")],
      forward,
      { maxAttempts: 1 },
    );

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
    });

    // An idle second account exists, but the single-attempt budget (the
    // autoFailover: false wiring) relays the 429 straight through.
    expect(attempts).toHaveLength(1);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).not.toContain(":will-retry");
  });

  it("never retries a non-retryable failure", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      return jsonResponse(401, { error: { message: "bad token" } });
    };
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")],
      forward,
    );

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, {});
      expect(res.status).toBe(401);
    });

    expect(attempts).toHaveLength(1);
  });

  it("fails a streaming request over on 429 and relays the second account's SSE bytes", async () => {
    const sse = [
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{}}}\n\n",
    ].join("");
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      if (attempts.length === 1) {
        return jsonResponse(429, { error: { message: "rate limited" } });
      }
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")],
      forward,
    );

    await withServer(app, async baseUrl => {
      const res = await postResponses(baseUrl, { stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(await res.text()).toBe(sse);
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
  });

  it("moves the sticky session binding to the failover account", async () => {
    const attempts: string[] = [];
    const forward: ForwardOpenAI = async ({ account }) => {
      attempts.push(account.id);
      if (attempts.length === 1) return jsonResponse(429, { error: { message: "rate limited" } });
      return jsonResponse(200, { id: "resp_ok", output: [], usage: {} });
    };
    const { app } = mountWithPool(
      [makeRuntimeAccount("openai-a"), makeRuntimeAccount("openai-b")],
      forward,
    );

    await withServer(app, async baseUrl => {
      const first = await postResponses(baseUrl, {});
      expect(first.status).toBe(200);
      // A follow-up request on the same session sticks to the account that
      // actually served the previous turn, not the one that 429ed.
      const second = await postResponses(baseUrl, {});
      expect(second.status).toBe(200);
    });

    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toBe(attempts[1]);
  });
});
