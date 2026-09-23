import type { LimitResetState } from "./types.js";

export interface PublicLimitResets {
  eligible: boolean;
  ineligibleReason?: string;
  available: number;
  usableNow: boolean;
  requiresLimit: boolean;
  useBy: number;
  clears: string[];
}

/** Disclosure-safe summary: counts, dates and flags only — grant ids stay in-process. */
export function publicLimitResets(state: LimitResetState): PublicLimitResets {
  const next = state.grants.find(grant => grant.id === state.nextGrantId);
  const available = state.grants.filter(grant => !grant.paused).reduce((sum, grant) => sum + grant.resetsLeft, 0);
  return {
    eligible: state.eligible === true,
    ...(state.ineligibleReason ? { ineligibleReason: state.ineligibleReason } : {}),
    available: Math.max(0, Math.min(99, Math.floor(available))),
    usableNow: next?.usableNow === true,
    requiresLimit: next?.useRequiresLimit !== false,
    useBy: next && next.endsAt > 0 ? next.endsAt : 0,
    clears: next ? [...next.clears] : [],
  };
}
