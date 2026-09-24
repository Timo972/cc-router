import { describe, expect, it, vi } from "vitest";
import { createClaudeResetConsumer } from "../proxy/claude-usage-reset.js";
import { ResetNotSubmittedError } from "../proxy/reset-errors.js";
import { DEFAULT_RATE_LIMITS, type Account, type LimitResetState } from "../proxy/types.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
const R1 = "12345678-1234-4234-8234-123456789abc";
const R2 = "12345678-1234-4234-8234-123456789abd";
/** The terms every state() grant shows, as the dashboard sends them back at confirmation. */
const OFFER = { useBy: 0, clears: ["five_hour"], clearsOther: false };

function claude(limitResets?: LimitResetState): Account {
  return {
    id: "claude-1",
    tokens: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-x", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference", "user:profile"] },
    healthy: true, busy: false, requestCount: 0, errorCount: 0, lastUsed: 0, lastRefresh: 0, consecutiveErrors: 0,
    rateLimits: { ...DEFAULT_RATE_LIMITS, usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh", ...(limitResets ? { limitResets } : {}) } },
    enabled: true, sessionLimitPercent: 100, weeklyLimitPercent: 100,
  };
}
const state = (next: string): LimitResetState => ({
  eligible: true, nextGrantId: next, cooldownUntil: 0,
  grants: [{ id: next, resetsLeft: 1, endsAt: 0, clears: ["five_hour"], clearsOther: false, usableNow: true, useRequiresLimit: false, paused: false }],
});

