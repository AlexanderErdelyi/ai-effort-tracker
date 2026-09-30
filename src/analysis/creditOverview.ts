/**
 * Credit spend overview for the dashboard's Overview tab: daily credits, KPIs
 * (today, last 7 days, billing period), breakdowns, an optional monthly budget
 * with a pace projection, and a few plain-language insights.
 *
 * Pure: no vscode import, all dates are local calendar days, `now` is injected.
 */

export interface CreditOverviewEntry {
  ts: number;
  credits: number;
  model: string;
  source?: string;
  workItemId?: string | null;
}

export interface CreditOverviewOptions {
  now: number;
  /** Monthly credit budget; 0 or less means no budget. */
  monthlyBudget?: number;
  /** Day of month the billing period starts (1–31, clamped to the month length). */
  renewalDay?: number;
  /** Days of daily history to return (default 90). */
  days?: number;
}

export interface CreditRow { key: string; credits: number; entries: number }

export interface CreditBreakdown {
  total: number;
  entries: number;
  byModel: CreditRow[];
  byWorkItem: CreditRow[];
  byDayOfWeek: CreditRow[];
  bySource: CreditRow[];
  /** Credits not linked to any work item. */
  unattributed: number;
}

export type BreakdownWindow = 'period' | '7' | '30' | '90';

export interface BudgetPace {
  budget: number;
  used: number;
  pct: number;
  /** Average credits per elapsed day of the period (including idle days). */
  avgDaily: number;
  projected: number;
  state: 'under' | 'will-exceed' | 'over';
  /** Local date the budget runs out at the current pace (will-exceed only). */
  exceedDate?: string;
  /** First day of the next period. */
  resetDate: string;
  daysLeft: number;
}

export interface CreditInsight { level: 'warn' | 'info' | 'good'; title: string; body: string }

export interface CreditOverview {
  today: number;
  yesterday: number;
  last7: number;
  prev7: number;
  period: { start: string; end: string; credits: number; prevCredits: number; elapsedDays: number; totalDays: number };
  /** Average over days with any spend in the last 30 days. */
  avgPerActiveDay: number;
  activeDays30: number;
  daily: { date: string; credits: number; byModel: Record<string, number> }[];
  /** Models shown as separate series in `daily` (top 5); the rest are 'other'. */
  models: string[];
  breakdown: Record<BreakdownWindow, CreditBreakdown>;
  budget: BudgetPace | null;
  insights: CreditInsight[];
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

/** Start of the month-long period containing `ts` whose periods begin on `renewalDay`. */
function anchor(year: number, month: number, renewalDay: number): number {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(renewalDay, last)).getTime();
}

export function billingPeriod(now: number, renewalDay = 1): { start: number; end: number; prevStart: number } {
  const rd = Math.min(31, Math.max(1, Math.round(renewalDay) || 1));
  const d = new Date(now);
  let start = anchor(d.getFullYear(), d.getMonth(), rd);
  let m = d.getMonth();
  let y = d.getFullYear();
  if (start > startOfDay(now)) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = anchor(y, m, rd);
  }
  const nm = m === 11 ? 0 : m + 1, ny = m === 11 ? y + 1 : y;
  const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
  return { start, end: anchor(ny, nm, rd), prevStart: anchor(py, pm, rd) };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function rows(map: Map<string, { credits: number; entries: number }>): CreditRow[] {
  return [...map.entries()]
    .map(([key, v]) => ({ key, credits: round(v.credits), entries: v.entries }))
    .sort((a, b) => b.credits - a.credits || a.key.localeCompare(b.key));
}

