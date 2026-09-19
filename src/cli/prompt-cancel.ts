import * as readline from "node:readline";

/**
 * Escape-to-cancel for the dashboard's interactive flows.
 *
 * `@inquirer/prompts` has no Escape handling of its own, but every prompt
 * takes an `AbortSignal`. While a flow runs we listen for the decoded Escape
 * key and abort the signal, which rejects the active prompt with an
 * `AbortPromptError` — the same shape a Ctrl-C produces, so callers treat
 * both as "the operator changed their mind".
 *
 * Decoded keys, not raw chunks: an arrow key is `ESC [ B`, and a terminal
 * transport may deliver the ESC in its own read. readline's keypress decoder
 * already holds a lone ESC for its escape-code timeout before calling it the
 * Escape key, and it is the same decoder the prompt reads from, so the two
 * can never disagree about what was pressed.
 */

export interface DecodedKey {
  name?: string;
  sequence?: string;
  meta?: boolean;
}

/** The Escape key itself — not an escape sequence and not an Alt-chord. */
export function isEscapeKey(key: DecodedKey | undefined): boolean {
  return key?.name === "escape" && key.sequence === "\x1b";
}

export async function withEscapeCancel<T>(
  flow: (signal: AbortSignal) => Promise<T>,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<T> {
  // Idempotent: the prompt's own readline interface installs the same decoder.
  readline.emitKeypressEvents(stdin);
  const controller = new AbortController();
  const onKeypress = (_input: string | undefined, key: DecodedKey | undefined) => {
    if (isEscapeKey(key)) controller.abort();
  };
  stdin.on("keypress", onKeypress);
  try {
    return await flow(controller.signal);
  } finally {
    stdin.off("keypress", onKeypress);
  }
}
