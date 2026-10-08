/**
 * Implausible AI line churn (#160). Whole-file reloads and rewrites (git
 * checkout/pull, regenerated translation files, an agent replacing a whole
 * document) used to be counted line for line as added AND deleted. Effective
 * lines are diff-based and mostly unaffected, so they tell how much really
 * changed. Pure: no vscode, no fs.
 */

/** A file needs at least this much AI churn (added + deleted) to be looked at. */
export const CHURN_MIN_LINES = 2000;
/** … and on average this many lines per recorded edit. */
export const CHURN_MIN_PER_EDIT = 200;
/** Effective lines per edit above this are themselves rewrite noise. */
export const EFFECTIVE_MAX_PER_EDIT = 1000;

export interface ChurnFileStat {
  aiAdded: number;
  aiDeleted: number;
  edits: number;
  effectiveAi?: number;
}

/** Corrected AI counters of one file. */
export interface ChurnTarget {
  aiAdded: number;
  aiDeleted: number;
  effectiveAi: number;
}

/**
 * The plausible AI counters of a file, or undefined when its churn looks real.
 * Raw churn is recounted from the diff-based effective lines; when those are
 * implausible too (e.g. a regenerated translation file) the file's AI lines
 * are dropped.
 */
export function planChurnFix(f: ChurnFileStat): ChurnTarget | undefined {
  const added = Math.max(0, Number(f.aiAdded) || 0), deleted = Math.max(0, Number(f.aiDeleted) || 0);
  const churn = added + deleted;
  const edits = Math.max(1, Number(f.edits) || 0);
  if (churn < CHURN_MIN_LINES || churn / edits < CHURN_MIN_PER_EDIT) return undefined;
  const eff = Math.max(0, Number(f.effectiveAi) || 0);
  if (eff / edits >= EFFECTIVE_MAX_PER_EDIT) return { aiAdded: 0, aiDeleted: 0, effectiveAi: 0 };
  if (eff * 4 > churn) return undefined;
  const newAdded = Math.round(eff * added / churn);
  return { aiAdded: newAdded, aiDeleted: eff - newAdded, effectiveAi: eff };
}

export interface ChurnOutlier {
  branch: string;
  path: string;
  before: { aiAdded: number; aiDeleted: number };
  after: ChurnTarget;
  /** AI lines (added + deleted) the fix removes. */
  excess: number;
}

/** All outlier files on live (not merged-away) branches, biggest first. */
export function findChurnOutliers(branches: Record<string, { movedTo?: string; files?: Record<string, ChurnFileStat> } | undefined>): ChurnOutlier[] {
  const out: ChurnOutlier[] = [];
  for (const [branch, b] of Object.entries(branches ?? {})) {
    if (!b || b.movedTo) continue;
    for (const [p, f] of Object.entries(b.files ?? {})) {
      if (!f) continue;
      const after = planChurnFix(f);
      if (!after) continue;
      const before = { aiAdded: f.aiAdded || 0, aiDeleted: f.aiDeleted || 0 };
      out.push({ branch, path: p, before, after, excess: before.aiAdded + before.aiDeleted - after.aiAdded - after.aiDeleted });
    }
  }
  return out.sort((a, b) => b.excess - a.excess || a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path));
}

/**
 * Split `amount` over days in proportion to each day's capacity without
 * exceeding any day (largest remainders get the leftovers). Returns day → part.
 */
export function distribute(amount: number, capacity: Record<string, number>): Record<string, number> {
  const days = Object.entries(capacity).filter(([, c]) => c > 0);
  const total = days.reduce((s, [, c]) => s + c, 0);
  const want = Math.min(Math.max(0, Math.round(amount)), total);
  const out: Record<string, number> = {};
  if (!want) return out;
  let given = 0;
  const rest: [string, number][] = [];
  for (const [d, c] of days) {
    const exact = want * c / total;
    const part = Math.min(c, Math.floor(exact));
    if (part) out[d] = part;
    given += part;
    rest.push([d, exact - part]);
  }
  rest.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (let i = 0; given < want && rest.length; i = (i + 1) % rest.length) {
    const d = rest[i][0];
    if ((out[d] ?? 0) < capacity[d]) { out[d] = (out[d] ?? 0) + 1; given++; }
    else if (rest.every(([x]) => (out[x] ?? 0) >= capacity[x])) break;
  }
  return out;
}
