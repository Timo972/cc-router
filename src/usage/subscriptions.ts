import { finiteAmount, object, boundedString, usageProvider, utcTimestamp } from "./types.js";
import type { Subscription, UsageAccount } from "./types.js";

export function validateSubscriptions(value: unknown): Subscription[] {
  if (!Array.isArray(value)) throw new Error("Invalid subscription list");
  const result = value.map(entry => {
    const input = object(entry, ["accountKey", "provider", "monthlyUsd", "from", "to"]);
    const subscription: Subscription = { accountKey: boundedString(input.accountKey, "account key", 128), provider: usageProvider(input.provider), monthlyUsd: finiteAmount(input.monthlyUsd), from: utcTimestamp(input.from) };
    if (input.to !== undefined) { subscription.to = utcTimestamp(input.to); if (subscription.to <= subscription.from) throw new Error("Invalid subscription date ordering"); }
    return subscription;
  });
  const byAccount = new Map<string, Subscription[]>();
  for (const entry of result) { const group = byAccount.get(entry.accountKey) ?? []; group.push(entry); byAccount.set(entry.accountKey, group); }
  for (const group of byAccount.values()) {
    group.sort((a,b) => a.from.localeCompare(b.from));
    for (let i = 1; i < group.length; i++) {
      if (group[i].provider !== group[0].provider || !group[i-1].to || group[i-1].to! > group[i].from) throw new Error("Invalid overlapping subscriptions or provider mismatch");
    }
  }
  return result;
}

export function setSubscription(subscriptions: Subscription[], account: UsageAccount, amount: number, from: string): Subscription[] {
  const next = validateSubscriptions(subscriptions);
  const start = utcTimestamp(from); finiteAmount(amount);
  const entries = next.filter(entry => entry.accountKey === account.key).sort((a,b) => a.from.localeCompare(b.from));
  const last = entries.at(-1);
  if (last) {
    if (last.provider !== account.provider || start <= last.from || (last.to && start < last.to)) throw new Error("Subscription overlaps existing history; historical edits are not supported");
    if (!last.to) last.to = start;
  }
  next.push({ accountKey: account.key, provider: account.provider, monthlyUsd: amount, from: start });
  return validateSubscriptions(next);
}

export function endSubscription(subscriptions: Subscription[], accountKey: string, on: string): Subscription[] {
  const next = validateSubscriptions(subscriptions); const end = utcTimestamp(on);
  const active = next.find(entry => entry.accountKey === accountKey && !entry.to);
  if (!active) throw new Error("No open subscription interval for account");
  if (end <= active.from) throw new Error("Subscription end must be after its start");
  active.to = end;
  return next;
}

/** Integrate a monthly rate over real UTC months, clamped at now. */
export function prorateSubscriptions(subscriptions: Subscription[], start: string, end: string, now: string): number {
  const from = Date.parse(utcTimestamp(start)); const to = Math.min(Date.parse(utcTimestamp(end)), Date.parse(utcTimestamp(now)));
  let total = 0;
  for (const entry of validateSubscriptions(subscriptions)) {
    let cursor = Math.max(from, Date.parse(entry.from));
    const stop = Math.min(to, entry.to ? Date.parse(entry.to) : Infinity);
    while (cursor < stop) {
      const date = new Date(cursor); const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
      const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const next = Math.min(stop, monthEnd);
      total += entry.monthlyUsd * ((next - cursor) / (monthEnd - monthStart)); cursor = next;
    }
  }
  return total;
}
