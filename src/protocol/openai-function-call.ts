export class OpenAIProtocolError extends Error {
  override name = "OpenAIProtocolError";
}

export function parseOpenAIFunctionArguments(argumentsJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new OpenAIProtocolError("Invalid OpenAI function call arguments");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OpenAIProtocolError("Invalid OpenAI function call arguments");
  }
  return parsed as Record<string, unknown>;
}
