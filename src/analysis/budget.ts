/**
 * Work-item budgets (issue #94). Pure and deterministic: no I/O, no vscode.
 * A work item's budget comes from, in priority order, an explicit credit/money
 * budget, its hour estimate, and the project default "credits per estimated
 * hour". Consumption is time, credits and cost across all of its branches.
 * Never returns NaN; missing inputs yield null or omitted dimensions.
 */

export type BudgetDimension = 'time' | 'credits' | 'cost';
export type BudgetState = 'unestimated' | 'ok' | 'warning' | 'over';
export type BudgetSource = 'explicit' | 'estimate' | 'project';

export interface BudgetDim {
  budget: number;
  used: number;
  remaining: number;
  /** Consumed share of the budget, in percent (may exceed 100). */
  pct: number;
  source: BudgetSource;
}

export interface BudgetDay { date: string; hours: number; credits: number }

export interface BudgetInput {
  /** Total estimate in hours (null when unestimated or estimated in points). */
  estimateHours: number | null;
  /** Hour estimate per category (only when the estimate is split and in hours). */
  estimateBreakdown?: Record<string, number | undefined>;
  creditBudget?: number | null;
  costBudget?: number | null;
  creditsPerEstimatedHour?: number | null;
  hourlyCostRate?: number | null;
  creditCostPerUnit?: number | null;
  usedHours: number;
  usedCredits: number;
  /** Labour + AI cost from the ROI figures; null when no rate is configured. */
  usedCost: number | null;
  /** Consumption per local day (YYYY-MM-DD), any order. */
  daily?: BudgetDay[];
  /** Effective lines per category, used to apportion hours to categories. */
  categoryLines?: Record<string, number>;
  branches?: { branch: string; hours: number; credits: number }[];
  /** Alert thresholds in percent (default 80 and 100). */
  thresholds?: number[];
  /** Local date the burn rate and projection are measured against. */
  today: string;
  /** Burn-rate window in days (default 7). */
  burnDays?: number;
  /** Days of cumulative history to return (default 30). */
  seriesDays?: number;
}

export interface BudgetStatus {
  state: BudgetState;
  /** Worst dimension's percentage, or null when unestimated. */
  pct: number | null;
  worst: BudgetDimension | null;
  dims: Partial<Record<BudgetDimension, BudgetDim>>;
  used: { hours: number; credits: number; cost: number | null };
  burn: { days: number; hoursPerDay: number; creditsPerDay: number; costPerDay: number | null };
  /** When the first budget runs out at the current burn rate. */
  projection: { dimension: BudgetDimension; daysLeft: number; date: string } | null;
  categories: { category: string; budgetHours: number; usedHours: number; pct: number | null }[];
  branches: { branch: string; hours: number; credits: number; creditsPct: number; hoursPct: number }[];
  /** Thresholds currently reached (sorted ascending). */
  crossed: number[];
  /** Cumulative consumption per day, ending at the current totals. */
  series: { date: string; hours: number; credits: number }[];
}

export const DEFAULT_THRESHOLDS = [80, 100];
/** Per-machine file (next to the store) with derived budget status for the MCP server. */
export const BUDGET_SNAPSHOT_FILE = 'budget-snapshot.json';
const DAY = 86_400_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** YYYY-MM-DD arithmetic in UTC so results do not depend on the host time zone. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date((Number.isFinite(t) ? t : 0) + Math.round(days) * DAY).toISOString().slice(0, 10);
}

export function normalizeThresholds(value: unknown): number[] {
  const list = Array.isArray(value) ? value.filter(v => positive(v) && v <= 1000) as number[] : [];
  const out = [...new Set(list.map(v => Math.round(v)))].sort((a, b) => a - b);
  return out.length ? out : [...DEFAULT_THRESHOLDS];
}

function dim(budget: number, used: number, source: BudgetSource): BudgetDim {
  return { budget: r2(budget), used: r2(used), remaining: r2(budget - used), pct: r1(used / budget * 100), source };
}

