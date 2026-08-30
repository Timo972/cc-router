import { describe, expect, it } from "vitest";
import { parseModelRef } from "../protocol/model-ref.js";

describe("parseModelRef", () => {
  it("routes openai-prefixed models to OpenAI subscription transport", () => {
    expect(parseModelRef("openai/gpt-5.5")).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/gpt-5.5",
      upstreamModel: "gpt-5.5",
    });
  });

  it("routes claude-prefixed models to Anthropic subscription transport", () => {
    expect(parseModelRef("claude/sonnet")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude/sonnet",
      upstreamModel: "claude-sonnet-4-5",
    });
  });

  it("routes unprefixed gpt-* models to OpenAI without a prefix", () => {
    // Codex writes the bare slug from its own registry — `model = "gpt-5.6-sol"`
    // in config.toml, or whatever its /model picker selects. Sending that to
    // the Anthropic path produced a 501 from the Responses ingress, and no
    // configuration could redirect it: `openAIAliases` is only consulted for
    // already-prefixed names.
    expect(parseModelRef("gpt-5.6-sol")).toEqual({
      provider: "openai_subscription",
      publicModel: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol",
    });
  });

  it("matches the gpt- prefix regardless of case", () => {
    expect(parseModelRef("GPT-5.6-Sol").provider).toBe("openai_subscription");
  });

  it("applies openAIAliases to an unprefixed gpt-* model", () => {
    // The same remapping the prefixed form gets, keyed on the bare name.
    expect(parseModelRef("gpt-5.6-sol", {
      openAIAliases: { "gpt-5.6-sol": "gpt-5.6-sol-2026-08-01" },
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "gpt-5.6-sol",
      upstreamModel: "gpt-5.6-sol-2026-08-01",
    });
  });

  it("leaves every other unprefixed model on the Anthropic default path", () => {
    expect(parseModelRef("claude-3-5-sonnet-latest")).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-3-5-sonnet-latest",
      upstreamModel: "claude-3-5-sonnet-latest",
    });
  });

  it("uses a configured Anthropic default when the client omits a model", () => {
    expect(parseModelRef(undefined, {
      anthropicDefaultModel: "claude-opus-4-1",
    })).toEqual({
      provider: "anthropic_subscription",
      publicModel: "claude-opus-4-1",
      upstreamModel: "claude-opus-4-1",
    });
  });

  it("lets deployments remap provider aliases to preferred upstream models", () => {
    expect(parseModelRef("claude/sonnet", {
      anthropicAliases: { "claude/sonnet": "claude-sonnet-4-6" },
    }).upstreamModel).toBe("claude-sonnet-4-6");

    expect(parseModelRef("openai/codex", {
      openAIAliases: { codex: "gpt-5-codex" },
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/codex",
      upstreamModel: "gpt-5-codex",
    });
  });

  it("resolves openai/default to the configured OpenAI default model", () => {
    expect(parseModelRef("openai/default", {
      openAIDefaultModel: "gpt-5-codex",
    })).toEqual({
      provider: "openai_subscription",
      publicModel: "openai/default",
      upstreamModel: "gpt-5-codex",
    });
  });
});
