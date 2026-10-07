/**
 * Calendar heatmap aggregation (issue #141): one cell per local day for the
 * last ~12 months, built from the per-branch daily buckets, the credit ledger
 * and manual effort/time entries. Only days with any activity are returned;
 * the UI lays out the grid from `start` to `end`.
 */

export interface CalendarBucket {
  humanCoding?: number;
  aiGenerating?: number;
  reviewing?: number;
  linesHuman?: number;
  linesAi?: number;
  linesByCategory?: Record<string, { human?: number; ai?: number }>;
}

export interface CalendarInput {
  branches: Record<string, { workItemId?: string | null; daily?: Record<string, CalendarBucket> }>;
  ledger?: { ts: number; credits: number; branch?: string | null; workItemId?: string | null }[];
  manualEffort?: { ts: number; workItemId?: string | null; category?: string; durationMs?: number; linesAdded?: number; isAi?: boolean }[];
  timeEntries?: { startTs?: number; createdAt: number; durationMs: number; branch?: string; workItemId?: string }[];
  /** Local YYYY-MM-DD of "today". */
  today: string;
  /** Number of week columns (default 53 = a full year plus the current week). */
  weeks?: number;
}

export interface CalendarItem {
  branch: string | null;
  workItemId: string | null;
  activeMs: number;
  lines: number;
  credits: number;
}

export interface CalendarDay {
  date: string;
  humanMs: number;
  aiMs: number;
  reviewMs: number;
  /** Manually logged time (manual effort + time entries). */
  manualMs: number;
  activeMs: number;
  linesHuman: number;
  linesAi: number;
  credits: number;
  /** Lines by category; null when the day predates per-category recording and has no manual lines. */
  categories: Record<string, { human: number; ai: number }> | null;
  items: CalendarItem[];
}

