import { groupEpisodes, type Correction, type CorrectionStoreData } from './corrections';
import { NON_LESSON_CATEGORIES } from './correctionLabels';
import { scopeMatches, type LessonRule } from './lessons';
import { categorizeWith } from '../util/categoryRules';

/**
 * Knowledge loop, step 5 (#130): is the AI getting better? The correction rate
 * is the share of AI-written lines that were corrected later (by you or by a
 * rework prompt), per week, category, work item and project, and for every
 * approved rule before vs after its approval. Rework time is estimated from the
 * correction episodes and shown as "rework cost" in the work item ROI.
 */

export const UNLABELLED = 'unlabelled';
/** Each correction episode counts at least this long as rework. */
export const REWORK_MIN_MS = 60_000;
/** ...and at most this long, so one long agent run cannot dominate. */
export const REWORK_MAX_MS = 30 * 60_000;
/** A rule needs this many days since approval before its effect is shown as final. */
export const RULE_MIN_DAYS = 7;

/** AI lines added on one local day on one branch (from the effort store's daily buckets). */
export interface AiLinesDay { date: string; branch: string; lines: number }

/** Branch → work item and work item → project, as in the effort store. */
export interface RateContext {
  workItemOfBranch?: Record<string, string>;
  projectOfWorkItem?: Record<string, string>;
}

export interface RateCell {
  /** AI lines written (denominator). */
  aiLines: number;
  /** AI-written lines that were replaced, removed or moved later. */
  correctedLines: number;
  corrections: number;
  /** Corrections you made yourself (the rest are AI rework). */
  human: number;
  episodes: number;
  /** Estimated rework time of the episodes (not split by category or rule). */
  reworkMs: number;
  /** correctedLines per 100 AI lines; null without AI lines. */
  rate: number | null;
}

export interface RateWeek extends RateCell {
  /** Monday of the week, `YYYY-MM-DD`. */
  week: string;
  /** Corrected lines per category. */
  byCategory: Record<string, number>;
}

export type Trend = 'up' | 'down' | 'flat' | 'new' | 'gone';

export interface CategoryTrend {
  category: string;
  correctedLines: number;
  corrections: number;
  episodes: number;
  /** Rate in the last `trendWeeks` weeks and the weeks before; null without AI lines. */
  recent: number | null;
  previous: number | null;
  trend: Trend;
}

export interface RateGroup extends RateCell { key: string }

export interface RuleEffect {
  id: string;
  category: string;
  scope: string;
  text: string;
  status: LessonRule['status'];
  approvedAt: number;
  /** Days since approval; the "before" window has the same length when data allows. */
  days: number;
  before: RateCell;
  after: RateCell;
  /** Relative change of the rate (-0.5 = half as many corrections); null when not comparable. */
  change: number | null;
  /** Fewer than {@link RULE_MIN_DAYS} days since approval. */
  early: boolean;
  /** Unlabelled corrections in the rule's scope since approval; label them to keep the comparison fair. */
  unlabelledAfter: number;
}

export interface CorrectionRateReport {
  /** When correction capture started; null without data. */
  since: number | null;
  weeks: RateWeek[];
  /** Everything since capture started. */
  total: RateCell;
  /** Last `trendWeeks` weeks and the same span before. */
  recent: RateCell;
  previous: RateCell;
  trendWeeks: number;
  categories: CategoryTrend[];
  workItems: RateGroup[];
  projects: RateGroup[];
  rules: RuleEffect[];
}

export interface RateOptions extends RateContext {
  since?: number | null;
  now?: number;
  /** Weeks in the series (default 12). */
  weeks?: number;
  /** Weeks compared for the category trend (default 4). */
  trendWeeks?: number;
  workItemId?: string;
  projectId?: string;
}

/** Local `YYYY-MM-DD`, the same day key as the effort store. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dayNum = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
};
const numDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Monday of the week of a `YYYY-MM-DD` day. */
export function weekOf(date: string): string {
  const n = dayNum(date);
  const dow = new Date(n * 86_400_000).getUTCDay();
  return numDay(n - ((dow + 6) % 7));
}

