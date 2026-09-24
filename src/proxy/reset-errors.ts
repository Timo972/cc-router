/** The redemption was provably never sent (or rejected before spending); safe to report as "nothing used". */
export class ResetNotSubmittedError extends Error {
  /**
   * @param abandon The client's pending redemption id can never be retried
   *   safely (its grant binding is gone); the client should drop it and look
   *   at fresh usage before starting a new redemption.
   * @param pendingRedemption An earlier, unresolved redemption id for this
   *   account that the client should retry instead of starting a new one.
   */
  constructor(
    readonly status: 409 | 503,
    message: string,
    readonly abandon = false,
    readonly pendingRedemption?: string,
  ) {
    super(message);
    this.name = "ResetNotSubmittedError";
  }
}

export const RESET_OUTCOME_UNKNOWN = "Reset outcome unknown; retry with the same redemption ID";
