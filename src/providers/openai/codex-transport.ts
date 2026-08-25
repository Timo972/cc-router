import type { OpenAIResponsesRequest } from "../../protocol/openai-responses-types.js";
import {
  classifyExpectedRuntimeFailure,
  recordSafeLog,
  recordUnexpectedException,
} from "../../telemetry/facade.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";

const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_INSTRUCTIONS = "You are a concise coding assistant.";

export interface ForwardOpenAICodexResponseOptions {
  account: OpenAISubscriptionAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
  /** Aborted when the client disconnects, so a request nobody is waiting for
   *  stops occupying an upstream slot on the account. */
  signal?: AbortSignal;
  /** One-based router attempt for failover/retry correlation. */
  attempt?: number;
}

export async function forwardOpenAICodexResponse(
  opts: ForwardOpenAICodexResponseOptions,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const body = toCodexBackendRequest(opts.body);
    const upstream = await fetch(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.account.accessToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const outcome = responseOutcome(upstream.status);
    if (upstream.status === 401 || upstream.status === 403
      || upstream.status === 429 || upstream.status >= 500) {
      recordSafeLog({
        operation: "provider.inference",
        provider: "openai",
        reason: responseReason(upstream.status),
        outcome,
        httpStatusCode: upstream.status,
        attempt: opts.attempt,
        operationDurationMs: Date.now() - startedAt,
        severity: "warn",
      });
    }
    return ensureEventStreamContentType(upstream);
  } catch (error) {
    const reason = classifyExpectedRuntimeFailure(error);
    const outcome = reason === "timeout" ? "timeout" : "upstream_error";
    if (reason) {
      recordSafeLog({
        operation: "provider.inference",
        provider: "openai",
        reason,
        outcome,
        attempt: opts.attempt,
        operationDurationMs: Date.now() - startedAt,
        severity: "error",
      });
    } else {
      recordUnexpectedException(error, {
        category: "runtime",
        reason: "other",
        operation: "provider.inference",
        provider: "openai",
      });
    }
    throw error;
  }
}

function responseOutcome(status: number): "complete" | "rate_limited" | "upstream_error" {
  if (status >= 200 && status < 400) return "complete";
  return status === 429 ? "rate_limited" : "upstream_error";
}

function responseReason(status: number): "unauthorized" | "forbidden" | "rate_limited" | "upstream_5xx" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "upstream_5xx";
}

export function toCodexBackendRequest(body: OpenAIResponsesRequest): OpenAIResponsesRequest & {
  instructions: string;
  store: false;
  stream: true;
} {
  const { max_output_tokens: _maxOutputTokens, ...rest } = body;
  return {
    ...rest,
    instructions: body.instructions?.trim() || DEFAULT_CODEX_INSTRUCTIONS,
    store: false,
    stream: true,
  };
}

function ensureEventStreamContentType(upstream: Response): Response {
  const contentType = upstream.headers.get("content-type");
  if (contentType?.includes("text/event-stream")) return upstream;

  // Only a successful response is actually an event stream that lost its
  // content-type header. A non-OK response (401/429/5xx) is typically a
  // plain JSON or text error body — rewriting its content-type would make
  // callers parse it as SSE and misreport a real upstream failure as an
  // empty success. Let it pass through with whatever content-type it has.
  if (!upstream.ok) return upstream;

  const headers = new Headers(upstream.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
