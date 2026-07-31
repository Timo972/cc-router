import { describe, expect, it } from "vitest";
import { extractAnthropicRouteContext } from "../proxy/request-model.js";

describe("extractAnthropicRouteContext", () => {
  it("normalizes a full Anthropic model ID into a bounded routing family", () => {
    expect(extractAnthropicRouteContext("claude-sonnet-4-5-20250929")).toEqual({
      requestedModel: "claude-sonnet-4-5-20250929",
      modelFamily: "sonnet",
    });
  });

  it("uses configured Anthropic aliases before normalizing the family", () => {
    expect(extractAnthropicRouteContext("fast", {
      anthropicAliases: { fast: "claude-haiku-4-5-20251001" },
    })).toEqual({
      requestedModel: "claude-haiku-4-5-20251001",
      modelFamily: "haiku",
    });
  });

  it("resolves claude/<alias> references", () => {
    expect(extractAnthropicRouteContext("claude/opus")).toEqual({
      requestedModel: "claude-opus-4-1",
      modelFamily: "opus",
    });
  });

  it.each([undefined, 42, { model: "claude-opus-4-1" }])(
    "uses the default Anthropic route for an absent or non-string model: %j",
    (model) => {
      expect(extractAnthropicRouteContext(model)).toEqual({
        requestedModel: "claude-sonnet-4-5",
        modelFamily: "sonnet",
      });
    },
  );

  it("keeps an unknown future model's normalized family bounded", () => {
    const model = `Claude Future Model ${"x".repeat(100)}`;
    const context = extractAnthropicRouteContext(model);

    expect(context).toEqual({
      requestedModel: model,
      modelFamily: "claude-future-model-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });
    expect(context?.modelFamily).toHaveLength(64);
  });

  it("does not produce Anthropic account-selection context for OpenAI routes", () => {
    expect(extractAnthropicRouteContext("openai/gpt-5.5")).toBeUndefined();
  });
});
