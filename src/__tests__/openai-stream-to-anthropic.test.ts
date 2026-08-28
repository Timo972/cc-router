import { describe, expect, it } from "vitest";
import { createOpenAIStreamToAnthropicNormalizer, openAIStreamEventToAnthropicEvents } from "../protocol/openai-stream-to-anthropic.js";

describe("openAIStreamEventToAnthropicEvents", () => {
  it("converts common Responses stream events to Anthropic message stream events", () => {
    const events = [
      ...openAIStreamEventToAnthropicEvents({
        type: "response.created",
        response: { id: "resp_1", model: "gpt-5.5" },
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "Hel",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.output_text.delta",
        delta: "lo",
      }),
      ...openAIStreamEventToAnthropicEvents({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.5",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_1",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      {
        type: "message_stop",
      },
    ]);
  });

  it("keeps text block state isolated per normalizer instance", () => {
    const first = createOpenAIStreamToAnthropicNormalizer();
    const second = createOpenAIStreamToAnthropicNormalizer();

    first.convert({ type: "response.created", response: { id: "first" } });
    second.convert({ type: "response.created", response: { id: "second" } });
    first.convert({ type: "response.output_text.delta", delta: "a" });

    expect(second.convert({ type: "response.output_text.delta", delta: "b" })).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "b" },
      },
    ]);
  });

  it("streams function calls as Anthropic tool_use blocks", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    const events = [
      ...normalizer.convert({ type: "response.created", response: { id: "resp_2", model: "gpt-5.5" } }),
      ...normalizer.convert({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "get_weather" },
      }),
      ...normalizer.convert({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{\"city\":\"Seoul\"}",
      }),
      ...normalizer.convert({ type: "response.output_item.done", output_index: 0 }),
      ...normalizer.convert({
        type: "response.completed",
        response: { id: "resp_2", usage: { input_tokens: 10, output_tokens: 4 } },
      }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_2",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"city\":\"Seoul\"}" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]);
  });

  it("keeps text and tool block indexes separate", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_3" } });

    expect(normalizer.convert({ type: "response.output_text.delta", output_index: 0, delta: "Checking." })[0])
      .toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    normalizer.convert({ type: "response.output_item.done", output_index: 0 });

    expect(normalizer.convert({
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "function_call", call_id: "call_2", name: "read_file" },
    })[0]).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_2", name: "read_file", input: {} },
    });
  });

  it("uses arguments from output_item.done when no argument events were sent", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_4" } });
    normalizer.convert({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_3", name: "read_file" },
    });

    expect(normalizer.convert({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", arguments: "{\"path\":\"README.md\"}" },
    })).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
  });

  it("streams refusal text and preserves the refusal stop reason", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    const events = [
      ...normalizer.convert({ type: "response.created", response: { id: "resp_refusal", model: "gpt-5.5" } }),
      ...normalizer.convert({ type: "response.refusal.delta", output_index: 0, delta: "I cannot help with that." }),
      ...normalizer.convert({ type: "response.output_item.done", output_index: 0 }),
      ...normalizer.convert({
        type: "response.completed",
        response: { id: "resp_refusal", usage: { input_tokens: 5, output_tokens: 6 } },
      }),
    ];

    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_refusal",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "I cannot help with that." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
      { type: "message_stop" },
    ]);
  });

  it("rejects streamed function calls without a call_id", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_invalid" } });

    expect(() => normalizer.convert({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", name: "read_file" },
    })).toThrow("Invalid OpenAI function call metadata");
  });

  it("rejects a streamed function call whose final arguments are invalid JSON", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_invalid" } });
    normalizer.convert({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "read_file" },
    });
    normalizer.convert({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: "{",
    });

    expect(() => normalizer.convert({
      type: "response.output_item.done",
      output_index: 0,
    })).toThrow("Invalid OpenAI function call arguments");
  });

  it("rejects response.completed while a streamed function call is still open", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_incomplete" } });
    normalizer.convert({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "read_file" },
    });
    normalizer.convert({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: "{}",
    });

    expect(() => normalizer.convert({
      type: "response.completed",
      response: { id: "resp_incomplete" },
    })).toThrow("OpenAI function call ended before completion");
  });

});
