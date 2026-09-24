import { describe, expect, it } from "vitest";
import {
  resetCreditsColumnLabel,
  claudeResetBlocker,
  claudeResetConfirmText,
  earliestWeeklyReset,
  grokQuotaNote,
  isClaudeAccount,
  isLimitedAccount,
  isOpenAIAccount,
  isWeeklyLimited,
  isXaiAccount,
  noteModelLimit,
  openaiQuotaGapNote,
  orderAccountsForDashboard,
  visibleCapacityRows,
  type AccountCapacityRow,
  type CodexRateLimitsView,
} from "../ui/Dashboard.js";

function chatgpt(id: string, weekly: number, resetAt = 1_700_000_000) {
  const limits: CodexRateLimitsView = {
    status: "ok",
    plan: "team",
    lastUpdated: 1,
    buckets: [{
      limitId: "codex",
      label: "codex",
      cooldownUntilMs: 0,
      primary: { utilization: weekly, resetAt, windowMinutes: 10_080 },
    }],
  };
  return { id, provider: "openai_subscription" as const, codexRateLimits: limits };
}

function chatgptWindows(id: string, session: number, weekly: number) {
  const limits: CodexRateLimitsView = {
    status: "ok",
    plan: "team",
    lastUpdated: 1,
    buckets: [{
      limitId: "codex",
      label: "codex",
      cooldownUntilMs: 0,
      primary: { utilization: session, resetAt: 1_700_000_000, windowMinutes: 300 },
      secondary: { utilization: weekly, resetAt: 1_700_000_000, windowMinutes: 10_080 },
    }],
  };
  return { id, provider: "openai_subscription" as const, codexRateLimits: limits };
}

function claude(id: string, fiveHour = 0, sevenDay = 0) {
  return {
    id,
    provider: "anthropic_subscription" as const,
    rateLimits: {
      status: "allowed" as const,
      fiveHourUtil: fiveHour,
      fiveHourReset: 0,
      sevenDayUtil: sevenDay,
      sevenDayReset: 0,
      claim: "",
      plan: "max",
      requestsLimit: 0,
      lastUpdated: 1,
    },
  };
}

describe("orderAccountsForDashboard", () => {
  it("puts Claude accounts before ChatGPT and Grok, and keeps relative order", () => {
    const ordered = orderAccountsForDashboard([
      { provider: "openai_subscription", id: "gpt-b" },
      { provider: "xai_subscription", id: "grok" },
      { provider: "anthropic_subscription", id: "claude-a" },
      { provider: "openai_subscription", id: "gpt-c" },
      { id: "claude-d" },
    ]);
    expect(ordered.map(a => a.id)).toEqual(["claude-a", "claude-d", "gpt-b", "gpt-c", "grok"]);
  });
});

describe("isOpenAIAccount", () => {
  it("treats missing provider as Claude", () => {
    expect(isOpenAIAccount({})).toBe(false);
    expect(isOpenAIAccount({ provider: "anthropic_subscription" })).toBe(false);
    expect(isOpenAIAccount({ provider: "openai_subscription" })).toBe(true);
    expect(isXaiAccount({ provider: "xai_subscription" })).toBe(true);
    expect(isClaudeAccount({ provider: "xai_subscription" })).toBe(false);
    expect(isClaudeAccount({})).toBe(true);
  });
});

describe("visibleCapacityRows", () => {
  const rows: AccountCapacityRow[] = [
    { label: "ok-model", state: "included available", color: "green", utilization: 0.2 },
    { label: "Fable", state: "exhausted", color: "red", utilization: 1, resetAt: 0 },
    { label: "warn-model", state: "included available", color: "yellow", utilization: 0.8 },
  ];

  it("hides healthy model rows unless the account is selected", () => {
    expect(visibleCapacityRows(rows, false).map(r => r.label)).toEqual(["Fable", "warn-model"]);
  });

  it("shows every row when selected", () => {
    expect(visibleCapacityRows(rows, true)).toEqual(rows);
  });
});

describe("noteModelLimit", () => {
  it("always reports Fable percent, even when the family is not critical", () => {
    const note = noteModelLimit({
      rateLimits: {
        status: "allowed",
        fiveHourUtil: 0,
        fiveHourReset: 0,
        sevenDayUtil: 0,
        sevenDayReset: 0,
        claim: "",
        plan: "",
        requestsLimit: 0,
        lastUpdated: 1,
        usage: {
          modelLimits: [{
            modelFamily: "fable",
            displayName: "Claude Fable",
            utilization: 0.29,
            resetAt: 0,
            active: false,
            severity: "unknown",
          }],
          fetchedAt: 1,
          fetchStatus: "fresh",
        },
      },
    });
    expect(note).toMatchObject({ label: "Fable", utilization: 0.29, color: "green" });
  });
});

