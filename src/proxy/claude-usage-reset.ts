import type { Account, LimitResetGrant } from "./types.js";
import { ResetNotSubmittedError } from "./reset-errors.js";
import { consumeClaudeLimitReset, type ClaudeResetResult } from "../providers/anthropic/usage-reset.js";

export interface ClaudeResetConsumerDeps {
  orgUuid(account: Account): Promise<string | undefined>;
  consume?: typeof consumeClaudeLimitReset;
}

export interface ClaudeResetAttempt {
  /** The client already sent this id once and never learned the outcome. */
  retry?: boolean;
  /**
   * The terms the operator confirmed (use-by, refill windows), as shown from
   * the public summary. Required for a new id: grant ids never leave the
   * router, so the terms are what binds the spend to the confirmation.
   */
  offer?: unknown;
}

/** Whether the confirmed terms are exactly the next grant's, as publicLimitResets shows them. */
function offerMatches(offer: unknown, grant: LimitResetGrant): boolean {
  if (typeof offer !== "object" || offer === null) return false;
  const { useBy, clears, clearsOther } = offer as Record<string, unknown>;
  return useBy === (grant.endsAt > 0 ? grant.endsAt : 0)
    && Array.isArray(clears) && clears.length === grant.clears.length && clears.every((w, i) => w === grant.clears[i])
    && clearsOther === grant.clearsOther;
}

const MAX_PINNED_PER_ACCOUNT = 8;

/**
 * Binds each redemption id to the grant and organization it first targeted. A replay after an
 * unknown outcome must hit the same grant, or a moved `next_grant_id` would
 * turn "retry" into "spend a second reset".
 *
 * Pins are keyed by account id, not the Account object, so a re-auth that
 * replaces the object keeps them. They live in memory only, and each account
 * keeps its 8 most recent ids. A retry whose pin is gone (router restart,
 * eviction) is refused before sending rather than re-derived: its original
 * grant can no longer be named, and only fresh usage can tell whether it was
 * spent. A pin is written only right before the claim is sent, and dropped
 * again if that first claim provably never left (409/503): a refusal before
 * submission leaves nothing pinned.
 *
 * The returned `resetsLeft` is account-wide (the redeemed grant's count plus
 * the other non-paused grants), matching the rst column.
 */
export function createClaudeResetConsumer(deps: ClaudeResetConsumerDeps) {
  const consume = deps.consume ?? consumeClaudeLimitReset;
  const pinned = new Map<string /* account.id */, Map<string /* requestId */, { grantId: string; org: string }>>();
  const run = async (account: Account, requestId: string, attempt: ClaudeResetAttempt = {}): Promise<ClaudeResetResult> => {
    const pin = pinned.get(account.id)?.get(requestId);
    let grantId = pin?.grantId;
    if (!grantId) {
      if (attempt.retry) {
        throw new ResetNotSubmittedError(409,
          "Earlier reset attempt can't be matched any more (router restarted?) — check rst before redeeming again; nothing sent", true);
      }
      const usage = account.rateLimits.usage;
      if (usage?.fetchStatus !== "fresh") throw new ResetNotSubmittedError(409, "Reset status is stale — reload with R; nothing sent");
      const resets = usage.limitResets;
      const next = resets?.eligible ? resets.grants.find(grant => grant.id === resets.nextGrantId) : undefined;
      if (!next) throw new ResetNotSubmittedError(409, "No reset available for this account");
      if (next.clears.length === 0) {
        throw new ResetNotSubmittedError(409, "Reset refill scope unknown — update cc-router; nothing sent");
      }
      if (!offerMatches(attempt.offer, next)) {
        throw new ResetNotSubmittedError(409, "Reset offer changed since you confirmed — review it and confirm again; nothing sent");
      }
      grantId = next.id;
    }
    const org = await deps.orgUuid(account);
    if (!org) throw new ResetNotSubmittedError(503, "Organization unknown; reset not submitted");
    // Grant ids are shared across accounts: re-authenticating this id as a
    // different Anthropic account must not aim the old claim at the new
    // organization's reset. Only its own organization can settle it.
    if (pin && pin.org !== org) {
      throw new ResetNotSubmittedError(409,
        "Account now signs in to a different organization than the earlier reset attempt — check rst before redeeming again; nothing sent", true);
    }
    let pins = pinned.get(account.id);
    if (!pins) pinned.set(account.id, pins = new Map());
    const firstAttempt = !pins.has(requestId);
    if (firstAttempt) {
      pins.set(requestId, { grantId, org });
      while (pins.size > MAX_PINNED_PER_ACCOUNT) pins.delete(pins.keys().next().value!);
    }
    // Other grants are untouched by this claim; summing them with the
    // returned per-grant count matches the rst column (non-paused grants).
    const othersLeft = (account.rateLimits.usage?.limitResets?.grants ?? [])
      .filter(grant => grant.id !== grantId && !grant.paused)
      .reduce((sum, grant) => sum + grant.resetsLeft, 0);
    let result: ClaudeResetResult;
    try {
      result = await consume(account, org, grantId, requestId);
    } catch (error) {
      // A first claim that provably never left must not bind this id: the
      // next press may confirm a different offer. A pin from an earlier,
      // possibly-sent attempt stays — that one still needs its own grant.
      if (firstAttempt && error instanceof ResetNotSubmittedError) pinned.get(account.id)?.delete(requestId);
      throw error;
    }
    return result.resetsLeft === undefined ? result : { ...result, resetsLeft: othersLeft + result.resetsLeft };
  };
  /** Whether this id was already sent for this account id — survives re-auth, unlike per-object state. */
  const isReplay = (account: Account, requestId: string): boolean => pinned.get(account.id)?.has(requestId) === true;
  return Object.assign(run, { isReplay });
}
