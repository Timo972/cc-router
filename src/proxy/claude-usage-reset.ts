import type { Account } from "./types.js";
import { ResetNotSubmittedError } from "./reset-errors.js";
import { consumeClaudeLimitReset, type ClaudeResetResult } from "../providers/anthropic/usage-reset.js";

export interface ClaudeResetConsumerDeps {
  orgUuid(account: Account): Promise<string | undefined>;
  consume?: typeof consumeClaudeLimitReset;
}

const MAX_PINNED_PER_ACCOUNT = 8;

/**
 * Binds each redemption id to the grant it first targeted. A replay after an
 * unknown outcome must hit the same grant, or a moved `next_grant_id` would
 * turn "retry" into "spend a second reset".
 *
 * Pins are keyed by account id, not the Account object, so a re-auth that
 * replaces the object keeps them. Each account keeps its 8 most recent
 * request ids (oldest evicted first), so interleaved ids each keep their own
 * grant. A pin is written only right before the claim is sent: a refusal
 * before submission (409/503) leaves nothing pinned.
 */
export function createClaudeResetConsumer(deps: ClaudeResetConsumerDeps) {
  const consume = deps.consume ?? consumeClaudeLimitReset;
  const pinned = new Map<string /* account.id */, Map<string /* requestId */, string /* grantId */>>();
  return async (account: Account, requestId: string): Promise<ClaudeResetResult> => {
    let grantId = pinned.get(account.id)?.get(requestId);
    if (!grantId) {
      const resets = account.rateLimits.usage?.limitResets;
      grantId = resets?.eligible ? resets.nextGrantId : undefined;
      if (!grantId) throw new ResetNotSubmittedError(409, "No reset available for this account");
    }
    const org = await deps.orgUuid(account);
    if (!org) throw new ResetNotSubmittedError(503, "Organization unknown; reset not submitted");
    let pins = pinned.get(account.id);
    if (!pins) pinned.set(account.id, pins = new Map());
    if (!pins.has(requestId)) {
      pins.set(requestId, grantId);
      while (pins.size > MAX_PINNED_PER_ACCOUNT) pins.delete(pins.keys().next().value!);
    }
    return consume(account, org, grantId, requestId);
  };
}
