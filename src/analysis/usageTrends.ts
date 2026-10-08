import type { UsageData } from '../store/database';
import type { ModelPrice } from '../util/modelCatalog';
import { collectCalls, detectCacheBreaks, optimizationFindings, priceOf, range, type Call, type Finding, type InsightFilter } from './usageInsights';

/**
 * Optimize trends (#162): is usage getting better or worse? Compares a period
 * with the equally long period before it and buckets the key efficiency
 * metrics per day or week. Pure and deterministic; shared by the dashboard and
 * the MCP server.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => Math.round(n * 1000) / 10;
const iso = (ts: number) => new Date(ts).toISOString();
/** Ranges up to this many days are bucketed per day, longer ones per week. */
export const DAILY_MAX_DAYS = 31;
const MAX_POINTS = 600;
/** Windows longer than this start at the first recorded call instead of the filter start. */
const TRIM_AFTER_DAYS = 400;

export interface Window { from: number; to: number }

/** The window of equal length directly before `w` (both inclusive). */
export function previousWindow(w: Window): Window {
  const span = w.to - w.from + 1;
  return { from: w.from - span, to: w.from - 1 };
}

export type MetricKey = 'credits' | 'calls' | 'turns' | 'sessions' | 'creditsPerTurn' | 'cacheHitPct'
  | 'avoidable' | 'avoidablePct' | 'premiumSharePct' | 'subagentCredits';
export type Better = 'lower' | 'higher' | 'neutral';

/** Which direction is an improvement. Volume metrics are neutral: more work is neither better nor worse. */
export const METRIC_BETTER: Record<MetricKey, Better> = {
  credits: 'neutral', calls: 'neutral', turns: 'neutral', sessions: 'neutral', subagentCredits: 'neutral',
  creditsPerTurn: 'lower', cacheHitPct: 'higher', avoidable: 'lower', avoidablePct: 'lower', premiumSharePct: 'lower'
};
/** Metrics that are already percentages: their delta is in percentage points. */
export const POINT_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>(['cacheHitPct', 'avoidablePct', 'premiumSharePct']);
export const METRIC_KEYS = Object.keys(METRIC_BETTER) as MetricKey[];

/** Ratio metrics are null when undefined (no turns, no tokens, no credits, no prices). */
export type PeriodMetrics = Record<MetricKey, number | null>;

/**
 * Premium models: priced above the median of the model catalog (input + output
 * list price per 1M tokens). Picker models define the median when at least two are known.
 * Returns null when fewer than two models are priced.
 */
export function premiumClassifier(prices: Record<string, ModelPrice>): ((model: string) => boolean | undefined) | null {
  const all = Object.values(prices);
  const pickers = all.filter(p => p.picker);
  const base = pickers.length >= 2 ? pickers : all;
  const blended = (p: ModelPrice) => p.default.input + p.default.output;
  const sorted = base.map(blended).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  return model => {
    const p = priceOf(prices, model);
    return p ? blended(p) > median : undefined;
  };
}

function metricsOf(calls: Call[], wasted: number, premium: ReturnType<typeof premiumClassifier>): PeriodMetrics {
  let credits = 0, input = 0, cached = 0, sub = 0, priced = 0, prem = 0;
  for (const c of calls) {
    const cr = c.credits ?? 0;
    credits += cr; input += c.input; cached += c.cached;
    if (c.subagent) sub += cr;
    const p = premium?.(c.model);
    if (p !== undefined) { priced += cr; if (p) prem += cr; }
  }
  const turns = new Set(calls.map(c => `${c.sessionId}|${c.turnId}`)).size;
  return {
    credits: r2(credits), calls: calls.length, turns, sessions: new Set(calls.map(c => c.sessionId)).size,
    creditsPerTurn: turns ? r2(credits / turns) : null,
    cacheHitPct: input ? pct(cached / input) : null,
    avoidable: r2(wasted),
    avoidablePct: credits > 0 ? pct(wasted / credits) : null,
    premiumSharePct: premium && priced > 0 ? pct(prem / priced) : null,
    subagentCredits: r2(sub)
  };
}

/** Metrics of the calls in a filter's window; avoidable = estimated waste of non-expected cache breaks. */
export function periodMetrics(data: UsageData, filter: InsightFilter = {}, now = Date.now()): PeriodMetrics {
  const calls = collectCalls(data, filter, now);
  const wasted = detectCacheBreaks(calls, data.modelPrices).reduce((n, b) => n + (b.wasted ?? 0), 0);
  return metricsOf(calls, wasted, premiumClassifier(data.modelPrices));
}

