import { describe, expect, it } from "vitest";
import { setSubscription, endSubscription, prorateSubscriptions, validateSubscriptions } from "../usage/subscriptions.js";
import type { UsageAccount } from "../usage/types.js";
const account: UsageAccount = { key: "key", alias: "personal", provider: "openai_subscription" };
describe("subscription intervals", () => {
  it("creates successors without mutating prior inputs and rejects overlapping historical edits", () => {
    const first = setSubscription([], account, 31, "2026-01-01");
    const second = setSubscription(first, account, 62, "2026-02-01");
    expect(first[0].to).toBeUndefined(); expect(second[0].to).toBe("2026-02-01T00:00:00.000Z");
    expect(() => setSubscription(second, account, 12, "2026-01-15")).toThrow(/overlap|histor/i);
    expect(() => setSubscription(second, account, 12, "2026-02-01")).toThrow();
    const ended = endSubscription(second, account.key, "2026-03-01");
    expect(ended[1].to).toBe("2026-03-01T00:00:00.000Z");
    expect(() => endSubscription(ended, account.key, "2026-04-01")).toThrow();
  });
  it("validates numbers, calendar dates, ordering and provider consistency", () => {
    for (const amount of [NaN, Infinity, -1]) expect(() => setSubscription([], account, amount, "2026-01-01")).toThrow();
    for (const date of ["2026-02-29", "2026-13-01", "tomorrow", "2026-01-01T23:00:00+02:00"]) expect(() => setSubscription([], account, 1, date)).toThrow();
    const list = setSubscription([], account, 0, "2026-01-01");
    expect(() => endSubscription(list, account.key, "2025-01-01")).toThrow();
    expect(() => validateSubscriptions([...list, ...list])).toThrow();
  });
  it("prorates real UTC month lengths including leap February and now", () => {
    const jan = setSubscription([], account, 31, "2026-01-01");
    expect(prorateSubscriptions(jan, "2026-01-01", "2026-01-02", "2026-01-03")).toBeCloseTo(1);
    expect(prorateSubscriptions(jan, "2026-01-01", "2026-01-02", "2026-01-01T12:00:00.000Z")).toBeCloseTo(0.5);
    const leap = setSubscription([], account, 29, "2024-02-01");
    expect(prorateSubscriptions(leap, "2024-02-28", "2024-03-01", "2024-03-02")).toBeCloseTo(2);
    expect(prorateSubscriptions(jan, "2026-01-31", "2026-02-02", "2026-03-01")).toBeCloseTo(1 + 31/28);
  });
});