export interface CalendarData {
  start: string;
  end: string;
  days: CalendarDay[];
  totals: { activeDays: number; activeMs: number; credits: number; lines: number };
  max: { activeMs: number; credits: number; lines: number };
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** First day of the grid: a Sunday, `weeks` columns before (and including) today's week. */
export function calendarStart(today: string, weeks = 53): string {
  const d = parseDay(today);
  d.setDate(d.getDate() - d.getDay() - (Math.max(1, weeks) - 1) * 7);
  return localDay(d.getTime());
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** `unknown` (detached HEAD) and `__unassigned__` (holding item) are not real work items. */
function realWorkItem(id: string | null | undefined): string | null {
  return typeof id === 'string' && id && id !== 'unknown' && id !== '__unassigned__' ? id : null;
}

export function buildCalendar(input: CalendarInput): CalendarData {
  const end = input.today;
  const start = calendarStart(end, input.weeks ?? 53);
  const inRange = (day: string) => day >= start && day <= end;
  const days = new Map<string, CalendarDay & { itemMap: Map<string, CalendarItem> }>();

  const dayOf = (date: string) => {
    let d = days.get(date);
    if (!d) {
      d = { date, humanMs: 0, aiMs: 0, reviewMs: 0, manualMs: 0, activeMs: 0, linesHuman: 0, linesAi: 0, credits: 0, categories: null, items: [], itemMap: new Map() };
      days.set(date, d);
    }
    return d;
  };
  const itemOf = (d: ReturnType<typeof dayOf>, branch: string | null, rawWorkItemId: string | null | undefined) => {
    const workItemId = realWorkItem(rawWorkItemId);
    const key = branch !== null ? 'b:' + branch : 'w:' + (workItemId ?? '');
    let item = d.itemMap.get(key);
    if (!item) {
      item = { branch, workItemId, activeMs: 0, lines: 0, credits: 0 };
      d.itemMap.set(key, item);
    }
    if (!item.workItemId && workItemId) item.workItemId = workItemId;
    return item;
  };
  const addCategory = (d: ReturnType<typeof dayOf>, category: string, human: number, ai: number) => {
    if (!d.categories) d.categories = {};
    const c = d.categories[category] ?? (d.categories[category] = { human: 0, ai: 0 });
    c.human += human;
    c.ai += ai;
  };

  for (const [branch, data] of Object.entries(input.branches ?? {})) {
    for (const [date, b] of Object.entries(data?.daily ?? {})) {
      if (!inRange(date) || !b) continue;
      const human = num(b.humanCoding), ai = num(b.aiGenerating), review = num(b.reviewing);
      const lh = num(b.linesHuman), la = num(b.linesAi);
      if (human + ai + review + lh + la === 0) continue;
      const d = dayOf(date);
      d.humanMs += human; d.aiMs += ai; d.reviewMs += review;
      d.linesHuman += lh; d.linesAi += la;
      for (const [cat, v] of Object.entries(b.linesByCategory ?? {})) {
        if (num(v?.human) + num(v?.ai) > 0) addCategory(d, cat, num(v?.human), num(v?.ai));
      }
      const item = itemOf(d, branch, data.workItemId ?? null);
      item.activeMs += human + ai + review;
      item.lines += lh + la;
    }
  }

  for (const e of input.ledger ?? []) {
    const credits = num(e?.credits);
    if (!credits || !Number.isFinite(e.ts)) continue;
    const date = localDay(e.ts);
    if (!inRange(date)) continue;
    const d = dayOf(date);
    d.credits += credits;
    const branch = e.branch || null;
    const fromBranch = branch ? realWorkItem(input.branches?.[branch]?.workItemId) : null;
    itemOf(d, branch, realWorkItem(e.workItemId) ?? fromBranch).credits += credits;
  }

  for (const m of input.manualEffort ?? []) {
    if (!m || !Number.isFinite(m.ts)) continue;
    const date = localDay(m.ts);
    if (!inRange(date)) continue;
    const ms = num(m.durationMs), lines = num(m.linesAdded);
    if (!ms && !lines) continue;
    const d = dayOf(date);
    d.manualMs += ms;
    if (m.isAi) d.linesAi += lines; else d.linesHuman += lines;
    if (lines) addCategory(d, m.category || 'other', m.isAi ? 0 : lines, m.isAi ? lines : 0);
    const item = itemOf(d, null, m.workItemId ?? null);
    item.activeMs += ms;
    item.lines += lines;
  }

  for (const t of input.timeEntries ?? []) {
    const ms = num(t?.durationMs);
    const ts = t?.startTs ?? t?.createdAt;
    if (!ms || !Number.isFinite(ts)) continue;
    const date = localDay(ts as number);
    if (!inRange(date)) continue;
    const d = dayOf(date);
    d.manualMs += ms;
    const branch = t.branch || null;
    itemOf(d, branch, realWorkItem(t.workItemId) ?? (branch ? realWorkItem(input.branches?.[branch]?.workItemId) : null)).activeMs += ms;
  }

  const out: CalendarDay[] = [];
  const totals = { activeDays: 0, activeMs: 0, credits: 0, lines: 0 };
  const max = { activeMs: 0, credits: 0, lines: 0 };
  for (const d of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const { itemMap, ...day } = d;
    day.activeMs = day.humanMs + day.aiMs + day.reviewMs + day.manualMs;
    day.credits = Math.round(day.credits * 1000) / 1000;
    day.items = [...itemMap.values()]
      .map(i => ({ ...i, credits: Math.round(i.credits * 1000) / 1000 }))
      .sort((a, b) => (b.activeMs - a.activeMs) || (b.credits - a.credits) || (b.lines - a.lines));
    const lines = day.linesHuman + day.linesAi;
    totals.activeDays += 1;
    totals.activeMs += day.activeMs;
    totals.credits += day.credits;
    totals.lines += lines;
    max.activeMs = Math.max(max.activeMs, day.activeMs);
    max.credits = Math.max(max.credits, day.credits);
    max.lines = Math.max(max.lines, lines);
    out.push(day);
  }
  totals.credits = Math.round(totals.credits * 1000) / 1000;
  return { start, end, days: out, totals, max };
}