describe("openaiQuotaGapNote", () => {
  it("explains a Pro account with no usage windows", () => {
    expect(openaiQuotaGapNote({
      provider: "openai_subscription",
      codexRateLimits: { status: "ok", plan: "pro", buckets: [], lastUpdated: 0 },
    })).toBe("pro · no quota");
  });

  it("stays quiet when a weekly window exists", () => {
    expect(openaiQuotaGapNote(chatgpt("chatgpt-ok", 0.96))).toBeUndefined();
  });
});

describe("grokQuotaNote", () => {
  it("prefers the live plan name over the coarse tier", () => {
    expect(grokQuotaNote({
      provider: "xai_subscription",
      healthy: true,
      xai: { tier: 1, subscriptionTier: "GrokPro" },
    })).toBe("GrokPro");
  });

  it("falls back to the spend tier when the plan name is not known yet", () => {
    expect(grokQuotaNote({
      provider: "xai_subscription",
      healthy: true,
      xai: { tier: 1 },
    })).toBe("tier 1");
  });

  it("falls back to cli when neither plan nor tier is known", () => {
    expect(grokQuotaNote({
      provider: "xai_subscription",
      healthy: true,
    })).toBe("cli");
  });

  it("marks an expired Grok login", () => {
    expect(grokQuotaNote({
      provider: "xai_subscription",
      healthy: false,
    })).toBe("expired");
  });
});

describe("resetCreditsColumnLabel", () => {
  it("is an em dash for Claude and 0 for ChatGPT without resetCredits", () => {
    expect(resetCreditsColumnLabel(claude("max-account-1"))).toBe("—");
    expect(resetCreditsColumnLabel(chatgpt("no-reset-credits-field"))).toBe("0");
  });

  it("prints the banked usage-limit reset count when present", () => {
    const withZero = {
      ...chatgpt("plus"),
      codexRateLimits: {
        ...chatgpt("plus").codexRateLimits,
        resetCredits: { available: 0 },
      },
    };
    expect(resetCreditsColumnLabel(withZero)).toBe("0");
    expect(resetCreditsColumnLabel({
      ...withZero,
      codexRateLimits: { ...withZero.codexRateLimits, resetCredits: { available: 2 } },
    })).toBe("2");
  });

  it("ignores billing credits and still shows 0 without resetCredits", () => {
    const billingOnly = {
      ...chatgpt("plus"),
      codexRateLimits: {
        ...chatgpt("plus").codexRateLimits,
        credits: { hasCredits: true, unlimited: false },
      },
    };
    expect(resetCreditsColumnLabel(billingOnly)).toBe("0");
  });
});

