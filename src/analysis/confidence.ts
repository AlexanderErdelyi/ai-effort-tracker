/**
 * Data-confidence indicators (issue #143): how much of a number was measured,
 * estimated or entered by hand. Credits, time and lines each get a split; ROI
 * inherits the confidence of its inputs.
 *
 * Pure: no vscode import.
 */

export type ConfidenceLevel = 'exact' | 'mixed' | 'estimated' | 'manual' | 'none';
export type ConfidenceKind = 'measured' | 'estimated' | 'manual';

export interface ConfidencePart {
  key: string;
  label: string;
  value: number;
  kind: ConfidenceKind;
}

export interface Confidence {
  level: ConfidenceLevel;
  /** Sum of all part values (credits, ms or lines). 0 for derived figures. */
  total: number;
  /** Share (0–1) of the total that was measured. */
  measuredShare: number;
  parts: ConfidencePart[];
  /** Inputs of a derived figure (ROI), with their own levels. */
  inputs?: { label: string; level: ConfidenceLevel }[];
  note?: string;
}

/** A split counts as pure once one kind reaches this share. */
export const PURE_SHARE = 0.98;

function clean(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function confidenceOf(parts: ConfidencePart[], note?: string): Confidence {
  const kept = parts.map(p => ({ ...p, value: clean(p.value) }));
  const total = kept.reduce((s, p) => s + p.value, 0);
  const by: Record<ConfidenceKind, number> = { measured: 0, estimated: 0, manual: 0 };
  for (const p of kept) by[p.kind] += p.value;
  let level: ConfidenceLevel = 'none';
  if (total > 0) {
    if (by.measured / total >= PURE_SHARE) level = 'exact';
    else if (by.estimated / total >= PURE_SHARE) level = 'estimated';
    else if (by.manual / total >= PURE_SHARE) level = 'manual';
    else level = 'mixed';
  }
  return {
    level,
    total,
    measuredShare: total > 0 ? by.measured / total : 0,
    parts: kept.filter(p => p.value > 0),
    ...(note ? { note } : {})
  };
}

// ---- Credits ---------------------------------------------------------------

export type CreditKind = 'exact' | 'partial' | 'estimated' | 'manual';

/** The ledger fields that decide how trustworthy a credit amount is. */
export interface CreditKindInput {
  credits: number;
  source?: string;
  exact?: boolean;
  debugUsage?: { unpricedRequests?: number; creditsOverridden?: boolean; logWarnings?: number };
}

/**
 * - manual: typed in, or a captured amount the user overrode.
 * - exact: the real per-request charge (live capture or a clean debug log).
 * - partial: from a debug log, but some calls had no charge or the log had
 *   warnings, so the amount is a lower bound.
 * - estimated: computed from token counts and per-model rates.
 */
export function creditKind(e: CreditKindInput): CreditKind {
  const d = e.debugUsage;
  if (e.source === 'manual' || d?.creditsOverridden) return 'manual';
  if (e.exact === true) return 'exact';
  if (d) return (d.unpricedRequests ?? 0) > 0 || (d.logWarnings ?? 0) > 0 ? 'partial' : 'exact';
  return 'estimated';
}

export type CreditSplit = Record<CreditKind, number>;

export function emptyCreditSplit(): CreditSplit {
  return { exact: 0, partial: 0, estimated: 0, manual: 0 };
}

export function addCredit(split: CreditSplit, e: CreditKindInput): void {
  const c = Number(e.credits);
  if (!Number.isFinite(c)) return;
  split[creditKind(e)] += c;
}

export function creditConfidence(split: CreditSplit): Confidence {
  return confidenceOf([
    { key: 'exact', label: 'Recorded per request', value: split.exact, kind: 'measured' },
    { key: 'partial', label: 'Partial: some calls unpriced (lower bound)', value: split.partial, kind: 'estimated' },
    { key: 'estimated', label: 'Estimated from token rates', value: split.estimated, kind: 'estimated' },
    { key: 'manual', label: 'Entered or adjusted by hand', value: split.manual, kind: 'manual' }
  ]);
}

// ---- Time ------------------------------------------------------------------

export interface TimeConfidenceInput {
  /** Automatically tracked active ms that survived any correction. */
  trackedMs: number;
  /** Absolute size of manual corrections to tracked time. */
  adjustedMs: number;
  /** Active ms from manual effort entries. */
  manualMs: number;
  /** Active ms from time log entries. */
  timeLogMs: number;
  /** Branch moves touching the subject; tracked time follows the branch. */
  reassignments?: number;
}

export function timeConfidence(t: TimeConfidenceInput): Confidence {
  const n = t.reassignments ?? 0;
  return confidenceOf(
    [
      { key: 'tracked', label: 'Tracked automatically', value: t.trackedMs, kind: 'measured' },
      { key: 'adjusted', label: 'Corrected by hand', value: t.adjustedMs, kind: 'manual' },
      { key: 'manual', label: 'Manual effort entries', value: t.manualMs, kind: 'manual' },
      { key: 'timeLog', label: 'Time log entries', value: t.timeLogMs, kind: 'manual' }
    ],
    n > 0 ? `${n} branch move${n === 1 ? '' : 's'}: tracked time moved with the branch` : undefined
  );
}

// ---- Lines -----------------------------------------------------------------

export interface LinesConfidenceInput {
  /** Lines counted edit by edit. */
  trackedLines: number;
  /** Lines carried over from history recorded before line-level tracking. */
  inferredLines: number;
  /** Lines from manual effort entries. */
  manualLines: number;
}

export function linesConfidence(l: LinesConfidenceInput): Confidence {
  return confidenceOf([
    { key: 'tracked', label: 'Tracked edit by edit', value: l.trackedLines, kind: 'measured' },
    { key: 'inferred', label: 'Inferred from older history', value: l.inferredLines, kind: 'estimated' },
    { key: 'manual', label: 'Manual effort entries', value: l.manualLines, kind: 'manual' }
  ]);
}

// ---- Derived figures -------------------------------------------------------

/** One level for several inputs: the shared level, or mixed. Ignores 'none'. */
export function inheritLevel(...levels: ConfidenceLevel[]): ConfidenceLevel {
  const used = levels.filter(l => l !== 'none');
  if (!used.length) return 'none';
  return used.every(l => l === used[0]) ? used[0] : 'mixed';
}

/** Confidence of a figure computed from other figures, such as ROI. */
export function derivedConfidence(inputs: { label: string; conf: Confidence }[]): Confidence {
  const used = inputs.filter(i => i.conf.level !== 'none');
  const level = inheritLevel(...used.map(i => i.conf.level));
  const measuredShare = used.length ? used.reduce((s, i) => s + i.conf.measuredShare, 0) / used.length : 0;
  return {
    level,
    total: 0,
    measuredShare,
    parts: [],
    inputs: used.map(i => ({ label: i.label, level: i.conf.level }))
  };
}

export interface SubjectConfidence {
  credits: Confidence;
  time: Confidence;
  lines: Confidence;
  roi: Confidence;
}

export function subjectConfidence(
  credits: CreditSplit,
  time: TimeConfidenceInput,
  lines: LinesConfidenceInput
): SubjectConfidence {
  const c = creditConfidence(credits);
  const t = timeConfidence(time);
  const l = linesConfidence(lines);
  return {
    credits: c,
    time: t,
    lines: l,
    roi: derivedConfidence([
      { label: 'Time', conf: t },
      { label: 'Credits', conf: c }
    ])
  };
}