function breakdown(entries: CreditOverviewEntry[]): CreditBreakdown {
  const model = new Map<string, { credits: number; entries: number }>();
  const wi = new Map<string, { credits: number; entries: number }>();
  const src = new Map<string, { credits: number; entries: number }>();
  const dow = WEEKDAYS.map(() => ({ credits: 0, entries: 0 }));
  let total = 0, unattributed = 0;
  const bump = (m: Map<string, { credits: number; entries: number }>, k: string, c: number) => {
    const v = m.get(k) ?? { credits: 0, entries: 0 };
    v.credits += c; v.entries += 1; m.set(k, v);
  };
  for (const e of entries) {
    total += e.credits;
    bump(model, e.model || 'unknown', e.credits);
    bump(src, e.source || 'unknown', e.credits);
    if (e.workItemId) bump(wi, e.workItemId, e.credits);
    else unattributed += e.credits;
    const d = dow[new Date(e.ts).getDay()];
    d.credits += e.credits; d.entries += 1;
  }
  // Monday-first, matching the rest of the dashboard's week views.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return {
    total: round(total),
    entries: entries.length,
    byModel: rows(model),
    byWorkItem: rows(wi),
    byDayOfWeek: order.map(i => ({ key: WEEKDAYS[i], credits: round(dow[i].credits), entries: dow[i].entries })),
    bySource: rows(src),
    unattributed: round(unattributed),
  };
}

function pace(budget: number, used: number, periodStart: number, periodEnd: number, now: number): BudgetPace {
  const totalDays = daysBetween(periodStart, periodEnd);
  const elapsed = Math.min(totalDays, daysBetween(periodStart, now) + 1);
  const avgDaily = used / Math.max(1, elapsed);
  const remaining = Math.max(0, totalDays - elapsed);
  const projected = used + avgDaily * remaining;
  const base = {
    budget, used: round(used), pct: budget > 0 ? Math.round((used / budget) * 100) : 0,
    avgDaily: round(avgDaily), projected: round(projected),
    resetDate: localDay(periodEnd), daysLeft: daysBetween(now, periodEnd),
  };
  if (used >= budget) return { ...base, state: 'over' };
  if (projected > budget && avgDaily > 0) {
    const days = Math.ceil((budget - used) / avgDaily);
    return { ...base, state: 'will-exceed', exceedDate: localDay(addDays(startOfDay(now), days)) };
  }
  return { ...base, state: 'under' };
}

function fmtCr(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1);
}

function insights(o: Omit<CreditOverview, 'insights'>): CreditInsight[] {
  const out: CreditInsight[] = [];
  const b = o.budget;
  if (b) {
    if (b.state === 'over') {
      out.push({ level: 'warn', title: 'Over the monthly budget', body: `${fmtCr(b.used)} of ${fmtCr(b.budget)} credits used (${b.pct}%). The period resets on ${b.resetDate}.` });
    } else if (b.state === 'will-exceed') {
      out.push({ level: 'warn', title: `On pace to run out around ${b.exceedDate}`, body: `At ${fmtCr(b.avgDaily)} credits a day this period ends near ${fmtCr(b.projected)} of ${fmtCr(b.budget)} credits.` });
    } else if (b.used > 0) {
      out.push({ level: 'good', title: 'On track for the budget', body: `Projected ${fmtCr(b.projected)} of ${fmtCr(b.budget)} credits by ${b.resetDate}.` });
    }
  }
  if (o.today >= 10 && o.avgPerActiveDay > 0 && o.today >= 2 * o.avgPerActiveDay) {
    out.push({ level: 'info', title: `Today is ${(o.today / o.avgPerActiveDay).toFixed(1)}× your usual day`, body: `${fmtCr(o.today)} credits so far against an average of ${fmtCr(o.avgPerActiveDay)} on active days (last 30 days).` });
  }
  const m30 = o.breakdown['30'];
  if (m30.total > 0) {
    const share = m30.unattributed / m30.total;
    if (share >= 0.1 && m30.unattributed >= 5) {
      out.push({ level: 'warn', title: `${Math.round(share * 100)}% of credits have no work item`, body: `${fmtCr(m30.unattributed)} credits in the last 30 days are not linked to a work item, so they are missing from work item budgets and ROI. Assign the branch or edit the entries in the Ledger.` });
    }
    const top = m30.byModel[0];
    if (top && m30.byModel.length > 1 && top.credits / m30.total >= 0.7) {
      out.push({ level: 'info', title: `${top.key} is ${Math.round((top.credits / m30.total) * 100)}% of your spend`, body: 'Routine edits, questions and small fixes often work just as well with a cheaper model. See the Optimize tab for per-task comparisons.' });
    }
  }
  if (o.prev7 >= 10) {
    const change = (o.last7 - o.prev7) / o.prev7;
    if (change >= 0.25) out.push({ level: 'info', title: `Spend up ${Math.round(change * 100)}% on the previous 7 days`, body: `${fmtCr(o.last7)} credits in the last 7 days against ${fmtCr(o.prev7)} the 7 days before.` });
    else if (change <= -0.25) out.push({ level: 'good', title: `Spend down ${Math.round(-change * 100)}% on the previous 7 days`, body: `${fmtCr(o.last7)} credits in the last 7 days against ${fmtCr(o.prev7)} the 7 days before.` });
  }
  return out.slice(0, 4);
}

