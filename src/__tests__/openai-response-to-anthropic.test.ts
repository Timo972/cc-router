import { describe, expect, it } from "vitest";
import { openAIResponseToAnthropicMessage } from "../protocol/openai-response-to-anthropic.js";

describe("openAIResponseToAnthropicMessage", () => {
  it("maps a completed OpenAI Responses JSON body to an Anthropic message JSON body", () => {
    expect(openAIResponseToAnthropicMessage({
      id: "resp_1",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Done." },
          ],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    })).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [
        { type: "text", text: "Done." },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
      },
    });
  });

  it("maps function calls to ordered Anthropic tool blocks", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_2",
      model: "gpt-5.5",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });

    expect(result.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Seoul" } },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("ignores reasoning output items instead of turning them into tool calls", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_reasoning",
      model: "gpt-5.5",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] } as never,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      ],
    });

    expect(result.content).toEqual([{ type: "text", text: "Done." }]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("preserves refusal content and its stop reason", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_refusal",
      model: "gpt-5.5",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I cannot help with that." } as never],
      }],
    });

    expect(result.content).toEqual([{ type: "text", text: "I cannot help with that." }]);
    expect(result.stop_reason).toBe("refusal");
  });

  it("ignores unsupported message content instead of treating it as a refusal", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_unknown_content",
      output: [{
        type: "message",
        role: "assistant",
        content: [
          { type: "audio", id: "audio_1" } as never,
          { type: "output_text", text: "Done." },
        ],
      }],
    });

    expect(result.content).toEqual([{ type: "text", text: "Done." }]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a scalar", "1"],
  ])("rejects function arguments containing %s", (_case, argumentsJson) => {
    expect(() => openAIResponseToAnthropicMessage({
      id: "resp_invalid_tool",
      output: [{
        type: "function_call",
        call_id: "call_1",
        name: "dangerous_default_tool",
        arguments: argumentsJson,
      }],
    })).toThrow("Invalid OpenAI function call arguments");
  });

  it.each([
    ["call_id", { call_id: "", name: "read_file" }],
    ["name", { call_id: "call_1", name: "" }],
  ])("rejects function calls without a valid %s", (_field, metadata) => {
    expect(() => openAIResponseToAnthropicMessage({
      id: "resp_invalid_tool",
      output: [{
        type: "function_call",
        ...metadata,
        arguments: "{}",
      }],
    })).toThrow("Invalid OpenAI function call metadata");
  });
});