export function computeBudget(input: BudgetInput): BudgetStatus {
  const thresholds = normalizeThresholds(input.thresholds);
  const usedHours = finite(input.usedHours) ? Math.max(0, input.usedHours) : 0;
  const usedCredits = finite(input.usedCredits) ? Math.max(0, input.usedCredits) : 0;
  const usedCost = finite(input.usedCost) ? Math.max(0, input.usedCost) : null;
  const costRate = positive(input.hourlyCostRate) ? input.hourlyCostRate : null;
  const creditPrice = positive(input.creditCostPerUnit) ? input.creditCostPerUnit : null;
  const hours = positive(input.estimateHours) ? input.estimateHours : null;

  const dims: Partial<Record<BudgetDimension, BudgetDim>> = {};
  if (hours) dims.time = dim(hours, usedHours, 'estimate');
  let creditBudget: number | null = null;
  if (positive(input.creditBudget)) { creditBudget = input.creditBudget; dims.credits = dim(creditBudget, usedCredits, 'explicit'); }
  else if (hours && positive(input.creditsPerEstimatedHour)) {
    creditBudget = hours * input.creditsPerEstimatedHour;
    dims.credits = dim(creditBudget, usedCredits, 'project');
  }
  if (usedCost !== null) {
    if (positive(input.costBudget)) dims.cost = dim(input.costBudget, usedCost, 'explicit');
    else if (hours && costRate) {
      const derived = hours * costRate + (creditBudget !== null && creditPrice ? creditBudget * creditPrice : 0);
      dims.cost = dim(derived, usedCost, 'estimate');
    }
  }

  let worst: BudgetDimension | null = null;
  for (const k of ['time', 'credits', 'cost'] as BudgetDimension[]) {
    if (dims[k] && (!worst || dims[k]!.pct > dims[worst]!.pct)) worst = k;
  }
  const pct = worst ? dims[worst]!.pct : null;
  const state: BudgetState = pct === null ? 'unestimated' : pct >= 100 ? 'over' : pct >= thresholds[0] ? 'warning' : 'ok';

  // Burn over the last N days (today inclusive).
  const burnDays = Math.max(1, Math.round(input.burnDays ?? 7));
  const since = addDays(input.today, -(burnDays - 1));
  const daily = (input.daily ?? []).filter(d => d && typeof d.date === 'string');
  const recent = daily.filter(d => d.date >= since && d.date <= input.today);
  const hoursPerDay = recent.reduce((n, d) => n + (finite(d.hours) ? d.hours : 0), 0) / burnDays;
  const creditsPerDay = recent.reduce((n, d) => n + (finite(d.credits) ? d.credits : 0), 0) / burnDays;
  const costPerDay = costRate || creditPrice ? hoursPerDay * (costRate ?? 0) + creditsPerDay * (creditPrice ?? 0) : null;
  const perDay: Record<BudgetDimension, number | null> = { time: hoursPerDay, credits: creditsPerDay, cost: costPerDay };

  let projection: BudgetStatus['projection'] = null;
  for (const k of Object.keys(dims) as BudgetDimension[]) {
    const d = dims[k]!, rate = perDay[k];
    let daysLeft: number | undefined;
    if (d.remaining <= 0) daysLeft = 0;
    else if (rate && rate > 0) daysLeft = d.remaining / rate;
    if (daysLeft === undefined || (projection && projection.daysLeft <= daysLeft)) continue;
    projection = { dimension: k, daysLeft: r1(daysLeft), date: addDays(input.today, Math.ceil(daysLeft)) };
  }

  const lines = input.categoryLines ?? {};
  const totalLines = Object.values(lines).reduce((n, v) => n + (positive(v) ? v : 0), 0);
  const breakdown = hours ? input.estimateBreakdown ?? {} : {};
  const categories = [...new Set([...Object.keys(breakdown), ...Object.keys(lines)])]
    .filter(c => positive(breakdown[c]) || positive(lines[c]))
    .map(category => {
      const budgetHours = positive(breakdown[category]) ? breakdown[category]! : 0;
      const usedH = totalLines ? usedHours * (positive(lines[category]) ? lines[category] : 0) / totalLines : 0;
      return { category, budgetHours: r2(budgetHours), usedHours: r2(usedH), pct: budgetHours ? r1(usedH / budgetHours * 100) : null };
    });

  const branchList = input.branches ?? [];
  const bh = branchList.reduce((n, b) => n + (finite(b.hours) ? b.hours : 0), 0);
  const bc = branchList.reduce((n, b) => n + (finite(b.credits) ? b.credits : 0), 0);
  const branches = branchList.map(b => ({
    branch: b.branch, hours: r2(finite(b.hours) ? b.hours : 0), credits: r2(finite(b.credits) ? b.credits : 0),
    hoursPct: bh ? r1((finite(b.hours) ? b.hours : 0) / bh * 100) : 0,
    creditsPct: bc ? r1((finite(b.credits) ? b.credits : 0) / bc * 100) : 0
  })).sort((a, b) => b.credits - a.credits || b.hours - a.hours);

  // Cumulative series that ends exactly at the current totals (adjustments and
  // history before the window become the starting offset).
  const seriesDays = Math.max(1, Math.round(input.seriesDays ?? 30));
  const first = addDays(input.today, -(seriesDays - 1));
  const byDate = new Map<string, { hours: number; credits: number }>();
  for (const d of daily) {
    if (d.date < first || d.date > input.today) continue;
    const cur = byDate.get(d.date) ?? { hours: 0, credits: 0 };
    cur.hours += finite(d.hours) ? d.hours : 0; cur.credits += finite(d.credits) ? d.credits : 0;
    byDate.set(d.date, cur);
  }
  let h = usedHours - [...byDate.values()].reduce((n, d) => n + d.hours, 0);
  let c = usedCredits - [...byDate.values()].reduce((n, d) => n + d.credits, 0);
  const series: BudgetStatus['series'] = [];
  for (let i = 0; i < seriesDays; i++) {
    const date = addDays(first, i);
    const d = byDate.get(date);
    if (d) { h += d.hours; c += d.credits; }
    series.push({ date, hours: r2(Math.max(0, h)), credits: r2(Math.max(0, c)) });
  }

  return {
    state, pct, worst, dims,
    used: { hours: r2(usedHours), credits: r2(usedCredits), cost: usedCost === null ? null : r2(usedCost) },
    burn: { days: burnDays, hoursPerDay: r2(hoursPerDay), creditsPerDay: r2(creditsPerDay), costPerDay: costPerDay === null ? null : r2(costPerDay) },
    projection, categories, branches,
    crossed: pct === null ? [] : thresholds.filter(t => pct >= t),
    series
  };
}