export function buildCreditOverview(ledger: CreditOverviewEntry[], opts: CreditOverviewOptions): CreditOverview {
  const now = opts.now;
  const days = Math.max(7, Math.min(400, Math.round(opts.days ?? 90)));
  const today0 = startOfDay(now);
  const tomorrow0 = addDays(today0, 1);
  const entries = ledger.filter(e => Number.isFinite(e.credits) && Number.isFinite(e.ts) && e.ts < tomorrow0);
  const sumBetween = (from: number, to: number) => entries.reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.credits : s), 0);
  const within = (from: number) => entries.filter(e => e.ts >= from);

  const per = billingPeriod(now, opts.renewalDay ?? 1);
  const totalDays = daysBetween(per.start, per.end);
  const elapsedDays = Math.min(totalDays, daysBetween(per.start, now) + 1);
  const periodCredits = sumBetween(per.start, tomorrow0);
  const prevCredits = sumBetween(per.prevStart, Math.min(per.start, addDays(per.prevStart, elapsedDays)));

  const from = addDays(today0, -(days - 1));
  const recent = within(from);
  const modelTotals = new Map<string, number>();
  for (const e of recent) modelTotals.set(e.model || 'unknown', (modelTotals.get(e.model || 'unknown') ?? 0) + e.credits);
  const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const models = ranked.slice(0, 5);
  const shown = new Set(models);
  const byDay = new Map<string, { credits: number; byModel: Record<string, number> }>();
  for (let i = 0; i < days; i++) byDay.set(localDay(addDays(from, i)), { credits: 0, byModel: {} });
  for (const e of recent) {
    const slot = byDay.get(localDay(e.ts));
    if (!slot) continue;
    const key = shown.has(e.model || 'unknown') ? (e.model || 'unknown') : 'other';
    slot.credits += e.credits;
    slot.byModel[key] = (slot.byModel[key] ?? 0) + e.credits;
  }
  const daily = [...byDay.entries()].map(([date, v]) => ({
    date,
    credits: round(v.credits),
    byModel: Object.fromEntries(Object.entries(v.byModel).map(([k, c]) => [k, round(c)])),
  }));

  const last30 = within(addDays(today0, -29));
  const activeDays30 = new Set(last30.filter(e => e.credits > 0).map(e => localDay(e.ts))).size;
  const credits30 = last30.reduce((s, e) => s + e.credits, 0);

  const budgetValue = opts.monthlyBudget ?? 0;
  const base = {
    today: round(sumBetween(today0, tomorrow0)),
    yesterday: round(sumBetween(addDays(today0, -1), today0)),
    last7: round(sumBetween(addDays(today0, -6), tomorrow0)),
    prev7: round(sumBetween(addDays(today0, -13), addDays(today0, -6))),
    period: { start: localDay(per.start), end: localDay(per.end), credits: round(periodCredits), prevCredits: round(prevCredits), elapsedDays, totalDays },
    avgPerActiveDay: activeDays30 ? round(credits30 / activeDays30) : 0,
    activeDays30,
    daily,
    models: ranked.length > 5 ? [...models, 'other'] : models,
    breakdown: {
      period: breakdown(within(per.start)),
      '7': breakdown(within(addDays(today0, -6))),
      '30': breakdown(last30),
      '90': breakdown(within(addDays(today0, -89))),
    },
    budget: budgetValue > 0 ? pace(budgetValue, periodCredits, per.start, per.end, now) : null,
  };
  return { ...base, insights: insights(base) };
}
