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

  it("closes the message on response.incomplete, mapping the token ceiling to max_tokens", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-luna" } });
    normalizer.convert({ type: "response.output_text.delta", delta: "Par" });

    // Without terminating the message the client is left waiting on a stream
    // that has already ended.
    expect(normalizer.convert({
      type: "response.incomplete",
      response: {
        id: "resp_1",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { output_tokens: 7 },
      },
    })).toEqual([
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ]);
  });

  it("falls back to end_turn for an incomplete response with another reason", () => {
    const normalizer = createOpenAIStreamToAnthropicNormalizer();
    normalizer.convert({ type: "response.created", response: { id: "resp_1" } });

    expect(normalizer.convert({
      type: "response.incomplete",
      response: { id: "resp_1", incomplete_details: { reason: "content_filter" }, usage: {} },
    })).toEqual([
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
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
});