/** Lesson corrections and unlabelled ones count; requirement changes and progress updates do not. */
export const countsAsCorrection = (c: Correction) => !c.category || !NON_LESSON_CATEGORIES.includes(c.category);

/** When capture started: the oldest correction or AI-owned line still in the store. */
export function correctionTrackingSince(data: CorrectionStoreData): number | null {
  let min = Infinity;
  for (const c of data.corrections) min = Math.min(min, c.start || c.t);
  for (const f of Object.values(data.owned)) for (const t of Object.values(f.h)) if (t > 0) min = Math.min(min, t);
  return Number.isFinite(min) ? min : null;
}

interface StoreBranch {
  workItemId?: string | null;
  daily?: Record<string, { linesAi?: number; linesAiTranslation?: number }>;
  files?: Record<string, { aiAdded?: number }>;
}

const isTranslationFile = (file: string) => categorizeWith(file, { extensions: {}, folders: {} }) === 'translation';

/**
 * Share of a branch's AI lines outside translation files, from its per-file
 * counters. Used for days recorded before the daily translation counter existed.
 */
function nonTranslationShare(files: StoreBranch['files'], isTranslation: (file: string) => boolean): number {
  let all = 0, translation = 0;
  for (const [file, f] of Object.entries(files ?? {})) {
    const n = Math.max(0, Number(f?.aiAdded) || 0);
    all += n;
    if (n && isTranslation(file)) translation += n;
  }
  return all > 0 ? (all - translation) / all : 1;
}

/**
 * AI lines per day and branch plus the branch/work item/project mapping from the
 * effort store. Translation files (generated XLIFF etc.) are left out like in the
 * productivity metrics, otherwise one generated file dilutes the rate to ~0.
 */
export function rateInputsFromStore(
  branches: Record<string, StoreBranch>,
  workItems: Record<string, { projectId?: string | null }>,
  isTranslation: (file: string) => boolean = isTranslationFile
): { aiDays: AiLinesDay[] } & Required<RateContext> {
  const aiDays: AiLinesDay[] = [];
  const workItemOfBranch: Record<string, string> = {};
  const projectOfWorkItem: Record<string, string> = {};
  for (const [branch, b] of Object.entries(branches ?? {})) {
    if (b?.workItemId) workItemOfBranch[branch] = b.workItemId;
    let share: number | undefined;
    for (const [date, bucket] of Object.entries(b?.daily ?? {})) {
      const all = Number(bucket?.linesAi) || 0;
      if (all <= 0) continue;
      const translation = bucket?.linesAiTranslation;
      const lines = typeof translation === 'number' && Number.isFinite(translation)
        ? all - Math.min(all, Math.max(0, translation))
        : Math.round(all * (share ??= nonTranslationShare(b.files, isTranslation)));
      if (lines > 0) aiDays.push({ date, branch, lines });
    }
  }
  for (const [id, wi] of Object.entries(workItems ?? {})) if (wi?.projectId) projectOfWorkItem[id] = wi.projectId;
  return { aiDays, workItemOfBranch, projectOfWorkItem };
}

interface Item { c: Correction; day: string; week: string; wi: string; proj: string; cat: string; ep: string }
interface Ep { ms: number; day: string; week: string; wi: string; proj: string }

const emptyCell = (): RateCell => ({ aiLines: 0, correctedLines: 0, corrections: 0, human: 0, episodes: 0, reworkMs: 0, rate: null });
const rateOf = (corrected: number, ai: number) => ai > 0 ? Math.round(corrected / ai * 10000) / 100 : null;

function trendOf(recent: number | null, previous: number | null): Trend {
  const r = recent ?? 0, p = previous ?? 0;
  if (p <= 0) return r > 0 ? 'new' : 'flat';
  if (r <= 0) return 'gone';
  return r > p * 1.2 ? 'up' : r < p * 0.8 ? 'down' : 'flat';
}