/**
 * Which alerts to send and which to re-arm, given the thresholds already
 * notified. A threshold re-arms when consumption falls back below it (for
 * example after the estimate was raised), so each crossing alerts once.
 */
export function budgetAlertChanges(crossed: number[], notified: number[] | undefined) {
  const before = new Set(notified ?? []);
  const now = new Set(crossed);
  return {
    fire: crossed.filter(t => !before.has(t)),
    rearm: [...before].filter(t => !now.has(t)),
    next: [...now].sort((a, b) => a - b)
  };
}

const UNIT: Record<BudgetDimension, (n: number, currency?: string) => string> = {
  time: n => `${r1(n)}h`,
  credits: n => `${r1(n)} cr`,
  cost: (n, cur) => `${r2(n)}${cur ? ' ' + cur : ''}`
};

/** Format a budget amount for a dimension (hours, credits or money). */
export function formatBudgetAmount(dimension: BudgetDimension, value: number, currency?: string): string {
  return UNIT[dimension](finite(value) ? value : 0, currency);
}

/** Compact status-bar label, e.g. "WI 1761: 64% · 3.2h left". */
export function budgetStatusLabel(workItemId: string, status: BudgetStatus, currency?: string): string {
  if (status.state === 'unestimated' || !status.worst) return `WI ${workItemId}: unestimated`;
  const d = status.dims[status.worst]!;
  const rest = d.remaining >= 0
    ? `${formatBudgetAmount(status.worst, d.remaining, currency)} left`
    : `${formatBudgetAmount(status.worst, -d.remaining, currency)} over`;
  return `WI ${workItemId}: ${status.pct}% \u00b7 ${rest}`;
}

/** True when the work item consumed anything within the burn window. */
export function budgetIsActive(status: BudgetStatus): boolean {
  return status.burn.hoursPerDay > 0 || status.burn.creditsPerDay > 0;
}
