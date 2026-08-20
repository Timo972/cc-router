/**
 * A process-wide monotonic counter for ordering routing events against each
 * other.
 *
 * Wall-clock milliseconds cannot do this job. A 429 response, the header
 * snapshot taken from it, and the usage refresh the router starts in response
 * all happen inside one event-loop turn, so `Date.now()` returns the same value
 * for all three — measured at ~199 ties in 200 runs. Anything deciding whether
 * one of those events came after another needs an ordering that does not
 * collapse at millisecond resolution.
 *
 * Values are meaningless as timestamps and are never persisted or reported:
 * only their relative order carries information, and only within one process.
 */
let sequence = 0;

export function nextEventSequence(): number {
  return ++sequence;
}
