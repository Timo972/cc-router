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
 * Longest the retry loop will wait for a failover account's token refresh
 * while an upstream failure response sits ready to relay. Refreshes normally
 * settle within a couple of seconds; the refresh fetch itself carries no
 * deadline, and the pre-response proxy timeout was already disarmed when the
 * failure's headers arrived — so without this bound a stalled OAuth endpoint
 * could withhold a ready 429/5xx for minutes. Generous on purpose: the
 * fallback is relaying a failure the client may not recover from, so a slow
 * but working refresh deserves the extra seconds.
 */
export const RETRY_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Await `work` for at most `ms`, resolving to `fallback` when the deadline
 * passes or `signal` aborts first. `work` is NOT cancelled — a token refresh
 * that settles late still updates its account for future requests — the
 * caller merely stops waiting for it, and a late rejection is swallowed so
 * abandoning the wait can never surface an unhandled rejection. A rejection
 * inside the deadline also resolves to `fallback`; callers that need to tell
 * failure from timeout map their promise to a value before waiting.
 */
export function boundedWait<T, F>(
  work: Promise<T>,
  ms: number,
  fallback: F,
  signal?: AbortSignal,
): Promise<T | F> {
  return new Promise<T | F>(resolve => {
    let settled = false;
    const finish = (value: T | F) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(fallback);
    const timer = setTimeout(() => finish(fallback), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    work.then(finish, () => finish(fallback));
  });
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
