import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { USAGE_PROVIDERS, addSpend, addTokens, totalSpend, totalTokens, zeroSpend, zeroTokens, type TokenCounts, type UsagePeriod, type UsageQuery, type UsageReport, type UsageSpend } from "../usage/types.js";
import { activityLevel, chartColumns, formatTokens, heatmapWeeks, legendColor, legendGlyph, PROVIDER_COLORS, PROVIDER_LABELS } from "./usage-chart.js";

const PERIODS: UsagePeriod[] = ["day", "week", "month", "year"];
const HEAT = ["#42474e", "#466c50", "#5b9565", "#82c489", "#b7efba"];
/** Which token category the chart and grid measure. Spend uses the same split on frozen-rate USD. */
type Facet = "sum" | "input" | "output";
const FACETS: Facet[] = ["sum", "input", "output"];
const FACET_LABELS: Record<Facet, string> = { sum: "All", input: "Input", output: "Output" };
/** One colour per token category, shared by the totals, the cost line, the mode indicator and the inspector. */
const CATEGORY_COLORS = { input: "#8dcc9a", output: "#db9bac", cache: "#e1ce8a" } as const;
const MAX_COLUMN_WIDTH = 12;
const money = (n: number | null) => n === null ? "unavailable" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
/** Axis-sized money: two decimals until the scale suffixes read better. */
const compactMoney = (n: number) => n >= 1000 ? `$${formatTokens(n)}` : money(n);
export function measureUsage(tokens: TokenCounts, usd: UsageSpend, spend: boolean, facet: Facet): number {
  if (spend) return facet === "sum" ? totalSpend(usd) : usd[facet];
  return facet === "sum" ? totalTokens(tokens) : tokens[facet];
}
export interface UsageDashboardProps {
  load(query: UsageQuery): Promise<UsageReport>;
  initialQuery?: UsageQuery;
  onExit?(): void;
}
export function shiftUsageDate(query: UsageQuery, direction: number): string {
  const d = new Date(`${query.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (query.period === "month") { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + direction); }
  else if (query.period === "year") { d.setUTCMonth(0, 1); d.setUTCFullYear(d.getUTCFullYear() + direction); }
  else d.setUTCDate(d.getUTCDate() + direction * (query.period === "week" ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

export function UsageDashboard({ load, initialQuery = { period: "month" }, onExit }: UsageDashboardProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const [query, setQuery] = useState<UsageQuery>(initialQuery);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState(false);
  const [spend, setSpend] = useState(false);
  const [facet, setFacet] = useState<Facet>("sum");
  const [gridFocus, setGridFocus] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelInspector, setModelInspector] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [focused, setFocused] = useState(initialQuery.date ?? new Date().toISOString().slice(0, 10));
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    stdout.on("resize", resize); return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setReport(undefined); setError(undefined);
    const poll = async () => {
      try {
        const next = await load(query);
        if (!cancelled) {
          setReport(next); setError(undefined);
          setFocused(current => next.days.some(day => day.date === current) ? current : next.start.slice(0, 10));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load usage history");
      } finally {
        if (!cancelled) { setLoading(false); timer = setTimeout(() => { void poll(); }, 5_000); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [load, query]);
  // Period totals per model: the inspector shows input/output/cache/spend, not a single bucket.
  const fullModels = [...(report?.buckets ?? []).reduce((acc, bucket) => {
    for (const series of Object.values(bucket.series)) {
      const key = `${series.provider}:${series.model}`;
      const entry = acc.get(key) ?? { provider: series.provider, model: series.model, tokens: zeroTokens(), usd: zeroSpend() };
      addTokens(entry.tokens, series.tokens); addSpend(entry.usd, series.usd); acc.set(key, entry);
    }
    return acc;
  }, new Map<string, { provider: string; model: string; tokens: TokenCounts; usd: UsageSpend }>()).values()].sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) { onExit?.(); exit(); return; }
    // Escape mirrors status: it leaves an overlay first and only quits from the main view.
    if (key.escape) {
      if (helpOpen) setHelpOpen(false);
      else if (modelInspector) setModelInspector(false);
      else { onExit?.(); exit(); }
      return;
    }
    if (input === "?") { setHelpOpen(value => !value); return; }
    if (helpOpen) return;
    if (input === "l") { setModelInspector(value => !value); return; }
    if (modelInspector) {
      if (key.upArrow || key.downArrow) setModelIndex(i => (i + (key.upArrow ? -1 : 1) + fullModels.length) % Math.max(1, fullModels.length));
      return;
    }
    if (key.tab) setQuery(q => ({ ...q, period: PERIODS[(PERIODS.indexOf(q.period) + (key.shift ? 3 : 1)) % 4] }));
    if (input === "m") setModels(value => !value);
    if (input === "s") setSpend(value => !value);
    if (input === "i") setFacet(value => FACETS[(FACETS.indexOf(value) + 1) % FACETS.length]);
    if (input === "g") setGridFocus(value => !value);
    if (input === "t") { const date = new Date().toISOString().slice(0, 10); setQuery(q => ({ ...q, date })); setFocused(date); }
    const index = "123".indexOf(input);
    if (input.length === 1 && index >= 0) setQuery(q => {
      const providers = q.providers ?? [...USAGE_PROVIDERS];
      return { ...q, providers: providers.includes(USAGE_PROVIDERS[index]) ? providers.filter(p => p !== USAGE_PROVIDERS[index]) : [...providers, USAGE_PROVIDERS[index]] };
    });
    if (gridFocus && report && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      const position = Math.max(0, report.days.findIndex(day => day.date === focused));
      const delta = key.leftArrow ? -7 : key.rightArrow ? 7 : key.upArrow ? -1 : 1;
      setFocused(report.days[Math.max(0, Math.min(report.days.length - 1, position + delta))]?.date ?? focused);
    } else if (key.leftArrow || key.rightArrow) {
      setQuery(q => ({ ...q, date: shiftUsageDate(q, key.leftArrow ? -1 : 1) }));
    }
  });
  const width = Math.max(12, size.width - 2);
  const height = Math.max(4, size.height - 1);
  const line = (content: React.ReactNode, key: string) => <Text key={key} wrap="truncate-end">{content}</Text>;
  const measure = (tokens: TokenCounts, usd: UsageSpend) => measureUsage(tokens, usd, spend, facet);
  const formatMeasure = (value: number) => spend ? compactMoney(value) : formatTokens(value);
  const unit = `${facet === "sum" ? "" : `${facet} `}${spend ? "spend" : "tokens"}`;
  const describe = (value: number) => `${spend ? money(value) : value.toLocaleString("en-US")} ${unit}`;
  // A fixed frame height, as the status dashboard uses, so the view always fills the terminal
  // and whatever was on screen before scrolls away instead of sitting above a short report.
  // One column of left padding, like the status dashboard; `width` already leaves room for it.
  if (helpOpen) return <Box width={width} height={height} paddingLeft={1} flexDirection="column">{[
    "Usage controls (UTC)", "Esc  Back / quit", "Tab / Shift+Tab  Period tab", "← →  Previous / next period", "t  Current period", "1/2/3  Claude/OpenAI/Grok", "m  Model stacks", "s  Tokens / spend", "i  All / input / output", "l  Full model names", "g  Day focus / chart", "↑ ↓  Inspect day (grid)", "← →  Inspect week (grid)", "?  Return to usage", "q quit",
  ].slice(0, height).map((text, i) => line(text, `help${i}`))}</Box>;
  if (modelInspector) {
    const selected = fullModels[modelIndex % Math.max(1, fullModels.length)];
    const name = selected?.model ?? "No model usage in this period";
    const chunks = Array.from({ length: Math.ceil(name.length / width) }, (_, i) => name.slice(i * width, (i + 1) * width));
    const detail = selected ? [
      line(<><Text color={CATEGORY_COLORS.input}>Input {formatTokens(selected.tokens.input)}</Text> · <Text color={CATEGORY_COLORS.output}>Output {formatTokens(selected.tokens.output)}</Text> · <Text color={CATEGORY_COLORS.cache}>Cache {formatTokens(selected.tokens.cacheRead)} read / {formatTokens(selected.tokens.cacheWrite)} write</Text></>, "model-tokens"),
      report?.spendAvailable === false
        ? line(<Text dimColor>Spend unavailable until the router restarts</Text>, "model-spend")
        : line(<><Text bold>Spend {money(totalSpend(selected.usd))}</Text> · <Text color={CATEGORY_COLORS.input}>Input {money(selected.usd.input)}</Text> · <Text color={CATEGORY_COLORS.output}>Output {money(selected.usd.output)}</Text> · <Text color={CATEGORY_COLORS.cache}>Cache {money(selected.usd.cacheRead + selected.usd.cacheWrite)}</Text></>, "model-spend"),
    ] : [];
    return <Box width={width} height={height} paddingLeft={1} flexDirection="column">{line(`Model ${fullModels.length ? modelIndex % fullModels.length + 1 : 0}/${fullModels.length} · ${selected ? PROVIDER_LABELS[selected.provider] : ""}`, "model-title")}{chunks.slice(0, Math.max(1, height - 3 - detail.length)).map((text, i) => line(text, `model-name${i}`))}{detail}{line("↑↓ browse · l back · q quit", "model-help")}</Box>;
  }
  // Spacer lines between sections whenever the viewport can afford them.
  const roomy = height >= 30;
  const lines: React.ReactNode[] = [];
  const gap = (key: string) => { if (roomy) lines.push(line(" ", key)); };
  lines.push(line(<><Text bold color="cyan">cc-router usage</Text>  {report?.start.slice(0, 10) ?? query.date ?? "Current"} · UTC{loading ? " · loading" : ""}</>, "title"));
  lines.push(line(<>{PERIODS.map(period => <Text key={period} bold={period === query.period} inverse={period === query.period}> {period[0].toUpperCase() + period.slice(1)} </Text>)}</>, "tabs"));
  gap("gap-tabs");
  if (report) {
    const { totals, costs } = report;
    const spendTotals = report.buckets.reduce((acc, bucket) => { addSpend(acc, bucket.usd); return acc; }, zeroSpend());
    const spendKnown = report.spendAvailable !== false;
    const cacheTokens = <Text color={CATEGORY_COLORS.cache}>Cache <Text bold>{formatTokens(totals.cacheRead)}</Text> read / <Text bold>{formatTokens(totals.cacheWrite)}</Text> write</Text>;
    lines.push(line(<><Text bold>{formatTokens(totalTokens(totals))}</Text> tokens  <Text color={CATEGORY_COLORS.input}>Input <Text bold>{formatTokens(totals.input)}</Text></Text>  <Text color={CATEGORY_COLORS.output}>Output <Text bold>{formatTokens(totals.output)}</Text></Text>{width >= 68 ? <>  {cacheTokens}</> : null}</>, "tokens"));
    // Narrow terminals truncated the cache figures off the end of the line; give them their own.
    if (width < 68) lines.push(line(cacheTokens, "cache-tokens"));
    lines.push(line(<><Text bold>API cost {money(costs.pricedApiUsd)}</Text>{costs.coverage.pricingComplete ? "" : <Text color="yellow"> (partial)</Text>}{width < 68 ? null : spendKnown
      ? <>  <Text color={CATEGORY_COLORS.input}>Input <Text bold>{money(spendTotals.input)}</Text></Text>  <Text color={CATEGORY_COLORS.output}>Output <Text bold>{money(spendTotals.output)}</Text></Text>  <Text color={CATEGORY_COLORS.cache}>Cache <Text bold>{money(spendTotals.cacheRead + spendTotals.cacheWrite)}</Text></Text></>
      : <Text dimColor>  Input / output / cache unavailable until the router restarts</Text>}</>, "costs"));
    gap("gap-totals");
  }
  lines.push(line(<>{USAGE_PROVIDERS.map((provider, i) => <Text key={provider} color={PROVIDER_COLORS[provider]} dimColor={query.providers !== undefined && !query.providers.includes(provider)}>{i + 1} {query.providers === undefined || query.providers.includes(provider) ? "■" : "□"} {PROVIDER_LABELS[provider]}  </Text>)}<Text dimColor>{models ? "Models" : "Providers"} · </Text><Text color={spend ? "yellow" : "cyan"}>{spend ? "Spend" : "Tokens"}</Text><Text dimColor> · </Text><Text color={facet === "sum" ? undefined : CATEGORY_COLORS[facet]} dimColor={facet === "sum"}>{FACET_LABELS[facet]}</Text></>, "providers"));
  const warning = error ?? report?.warnings[0];
  const notice = warning
    ? line(<Text color="yellow">{error ? "Error" : "Partial"}: {warning}{report && report.warnings.length > 1 ? ` (+${report.warnings.length - 1})` : ""}</Text>, "warning")
    : report && totalTokens(report.totals) === 0
      ? line(<Text dimColor>{query.providers?.length === 0 ? "No providers selected. Press 1–3 to include one." : "No tokens recorded in this period. History begins with tracking."}</Text>, "empty")
      : undefined;
  if (report) {
    const showBoth = height >= 25;
    const showGrid = showBoth || gridFocus;
    const gapLines = roomy ? 1 : 0;
    // Everything that must still fit under the chart: axis, legend, grid, notice, help and the spacers between them.
    const reserved = 2 + (showGrid ? 9 + gapLines : 0) + gapLines + (notice ? 1 : 0) + 1;
    const chartHeight = Math.max(2, Math.min(8, height - lines.length - gapLines - reserved));
    // The grid is at most a year of weeks wide; the chart shares that right edge so the two read as one block.
    const weeks = heatmapWeeks(report.days.map(day => day.date));
    const span = Math.max(1, Math.min(weeks.length, Math.floor((width - 4) / 2)));
    const gridWidth = 4 + span * 2;
    if (showBoth || !gridFocus) {
      gap("gap-chart");
      // Few buckets (a week has seven) get wide columns so the bars fill the row and every label has room.
      const buckets = report.buckets.map(b => ({
        label: query.period === "day" ? b.start.slice(11, 13) : query.period === "year" ? b.start.slice(5, 7) : b.start.slice(8, 10),
        series: Object.values(b.series).map(s => ({ ...s, tokens: measure(s.tokens, s.usd) })),
      }));
      // The y-axis gutter fits its widest label: a spend peak like $945.61 is seven characters, and a
      // fixed six-character gutter pushed that row one column off the axis line.
      const layout = (gutter: number) => {
        const plotWidth = Math.max(2, Math.min(width, gridWidth) - gutter - 2);
        const columnWidth = Math.max(2, Math.min(MAX_COLUMN_WIDTH, Math.floor(plotWidth / Math.max(1, report.buckets.length))));
        const chart = chartColumns(buckets, Math.max(1, Math.floor(plotWidth / columnWidth)), chartHeight, models, models ? Math.max(2, Math.floor(width / 24)) : 3);
        return { columnWidth, chart, gutter: Math.max(gutter, formatMeasure(chart.max).length) };
      };
      const first = layout(6);
      const { columnWidth, chart, gutter } = first.gutter > 6 ? layout(first.gutter) : first;
      const colors = new Map(chart.legend.map((s, i) => [s.key, legendColor(s, i, models)]));
      const glyphs = new Map(chart.legend.map((s, i) => [s.key, legendGlyph(s, i, models)]));
      // Wide columns keep one blank cell between bars; two-cell columns stay flush as before.
      const fill = columnWidth >= 3 ? columnWidth - 1 : columnWidth;
      for (let row = 0; row < chartHeight; row++) lines.push(line(<><Text dimColor>{(row === 0 ? formatMeasure(chart.max) : row === chartHeight - 1 ? "0" : "").padStart(gutter)} │</Text>{chart.columns.map((col, i) => <Text key={i} color={col.cells[row] ? colors.get(col.cells[row]!) : undefined}>{(col.cells[row] ? glyphs.get(col.cells[row]!)!.repeat(fill) : " ".repeat(fill)).padEnd(columnWidth)}</Text>)}</>, `bar${row}`));
      const labelStride = columnWidth >= 3 ? 1 : Math.max(1, Math.ceil(chart.columns.length / 8));
      const axisUnit = query.period === "day" ? "hour" : query.period === "year" ? "month" : "day";
      lines.push(line(<Text dimColor>{`${" ".repeat(gutter + 1)}└`}{chart.columns.map((col, i) => i % labelStride === 0 ? col.label.padStart(2).slice(-2).padEnd(columnWidth) : " ".repeat(columnWidth)).join("").trimEnd()}  {axisUnit}</Text>, "axis"));
      const labelWidth = Math.max(5, Math.floor(width / Math.max(1, chart.legend.length)) - 4);
      lines.push(line(<>{chart.legend.map(s => <Text key={s.key} color={colors.get(s.key)}>{glyphs.get(s.key)} {s.label.length > labelWidth ? `${s.label.slice(0, Math.ceil((labelWidth - 1) / 2))}…${s.label.slice(-Math.floor((labelWidth - 1) / 2))}` : s.label}  </Text>)}</>, "legend"));
    }
    if (showGrid && height - lines.length >= 10 + gapLines) {
      gap("gap-grid");
      const byDate = new Map(report.days.map(day => [day.date, day]));
      const focusedWeek = weeks.findIndex(week => week.includes(focused));
      const firstWeek = Math.max(0, Math.min(weeks.length - span, focusedWeek - Math.floor(span / 2)));
      const visible = weeks.slice(firstWeek, firstWeek + span);
      const max = Math.max(0, ...report.days.map(day => measure(day.tokens, day.usd)));
      let lastMonth = "";
      const months = visible.map(week => {
        const date = week.find(Boolean) ?? ""; const month = date.slice(5, 7);
        const label = month !== lastMonth ? month : "  "; lastMonth = month; return label;
      }).join("");
      lines.push(line(<Text dimColor>    {months}  {gridFocus ? "[day focus]" : `[daily ${spend ? "spend" : "tokens"}${facet === "sum" ? "" : ` · ${facet}`}]`}</Text>, "months"));
      for (let row = 0; row < 7; row++) lines.push(line(<><Text dimColor>{["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"][row]}  </Text>{visible.map((week, i) => {
        const date = week[row]; const day = date ? byDate.get(date) : undefined;
        if (!day) return <Text key={i}>{"  "}</Text>;
        const unknown = day.coverage === "future" || day.coverage === "untracked";
        return <Text key={i} inverse={gridFocus && date === focused} bold={day.selected} color={unknown ? "gray" : HEAT[activityLevel(measure(day.tokens, day.usd), max)]}>{day.coverage === "future" ? "· " : day.coverage === "untracked" ? "? " : day.coverage === "partial" ? "▧ " : "■ "}</Text>;
      })}</>, `heat${row}`));
      const selected = byDate.get(focused);
      lines.push(line(<Text dimColor>{selected ? `${focused}  ${describe(measure(selected.tokens, selected.usd))} · ${selected.coverage}` : `Daily ${unit}`}  Less ░▒▓█ More</Text>, "day"));
    } else if (showGrid) {
      const selected = report.days.find(day => day.date === focused);
      lines.push(line(<Text bold>Compact day focus · arrows inspect</Text>, "compact-grid"));
      if (selected) lines.push(line(`${focused}  ${describe(measure(selected.tokens, selected.usd))}`, "compact-inspector"));
      lines.push(line(`${selected?.coverage ?? "unavailable"} · ? untracked · · future`, "compact-coverage"));
    }
  }
  if (notice) { gap("gap-notice"); lines.push(notice); }
  if (!report && !loading && !error) lines.push(line("No usage history available.", "nohistory"));
  const help = width >= 96 ? "q quit · ? help · Tab period · ←→ move · t today · 1–3 · m models · s spend · i in/out · g grid · l names" : width >= 38 ? "q quit · ? help · Tab ←→ t 1–3 m s i g l" : "q quit · ? help";
  // Explicit viewport budget prevents Ink from scrolling controls offscreen on resize.
  return <Box width={width} height={height} paddingLeft={1} flexDirection="column">{lines.slice(0, height - 1)}{line(<Text dimColor>{help}</Text>, "help")}</Box>;
}
