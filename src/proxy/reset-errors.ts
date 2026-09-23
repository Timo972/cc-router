/** The redemption was provably never sent (or rejected before spending); safe to report as "nothing used". */
export class ResetNotSubmittedError extends Error {
  constructor(readonly status: 409 | 503, message: string) {
    super(message);
    this.name = "ResetNotSubmittedError";
  }
}

export const RESET_OUTCOME_UNKNOWN = "Reset outcome unknown; retry with the same redemption ID";
