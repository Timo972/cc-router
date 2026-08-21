import { describe, expect, it } from "vitest";
import {
  creditsColumnLabel,
  earliestWeeklyReset,
  isLimitedAccount,
  isOpenAIAccount,
  isWeeklyLimited,
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
  it("puts Claude accounts before ChatGPT and keeps relative order", () => {
    const ordered = orderAccountsForDashboard([
      { provider: "openai_subscription", id: "gpt-b" },
      { provider: "anthropic_subscription", id: "claude-a" },
      { provider: "openai_subscription", id: "gpt-c" },
      { id: "claude-d" },
    ]);
    expect(ordered.map(a => a.id)).toEqual(["claude-a", "claude-d", "gpt-b", "gpt-c"]);
  });
});

describe("isOpenAIAccount", () => {
  it("treats missing provider as Claude", () => {
    expect(isOpenAIAccount({})).toBe(false);
    expect(isOpenAIAccount({ provider: "anthropic_subscription" })).toBe(false);
    expect(isOpenAIAccount({ provider: "openai_subscription" })).toBe(true);
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
    expect(openaiQuotaGapNote(chatgpt("info-droidrun", 0.96))).toBeUndefined();
  });
});

describe("creditsColumnLabel", () => {
  it("is an em dash for Claude and for ChatGPT without a credits object", () => {
    expect(creditsColumnLabel(claude("max-account-1"))).toBe("—");
    expect(creditsColumnLabel(chatgpt("no-credits-field"))).toBe("—");
  });

  it("prints Codex credits when present", () => {
    const withCredits = {
      ...chatgpt("plus"),
      codexRateLimits: {
        ...chatgpt("plus").codexRateLimits,
        credits: { hasCredits: false, unlimited: false },
      },
    };
    expect(creditsColumnLabel(withCredits)).toBe("no");
    expect(creditsColumnLabel({
      ...withCredits,
      codexRateLimits: { ...withCredits.codexRateLimits, credits: { hasCredits: true, unlimited: false } },
    })).toBe("yes");
    expect(creditsColumnLabel({
      ...withCredits,
      codexRateLimits: { ...withCredits.codexRateLimits, credits: { hasCredits: false, unlimited: true } },
    })).toBe("∞");
  });
});

describe("limit sorting", () => {
  const idleClaude = claude("max-account-1", 0.4, 0.2);
  const usable = chatgpt("info-droidrun", 0.96, 300);
  const fullA = chatgpt("dev-droidrun", 1, 100);
  const fullB = chatgpt("eren-droidrun", 1, 80);
  const fullC = chatgpt("lucius-max", 1, 200);

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
      [fullA, idleClaude, usable, fullB, fullC] as never,
    );
    expect(ordered.map(a => a.id)).toEqual([
      "max-account-1",
      "info-droidrun",
      "dev-droidrun",
      "eren-droidrun",
      "lucius-max",
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
