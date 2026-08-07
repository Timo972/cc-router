import type { IncomingMessage } from "node:http";
import type { Response } from "express";
import type { NoEligibleAccountError } from "./account-pool.js";
import { extractClaudeSessionId } from "./anthropic-routing.js";
import { normalizeSessionId } from "./session-router.js";

const CODEX_SESSION_HEADER = "session_id";

/** Extract exactly one native HTTP header field without joined duplicates. */
function extractSingleHeader(request: IncomingMessage, name: string): string | undefined {
  const distinct = request.headersDistinct;
  if (distinct !== undefined) {
    const values = distinct[name];
    if (!values || values.length !== 1) return undefined;
    return normalizeSessionId(values[0]);
  }

  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1) return undefined;
  return normalizeSessionId(values[0]);
}

/**
 * Resolve the OpenAI affinity key in priority order: Codex session_id header,
 * Claude Code session header, then the request body's prompt_cache_key
 * (Codex thread id). Returns undefined for unscoped requests.
 */
export function extractCodexSessionKey(request: IncomingMessage, body: unknown): string | undefined {
  const codexSession = extractSingleHeader(request, CODEX_SESSION_HEADER);
  if (codexSession !== undefined) return codexSession;

  const claudeSession = extractClaudeSessionId(request);
  if (claudeSession !== undefined) return claudeSession;

  const promptCacheKey = body !== null && typeof body === "object"
    ? (body as { prompt_cache_key?: unknown }).prompt_cache_key
    : undefined;
  return normalizeSessionId(promptCacheKey);
}

/** Local OpenAI/Responses-shaped rejection — zero upstream requests were made. */
export function sendOpenAINoEligibleResponse(
  error: NoEligibleAccountError,
  response: Response,
  nowMs: number,
): void {
  if (error.reason === "rate_limited") {
    if (error.retryAtMs !== undefined) {
      const retryAfterSeconds = Math.max(0, Math.ceil((error.retryAtMs - nowMs) / 1_000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
    }
    response.status(429).json({
      error: {
        type: "rate_limit_exceeded",
        message: "All configured OpenAI accounts are currently rate limited",
      },
    });
    return;
  }

  response.status(503).json({
    error: {
      type: "service_unavailable",
      message: "All configured OpenAI accounts are currently unavailable",
    },
  });
}
