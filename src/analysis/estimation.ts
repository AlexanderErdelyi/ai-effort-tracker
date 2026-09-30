import type { WorkItemSummary, WorkItemStatus } from '../store/database';

/**
 * Estimation intelligence (issues #97, #98). Pure: suggests estimates from
 * finished work items and measures how accurate past estimates were. Actual
 * hours are active tracked time (coding + AI + review, incl. manual entries).
 */

export interface EstimationItem {
  id: string;
  title: string | null;
  projectId: string | null;
  status?: WorkItemStatus;
  /** Total estimate in hours; null when missing or expressed in points. */
  estimateHours: number | null;
  estimatePoints: number | null;
  /** Per-category estimate hours vs used hours (from the budget engine). */
  categories: { category: string; estimateHours: number; actualHours: number }[];
  actualHours: number;
  credits: number;
  /** Share of effective lines per category (0–1). */
  mix: Record<string, number>;
  firstDay: string | null;
  lastDay: string | null;
}

export const DORMANT_DAYS = 14;
const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Project a work item summary onto the fields estimation needs. */
export function toEstimationItem(s: WorkItemSummary): EstimationItem {
  const hours = (s.humanCodingMs + s.aiGeneratingMs + s.reviewingMs) / 3_600_000;
  const inHours = (s.estimateUnit ?? 'hours') === 'hours';
  const est = finite(s.estimate) && s.estimate > 0 ? s.estimate : null;
  const lines: Record<string, number> = {};
  let total = 0;
  for (const [cat, v] of Object.entries(s.effectiveByCategory ?? {})) {
    const n = (v?.human ?? 0) + (v?.ai ?? 0);
    if (n > 0) { lines[cat] = n; total += n; }
  }
  const mix = Object.fromEntries(Object.entries(lines).map(([c, n]) => [c, total ? n / total : 0]));
  let firstDay = s.activity?.firstDay ?? null, lastDay = s.activity?.lastDay ?? null;
  if (!s.activity) {
    let prev = { hours: 0, credits: 0 };
    for (const p of s.budget?.series ?? []) {
      if (p.hours > prev.hours + 1e-9 || p.credits > prev.credits + 1e-9) { firstDay ??= p.date; lastDay = p.date; }
      prev = p;
    }
  }
  return {
    id: s.workItemId, title: s.title, projectId: s.projectId,
    ...(s.status ? { status: s.status } : {}),
    estimateHours: inHours ? est : null,
    estimatePoints: inHours ? null : est,
    categories: inHours ? (s.budget?.categories ?? []).map(c => ({ category: c.category, estimateHours: c.budgetHours, actualHours: c.usedHours })) : [],
    actualHours: r2(hours),
    credits: r2(finite(s.creditsTotal) ? s.creditsTotal : 0),
    mix, firstDay, lastDay
  };
}

