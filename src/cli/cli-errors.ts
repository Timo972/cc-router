/**
 * The line between "the operator needs to read one sentence" and "this is a
 * bug worth a stack trace".
 *
 * Keeping the decision here — rather than inline in `index.ts` — is what lets
 * it be tested without parsing a command line, and what keeps the entry point
 * to a single `.catch()`.
 */
import chalk from "chalk";
import { SetupDiagnosticError, isPromptCancellation } from "../telemetry/setup-diagnostics.js";

/**
 * A wrong argument, not a failure: the command never started work, so there is
 * nothing to diagnose beyond the sentence telling the operator what to type.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ExpectedCliError {
  /** Ready to print as-is, colour included. */
  message: string;
  exitCode: number;
}

/**
 * Describe an error the CLI expects to hit — a missing `claude` binary, a
 * sign-in the operator closed, a mistyped provider, Ctrl+C at a prompt — or
 * `null` for anything else, which must keep surfacing with its stack so a real
 * bug is never quietly downgraded to a one-liner.
 */
export function describeExpectedCliError(error: unknown): ExpectedCliError | null {
  // 130 = terminated by SIGINT, which is what Ctrl+C at a prompt means.
  if (isPromptCancellation(error)) return { message: chalk.gray("Cancelled."), exitCode: 130 };
  if (error instanceof CliUsageError) return { message: chalk.red(`✗ ${error.message}`), exitCode: 1 };
  if (error instanceof SetupDiagnosticError && error.classification.expected) {
    return { message: chalk.red(`✗ ${error.message}`), exitCode: 1 };
  }
  return null;
}
