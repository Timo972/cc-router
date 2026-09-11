import type { Account, AccountRateLimits } from "../../proxy/types.js";
import { nextEventSequence } from "../../proxy/event-sequence.js";

/**
 * Rate-limit extraction from Anthropic's unified response headers. Lives
 * apart from the server so both Anthropic transports (the generic /v1 proxy
 * and the retrying /v1/messages route) capture the same snapshot.
 */

function inferPlan(requestsLimit: number): string {
  if (requestsLimit <= 0) return "";
  if (requestsLimit <= 100) return "Pro";
  if (requestsLimit <= 500) return "Max 5x";
  return "Max 20x";
}

function extractRateLimits(headers: Record<string, string | string[] | undefined>): AccountRateLimits | null {
  const h = (name: string) => String(headers[name] ?? "");
  const status = h("anthropic-ratelimit-unified-status");
  if (!status) return null; // No unified headers in this response

  const requestsLimit = parseInt(h("anthropic-ratelimit-requests-limit"), 10) || 0;

  return {
    status: status === "rate_limited" ? "rate_limited" : "allowed",
    fiveHourUtil: parseFloat(h("anthropic-ratelimit-unified-5h-utilization")) || 0,
    fiveHourReset: parseInt(h("anthropic-ratelimit-unified-5h-reset"), 10) || 0,
    sevenDayUtil: parseFloat(h("anthropic-ratelimit-unified-7d-utilization")) || 0,
    sevenDayReset: parseInt(h("anthropic-ratelimit-unified-7d-reset"), 10) || 0,
    claim: h("anthropic-ratelimit-unified-representative-claim"),
    plan: inferPlan(requestsLimit),
    requestsLimit,
    lastUpdated: Date.now(),
    // Wall-clock ms ties with the usage refresh the router starts from this
    // same response, so the ordering token is what makes them comparable.
    lastUpdatedSeq: nextEventSequence(),
  };
}

/** Apply upstream rate-limit headers without discarding the usage snapshot. */
export function applyRateLimitHeaders(
  account: Account,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const rateLimits = extractRateLimits(headers);
  if (!rateLimits) return false;
  account.rateLimits = { ...account.rateLimits, ...rateLimits };
  return true;
}
