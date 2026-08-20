/**
 * Shared policy for router-side upstream retries. Both providers consult the
 * same rules so a 429 fails over and a 5xx retries identically whether the
 * request came from Claude Code or the Codex CLI.
 *
 * The policy deliberately lives apart from either transport: it must only be
 * applied BEFORE any response bytes have been relayed to a client, and the
 * decision of when that is remains each transport's own.
 */

/** Total upstream attempts per client request, the first one included. */
export const MAX_UPSTREAM_ATTEMPTS = 3;

/**
 * Pause before re-sending to the SAME account (a plain 5xx applies no
 * cooldown and keeps the sticky binding, so re-acquisition returns the
 * account that just failed). An immediate replay would hit whatever
 * transient condition produced the 5xx still in progress; failovers to a
 * different account skip the delay entirely.
 */
export const SAME_ACCOUNT_RETRY_DELAY_MS = 500;

/**
 * Which upstream statuses the router may retry on its own. 429 fails over to
 * a different account; 5xx (including Anthropic's 529 and Codex's 503
 * overloads, whose cooldowns rebind the session elsewhere) retries per the
 * pool's routing rules. 401 is deliberately absent: auth failures pass
 * through while a background token refresh runs, exactly as before.
 */
export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts — a client that hung up
 * must not keep a retry pending. Never rejects.
 */
export function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
