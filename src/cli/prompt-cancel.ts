/**
 * Escape-to-cancel for the dashboard's interactive flows.
 *
 * `@inquirer/prompts` has no Escape handling of its own, but every prompt
 * takes an `AbortSignal`. While a flow runs we watch stdin for a bare
 * Escape byte (arrow keys arrive as multi-byte sequences and are left alone)
 * and abort the signal, which rejects the active prompt with an
 * `AbortPromptError` — the same shape a Ctrl-C produces, so callers treat
 * both as "the operator changed their mind".
 */

/** A lone ESC byte. Escape sequences (`\x1b[A`, `\x1bOA`) are longer. */
export function isEscapeKey(chunk: Buffer | string): boolean {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return text === "\x1b";
}

export async function withEscapeCancel<T>(
  flow: (signal: AbortSignal) => Promise<T>,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<T> {
  const controller = new AbortController();
  const onData = (chunk: Buffer | string) => {
    if (isEscapeKey(chunk)) controller.abort();
  };
  stdin.on("data", onData);
  try {
    return await flow(controller.signal);
  } finally {
    stdin.off("data", onData);
  }
}