describe("Claude limit resets in the dashboard", () => {
  const withResets = (limitResets: object) => ({
    ...claude("max-1"),
    rateLimits: { ...claude("max-1").rateLimits!, usage: { modelLimits: [], fetchedAt: 1, fetchStatus: "fresh" as const, limitResets } },
  });
  const ok = { eligible: true, available: 1, usableNow: true, requiresLimit: false, useBy: 1_792_684_800, clears: ["five_hour", "seven_day", "seven_day_overage_included"], clearsOther: false };

  it("shows the banked count, or an em dash when unknown or ineligible", () => {
    expect(resetCreditsColumnLabel(withResets(ok))).toBe("1");
    expect(resetCreditsColumnLabel(withResets({ ...ok, available: 0 }))).toBe("0");
    expect(resetCreditsColumnLabel(withResets({ ...ok, eligible: false, ineligibleReason: "surface", available: 0 }))).toBe("—");
    expect(resetCreditsColumnLabel(claude("no-usage"))).toBe("—");
  });

  it("explains why a reset cannot start", () => {
    expect(claudeResetBlocker(withResets(ok))).toBeUndefined();
    expect(claudeResetBlocker(claude("no-usage"))).toBe("Reset status unknown — reload with R");
    expect(claudeResetBlocker(withResets({ ...ok, eligible: false, ineligibleReason: "cli_version" })))
      .toBe("Claude Code version too old for resets — update cc-router");
    expect(claudeResetBlocker(withResets({ ...ok, eligible: false, ineligibleReason: "tier" }))).toBe("Resets unavailable for this account (tier)");
    expect(claudeResetBlocker(withResets({ ...ok, available: 0 }))).toBe("No resets available");
    expect(claudeResetBlocker(withResets({ ...ok, usableNow: false, requiresLimit: true }))).toBe("Reset only usable at a limit");
  });

  it("refuses a grant whose refill scope cannot be named", () => {
    expect(claudeResetBlocker(withResets({ ...ok, clears: [], clearsOther: true })))
      .toBe("Reset refill scope unknown — update cc-router");
  });

  it("refuses a new redemption on stale or unavailable reset status", () => {
    const at = (fetchStatus: "stale" | "unavailable") => ({
      ...claude("max-1"),
      rateLimits: { ...claude("max-1").rateLimits!, usage: { modelLimits: [], fetchedAt: 1, fetchStatus, limitResets: ok } },
    });
    expect(claudeResetBlocker(at("stale"))).toBe("Reset status is out of date — reload with R");
    expect(claudeResetBlocker(at("unavailable"))).toBe("Reset status is out of date — reload with R");
  });

  it("names every refilled window, count and deadline in the confirmation", () => {
    expect(claudeResetConfirmText("max-1", ok))
      .toBe('Redeem 1 reset for "max-1"? Refills 5h + 7d + 7d overage limits · 1 left · use by 2026-10-22');
    expect(claudeResetConfirmText("max-1", { ...ok, clears: ["seven_day_opus"] }))
      .toBe('Redeem 1 reset for "max-1"? Refills 7d Opus limits · 1 left · use by 2026-10-22');
    expect(claudeResetConfirmText("max-1", { ...ok, clears: ["five_hour", "seven_day_sonnet"] }))
      .toBe('Redeem 1 reset for "max-1"? Refills 5h + 7d Sonnet limits · 1 left · use by 2026-10-22');
    expect(claudeResetConfirmText("max-1", { ...ok, clears: ["five_hour"], clearsOther: true }))
      .toBe('Redeem 1 reset for "max-1"? Refills 5h + other limits · 1 left · use by 2026-10-22');
  });
});

describe("limit sorting", () => {
  const idleClaude = claude("max-account-1", 0.4, 0.2);
  const usable = chatgpt("chatgpt-ok", 0.96, 300);
  const fullA = chatgpt("chatgpt-full-a", 1, 100);
  const fullB = chatgpt("chatgpt-full-b", 1, 80);
  const fullC = chatgpt("chatgpt-full-c", 1, 200);

  it("treats a 100% weekly Codex window as limited", () => {
    expect(isWeeklyLimited(usable)).toBe(false);
    expect(isLimitedAccount(usable)).toBe(false);
    expect(isWeeklyLimited(fullA)).toBe(true);
    expect(isLimitedAccount(fullA)).toBe(true);
    expect(isLimitedAccount(idleClaude)).toBe(false);
  });

  it("treats a full 5h or 7d Claude window as limited", () => {
    expect(isLimitedAccount(claude("session-full", 1, 0.4))).toBe(true);
    expect(isLimitedAccount(claude("weekly-full", 0.4, 1))).toBe(true);
    expect(isLimitedAccount(claude("almost", 0.99, 0.99))).toBe(false);
  });

  it("treats a full 5h Codex window as limited even when weekly is open", () => {
    expect(isLimitedAccount(chatgptWindows("session-full", 1, 0.4))).toBe(true);
    expect(isLimitedAccount(chatgptWindows("open", 0.5, 0.4))).toBe(false);
  });

  it("keeps each limited ChatGPT account visible, sorted below usable ones", () => {
    const ordered = orderAccountsForDashboard(
      [fullA, idleClaude, usable, fullB, fullC],
    );
    expect(ordered.map(a => a.id)).toEqual([
      "max-account-1",
      "chatgpt-ok",
      "chatgpt-full-a",
      "chatgpt-full-b",
      "chatgpt-full-c",
    ]);
  });

  it("sorts a 5h-full Claude account below usable Claude accounts", () => {
    const ordered = orderAccountsForDashboard([
      claude("session-full", 1, 0.3),
      claude("open-a", 0.5, 0.2),
      claude("weekly-full", 0.1, 1),
      claude("open-b", 0.2, 0.1),
    ]);
    expect(ordered.map(a => a.id)).toEqual([
      "open-a",
      "open-b",
      "session-full",
      "weekly-full",
    ]);
  });

  it("picks the earliest weekly reset among limited accounts", () => {
    expect(earliestWeeklyReset([fullA, fullB, fullC] as never)).toBe(80);
  });
});
