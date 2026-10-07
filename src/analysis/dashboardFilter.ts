/**
 * Global dashboard filter (issue #146): one date range + project + work item
 * that every tab reads. Pure: no vscode import, `now` is injected.
 */

import { billingPeriod } from './creditOverview';

export type FilterRange = '7' | '30' | '90' | 'period' | 'all' | 'custom';

export interface DashboardFilter {
  range: FilterRange;
  /** Local YYYY-MM-DD, inclusive. Only used when `range` is 'custom'. */
  from: string;
  /** Local YYYY-MM-DD, inclusive. Only used when `range` is 'custom'. */
  to: string;
  /** Project id, '__none__' for work items without a project, '' for all. */
  projectId: string;
  /** Work item id, '' for all. */
  workItemId: string;
}

export const NO_PROJECT = '__none__';

export const DEFAULT_FILTER: DashboardFilter = { range: '30', from: '', to: '', projectId: '', workItemId: '' };

const RANGES: FilterRange[] = ['7', '30', '90', 'period', 'all', 'custom'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}

function day(v: unknown): string {
  const s = str(v);
  return DAY_RE.test(s) && Number.isFinite(parseDay(s)) ? s : '';
}

/** Coerce untrusted input (webview message, stored state) into a valid filter. */
export function normalizeFilter(raw: unknown): DashboardFilter {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let range = RANGES.includes(r.range as FilterRange) ? r.range as FilterRange : DEFAULT_FILTER.range;
  let from = day(r.from), to = day(r.to);
  if (range === 'custom') {
    if (!from && !to) range = DEFAULT_FILTER.range;
    else if (from && to && from > to) [from, to] = [to, from];
  }
  if (range !== 'custom') { from = ''; to = ''; }
  return { range, from, to, projectId: str(r.projectId), workItemId: str(r.workItemId) };
}

/** Local midnight of a YYYY-MM-DD day. */
export function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/**
 * The filter's time window as `[from, to)` epoch ms. `from` is undefined for
 * 'all' (and an open-ended custom start); `to` is undefined when the window
 * runs up to now.
 */
export function filterWindow(f: DashboardFilter, now: number, renewalDay = 1): { from?: number; to?: number } {
  const today0 = startOfDay(now);
  switch (f.range) {
    case 'all': return {};
    case 'period': return { from: billingPeriod(now, renewalDay).start };
    case 'custom': return {
      ...(f.from ? { from: parseDay(f.from) } : {}),
      ...(f.to ? { to: addDays(parseDay(f.to), 1) } : {}),
    };
    default: return { from: addDays(today0, -((parseInt(f.range, 10) || 30) - 1)) };
  }
}

export function inWindow(ts: number, w: { from?: number; to?: number }): boolean {
  return (w.from === undefined || ts >= w.from) && (w.to === undefined || ts < w.to);
}

/** True when an entry's project / work item matches the filter's scope. */
export function matchesScope(e: { projectId?: string | null; workItemId?: string | null }, f: DashboardFilter): boolean {
  if (f.workItemId && (e.workItemId ?? '') !== f.workItemId) return false;
  if (f.projectId === NO_PROJECT) return !e.projectId;
  if (f.projectId && (e.projectId ?? '') !== f.projectId) return false;
  return true;
}

export function isScoped(f: DashboardFilter): boolean {
  return !!(f.projectId || f.workItemId);
}
