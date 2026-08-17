import { EventEmitter } from "node:events";
import type { Response as ExpressResponse } from "express";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIAccount } from "../providers/openai/account-state.js";
import { OpenAITokenPool } from "../providers/openai/token-pool.js";
import {
  runOpenAIIngress,
  type OpenAIIngressTelemetry,
} from "../proxy/openai-ingress.js";
import { SessionRouter } from "../proxy/session-router.js";

const ACCOUNT_CANARY = "private-openai-account";
const SESSION_CANARY = "private-session-key";
const BODY_CANARY = "private-request-body";
const HEADER_CANARY = "private-upstream-header";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function makeTelemetry(mode: "enabled" | "disabled" | "failing") {
  const records: unknown[] = [];
  const record = (...values: unknown[]): void => {
    if (mode === "disabled") return;
    if (mode === "failing") throw new Error("telemetry transport failed");
    records.push(values);
  };
  const telemetry: OpenAIIngressTelemetry = {
    annotateActiveSpan: record,
    recordSafeLog: record,
    recordUnexpectedException: record,
  };
  return { records, telemetry };
}

describe("OpenAI routing and telemetry composition", () => {
  it.each(["enabled", "disabled", "failing"] as const)(
    "preserves sticky ingress behavior with telemetry %s",
    async mode => {
      const account = createOpenAIAccount({
        id: ACCOUNT_CANARY,
        provider: "openai_subscription",
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1_000,
        enabled: true,
      });
      const pool = new OpenAITokenPool([account]);
      const router = new SessionRouter(pool);
      const response = new FakeResponse();
      const forward = vi.fn(async () => new Response("upstream body", {
        status: 200,
        headers: { "x-private": HEADER_CANARY },
      }));
      const activity: unknown[] = [];
      const { records, telemetry } = makeTelemetry(mode);

      await runOpenAIIngress({
        res: response as unknown as ExpressResponse,
        sessionKey: SESSION_CANARY,
        requestedModel: "gpt-5.6-luna",
        path: "/v1/responses",
        requestSource: "api",
        openAIRouter: router,
        openAIPool: pool,
        prepareOpenAIAccount: async () => true,
        forwardOpenAI: forward,
        forwardBody: {
          model: "gpt-5.6-luna",
          input: [{ role: "user", content: BODY_CANARY }],
          stream: false,
        },
        recordActivity: entry => activity.push(entry),
        now: Date.now,
        envelope: {
          wrap: (type, message) => ({ error: { type, message } }),
          sendNoEligible: () => undefined,
        },
        relay: async (upstream, res) => {
          await upstream.text();
          (res as unknown as FakeResponse).status(upstream.status).json({ ok: true });
          return { statusCode: upstream.status };
        },
        telemetry,
      });

      expect(forward).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(activity).toHaveLength(1);
      expect(account.errorCount).toBe(0);

      if (mode === "enabled") {
        expect(records.length).toBeGreaterThan(0);
        const wire = JSON.stringify(records);
        expect(wire).toContain("proxy.request");
        for (const canary of [ACCOUNT_CANARY, SESSION_CANARY, BODY_CANARY, HEADER_CANARY]) {
          expect(wire).not.toContain(canary);
        }
      } else {
        expect(records).toEqual([]);
      }
    },
  );
});