/** Finished = marked done, or (no explicit status) with tracked time and dormant for DORMANT_DAYS. */
export function isFinished(item: EstimationItem, today: string, dormantDays = DORMANT_DAYS): boolean {
  if (item.status === 'done') return true;
  if (item.status === 'active' || !item.lastDay || item.actualHours <= 0) return false;
  return Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.lastDay}T00:00:00Z`) >= dormantDays * DAY;
}

// ---------------------------------------------------------------------------
// Accuracy (#98)
// ---------------------------------------------------------------------------

export type SizeBucket = 'small' | 'medium' | 'large';
export const SIZE_LABELS: Record<SizeBucket, string> = { small: '< 4 h', medium: '4–16 h', large: '> 16 h' };

export interface AccuracyRow {
  id: string;
  title: string | null;
  projectId: string | null;
  estimate: number;
  actual: number;
  /** actual ÷ estimate: 1 = spot on, 1.5 = took 50 % longer. */
  factor: number;
  /** (actual − estimate) ÷ estimate × 100. */
  errorPct: number;
  size: SizeBucket;
  month: string | null;
  credits: number;
}

export interface AccuracyGroup {
  key: string;
  count: number;
  /** Median actual ÷ estimate. */
  medianFactor: number;
  /** Share (%) of items within ±20 % of the estimate. */
  withinPct: number;
  /** Share (%) that took more than 20 % longer. */
  overPct: number;
  /** Share (%) that took more than 20 % less. */
  underPct: number;
  /** Mean absolute error (%). */
  meanAbsErrorPct: number;
  estimateHours: number;
  actualHours: number;
}

export interface EstimateAccuracy {
  rows: AccuracyRow[];
  overall: AccuracyGroup | null;
  byProject: AccuracyGroup[];
  bySize: AccuracyGroup[];
  byMonth: AccuracyGroup[];
  byCategory: { category: string; count: number; estimateHours: number; actualHours: number; factor: number | null }[];
  /** Largest misses either way. */
  worst: AccuracyRow[];
  finished: number;
  /** Finished items without an hours estimate (unestimated or points). */
  unestimated: number;
  points: number;
}

const WITHIN = 0.2;

export function sizeOf(estimateHours: number): SizeBucket {
  return estimateHours < 4 ? 'small' : estimateHours <= 16 ? 'medium' : 'large';
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function group(key: string, rows: AccuracyRow[]): AccuracyGroup {
  const pct = (n: number) => Math.round(n / rows.length * 100);
  return {
    key, count: rows.length,
    medianFactor: r2(median(rows.map(r => r.factor))),
    withinPct: pct(rows.filter(r => Math.abs(r.factor - 1) <= WITHIN).length),
    overPct: pct(rows.filter(r => r.factor > 1 + WITHIN).length),
    underPct: pct(rows.filter(r => r.factor < 1 - WITHIN).length),
    meanAbsErrorPct: Math.round(rows.reduce((n, r) => n + Math.abs(r.errorPct), 0) / rows.length),
    estimateHours: r1(rows.reduce((n, r) => n + r.estimate, 0)),
    actualHours: r1(rows.reduce((n, r) => n + r.actual, 0))
  };
}

function groupBy(rows: AccuracyRow[], key: (r: AccuracyRow) => string | null): AccuracyGroup[] {
  const map = new Map<string, AccuracyRow[]>();
  for (const r of rows) { const k = key(r); if (k !== null) map.set(k, [...(map.get(k) ?? []), r]); }
  return [...map.entries()].map(([k, list]) => group(k, list));
}

/** How accurate estimates of finished work items were (issue #98). */
export function estimateAccuracy(items: EstimationItem[], today: string, opts: { projectId?: string; dormantDays?: number } = {}): EstimateAccuracy {
  const finished = items.filter(i => (!opts.projectId || i.projectId === opts.projectId) && isFinished(i, today, opts.dormantDays));
  const rows: AccuracyRow[] = finished
    .filter(i => i.estimateHours !== null && i.estimateHours > 0 && i.actualHours > 0)
    .map(i => {
      const factor = i.actualHours / i.estimateHours!;
      return {
        id: i.id, title: i.title, projectId: i.projectId, estimate: i.estimateHours!, actual: i.actualHours,
        factor: r2(factor), errorPct: Math.round((factor - 1) * 100), size: sizeOf(i.estimateHours!),
        month: i.lastDay ? i.lastDay.slice(0, 7) : null, credits: i.credits
      };
    })
    .sort((a, b) => (b.month ?? '').localeCompare(a.month ?? '') || a.id.localeCompare(b.id));
  const cats = new Map<string, { count: number; est: number; act: number }>();
  for (const i of finished) for (const c of i.categories) {
    if (!(c.estimateHours > 0)) continue;
    const g = cats.get(c.category) ?? { count: 0, est: 0, act: 0 };
    g.count++; g.est += c.estimateHours; g.act += c.actualHours;
    cats.set(c.category, g);
  }
  const order: SizeBucket[] = ['small', 'medium', 'large'];
  return {
    rows,
    overall: rows.length ? group('all', rows) : null,
    byProject: groupBy(rows, r => r.projectId ?? '(no project)').sort((a, b) => b.count - a.count),
    bySize: groupBy(rows, r => r.size).sort((a, b) => order.indexOf(a.key as SizeBucket) - order.indexOf(b.key as SizeBucket)),
    byMonth: groupBy(rows, r => r.month).sort((a, b) => a.key.localeCompare(b.key)),
    byCategory: [...cats.entries()].map(([category, g]) => ({
      category, count: g.count, estimateHours: r1(g.est), actualHours: r1(g.act), factor: g.est > 0 ? r2(g.act / g.est) : null
    })).sort((a, b) => b.estimateHours - a.estimateHours),
    worst: [...rows].sort((a, b) => Math.abs(Math.log(b.factor)) - Math.abs(Math.log(a.factor))).slice(0, 5),
    finished: finished.length,
    unestimated: finished.filter(i => i.estimateHours === null).length,
    points: finished.filter(i => i.estimatePoints !== null).length
  };
}

// ---------------------------------------------------------------------------
// Suggestion (#97)
// ---------------------------------------------------------------------------

export interface EstimateQuery {
  title?: string | null;
  projectId?: string | null;
  /** Expected main categories (e.g. ['programming']). */
  categories?: string[];
  /** The work item being estimated (never its own comparable). */
  excludeId?: string;
}

export interface Comparable {
  id: string;
  title: string | null;
  projectId: string | null;
  actualHours: number;
  credits: number;
  estimateHours: number | null;
  similarity: number;
}

export interface Range { low: number; median: number; high: number }

export interface EstimateSuggestion {
  /** How comparables were chosen. */
  basis: 'similar' | 'project' | 'all' | 'none';
  comparables: Comparable[];
  /** Comparables considered in total (the list above is capped). */
  sampleSize: number;
  hours: Range | null;
  credits: Range | null;
  /** Historical actual ÷ estimate for this scope (project if enough data, else overall). */
  biasFactor: number | null;
  biasSamples: number;
  note: string;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'add', 'new', 'fix', 'update', 'change', 'implement', 'implementation',
  'support', 'bug', 'feature', 'task', 'der', 'die', 'das', 'und', 'mit', 'von', 'für', 'auf', 'neue', 'neuer', 'anpassen', 'anpassung']);
const MIN_BIAS_SAMPLES = 3;
const MAX_COMPARABLES = 8;
const MAX_POOL = 50;
/** Items with less tracked time are noise (a branch opened by mistake), not comparables. */
const MIN_COMPARABLE_HOURS = 0.25;

export function titleTokens(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (title ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
    out.add(w.length > 5 ? w.replace(/(ing|ed|es|s|en|er)$/, '') : w);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function dominant(mix: Record<string, number>): string | null {
  let best: string | null = null, max = 0;
  for (const [c, v] of Object.entries(mix)) if (v > max) { best = c; max = v; }
  return best;
}

/** Weighted percentile (0–1) of values with weights. */
export function weightedPercentile(points: { value: number; weight: number }[], p: number): number {
  const s = points.filter(x => x.weight > 0 && Number.isFinite(x.value)).sort((a, b) => a.value - b.value);
  if (!s.length) return 0;
  const total = s.reduce((n, x) => n + x.weight, 0);
  let acc = 0;
  for (const x of s) { acc += x.weight; if (acc >= p * total - 1e-9) return x.value; }
  return s[s.length - 1].value;
}

function range(points: { value: number; weight: number }[]): Range {
  return { low: r1(weightedPercentile(points, 0.25)), median: r1(weightedPercentile(points, 0.5)), high: r1(weightedPercentile(points, 0.75)) };
}

/** Suggest hours and credits for a work item from finished comparable ones (issue #97). */
export function suggestEstimate(items: EstimationItem[], query: EstimateQuery, today: string, opts: { dormantDays?: number } = {}): EstimateSuggestion {
  const pool = items.filter(i => i.id !== query.excludeId && isFinished(i, today, opts.dormantDays) && i.actualHours >= MIN_COMPARABLE_HOURS);
  const words = titleTokens(query.title);
  const wanted = new Set(query.categories ?? []);
  const titleSim = new Map<string, number>();
  const scored: Comparable[] = pool.map(i => {
    const sameProject = !!query.projectId && i.projectId === query.projectId;
    const dom = dominant(i.mix);
    const catMatch = wanted.size && dom ? (wanted.has(dom) ? 1 : 0) : 0;
    const t = jaccard(words, titleTokens(i.title));
    titleSim.set(i.id, t);
    const similarity = 0.6 * t + 0.3 * (sameProject ? 1 : 0) + 0.1 * catMatch;
    return { id: i.id, title: i.title, projectId: i.projectId, actualHours: i.actualHours, credits: i.credits, estimateHours: i.estimateHours, similarity: r2(similarity) };
  });
  // At least ~1 shared meaningful word in 6 distinct ones.
  const titleHits = scored.filter(c => (titleSim.get(c.id) ?? 0) >= 1 / 6 - 1e-9);
  let basis: EstimateSuggestion['basis'];
  let chosen: Comparable[];
  if (titleHits.length) { basis = 'similar'; chosen = titleHits; }
  else if (query.projectId && scored.some(c => c.projectId === query.projectId)) { basis = 'project'; chosen = scored.filter(c => c.projectId === query.projectId); }
  else if (scored.length) { basis = 'all'; chosen = scored; }
  else { basis = 'none'; chosen = []; }
  chosen = chosen.sort((a, b) => b.similarity - a.similarity || b.actualHours - a.actualHours)
    .slice(0, basis === 'similar' ? MAX_COMPARABLES : MAX_POOL);
  const weight = (c: Comparable) => Math.max(0.05, c.similarity);

  const acc = estimateAccuracy(items, today, opts);
  const projectRows = query.projectId ? acc.rows.filter(r => r.projectId === query.projectId) : [];
  const biasRows = projectRows.length >= MIN_BIAS_SAMPLES ? projectRows : acc.rows;
  const biasFactor = biasRows.length >= MIN_BIAS_SAMPLES ? r2(median(biasRows.map(r => r.factor))) : null;

  const hours = chosen.length ? range(chosen.map(c => ({ value: c.actualHours, weight: weight(c) }))) : null;
  const credits = chosen.length ? range(chosen.map(c => ({ value: c.credits, weight: weight(c) }))) : null;
  const note = basis === 'none'
    ? 'No finished work items yet. Mark items done (or leave them untouched for two weeks) to get suggestions.'
    : `${chosen.length} ${basis === 'similar' ? 'similar' : basis === 'project' ? 'finished items of this project' : 'finished items (no similar titles)'}` +
      (hours ? `: typically ${hours.median} h (${hours.low}–${hours.high} h)` : '') +
      (biasFactor !== null ? `. Your actuals run ${biasFactor}× your estimates` : '') + '.';
  return { basis, comparables: chosen.slice(0, MAX_COMPARABLES), sampleSize: chosen.length, hours, credits, biasFactor, biasSamples: biasFactor !== null ? biasRows.length : 0, note };
}

/** Apply the historical bias to a raw estimate (null when there is no bias data). */
export function adjustForBias(estimateHours: number, biasFactor: number | null): number | null {
  return biasFactor !== null && finite(estimateHours) && estimateHours > 0 ? r1(estimateHours * biasFactor) : null;
}

/** Per-machine file (next to the store) with estimation items for the MCP server. */
export const ESTIMATION_SNAPSHOT_FILE = 'estimation-snapshot.json';
