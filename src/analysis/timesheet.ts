/**
 * Timesheet (issue #101). Pure week-grid builder: active hours per work item and
 * local day, with optional rounding and CSV export. The per-day hours come from
 * the same source as the work item budget (tracked + manual time), so the
 * timesheet and the work item totals never disagree.
 */

export type TimesheetRounding = 'none' | '0.25' | '0.5';

export interface TimesheetSourceRow {
  workItemId: string;
  title: string | null;
  externalRef: string | null;
  projectId: string | null;
  /** Active hours per local day, `YYYY-MM-DD`. */
  daily: { date: string; hours: number }[];
}

export interface TimesheetRow {
  workItemId: string;
  title: string | null;
  externalRef: string | null;
  projectId: string | null;
  /** Hours for each of the 7 days (Mon..Sun), rounded. */
  cells: number[];
  total: number;
}

export interface Timesheet {
  weekStart: string;
  days: string[];
  rounding: TimesheetRounding;
  rows: TimesheetRow[];
  dayTotals: number[];
  total: number;
  /** Unrounded hours of the week, to show the rounding difference. */
  rawTotal: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Monday (local) of the week containing `day` (`YYYY-MM-DD` or a timestamp). */
export function weekStartOf(day: string | number): string {
  const d = typeof day === 'number' ? new Date(day) : parseDay(day) ?? new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return fmt(monday);
}

/** The 7 local days starting at `weekStart`. */
export function weekDays(weekStart: string): string[] {
  const s = parseDay(weekStartOf(weekStart))!;
  return Array.from({ length: 7 }, (_, i) => fmt(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i)));
}

/** Shift a week start by `weeks` (negative = back). */
export function shiftWeek(weekStart: string, weeks: number): string {
  const s = parseDay(weekStartOf(weekStart))!;
  return fmt(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * (Number.isFinite(weeks) ? weeks : 0)));
}

export function normalizeRounding(v: unknown): TimesheetRounding {
  return v === '0.25' || v === '0.5' ? v : 'none';
}

/** Round hours to the nearest step; 'none' keeps two decimals. */
export function roundHours(hours: number, rounding: TimesheetRounding): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  const step = rounding === '0.25' ? 0.25 : rounding === '0.5' ? 0.5 : 0;
  if (!step) return Math.round(hours * 100) / 100;
  return Math.round(hours / step) * step;
}

export function buildTimesheet(source: TimesheetSourceRow[], weekStart: string, rounding: TimesheetRounding = 'none'): Timesheet {
  const days = weekDays(weekStart);
  const index = new Map(days.map((d, i) => [d, i]));
  const r = normalizeRounding(rounding);
  let rawTotal = 0;
  const rows: TimesheetRow[] = [];
  for (const s of source ?? []) {
    const raw = new Array(7).fill(0);
    for (const p of s?.daily ?? []) {
      const i = index.get(p?.date);
      if (i !== undefined && Number.isFinite(p.hours) && p.hours > 0) raw[i] += p.hours;
    }
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    rawTotal += sum;
    const cells = raw.map(h => roundHours(h, r));
    rows.push({
      workItemId: s.workItemId,
      title: s.title ?? null,
      externalRef: s.externalRef ?? null,
      projectId: s.projectId ?? null,
      cells,
      total: round2(cells.reduce((a, b) => a + b, 0))
    });
  }
  rows.sort((a, b) => b.total - a.total || a.workItemId.localeCompare(b.workItemId));
  const dayTotals = days.map((_, i) => round2(rows.reduce((a, row) => a + row.cells[i], 0)));
  return {
    weekStart: days[0],
    days,
    rounding: r,
    rows,
    dayTotals,
    total: round2(dayTotals.reduce((a, b) => a + b, 0)),
    rawTotal: round2(rawTotal)
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/** One line per work item and day with hours (zero cells are skipped). */
export function timesheetCsv(sheet: Timesheet): string {
  const lines = ['work_item,external_ref,title,day,hours'];
  for (const row of sheet.rows) {
    row.cells.forEach((h, i) => {
      if (h > 0) lines.push([row.workItemId, row.externalRef, row.title, sheet.days[i], h].map(csvCell).join(','));
    });
  }
  return lines.join('\n');
}
