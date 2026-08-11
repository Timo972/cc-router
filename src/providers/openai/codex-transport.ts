import type { OpenAIResponsesRequest } from "../../protocol/openai-responses-types.js";
import type { OpenAISubscriptionAccount } from "./token-refresher.js";

const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_INSTRUCTIONS = "You are a concise coding assistant.";

export interface ForwardOpenAICodexResponseOptions {
  account: OpenAISubscriptionAccount;
  body: OpenAIResponsesRequest;
  stream: boolean;
}

export async function forwardOpenAICodexResponse(
  opts: ForwardOpenAICodexResponseOptions,
): Promise<Response> {
  const body = toCodexBackendRequest(opts.body);
  const upstream = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.account.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  return ensureEventStreamContentType(upstream);
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