export interface MetricDelta {
  value: number | null;
  previous: number | null;
  /** value − previous; percentage points for POINT_METRICS. */
  delta: number | null;
  /** Relative change in %; null for point metrics or when previous is 0. */
  deltaPct: number | null;
  unit: 'points' | 'relative';
  better: Better;
  direction: 'up' | 'down' | 'flat' | null;
  verdict: 'better' | 'worse' | 'neutral' | 'flat' | null;
}

/** Changes below these thresholds count as flat (rounding noise). */
const FLAT_POINTS = 0.5;
const FLAT_RELATIVE_PCT = 1;

export function compareMetric(key: MetricKey, value: number | null, previous: number | null): MetricDelta {
  const better = METRIC_BETTER[key];
  const unit = POINT_METRICS.has(key) ? 'points' : 'relative';
  if (value === null || previous === null) {
    return { value, previous, delta: null, deltaPct: null, unit, better, direction: null, verdict: null };
  }
  const delta = r2(value - previous);
  const deltaPct = unit === 'relative' && previous !== 0 ? Math.round((value - previous) / Math.abs(previous) * 1000) / 10 : null;
  const flat = Math.abs(value - previous) < 1e-9
    || (unit === 'points' ? Math.abs(delta) < FLAT_POINTS : deltaPct !== null && Math.abs(deltaPct) < FLAT_RELATIVE_PCT);
  const direction = flat ? 'flat' : value > previous ? 'up' : 'down';
  const verdict = flat ? 'flat' : better === 'neutral' ? 'neutral'
    : (direction === 'down') === (better === 'lower') ? 'better' : 'worse';
  return { value, previous, delta, deltaPct, unit, better, direction, verdict };
}

export interface FindingTrend {
  id: string;
  title: string;
  severity: Finding['severity'] | null;
  previousSeverity: Finding['severity'] | null;
  creditsAtStake: number | null;
  previousCreditsAtStake: number | null;
  /** null when there is no previous period to compare with. */
  status: 'new' | 'resolved' | 'better' | 'worse' | 'same' | null;
}

/** Per finding id: credits at stake now vs. the previous period, including findings that disappeared. */
export function findingsTrend(current: Finding[], previous: Finding[] | null): FindingTrend[] {
  const prev = new Map((previous ?? []).map(f => [f.id, f]));
  const rows: FindingTrend[] = current.map(f => {
    const p = prev.get(f.id);
    const now = f.creditsAtStake ?? null, before = p?.creditsAtStake ?? null;
    let status: FindingTrend['status'] = null;
    if (previous) {
      if (!p) status = 'new';
      else {
        const a = now ?? 0, b = before ?? 0;
        status = Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.05) ? 'same' : a < b ? 'better' : 'worse';
      }
    }
    return { id: f.id, title: f.title, severity: f.severity, previousSeverity: p?.severity ?? null,
      creditsAtStake: now, previousCreditsAtStake: before, status };
  });
  const seen = new Set(current.map(f => f.id));
  for (const p of previous ?? []) {
    if (seen.has(p.id)) continue;
    rows.push({ id: p.id, title: p.title, severity: null, previousSeverity: p.severity,
      creditsAtStake: null, previousCreditsAtStake: p.creditsAtStake ?? null, status: 'resolved' });
  }
  return rows;
}

/** Timestamp of the first recorded debug-log call in the whole store (tracking start), or null. */
export function firstCallTs(data: UsageData): number | null {
  let first: number | null = null;
  for (const e of data.creditLedger) {
    const u = e.debugUsage;
    if (!u) continue;
    u.requests.forEach((r, i) => {
      const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : e.ts + i;
      if (first === null || ts < first) first = ts;
    });
  }
  return first;
}

export interface UsageComparison {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  /** False when nothing was recorded in the previous period (deltas are then null, shown as "–"). */
  hasPrevious: boolean;
  /** Tracking started inside the previous period, so it is only partly covered. */
  partial: boolean;
  current: PeriodMetrics;
  previous: PeriodMetrics | null;
  metrics: Record<MetricKey, MetricDelta>;
  findings: FindingTrend[];
  note: string;
}

