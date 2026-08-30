import { normalizeModelFamily } from "../providers/anthropic/usage.js";
import { parseModelRef, type ModelRoutingConfig } from "../protocol/model-ref.js";
import type { RouteContext } from "./types.js";

/**
 * Extract bounded Anthropic routing context from an incoming Messages model.
 * OpenAI-routed requests deliberately return no context because they never
 * enter the Anthropic account-selection middleware.
 */
export function extractAnthropicRouteContext(
  model: unknown,
  config: ModelRoutingConfig = {},
): RouteContext | undefined {
  const parsed = parseModelRef(typeof model === "string" ? model : undefined, config);
  if (parsed.provider !== "anthropic_subscription") return undefined;

  const modelFamily = normalizeModelFamily(parsed.upstreamModel);
  return {
    requestedModel: parsed.upstreamModel,
    ...(modelFamily ? { modelFamily } : {}),
  };
}