/** Estimated rework per episode: from the rework prompt (or first edit) to the last edit, clamped to 1–30 minutes. */
export function episodeReworkMs(start: number, end: number, promptAt?: number): number {
  const from = promptAt && promptAt < start && start - promptAt <= REWORK_MAX_MS ? promptAt : start;
  return Math.min(REWORK_MAX_MS, Math.max(REWORK_MIN_MS, end - from));
}

export function correctionRateReport(
  corrections: readonly Correction[],
  aiDays: readonly AiLinesDay[],
  rules: readonly LessonRule[],
  opts: RateOptions = {}
): CorrectionRateReport {
  const now = opts.now ?? Date.now();
  const nWeeks = Math.max(1, Math.min(104, Math.floor(opts.weeks ?? 12)));
  const trendWeeks = Math.max(1, Math.min(26, Math.floor(opts.trendWeeks ?? 4)));
  const wiOfBranch = opts.workItemOfBranch ?? {};
  const projOfWi = opts.projectOfWorkItem ?? {};
  const since = opts.since ?? null;
  const sinceDay = since !== null ? localDay(since) : undefined;
  const wiOf = (branch: string, fallback?: string) => wiOfBranch[branch] ?? fallback ?? '';
  const keep = (wi: string) => (!opts.workItemId || wi === opts.workItemId) && (!opts.projectId || (projOfWi[wi] ?? '') === opts.projectId);

  const days = aiDays
    .filter(d => d.lines > 0 && (!sinceDay || d.date >= sinceDay) && keep(wiOf(d.branch)))
    .map(d => { const wi = wiOf(d.branch); return { ...d, week: weekOf(d.date), wi, proj: projOfWi[wi] ?? '' }; });

  const counted = corrections.filter(c => countsAsCorrection(c) && keep(wiOf(c.branch, c.workItemId)));
  const epOf = new Map<string, string>();
  const episodes = groupEpisodes(counted);
  for (const e of episodes) for (const id of e.correctionIds) epOf.set(id, e.id);
  const byId = new Map(counted.map(c => [c.id, c]));
  const items: Item[] = counted.map(c => {
    const day = localDay(c.t), wi = wiOf(c.branch, c.workItemId);
    return { c, day, week: weekOf(day), wi, proj: projOfWi[wi] ?? '', cat: c.category || UNLABELLED, ep: epOf.get(c.id) ?? c.id };
  });
  const eps = new Map<string, Ep>();
  for (const e of episodes) {
    const cs = e.correctionIds.map(id => byId.get(id)).filter((c): c is Correction => !!c);
    const prompts = cs.map(c => c.trigger?.t ?? 0).filter(t => t > 0);
    const first = cs.slice().sort((a, b) => a.t - b.t)[0];
    const day = localDay(e.end), wi = first ? wiOf(first.branch, first.workItemId) : '';
    eps.set(e.id, { ms: episodeReworkMs(e.start, e.end, prompts.length ? Math.min(...prompts) : undefined), day, week: weekOf(day), wi, proj: projOfWi[wi] ?? '' });
  }

  const cell = (fi: (i: Item) => boolean, fd: (d: typeof days[number]) => boolean, fe?: (e: Ep) => boolean): RateCell => {
    const out = emptyCell();
    const seen = new Set<string>();
    for (const i of items) {
      if (!fi(i)) continue;
      out.correctedLines += i.c.aiLines;
      out.corrections++;
      if (i.c.source === 'human') out.human++;
      seen.add(i.ep);
    }
    out.episodes = seen.size;
    for (const d of days) if (fd(d)) out.aiLines += d.lines;
    if (fe) for (const e of eps.values()) if (fe(e)) out.reworkMs += e.ms;
    out.rate = rateOf(out.correctedLines, out.aiLines);
    return out;
  };

  const nowWeek = weekOf(localDay(now));
  const weekKeys: string[] = [];
  for (let k = 0; k < nWeeks; k++) {
    const w = numDay(dayNum(nowWeek) - 7 * k);
    if (sinceDay && w < weekOf(sinceDay)) break;
    weekKeys.unshift(w);
  }
  const weeks: RateWeek[] = weekKeys.map(w => {
    const byCategory: Record<string, number> = {};
    for (const i of items) if (i.week === w) byCategory[i.cat] = (byCategory[i.cat] ?? 0) + i.c.aiLines;
    return { week: w, ...cell(i => i.week === w, d => d.week === w, e => e.week === w), byCategory };
  });

  const recentFrom = numDay(dayNum(nowWeek) - 7 * (trendWeeks - 1));
  const prevFrom = numDay(dayNum(recentFrom) - 7 * trendWeeks);
  const inRecent = (day: string) => day >= recentFrom;
  const inPrev = (day: string) => day >= prevFrom && day < recentFrom;
  const recent = cell(i => inRecent(i.day), d => inRecent(d.date), e => inRecent(e.day));
  const previous = cell(i => inPrev(i.day), d => inPrev(d.date), e => inPrev(e.day));

  const cats = [...new Set(items.map(i => i.cat))];
  const categories: CategoryTrend[] = cats.map(category => {
    const all = cell(i => i.cat === category, () => false);
    const r = cell(i => i.cat === category && inRecent(i.day), () => false);
    const p = cell(i => i.cat === category && inPrev(i.day), () => false);
    const rr = rateOf(r.correctedLines, recent.aiLines), pr = rateOf(p.correctedLines, previous.aiLines);
    return { category, correctedLines: all.correctedLines, corrections: all.corrections, episodes: all.episodes, recent: rr, previous: pr, trend: trendOf(rr, pr) };
  }).sort((a, b) => b.correctedLines - a.correctedLines || b.corrections - a.corrections || a.category.localeCompare(b.category));

  const groupRows = (field: 'wi' | 'proj'): RateGroup[] => {
    const keys = new Set<string>([...items.map(i => i[field]), ...days.map(d => d[field])]);
    return [...keys].map(key => ({ key, ...cell(i => i[field] === key, d => d[field] === key, e => e[field] === key) }))
      .filter(g => g.corrections > 0)
      .sort((a, b) => b.correctedLines - a.correctedLines || b.corrections - a.corrections || a.key.localeCompare(b.key));
  };

  const today = dayNum(localDay(now));
  const sinceNum = sinceDay ? dayNum(sinceDay) : -Infinity;
  const ruleEffects: RuleEffect[] = rules
    .filter(r => r.approvedAt && (r.status === 'approved' || r.status === 'retired'))
    .map(r => {
      const aDay = dayNum(localDay(r.approvedAt!));
      const span = Math.max(1, today - aDay + 1);
      const bFrom = Math.max(aDay - span, sinceNum);
      const inAfter = (day: string) => dayNum(day) >= aDay;
      const inBefore = (day: string) => { const n = dayNum(day); return n < aDay && n >= bFrom; };
      const repoOk = (c: Correction) => !r.repo || !c.repo || r.repo.toLowerCase() === c.repo.toLowerCase();
      const match = (i: Item) => i.c.category === r.category && repoOk(i.c) && scopeMatches(r.scope, i.c.path);
      const before = cell(i => match(i) && inBefore(i.day), d => inBefore(d.date));
      const after = cell(i => match(i) && inAfter(i.day), d => inAfter(d.date));
      const unlabelledAfter = items.filter(i => !i.c.category && i.c.t >= r.approvedAt! && repoOk(i.c) && scopeMatches(r.scope, i.c.path)).length;
      const change = before.rate && after.rate !== null ? Math.round((after.rate - before.rate) / before.rate * 100) / 100 : null;
      return {
        id: r.id, category: r.category, scope: r.scope, text: r.text, status: r.status, approvedAt: r.approvedAt!,
        days: span, before, after, change, early: span < RULE_MIN_DAYS, unlabelledAfter
      };
    })
    .sort((a, b) => b.approvedAt - a.approvedAt);

  return {
    since, weeks,
    total: cell(() => true, () => true, () => true),
    recent, previous, trendWeeks, categories,
    workItems: groupRows('wi'), projects: groupRows('proj'), rules: ruleEffects
  };
}