/** Current period vs. the equally long period before it, with the same scope filter. */
export function usageComparison(data: UsageData, filter: InsightFilter = {}, now = Date.now(),
  opts: { findings?: Finding[]; withFindings?: boolean } = {}): UsageComparison {
  const cur = range(filter, now);
  const prevW = previousWindow(cur);
  const prevFilter: InsightFilter = { ...filter, from: prevW.from, to: prevW.to };
  delete prevFilter.days;
  const current = periodMetrics(data, filter, now);
  const prevMetrics = periodMetrics(data, prevFilter, now);
  const hasPrevious = (prevMetrics.calls ?? 0) > 0;
  const previous = hasPrevious ? prevMetrics : null;
  const first = firstCallTs(data);
  const partial = hasPrevious && first !== null && first > prevW.from;
  const metrics = Object.fromEntries(METRIC_KEYS.map(k => [k, compareMetric(k, current[k], previous ? previous[k] : null)])) as Record<MetricKey, MetricDelta>;
  const findings = opts.withFindings === false ? []
    : findingsTrend(opts.findings ?? optimizationFindings(data, filter, now), hasPrevious ? optimizationFindings(data, prevFilter, now) : null);
  return {
    period: { from: iso(cur.from), to: iso(cur.to) },
    previousPeriod: { from: iso(prevW.from), to: iso(prevW.to) },
    hasPrevious, partial, current, previous, metrics, findings,
    note: !hasPrevious ? 'No usage was recorded in the previous period, so there is nothing to compare with.'
      : partial ? 'Tracking started during the previous period, so it is only partly covered; treat the deltas with care.'
        : 'Compared with the equally long period directly before. Volume metrics (credits, calls, turns, sessions) are neutral; efficiency metrics are better when credits/turn, avoidable cache cost and premium share go down and cache hit goes up. Premium = models priced above the median of the model catalog.'
  };
}

export interface TrendPoint {
  /** Local YYYY-MM-DD of the bucket start. */
  start: string;
  from: number;
  to: number;
  calls: number;
  credits: number;
  turns: number;
  creditsPerTurn: number | null;
  cacheHitPct: number | null;
  avoidable: number;
  avoidablePct: number | null;
  premiumSharePct: number | null;
}

export interface UsageTrend { granularity: 'day' | 'week'; points: TrendPoint[] }

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Key efficiency metrics per day (ranges up to 31 days) or week, over the filter's window. */
export function usageTrend(data: UsageData, filter: InsightFilter = {}, now = Date.now()): UsageTrend {
  const w = range(filter, now);
  const calls = collectCalls(data, filter, now);
  const days = (w.to - w.from + 1) / DAY;
  const granularity: UsageTrend['granularity'] = days <= DAILY_MAX_DAYS + 1e-6 ? 'day' : 'week';
  let startTs = w.from;
  if (days > TRIM_AFTER_DAYS) {
    if (!calls.length) return { granularity, points: [] };
    startTs = Math.max(w.from, calls[0].ts);
  }
  const start = new Date(startTs);
  start.setHours(0, 0, 0, 0);
  const step = granularity === 'day' ? 1 : 7;
  // Cache breaks over the whole window, so a break is judged against the call before it even across buckets.
  const breaks = detectCacheBreaks(calls, data.modelPrices);
  const premium = premiumClassifier(data.modelPrices);
  const points: TrendPoint[] = [];
  let ci = 0, bi = 0;
  for (const d = start; d.getTime() <= w.to && points.length < MAX_POINTS;) {
    const from = d.getTime();
    d.setDate(d.getDate() + step);
    const to = Math.min(d.getTime() - 1, w.to);
    const list: Call[] = [];
    while (ci < calls.length && calls[ci].ts <= to) { if (calls[ci].ts >= from) list.push(calls[ci]); ci++; }
    let wasted = 0;
    while (bi < breaks.length && breaks[bi].ts <= to) { if (breaks[bi].ts >= from) wasted += breaks[bi].wasted ?? 0; bi++; }
    const m = metricsOf(list, wasted, premium);
    points.push({ start: localDay(from), from, to, calls: list.length, credits: m.credits ?? 0, turns: m.turns ?? 0,
      creditsPerTurn: m.creditsPerTurn, cacheHitPct: m.cacheHitPct, avoidable: m.avoidable ?? 0,
      avoidablePct: m.avoidablePct, premiumSharePct: m.premiumSharePct });
  }
  return { granularity, points };
}