describe("Claude reset consumer", () => {
  it("claims the snapshot's next grant for the account's organization", async () => {
    const consume = vi.fn().mockResolvedValue({ code: "reset" });
    const a = claude(state("grant-a"));
    await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(a, R1, { offer: OFFER });
    expect(consume).toHaveBeenCalledWith(a, ORG, "grant-a", R1);
  });

  it("replays the ORIGINAL grant for the same redemption id even after next_grant_id moved", async () => {
    const consume = vi.fn().mockRejectedValueOnce(new Error("outcome unknown")).mockResolvedValue({ code: "already_used" });
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1, { offer: OFFER })).rejects.toThrow();
    a.rateLimits.usage!.limitResets = state("grant-b");
    await run(a, R1, { offer: OFFER });
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", R1);
    await run(a, R2, { offer: OFFER }); // a new redemption picks the new grant
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-b", R2);
  });

  it("replays the original grant on a re-authenticated Account object with the same id", async () => {
    const consume = vi.fn().mockRejectedValueOnce(new Error("outcome unknown")).mockResolvedValue({ code: "already_used" });
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(claude(state("grant-a")), R1, { offer: OFFER })).rejects.toThrow();
    const reauthed = claude(state("grant-b"));
    await run(reauthed, R1, { offer: OFFER });
    expect(consume).toHaveBeenLastCalledWith(reauthed, ORG, "grant-a", R1);
  });

  it("keeps each interleaved redemption id on its own grant", async () => {
    const consume = vi.fn().mockRejectedValue(new Error("outcome unknown"));
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1, { offer: OFFER })).rejects.toThrow();
    a.rateLimits.usage!.limitResets = state("grant-b");
    await expect(run(a, R2, { offer: OFFER })).rejects.toThrow();
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-b", R2);
    await expect(run(a, R1, { offer: OFFER })).rejects.toThrow();
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", R1);
  });

  it("fails a retry closed once its pin is gone, instead of re-deriving a grant", async () => {
    const consume = vi.fn().mockRejectedValue(new Error("outcome unknown"));
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    const ids = Array.from({ length: 9 }, (_, i) => `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`);
    for (const id of ids) await expect(run(a, id, { offer: OFFER })).rejects.toThrow();
    a.rateLimits.usage!.limitResets = state("grant-b");
    await expect(run(a, ids[1]!, { retry: true })).rejects.toThrow("outcome unknown");
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", ids[1]); // still pinned
    consume.mockClear();
    const error = await run(a, ids[0]!, { retry: true }).catch(e => e); // evicted
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(error.abandon).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses a retry whose account now belongs to a different organization", async () => {
    const OTHER_ORG = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    let org = ORG;
    const consume = vi.fn().mockRejectedValue(new Error("outcome unknown"));
    const run = createClaudeResetConsumer({ orgUuid: async () => org, consume });
    await expect(run(claude(state("grant-a")), R1, { offer: OFFER })).rejects.toThrow("outcome unknown");
    org = OTHER_ORG; // same account id re-authenticated as another Anthropic account
    consume.mockClear();
    const error = await run(claude(state("grant-a")), R1, { retry: true }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(error.abandon).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    org = ORG; // back on the original organization, the retry goes through unchanged
    await expect(run(claude(state("grant-b")), R1, { retry: true })).rejects.toThrow("outcome unknown");
    expect(consume).toHaveBeenLastCalledWith(expect.anything(), ORG, "grant-a", R1);
  });

  it("spends only the offer the operator confirmed", async () => {
    const consume = vi.fn().mockResolvedValue({ code: "reset" });
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    const shown = { useBy: 0, clears: ["five_hour"], clearsOther: false };
    await run(claude(state("grant-a")), R1, { offer: shown });
    expect(consume).toHaveBeenCalledTimes(1);
    const moved = claude({ ...state("grant-b"), grants: [{ ...state("grant-b").grants[0]!, endsAt: 1_792_684_800, clears: ["seven_day"] }] });
    for (const offer of [shown, { ...shown, clears: ["seven_day"] }, undefined, "garbage"]) {
      const error = await run(moved, R2, { offer }).catch(e => e);
      expect(error).toBeInstanceOf(ResetNotSubmittedError);
      expect(error.status).toBe(409);
      expect(error.abandon).toBeFalsy();
    }
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("refuses a grant whose refill scope it cannot name", async () => {
    const consume = vi.fn();
    const unknownScope = claude({ ...state("grant-a"), grants: [{ ...state("grant-a").grants[0]!, clears: [], clearsOther: true }] });
    const error = await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(unknownScope, R1,
      { offer: { useBy: 0, clears: [], clearsOther: true } }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(consume).not.toHaveBeenCalled();
  });

  it("forgets a pin whose first claim was provably never sent", async () => {
    const consume = vi.fn()
      .mockRejectedValueOnce(new ResetNotSubmittedError(503, "Account credentials rejected; reset not submitted"))
      .mockResolvedValue({ code: "reset" });
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1, { offer: OFFER })).rejects.toBeInstanceOf(ResetNotSubmittedError);
    expect(run.isReplay(a, R1)).toBe(false);
    a.rateLimits.usage!.limitResets = state("grant-b"); // credentials repaired, a new offer confirmed
    await run(a, R1, { offer: OFFER });
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-b", R1);
  });

  it("keeps an earlier unknown attempt's pin when a later retry is refused unsent", async () => {
    const consume = vi.fn()
      .mockRejectedValueOnce(new Error("outcome unknown"))
      .mockRejectedValueOnce(new ResetNotSubmittedError(503, "Account credentials rejected; reset not submitted"))
      .mockResolvedValue({ code: "already_used" });
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1, { offer: OFFER })).rejects.toThrow("outcome unknown");
    await expect(run(a, R1, { retry: true })).rejects.toBeInstanceOf(ResetNotSubmittedError);
    a.rateLimits.usage!.limitResets = state("grant-b");
    await run(a, R1, { retry: true });
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", R1);
  });

  it("reports the account-wide count left, not just the redeemed grant's", async () => {
    const two: LimitResetState = {
      ...state("grant-a"),
      grants: [
        state("grant-a").grants[0]!,
        { ...state("grant-b").grants[0]!, resetsLeft: 2 },
        { ...state("grant-c").grants[0]!, resetsLeft: 5, paused: true }, // rst ignores paused grants too
      ],
    };
    const consume = vi.fn().mockResolvedValue({ code: "reset", resetsLeft: 0 });
    const result = await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(claude(two), R1, { offer: OFFER });
    expect(result).toEqual({ code: "reset", resetsLeft: 2 });
    consume.mockResolvedValue({ code: "not_limited" }); // no count reported → none invented
    expect(await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(claude(two), R2, { offer: OFFER }))
      .toEqual({ code: "not_limited" });
  });

  it("fails a retry closed when the router lost its pins (restart)", async () => {
    const consume = vi.fn();
    const restarted = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    const error = await restarted(claude(state("grant-b")), R1, { retry: true }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.abandon).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses a NEW redemption on stale reset status but still replays a pinned one", async () => {
    const consume = vi.fn().mockRejectedValueOnce(new Error("outcome unknown")).mockResolvedValue({ code: "reset" });
    const a = claude(state("grant-a"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    await expect(run(a, R1, { offer: OFFER })).rejects.toThrow();
    a.rateLimits.usage!.fetchStatus = "stale";
    const error = await run(a, R2, { offer: OFFER }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(error.abandon).toBeFalsy();
    await run(a, R1, { retry: true });
    expect(consume).toHaveBeenLastCalledWith(a, ORG, "grant-a", R1);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("reports a replay from the pin, across a re-authenticated Account object", async () => {
    const consume = vi.fn().mockRejectedValue(new Error("outcome unknown"));
    const run = createClaudeResetConsumer({ orgUuid: async () => ORG, consume });
    expect(run.isReplay(claude(state("grant-a")), R1)).toBe(false);
    await expect(run(claude(state("grant-a")), R1, { offer: OFFER })).rejects.toThrow();
    expect(run.isReplay(claude(state("grant-b")), R1)).toBe(true); // new object, same id
    expect(run.isReplay(claude(state("grant-b")), R2)).toBe(false);
  });

  it.each([
    ["no status", undefined],
    ["ineligible", { eligible: false, ineligibleReason: "surface", grants: [], cooldownUntil: 0 } as LimitResetState],
    ["no next grant", { eligible: true, grants: [], cooldownUntil: 0 } as LimitResetState],
  ])("refuses with 409 before sending when there is %s", async (_label, resets) => {
    const consume = vi.fn();
    const error = await createClaudeResetConsumer({ orgUuid: async () => ORG, consume })(claude(resets), R1, { offer: OFFER }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(409);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuses with 503 before sending when the organization is unknown", async () => {
    const consume = vi.fn();
    const error = await createClaudeResetConsumer({ orgUuid: async () => undefined, consume })(claude(state("grant-a")), R1, { offer: OFFER }).catch(e => e);
    expect(error).toBeInstanceOf(ResetNotSubmittedError);
    expect(error.status).toBe(503);
    expect(consume).not.toHaveBeenCalled();
  });
});
