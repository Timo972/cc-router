import { describe, expect, it } from "vitest";
import { openAIResponsesToAnthropic } from "../protocol/openai-to-anthropic.js";

describe("openAIResponsesToAnthropic", () => {
  it("maps a Responses request to Anthropic Messages", () => {
    const result = openAIResponsesToAnthropic({
      model: "claude/sonnet",
      instructions: "Be direct.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this." }],
        },
      ],
      max_output_tokens: 512,
      stream: true,
    });

    expect(result).toEqual({
      model: "claude-sonnet-4-5",
      system: "Be direct.",
      messages: [
        { role: "user", content: "Summarize this." },
      ],
      max_tokens: 512,
      stream: true,
    });
  });

  it("maps top-level function call items to adjacent Anthropic messages", () => {
    const result = openAIResponsesToAnthropic({
      model: "anthropic/claude-opus-4-1",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Read it." }] },
        { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
        { type: "function_call_output", call_id: "call_1", output: "CC-Router" },
      ],
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Read it." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "CC-Router" }] },
    ]);
  });
});
