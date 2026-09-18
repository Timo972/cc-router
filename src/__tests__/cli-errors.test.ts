import { describe, expect, it } from "vitest";
import { describeExpectedCliError, CliUsageError } from "../cli/cli-errors.js";
import { SetupDiagnosticError } from "../telemetry/setup-diagnostics.js";

/**
 * Colour is stripped by chalk when the suite runs without a TTY, but a CI that
 * forces colour would wrap the text in escapes — assert on the text only.
 */
function text(value: string | undefined): string {
  return (value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("describeExpectedCliError", () => {
  it("describes a missing claude CLI as one expected line", () => {
    const error = new SetupDiagnosticError(
      "Claude Code CLI not found on PATH. Install it or use `cc-router accounts add claude` to import an existing login.",
      { stage: "credential_read", reason: "not_found", expected: true },
    );

    const described = describeExpectedCliError(error);

    expect(described).not.toBeNull();
    expect(text(described?.message)).toBe("✗ Claude Code CLI not found on PATH. Install it or use `cc-router accounts add claude` to import an existing login.");
    expect(described?.exitCode).toBe(1);
  });

  it("describes a cancelled browser sign-in as one expected line", () => {
    const error = new SetupDiagnosticError("claude auth login was cancelled or failed", {
      stage: "credential_read",
      reason: "user_cancelled",
      expected: true,
    });

    const described = describeExpectedCliError(error);

    expect(text(described?.message)).toBe("✗ claude auth login was cancelled or failed");
    expect(described?.exitCode).toBe(1);
  });

  it("describes an unknown provider argument as one expected line", () => {
    const described = describeExpectedCliError(
      new CliUsageError('Unknown provider "bing" — use claude, openai or grok'),
    );

    expect(text(described?.message)).toBe('✗ Unknown provider "bing" — use claude, openai or grok');
    expect(described?.exitCode).toBe(1);
  });

  it("describes Ctrl+C in a prompt as a cancellation", () => {
    const error = new Error("User force closed the prompt");
    error.name = "ExitPromptError";

    const described = describeExpectedCliError(error);

    expect(text(described?.message)).toBe("Cancelled.");
    expect(described?.exitCode).toBe(130);
  });

  it("leaves an unexpected setup failure to Node, stack and all", () => {
    expect(describeExpectedCliError(new SetupDiagnosticError("boom", {
      stage: "credential_read",
      reason: "other",
      expected: false,
    }))).toBeNull();
  });

  it("leaves any other error to Node, stack and all", () => {
    expect(describeExpectedCliError(new Error("kaboom"))).toBeNull();
    expect(describeExpectedCliError("not even an error")).toBeNull();
    expect(describeExpectedCliError(undefined)).toBeNull();
  });
});
