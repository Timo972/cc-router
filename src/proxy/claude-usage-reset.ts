import type { Account } from "./types.js";
import { ResetNotSubmittedError } from "./reset-errors.js";
import { consumeClaudeLimitReset, type ClaudeResetResult } from "../providers/anthropic/usage-reset.js";

export interface ClaudeResetConsumerDeps {
  orgUuid(account: Account): Promise<string | undefined>;
  consume?: typeof consumeClaudeLimitReset;
}

/**
 * Binds each redemption id to the grant it first targeted. A replay after an
 * unknown outcome must hit the same grant, or a moved `next_grant_id` would
 * turn "retry" into "spend a second reset".
 */
export function createClaudeResetConsumer(deps: ClaudeResetConsumerDeps) {
  const consume = deps.consume ?? consumeClaudeLimitReset;
  const pinned = new WeakMap<Account, { requestId: string; grantId: string }>();
  return async (account: Account, requestId: string): Promise<ClaudeResetResult> => {
    const prior = pinned.get(account);
    let grantId = prior?.requestId === requestId ? prior.grantId : undefined;
    if (!grantId) {
      const resets = account.rateLimits.usage?.limitResets;
      grantId = resets?.eligible ? resets.nextGrantId : undefined;
      if (!grantId) throw new ResetNotSubmittedError(409, "No reset available for this account");
    }
    const org = await deps.orgUuid(account);
    if (!org) throw new ResetNotSubmittedError(503, "Organization unknown; reset not submitted");
    pinned.set(account, { requestId, grantId });
    return consume(account, org, grantId, requestId);
  };
}
