import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { USAGE_PROVIDERS, totalTokens, type UsagePeriod, type UsageQuery, type UsageReport } from "../usage/types.js";
import { activityLevel, chartColumns, formatTokens, heatmapWeeks, legendColor, legendGlyph, PROVIDER_COLORS, PROVIDER_LABELS } from "./usage-chart.js";

const PERIODS: UsagePeriod[] = ["day", "week", "month", "year"];
const HEAT = ["#42474e", "#466c50", "#5b9565", "#82c489", "#b7efba"];
const money = (n: number | null) => n === null ? "unavailable" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
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
  const fullModels = [...new Map(report?.buckets.flatMap(bucket => Object.values(bucket.series).map(series => [`${series.provider}:${series.model}`, series] as const)) ?? []).values()].sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) { onExit?.(); exit(); return; }
    if (input === "?") { setHelpOpen(value => !value); return; }
    if (helpOpen) return;
    if (input === "l") { setModelInspector(value => !value); return; }
    if (modelInspector) {
      if (key.upArrow || key.downArrow) setModelIndex(i => (i + (key.upArrow ? -1 : 1) + fullModels.length) % Math.max(1, fullModels.length));
      return;
    }
    if (key.tab) setQuery(q => ({ ...q, period: PERIODS[(PERIODS.indexOf(q.period) + (key.shift ? 3 : 1)) % 4] }));
    if (input === "m") setModels(value => !value);
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
  if (helpOpen) return <Box width={width} flexDirection="column">{[
    "Usage controls (UTC)", "Tab / Shift+Tab  Period tab", "← →  Previous / next period", "t  Current period", "1/2/3  Claude/OpenAI/Grok", "m  Model stacks", "l  Full model names", "g  Day focus / chart", "↑ ↓  Inspect day (grid)", "← →  Inspect week (grid)", "?  Return to usage", "q quit",
  ].slice(0, height).map((text, i) => line(text, `help${i}`))}</Box>;
  if (modelInspector) {
    const selected = fullModels[modelIndex % Math.max(1, fullModels.length)];
    const name = selected?.model ?? "No model usage in this period";
    const chunks = Array.from({ length: Math.ceil(name.length / width) }, (_, i) => name.slice(i * width, (i + 1) * width));
    return <Box width={width} flexDirection="column">{line(`Model ${fullModels.length ? modelIndex % fullModels.length + 1 : 0}/${fullModels.length} · ${selected ? PROVIDER_LABELS[selected.provider] : ""}`, "model-title")}{chunks.slice(0, Math.max(1, height - 3)).map((text, i) => line(text, `model-name${i}`))}{line("↑↓ browse · l back · q quit", "model-help")}</Box>;
  }
  const lines: React.ReactNode[] = [];
  lines.push(line(<><Text bold color="cyan">cc-router usage</Text>  {report?.start.slice(0, 10) ?? query.date ?? "Current"} · UTC{loading ? " · loading" : ""}</>, "title"));
  lines.push(line(<>{PERIODS.map(period => <Text key={period} bold={period === query.period} inverse={period === query.period}> {period[0].toUpperCase() + period.slice(1)} </Text>)}</>, "tabs"));
  if (report) {
    const { totals, costs } = report;
    lines.push(line(<><Text bold>{formatTokens(totalTokens(totals))}</Text> tokens  Input {formatTokens(totals.input)}  Output {formatTokens(totals.output)}  Cache {formatTokens(totals.cacheRead)} read / {formatTokens(totals.cacheWrite)} write</>, "tokens"));
    const saved = <><Text color={costs.savingsUsd !== null && costs.savingsUsd < 0 ? "red" : "green"}>{money(costs.savingsUsd)}</Text>{costs.savingsPercent === null ? "" : ` (${costs.savingsPercent.toFixed(1)}%)`}</>;
    lines.push(line(<>{width < 68 ? "API" : "API equivalent"} {money(costs.pricedApiUsd)}{costs.coverage.pricingComplete ? "" : " (partial)"}  Sub {money(costs.subscriptionUsd)}{costs.coverage.subscriptionComplete ? "" : " (partial)"}{width >= 68 ? <>  Savings {saved}</> : null}</>, "costs"));
    if (width < 68) lines.push(line(<>Savings {saved}</>, "savings"));
  }
  lines.push(line(<>{USAGE_PROVIDERS.map((provider, i) => <Text key={provider} color={PROVIDER_COLORS[provider]} dimColor={query.providers !== undefined && !query.providers.includes(provider)}>{i + 1} {query.providers === undefined || query.providers.includes(provider) ? "■" : "□"} {PROVIDER_LABELS[provider]}  </Text>)}<Text dimColor>{models ? "Models" : "Providers"}</Text></>, "providers"));
  const warning = error ?? report?.warnings[0];
  if (warning) lines.push(line(<Text color="yellow">{error ? "Error" : "Partial"}: {warning}{report && report.warnings.length > 1 ? ` (+${report.warnings.length - 1})` : ""}</Text>, "warning"));
  else if (report && totalTokens(report.totals) === 0) lines.push(line(<Text dimColor>{query.providers?.length === 0 ? "No providers selected. Press 1–3 to include one." : "No tokens recorded in this period. History begins with tracking."}</Text>, "empty"));
  if (report) {
    const showBoth = height >= 25;
    const showGrid = showBoth || gridFocus;
    const chartHeight = showBoth ? Math.max(2, Math.min(8, height - lines.length - 13)) : Math.max(2, Math.min(8, height - lines.length - 4));
    if (showBoth || !gridFocus) {
      const chart = chartColumns(report.buckets.map(b => ({
        label: query.period === "day" ? b.start.slice(11, 13) : query.period === "year" ? b.start.slice(5, 7) : b.start.slice(8, 10),
        series: Object.values(b.series).map(s => ({ ...s, tokens: totalTokens(s.tokens) })),
      })), Math.max(1, Math.floor((width - 7) / 2)), chartHeight, models, models ? Math.max(2, Math.floor(width / 24)) : 3);
      const colors = new Map(chart.legend.map((s, i) => [s.key, legendColor(s, i, models)]));
      const glyphs = new Map(chart.legend.map((s, i) => [s.key, legendGlyph(s, i, models)]));
      for (let row = 0; row < chartHeight; row++) lines.push(line(<><Text dimColor>{(row === 0 ? formatTokens(chart.max) : row === chartHeight - 1 ? "0" : "").padStart(5)} │</Text>{chart.columns.map((col, i) => <Text key={i} color={col.cells[row] ? colors.get(col.cells[row]!) : undefined}>{col.cells[row] ? glyphs.get(col.cells[row]!)!.repeat(2) : "  "}</Text>)}</>, `bar${row}`));
      lines.push(line(<Text dimColor>{"      └"}{chart.columns.map((col, i) => i % Math.max(1, Math.ceil(chart.columns.length / 8)) === 0 ? col.label.padStart(2).slice(-2) : "  ").join("")}</Text>, "axis"));
      const labelWidth = Math.max(5, Math.floor(width / Math.max(1, chart.legend.length)) - 4);
      lines.push(line(<>{chart.legend.map(s => <Text key={s.key} color={colors.get(s.key)}>{glyphs.get(s.key)} {s.label.length > labelWidth ? `${s.label.slice(0, Math.ceil((labelWidth - 1) / 2))}…${s.label.slice(-Math.floor((labelWidth - 1) / 2))}` : s.label}  </Text>)}</>, "legend"));
    }
    if (showGrid && height - lines.length >= 10) {
      const byDate = new Map(report.days.map(day => [day.date, day]));
      const weeks = heatmapWeeks(report.days.map(day => day.date));
      const span = Math.max(1, Math.floor((width - 4) / 2));
      const focusedWeek = weeks.findIndex(week => week.includes(focused));
      const firstWeek = Math.max(0, Math.min(weeks.length - span, focusedWeek - Math.floor(span / 2)));
      const visible = weeks.slice(firstWeek, firstWeek + span);
      const max = Math.max(0, ...report.days.map(day => totalTokens(day.tokens)));
      let lastMonth = "";
      const months = visible.map(week => {
        const date = week.find(Boolean) ?? ""; const month = date.slice(5, 7);
        const label = month !== lastMonth ? month : "  "; lastMonth = month; return label;
      }).join("");
      lines.push(line(<Text dimColor>    {months}  {gridFocus ? "[day focus]" : "[daily tokens]"}</Text>, "months"));
      for (let row = 0; row < 7; row++) lines.push(line(<><Text dimColor>{["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"][row]}  </Text>{visible.map((week, i) => {
        const date = week[row]; const day = date ? byDate.get(date) : undefined;
        if (!day) return <Text key={i}>{"  "}</Text>;
        const unknown = day.coverage === "future" || day.coverage === "untracked";
        return <Text key={i} inverse={gridFocus && date === focused} bold={day.selected} color={unknown ? "gray" : HEAT[activityLevel(totalTokens(day.tokens), max)]}>{day.coverage === "future" ? "· " : day.coverage === "untracked" ? "? " : day.coverage === "partial" ? "▧ " : "■ "}</Text>;
      })}</>, `heat${row}`));
      const selected = byDate.get(focused);
      lines.push(line(<Text dimColor>{selected ? `${focused}  ${totalTokens(selected.tokens).toLocaleString("en-US")} tokens · ${selected.coverage}` : "Daily tokens"}  Less ░▒▓█ More</Text>, "day"));
    } else if (showGrid) {
      const selected = report.days.find(day => day.date === focused);
      lines.push(line(<Text bold>Compact day focus · arrows inspect</Text>, "compact-grid"));
      if (selected) lines.push(line(`${focused}  ${totalTokens(selected.tokens).toLocaleString("en-US")} tokens`, "compact-inspector"));
      lines.push(line(`${selected?.coverage ?? "unavailable"} · ? untracked · · future`, "compact-coverage"));
    }
  }
  if (!report && !loading && !error) lines.push(line("No usage history available.", "nohistory"));
  const help = width >= 76 ? "q quit · ? help · Tab period · ←→ move · t today · 1–3 · m models · g grid · l names" : width >= 38 ? "q quit · ? help · Tab ←→ t 1–3 m g l" : "q quit · ? help";
  // Explicit viewport budget prevents Ink from scrolling controls offscreen on resize.
  return <Box width={width} flexDirection="column">{lines.slice(0, height - 1)}{line(<Text dimColor>{help}</Text>, "help")}</Box>;
}
