/** Pure bounded chart geometry, shared by the terminal and regression tests. */
export interface ChartSeries { provider: string; model: string; tokens: number }
export interface ChartBucket { label: string; series: ChartSeries[] }
export interface ChartLegend { key: string; label: string; provider: string }
export interface ChartColumn { label: string; total: number; cells: Array<string | null> }
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic_subscription: "Claude", openai_subscription: "OpenAI", xai_subscription: "Grok",
};
export const PROVIDER_COLORS: Record<string, string> = {
  anthropic_subscription: "#e4a875", openai_subscription: "#71b7db", xai_subscription: "#b69ee8",
};
const MODEL_COLORS = ["#e4a875", "#71b7db", "#b69ee8", "#8dcc9a", "#db9bac", "#e1ce8a", "#77c9c2", "#aab2bd"];
export function legendColor(item: ChartLegend, index: number, models: boolean): string {
  let hash = 0;
  for (const ch of item.key) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  return models ? MODEL_COLORS[hash % MODEL_COLORS.length] : PROVIDER_COLORS[item.provider] ?? "gray";
}
/** Redundant patterns keep co-present models distinguishable in monochrome,
 * even when their stable color hashes collide. Legend order owns patterns. */
export function legendGlyph(item: ChartLegend, index: number, models: boolean): string {
  if (models) return ["█", "▓", "▒", "░", "▤", "▥", "▦", "▧"][index % 8];
  return ({ anthropic_subscription: "█", openai_subscription: "▓", xai_subscription: "▒" } as Record<string, string>)[item.provider] ?? "░";
}
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  for (const [scale, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= scale) return `${(value / scale).toFixed(value / scale >= 100 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
  }
  return String(Math.round(value));
}
export function chartColumns(buckets: ChartBucket[], width: number, height: number, models: boolean, legendLimit = 8): {
  columns: ChartColumn[]; legend: ChartLegend[]; max: number;
} {
  const count = Math.max(1, Math.floor(width));
  const rows = Math.max(1, Math.min(20, Math.floor(height)));
  const totals = new Map<string, { total: number; provider: string; model: string }>();
  const seriesKey = (s: ChartSeries) => models ? `${s.provider}:${s.model}` : s.provider;
  for (const b of buckets) for (const s of b.series) {
    if (!Number.isFinite(s.tokens) || s.tokens <= 0) continue;
    const key = seriesKey(s);
    const entry = totals.get(key) ?? { total: 0, provider: s.provider, model: s.model };
    entry.total += s.tokens;
    totals.set(key, entry);
  }
  // Deterministic keys/colors rather than ordering by a changing usage count.
  const keys = [...totals.keys()].sort();
  const limit = Math.max(2, Math.min(8, Math.floor(legendLimit)));
  const shown = new Set(keys.length > limit ? keys.slice(0, limit - 1) : keys);
  const legend: ChartLegend[] = [...shown].map(key => {
    const entry = totals.get(key)!;
    return { key, provider: entry.provider, label: models ? entry.model : PROVIDER_LABELS[entry.provider] ?? entry.provider };
  });
  if (shown.size < keys.length) legend.push({ key: "other", provider: "other", label: `Other (${keys.length - shown.size})` });
  const groups: Array<{ label: string; values: Map<string, number> }> = [];
  const stride = Math.max(1, Math.ceil(buckets.length / count));
  for (let i = 0; i < buckets.length; i += stride) {
    const group = { label: buckets[i].label, values: new Map<string, number>() };
    for (const b of buckets.slice(i, i + stride)) for (const s of b.series) {
      if (!Number.isFinite(s.tokens) || s.tokens <= 0) continue;
      const key = shown.has(seriesKey(s)) ? seriesKey(s) : "other";
      group.values.set(key, (group.values.get(key) ?? 0) + s.tokens);
    }
    groups.push(group);
  }
  const sum = (values: Map<string, number>) => [...values.values()].reduce((n, v) => n + v, 0);
  const max = Math.max(0, ...groups.map(g => sum(g.values)));
  const columns = groups.map(group => {
    const total = sum(group.values);
    const filled = max > 0 ? Math.max(total > 0 ? 1 : 0, Math.round(total / max * rows)) : 0;
    const allocations = legend.map(item => {
      const exact = total > 0 ? (group.values.get(item.key) ?? 0) / total * filled : 0;
      return { key: item.key, exact, cells: Math.floor(exact), fraction: exact % 1 };
    });
    // Height stays tied to the total. Within it every series keeps at least one cell, so a provider
    // at a few percent of the bucket no longer rounds to nothing and leaves the other one alone;
    // when series outnumber the cells, the largest contributors get them.
    const visible = new Set(allocations.filter(a => a.exact > 0).sort((a, b) => b.exact - a.exact).slice(0, filled));
    for (const a of allocations) if (!visible.has(a)) a.fraction = 0;
    let remaining = filled - allocations.reduce((n, a) => n + a.cells, 0);
    for (const a of visible) if (a.cells === 0) { a.cells = 1; a.fraction = 0; remaining--; }
    for (const a of [...allocations].sort((a, b) => b.fraction - a.fraction)) {
      if (remaining > 0 && a.fraction > 0) { a.cells++; remaining--; }
    }
    // Minimum cells may overdraw the column, or dropped fractions underfill it: settle on the largest series.
    const largest = () => allocations.reduce((a, b) => b.cells > a.cells ? b : a);
    while (remaining < 0 && largest().cells > 1) { largest().cells--; remaining++; }
    while (remaining > 0) { largest().cells++; remaining--; }
    const stack = allocations.flatMap(a => Array<string>(a.cells).fill(a.key));
    return { label: group.label, total, cells: [...Array<null>(rows - filled).fill(null), ...stack.reverse()] };
  });
  return { columns, legend, max };
}
export function activityLevel(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tokens / max) * 4)));
}
/** Monday first, null padding at the calendar's outer edges only. */
export function heatmapWeeks(dates: string[]): Array<Array<string | null>> {
  if (dates.length === 0) return [];
  const offset = (new Date(`${dates[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days: Array<string | null> = [...Array<null>(offset).fill(null), ...dates];
  while (days.length % 7 !== 0) days.push(null);
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
}
