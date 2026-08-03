import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { TrackingMode } from '../trackers/timeTracker';
import { ALL_CATEGORIES } from '../util/fileTypes';
import type { FileCategory } from '../util/fileTypes';
import {
  resolveEffectiveRates,
  computeRoiFigures,
  computeGeneratedValue,
  MS_PER_HOUR,
  type EffectiveRates,
  type RateGlobals,
  type RoiFigures,
  type GeneratedValue
} from '../util/rates';
import type { TurnAnalysis } from '../util/debugExport';

export interface LineStats {
  added: number;
  deleted: number;
}

export interface ExtStats {
  human: LineStats;
  ai: LineStats;
}

export interface BranchSummary {
  branch: string;
  workItemId: string | null;
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  idleMs: number;
  /**
   * The RAW auto-tracked ms per mode BEFORE the issue #47 adjustment is applied
   * (the untouched {@link BranchData.time} buckets). Exposed so the dashboard can
   * show the original tracked value alongside the corrected one and prove the raw
   * number is never lost. The `humanCodingMs`/`aiGeneratingMs`/`reviewingMs`/
   * `idleMs` fields above are the EFFECTIVE (adjusted, clamped-at-0) values used
   * by every rollup / ROI calculation.
   */
  rawTime: Record<TrackingMode, number>;
  /**
   * The per-mode adjustment DELTA in ms currently applied to this branch (issue
   * #47). Only modes with a non-zero adjustment are present; an empty object
   * means the branch is fully on its raw auto-tracked value.
   */
  timeAdjustment: Partial<Record<TrackingMode, number>>;
  // Aggregated line totals
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  copilotAcceptances: number;
  estimatedCostUsd: number;
  chatCharsHuman: number;
  chatTurnsHuman: number;
  humanChars: number;
  aiChars: number;
  humanKeystrokes: number;
  aiInserts: number;
  aiInlineLines: number;
  aiChatLines: number;
  aiInlineChars: number;
  aiChatChars: number;
  creditsTotal: number;
  creditsByModel: { model: string; credits: number; turns: number }[];
  // Breakdown by file extension: { "al": { human: {...}, ai: {...} }, ... }
  byExt: Record<string, ExtStats>;
  // Breakdown by category (programming/specification/documentation/deployment/config/other)
  byCategory: Record<string, { human: LineStats; ai: LineStats }>;
  /**
   * The itemised time-log entries attached to THIS branch (issue #60), newest
   * first. These `source:'manual'` entries are ALREADY INCLUDED (additively) in
   * the effective time above; the array just lets the UI render the per-entry
   * Time Log card and a running total. Display-only.
   */
  timeEntries?: TimeEntry[];
  /**
   * Economic ROI figures (issue #45) for this branch, computed from the EFFECTIVE
   * rates of the branch's owning project (project override → global default →
   * legacy) applied to its billable time + ledger credits/cost. Money fields are
   * `null` when a required rate is unconfigured (never NaN). Display-only: the
   * webview renders credit cost / ROI net / value produced from THIS instead of a
   * global heuristic, so branch, work-item and project ROI share one rate source.
   */
  roi: RoiFigures;
}

export interface CreditEntry {
  ts: number;
  model: string;
  credits: number;
  note?: string;
}

/** How a {@link LedgerEntry} was captured. */
export type LedgerSource = 'manual' | 'auto' | 'import';

/**
 * A first-class credit ledger row (issue #11 / milestone M2). Unlike the legacy
 * per-branch {@link CreditEntry}, ledger entries live at the TOP LEVEL of the
 * store so credit/cost can be summed across branches by work item, project, or
 * period. `source` separates ESTIMATED auto captures from manual/import so
 * callers can compute manual-only vs auto vs all (addresses the #17
 * over-counting concern). Attribution (`branch`/`workItemId`/`projectId`) is
 * resolved at write/migration time and stored on the row.
 */
export interface LedgerEntry {
  id: string;
  ts: number;
  model: string;
  credits: number;
  cost?: number;
  source: LedgerSource;
  branch?: string;
  workItemId?: string | null;
  projectId?: string | null;
  chatSessionId?: string | null;
  note?: string;
  /**
   * Real prompt (input) tokens captured from VS Code chat session storage
   * (issue #59). Optional and additive: pre-#59 rows simply lack it and load as
   * `undefined`, so no schema migration is required — {@link migrateStore} passes
   * the ledger through untouched.
   */
  promptTokens?: number;
  /** Real completion (output) tokens captured from chat session storage (#59). */
  completionTokens?: number;
  /**
   * True when `credits` is the EXACT AIU cost read from a request's
   * `copilot_usage.total_nano_aiu` (caught by the live tailer before compaction);
   * false/undefined when `credits` is the deterministic per-model token-rate
   * ESTIMATE (issue #59). An exact capture upgrades an earlier estimate for the
   * same requestId in place (never a second row).
   */
  exact?: boolean;
  /**
   * Compact, code-free deep-analysis of an IMPORTED chat turn (issue #74): per-file
   * line counts, tool histogram, and per-request token tiers. Present only on
   * `source:'import'` rows that carried a debug export. Optional and additive —
   * pre-#74 rows lack it and load as `undefined`, so no migration is needed.
   */
  analysis?: TurnAnalysis;
}

/**
 * A hand-entered effort/time/line adjustment for a work item (issue #21 /
 * milestone M5). Mirrors the first-class credit ledger ({@link LedgerEntry}):
 * manual effort lives at the TOP LEVEL of the store (its own `manualEffort`
 * array) so a user can CORRECT under/over-tracked effort per work item without
 * touching the automatic per-branch capture path (issue #17). `source` is fixed
 * to `'manual'` so these rows are always separable from auto-captured data.
 *
 * All measurement fields are optional so one entry can add just time, just
 * lines, or both:
 *  - `mode` + `durationMs` add time onto that {@link TrackingMode} bucket.
 *  - `category` + `linesAdded`/`linesDeleted` add lines onto that
 *    {@link FileCategory} bucket, on the AI side when `isAi` is true else human.
 */
export interface ManualEffortEntry {
  id: string;
  ts: number;
  workItemId: string;
  mode?: TrackingMode;
  category?: FileCategory;
  durationMs?: number;
  linesAdded?: number;
  linesDeleted?: number;
  isAi?: boolean;
  note?: string;
  source: 'manual';
}

/**
 * An immutable audit-trail entry recording that a branch was re-homed from one
 * work item to another (issue #22 / milestone M5). Unlike the branch → work item
 * mapping itself (which is stored on {@link BranchData} and simply overwritten on
 * each reassignment), these rows live at the TOP LEVEL of the store so the full
 * HISTORY of corrections survives — a user can see exactly when effort was
 * re-homed, from where, to where, and why. `fromWorkItemId` captures the branch's
 * PREVIOUS mapping (null when it was unmapped) taken BEFORE the re-point, so the
 * record is a faithful before/after snapshot. `batchId` groups the rows written
 * by a single bulk reassignment; a single-branch move is simply a batch of one.
 */
export interface ReassignmentRecord {
  id: string;
  ts: number;
  branch: string;
  /** The branch's work item BEFORE this move, or null when it was unmapped. */
  fromWorkItemId: string | null;
  /** The work item the branch was moved TO. */
  toWorkItemId: string;
  note?: string;
  /** Groups records written together by one bulk operation. */
  batchId?: string;
}

/**
 * Caller-supplied fields for {@link Database.addManualEffort}. `id`/`source` are
 * assigned by the store; `ts` defaults to now when omitted.
 */
export interface ManualEffortInput {
  workItemId: string;
  ts?: number;
  mode?: TrackingMode;
  category?: FileCategory;
  durationMs?: number;
  linesAdded?: number;
  linesDeleted?: number;
  isAi?: boolean;
  note?: string;
}

/**
 * Editable fields for {@link Database.updateManualEffort} (issue #21). Only keys
 * that are present are applied. `id`/`source` are intentionally NOT editable so
 * a row's identity and provenance survive an edit. Passing `null` for an
 * optional measurement field clears it.
 */
export interface ManualEffortPatch {
  workItemId?: string;
  ts?: number;
  mode?: TrackingMode | null;
  category?: FileCategory | null;
  durationMs?: number | null;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  isAi?: boolean | null;
  note?: string | null;
}

/** The categories allowed on a {@link TimeEntry} (issue #60) — a descriptive tag
 * for the KIND of work, distinct from the file-based {@link FileCategory}; it does
 * not feed any line bucket. */
export const TIME_ENTRY_CATEGORIES = ['programming', 'spec', 'docs', 'deployment', 'other'] as const;
export type TimeEntryCategory = typeof TIME_ENTRY_CATEGORIES[number];

/**
 * One discrete, itemised time-log entry (issue #60 / milestone M5). Unlike the
 * single #21 manual-effort CORRECTION or the #47 aggregate DELTA, this is an
 * append-only LOG row — "worked 10:00–11:00" — that the user can add, edit and
 * delete individually. Entries live at the TOP LEVEL of the store (its own
 * `timeEntries` array, exactly like `manualEffort`/`reassignments`) so they span
 * branches and survive re-homings.
 *
 * `durationMs` is the AUTHORITATIVE amount (derived from `startTs`/`endTs` when
 * those are given, or entered directly). Attachment is optional and drives the
 * roll-up level (see the Database roll-up helpers): a `branch` entry rolls up at
 * the branch level, else a `workItemId` entry at the work-item level, else a
 * `projectId` entry at the project level. `source` separates hand-entered
 * `'manual'` rows (which DO roll up) from any future `'auto'` surfacing of tracked
 * sessions (display-only, so they can never double-count the auto buckets).
 */
export interface TimeEntry {
  id: string;
  workItemId?: string;
  branch?: string;
  projectId?: string;
  /** Optional explicit start (epoch ms). */
  startTs?: number;
  /** Optional explicit end (epoch ms). */
  endTs?: number;
  /** Authoritative duration in ms (from start/end, or entered directly). */
  durationMs: number;
  mode?: TrackingMode;
  category?: TimeEntryCategory;
  source: 'manual' | 'auto';
  note?: string;
  createdAt: number;
}

/**
 * Caller-supplied fields for {@link Database.addTimeEntry} (issue #60). `id` and
 * `createdAt` are assigned by the store; `source` defaults to `'manual'`;
 * `durationMs` may be omitted when `startTs`+`endTs` bound a valid interval.
 */
export interface TimeEntryInput {
  workItemId?: string;
  branch?: string;
  projectId?: string;
  startTs?: number;
  endTs?: number;
  durationMs?: number;
  mode?: TrackingMode;
  category?: TimeEntryCategory;
  source?: 'manual' | 'auto';
  note?: string;
}

/**
 * Editable fields for {@link Database.updateTimeEntry} (issue #60). Only keys that
 * are present are applied; `id`/`source`/`createdAt` are intentionally NOT editable
 * so a row's identity and provenance survive an edit. Passing `null` for an
 * optional field clears it.
 */
export interface TimeEntryPatch {
  workItemId?: string | null;
  branch?: string | null;
  projectId?: string | null;
  startTs?: number | null;
  endTs?: number | null;
  durationMs?: number;
  mode?: TrackingMode | null;
  category?: TimeEntryCategory | null;
  note?: string | null;
}

/** Optional filter for {@link Database.getTimeEntries} (issue #60). */
export interface TimeEntryQuery {
  workItemId?: string;
  branch?: string;
  projectId?: string;
  /** Inclusive lower bound on the entry's effective timestamp (ms). */
  from?: number;
  /** Inclusive upper bound on the entry's effective timestamp (ms). */
  to?: number;
}

/**
 * The rolled-up contribution of a work item's MANUAL effort entries (issue #21),
 * kept separate from the automatic totals so the UI can show what portion of a
 * work item's effort was hand-entered. Time is summed per {@link TrackingMode}
 * bucket; lines are summed per {@link FileCategory} plus flat human/AI totals.
 */
export interface ManualRollup {
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  idleMs: number;
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  /** Number of manual entries that rolled into this total. */
  entries: number;
  byCategory: Record<string, { human: LineStats; ai: LineStats }>;
}

/** Optional filter for {@link Database.getCredits} and its wrappers. */
export interface CreditQuery {
  branch?: string;
  workItemId?: string | null;
  projectId?: string | null;
  source?: LedgerSource;
  /** Inclusive lower bound on entry timestamp (ms). */
  from?: number;
  /** Inclusive upper bound on entry timestamp (ms). */
  to?: number;
}

/**
 * Editable fields for {@link Database.updateLedgerEntry} (issue #19). Only keys
 * that are present are applied; `cost: null` clears the optional cost. `id`,
 * `source`, `branch` and `chatSessionId` are intentionally NOT editable so a
 * row's identity and provenance survive a manual correction. `projectId` is not
 * listed because it is derived from `workItemId`, not set directly.
 */
export interface LedgerEntryPatch {
  model?: string;
  credits?: number;
  cost?: number | null;
  note?: string;
  workItemId?: string | null;
  ts?: number;
}

/** Summable credit/cost totals for a ledger slice. */
export interface CreditTotals {
  credits: number;
  cost: number;
  entries: number;
  byModel: { model: string; credits: number; turns: number }[];
  bySource: { manual: number; auto: number; import: number };
}

/** One calendar day of activity for a branch (key = YYYY-MM-DD, local time). */
export interface DailyBucket {
  humanCoding: number;
  aiGenerating: number;
  reviewing: number;
  idle: number;
  linesHuman: number;
  linesAi: number;
  /** Active ms per hour-of-day (0-23) — drives the activity heatmap. */
  hours: number[];
  /** Active ms per hour-of-day split by mode — drives the today timeline. */
  hoursByMode?: { humanCoding: number[]; aiGenerating: number[]; reviewing: number[] };
}

/** Cumulative edit stats for a single file (hotspots). */
export interface FileStat {
  humanAdded: number;
  humanDeleted: number;
  aiAdded: number;
  aiDeleted: number;
  edits: number;
  lastTs: number;
}

/** A completed uninterrupted focus/flow session. */
export interface FocusSession {
  ts: number;      // end timestamp
  ms: number;      // duration of continuous active work
  humanMs: number; // portion spent human-coding
  aiMs: number;    // portion spent with AI generating
}

/** Aggregated point for the daily trend chart (across all branches). */
export interface DailyPoint {
  date: string;
  humanCoding: number;
  aiGenerating: number;
  reviewing: number;
  idle: number;
  linesHuman: number;
  linesAi: number;
}

export interface FocusStats {
  sessionsToday: number;
  sessionsWeek: number;
  totalFocusMsToday: number;
  totalFocusMsWeek: number;
  longestMs: number;
  avgMs: number;
  goalProgressPct: number;
}

export interface StreakStats {
  current: number;
  longest: number;
}

export interface WeekAgg {
  activeMs: number;
  lines: number;
  aiShare: number;
}

export interface WeekComparison {
  thisWeek: WeekAgg;
  lastWeek: WeekAgg;
}

export interface TopFile {
  path: string;
  human: number;
  ai: number;
  edits: number;
  total: number;
  aiShare: number;
  lastTs: number;
}

export interface TodayTimeline {
  humanCoding: number[];
  aiGenerating: number[];
  reviewing: number[];
}

interface BranchData {
  workItemId: string | null;
  /**
   * Sticky manual-override marker (issue #10). When true the branch → work item
   * mapping was set explicitly by the user and MUST NOT be overwritten by
   * branch-name auto-detection. Absent/false ⇒ the mapping is auto-managed.
   */
  workItemIdManual?: boolean;
  time: Record<TrackingMode, number>;
  /**
   * Optional per-mode adjustment DELTA in ms (issue #47 / schema v9), applied on
   * top of the raw auto-tracked {@link BranchData.time} buckets to CORRECT
   * over/under-counting. Values may be NEGATIVE. The raw buckets are NEVER
   * mutated by this feature — {@link Database.recordTime} keeps incrementing them
   * — so the EFFECTIVE time for a mode is `max(0, raw + (timeAdjustment[mode] ??
   * 0))` and the original tracked value stays intact and restorable via
   * {@link Database.clearTimeAdjustment}. Absent (or an empty object after
   * sanitizing) ⇒ no adjustment. A delta of exactly 0 is never stored (it is a
   * no-op) — see {@link sanitizeBranchTimeAdjustments}.
   */
  timeAdjustment?: Partial<Record<TrackingMode, number>>;
  copilotAcceptances: number;
  chatCharsHuman?: number;
  chatTurnsHuman?: number;
  humanCharsInserted?: number;
  aiCharsInserted?: number;
  humanKeystrokes?: number;
  aiInserts?: number;
  aiInlineLines?: number;
  aiChatLines?: number;
  aiInlineChars?: number;
  aiChatChars?: number;
  creditsLog?: CreditEntry[];
  /** Count of model requests auto-captured from the Copilot chat log. */
  autoModelRequests?: number;
  daily?: Record<string, DailyBucket>;
  focusSessions?: FocusSession[];
  files?: Record<string, FileStat>;
  // line changes keyed by ext → source → { added, deleted }
  lineChanges: Record<string, { human: LineStats; ai: LineStats }>;
}

type Store = Record<string, BranchData>;

/**
 * A unit of work that may span multiple branches (issue #9 / milestone M2).
 * A branch is auto-associated to a work item via {@link GitTracker.extractWorkItemId}.
 * projectId/externalRef are intentionally nullable — they land in later milestones
 * (#12 project rollups, Azure DevOps linkage) but the field is reserved now so the
 * persisted shape is forward-compatible.
 */
export interface WorkItem {
  id: string;
  title: string | null;
  projectId: string | null;
  estimate: number | null;
  externalRef: string | null;
  createdAt: number;
  /**
   * Optional per-category estimate breakdown (issue #16 / milestone M3). Keyed by
   * {@link FileCategory} so it reuses the same category vocabulary as tracked
   * effort. When present and non-empty it is the source of truth for the TOTAL
   * estimate ({@link workItemTotalEstimate} = sum of the parts) and the scalar
   * {@link WorkItem.estimate} is kept in sync as that sum. When absent, the
   * scalar `estimate` remains the canonical total. Missing/omitted categories
   * count as 0.
   */
  estimateBreakdown?: EstimateBreakdown;
  /** Unit the estimate numbers are expressed in (issue #16). Defaults to 'hours'. */
  estimateUnit?: EstimateUnit;
  /**
   * Manual 'could-charge' billable-hours override (issue #46), DECOUPLED from
   * the actual tracked time. When set to a finite, non-negative number it is the
   * billable quantity used for the invoice/ROI economics; when `null`/absent the
   * effective billable hours default to the work item's total estimate (only
   * when {@link estimateUnit} is hours) and finally to the actual worked hours.
   * A 'points' estimate is never used as billable hours. See
   * {@link Database.setBillableHours} / `effectiveBillableHours`.
   */
  billableHours?: number;
}

/** Categories an estimate can be broken down by — reuses {@link FileCategory}. */
export type EstimateCategory = FileCategory;

/** Unit an estimate is expressed in (issue #16). */
export type EstimateUnit = 'hours' | 'points';

/** Sparse per-category estimate map. Omitted categories are treated as 0. */
export type EstimateBreakdown = Partial<Record<EstimateCategory, number>>;

/**
 * Resolve a work item's TOTAL estimate (issue #16). Rule: if a non-empty
 * {@link WorkItem.estimateBreakdown} exists, the total is the SUM of its parts;
 * otherwise it falls back to the scalar {@link WorkItem.estimate}. Returns null
 * only when neither a breakdown nor a scalar estimate is present. Pure.
 */
export function workItemTotalEstimate(
  wi: Pick<WorkItem, 'estimate' | 'estimateBreakdown'>
): number | null {
  const sum = sumBreakdown(wi.estimateBreakdown);
  if (sum !== null) return sum;
  return wi.estimate ?? null;
}

/** Sum a breakdown's numeric parts, or null when it is missing/empty. Pure. */
export function sumBreakdown(breakdown: EstimateBreakdown | undefined): number | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  let total = 0;
  let seen = false;
  for (const cat of ALL_CATEGORIES) {
    const v = breakdown[cat];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Per-project settings (issue #8 extension point; rate fields land in #15 / M3).
 * The rate fields below are the per-project OVERRIDES for ROI economics; when a
 * field is absent the effective value falls back to a global default and then to
 * a legacy setting (see {@link resolveEffectiveRates} / package.json). Because
 * these live inside `Project.settings`, which already persists, adding them does
 * NOT change the on-disk envelope shape and needs no schema bump. The index
 * signature is kept so the object stays open/extensible for future settings.
 */
export interface ProjectSettings {
  /** What one developer hour COSTS for this project (money, in `currency`). */
  hourlyCostRate?: number;
  /** What one developer hour is BILLED/SOLD for on this project (money). */
  hourlySellRate?: number;
  /** Currency the rate figures are expressed in (e.g. 'USD', 'EUR'). */
  currency?: string;
  /** Money cost per 1 credit / premium-request, for folding AI spend into cost. */
  creditCostPerUnit?: number;
  [key: string]: unknown;
}

/**
 * A first-class Project entity (issue #8 / milestone M2). A project groups one
 * or more repositories (`repos`, many-to-many capable) and, transitively, the
 * work items whose {@link WorkItem.projectId} points here. Effort and credits
 * roll up branch → work item → project. `settings` carries per-project rate/ROI
 * configuration (issue #15) and remains open for future keys.
 */
export interface Project {
  id: string;
  name: string;
  /** Repository identities owned by this project. See {@link normalizeRepoId}. */
  repos: string[];
  settings?: ProjectSettings;
  createdAt: number;
}

/**
 * On-disk envelope (schemaVersion >= 1). Older files were a flat
 * `Record<branchName, BranchData>` map with no version; {@link migrateStore}
 * upgrades those in place while preserving every existing field.
 */
export interface PersistedStore {
  schemaVersion: number;
  branches: Store;
  workItems: Record<string, WorkItem>;
  /** First-class credit ledger (issue #11). Top-level so it spans branches. */
  creditLedger: LedgerEntry[];
  /** First-class projects keyed by id (issue #8). Top-level so repos/work items map into them. */
  projects: Record<string, Project>;
  /**
   * Hand-entered effort adjustments (issue #21). Top-level, like the credit
   * ledger, so a work item's manual corrections span its branches and stay
   * separable from the automatic capture path.
   */
  manualEffort: ManualEffortEntry[];
  /**
   * Immutable branch → work item reassignment audit trail (issue #22). Top-level,
   * like the credit ledger and manual effort, so the HISTORY of corrections spans
   * branches and work items and survives future re-points. Added in schema v7.
   */
  reassignments: ReassignmentRecord[];
  /**
   * Itemised time-log entries (issue #60). Top-level, like the credit ledger,
   * manual effort and reassignments, so discrete time rows span branches and
   * work items and stay separable from the automatic capture path. Added in
   * schema v10.
   */
  timeEntries: TimeEntry[];
}

/** Aggregated effort for a single work item, rolled up across all its branches. */
export interface WorkItemSummary {
  workItemId: string;
  title: string | null;
  projectId: string | null;
  estimate: number | null;
  /** Per-category estimate breakdown, if one was entered (issue #16). */
  estimateBreakdown?: EstimateBreakdown;
  /** Unit the estimate is expressed in (issue #16). Defaults to 'hours'. */
  estimateUnit?: EstimateUnit;
  externalRef: string | null;
  createdAt: number;
  /** Branch names that currently roll up into this work item. */
  branches: string[];
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  idleMs: number;
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  copilotAcceptances: number;
  estimatedCostUsd: number;
  chatCharsHuman: number;
  chatTurnsHuman: number;
  humanChars: number;
  aiChars: number;
  humanKeystrokes: number;
  aiInserts: number;
  aiInlineLines: number;
  aiChatLines: number;
  aiInlineChars: number;
  aiChatChars: number;
  creditsTotal: number;
  creditsByModel: { model: string; credits: number; turns: number }[];
  byExt: Record<string, ExtStats>;
  byCategory: Record<string, { human: LineStats; ai: LineStats }>;
  /**
   * The portion of the totals above that came from MANUAL effort entries
   * (issue #21). The mode/line/category numbers here are ALREADY INCLUDED in the
   * fields above (manual is additive); this breakdown just lets the UI show how
   * much of a work item's effort was hand-entered vs auto-tracked.
   */
  manual: ManualRollup;
  /**
   * Economic ROI figures (issue #45) for this work item, from its owning
   * project's EFFECTIVE rates applied to its rolled-up billable time + ledger
   * credits/cost. Money fields are `null` when a required rate is unconfigured
   * (never NaN). Shares the same rate source as branch and project ROI so the
   * three can never disagree. Display-only.
   */
  roi: RoiFigures;
  /**
   * The monetary VALUE OF GENERATED LINES for this work item (issue #48): its
   * rolled-up added lines (human + AI) expressed as equivalent authoring hours at
   * the global baseline speed, and what that time is worth at the project's
   * effective sell rate + currency. `generatedValue` is `null` when the sell rate
   * (or baseline) is unconfigured — never NaN — and `equivalentHours` doubles as
   * the SUGGESTED `billableHours` the UI offers. Shares the same effective-rate
   * source as {@link roi} so they can never disagree. Display-only / derived.
   */
  generated: GeneratedValue;
  /**
   * The itemised time-log entries that roll up into THIS work item (issue #60),
   * newest first — branch-scoped entries on the work item's mapped branches plus
   * branch-less entries attached directly to it. Already INCLUDED (additively) in
   * the totals above; the array drives the per-entry Time Log card. Display-only.
   */
  timeEntries?: TimeEntry[];
}

/** The numeric/breakdown portion of a {@link WorkItemSummary} (identity omitted). */
export type BranchRollup = Omit<
  WorkItemSummary,
  | 'workItemId' | 'title' | 'projectId' | 'estimate' | 'estimateBreakdown'
  | 'estimateUnit' | 'externalRef' | 'createdAt' | 'branches' | 'manual' | 'roi'
  | 'generated' | 'timeEntries'
>;

/** One category's estimate vs tracked actual for a work item (issue #16). */
export interface EstimateActualRow {
  category: EstimateCategory;
  /** Planned estimate for this category (0 when none was entered). */
  estimate: number;
  /** Tracked actual for this category (see {@link Database.getEstimateVsActual}). */
  actual: number;
}

/**
 * Estimate-vs-actual comparison for a work item (issue #16). `unit` is the
 * estimate's unit; `actual` numbers are lines-added (not the same unit) and are
 * provided for relative comparison only. `total` mirrors the per-category rows.
 */
export interface EstimateVsActual {
  workItemId: string;
  unit: EstimateUnit;
  /** True when the work item has no estimate at all (total + breakdown absent). */
  hasEstimate: boolean;
  byCategory: EstimateActualRow[];
  total: { estimate: number | null; actual: number };
}

/**
 * Aggregated effort for a single {@link Project}, rolled up across every work
 * item that belongs to it and, in turn, all of those work items' branches.
 * Mirrors {@link WorkItemSummary}: identity fields plus the shared numeric
 * {@link BranchRollup}. `credits` comes straight from the top-level ledger via
 * {@link Database.getCreditsForProject} so project spend is authoritative even
 * when it differs from the per-branch estimate.
 */
export interface ProjectSummary extends BranchRollup {
  projectId: string;
  name: string;
  repos: string[];
  createdAt: number;
  /** Work item ids that belong to this project. */
  workItemIds: string[];
  /** Branch names that roll up into this project (via its work items). */
  branches: string[];
  /** Ledger-derived credit/cost totals for the project. */
  credits: CreditTotals;
  /**
   * Economic ROI figures (issue #15) computed from the project's EFFECTIVE
   * rates + its rolled-up billable time + its ledger credits. Money fields are
   * `null` when a required rate is unconfigured (never NaN). This is raw input
   * for the ROI report (M7 / #29), not the report itself.
   */
  roi: ProjectRoi;
}

/**
 * A project's resolved rates + ROI economic figures (issue #15). Extends the
 * pure {@link RoiFigures} with the owning project id so callers can carry it
 * around standalone (see {@link Database.getProjectRoi}).
 */
export interface ProjectRoi extends RoiFigures {
  projectId: string;
}

/**
 * Current persisted schema version. Bump when the on-disk shape changes.
 *
 * v4 (issue #10) reserves the optional `BranchData.workItemIdManual` sticky
 * marker. No data rewrite is needed: {@link migrateStore} carries every branch
 * record through untouched and a missing marker is treated as `auto`, so a v3 →
 * v4 load is a pure, idempotent, zero-loss default.
 *
 * v5 (issue #16) adds optional `WorkItem.estimateBreakdown` (per-category
 * estimate) and `WorkItem.estimateUnit`. No data rewrite is needed either:
 * {@link migrateStore} carries the `workItems` map through untouched, so a
 * legacy work item keeps its scalar `estimate` (the total falls back to it when
 * no breakdown is present) and simply has `estimateBreakdown`/`estimateUnit`
 * undefined. A v4 → v5 load is therefore pure, idempotent and zero-loss.
 *
 * v5 also hosts the issue #12 branch → work item back-migration
 * ({@link assignUnmappedBranches}): every previously-orphaned branch (one whose
 * `workItemId` was `null` because it pre-dated auto-detection or its name did
 * not match) is either auto-detected into its work item or parked in the
 * {@link UNASSIGNED_WORK_ITEM_ID} holding item. This only SETS a
 * previously-null `workItemId` and may create a work item entity — it does NOT
 * change the on-disk envelope SHAPE (both fields already exist), so NO schema
 * bump is required and the pass stays pure, idempotent and zero-loss.
 *
 * v7 (issue #22) adds the top-level `reassignments` audit trail — the immutable
 * history of branch → work item re-homings. {@link migrateStore} defaults it to
 * `[]` for every pre-v7 file (both the current envelope and the legacy flat map)
 * exactly as `manualEffort`/`creditLedger` are defaulted, so a v6 → v7 load is a
 * pure, idempotent, zero-loss default with no rewrite of existing data.
 *
 * v8 (issue #46) adds optional `WorkItem.billableHours` — the manual
 * 'could-charge' hours override, DECOUPLED from actual worked time. No data
 * rewrite is needed: a pre-v8 work item simply has the field undefined, which
 * means "use the default" (estimate-in-hours, else actual hours). For BOTH the
 * current envelope AND the legacy flat map, {@link migrateStore} runs
 * {@link normalizeWorkItemBillableHours}, which only strips a persisted
 * `billableHours` that is not a finite, non-negative number. That is pure,
 * idempotent and zero-loss (a valid value round-trips untouched; an invalid one
 * would have been ignored by the ROI math anyway), so a v7 → v8 load never NaNs
 * and never loses data.
 *
 * v9 (issue #47) adds the optional per-branch `BranchData.timeAdjustment` — a
 * per-mode signed ms DELTA that CORRECTS the raw auto-tracked `time` buckets
 * (over/under-counting) without mutating them, so the effective time for a mode
 * is `max(0, raw + (timeAdjustment[mode] ?? 0))` and the raw value stays intact
 * and restorable. No data rewrite is needed: a pre-v9 branch simply has the
 * field undefined, which means "no adjustment". For BOTH the current envelope
 * AND the legacy flat map (which converge on the shared `branches` map),
 * {@link migrateStore} runs {@link sanitizeBranchTimeAdjustments}, which strips
 * the field when absent/empty and drops any per-mode entry that is not a finite
 * non-zero number. That is pure, idempotent and zero-loss (a valid delta
 * round-trips untouched; a 0 or garbage delta — which the effective-time math
 * would treat as a no-op anyway — is removed), so a v8 → v9 load never NaNs and
 * never loses data.
 *
 * v10 (issue #60) adds the top-level `timeEntries` array — an append-only,
 * itemised time LOG (discrete start/end or direct-duration rows) that rolls up
 * additively into the effective time. {@link migrateStore} defaults it to `[]`
 * for any pre-v10 file (envelope or legacy flat map) and runs
 * {@link sanitizeTimeEntries}, exactly as `manualEffort`/`reassignments` are
 * defaulted/sanitized, so a v9 → v10 load is a pure, idempotent, zero-loss
 * upgrade that never NaNs and never loses data.
 */
export const CURRENT_SCHEMA_VERSION = 10;

/**
 * Well-known holding work item (issue #12) for branches that carry effort but
 * cannot be resolved to a real work item after auto-detection. Parking them here
 * keeps their historical effort/credits VISIBLE in the work-item model instead
 * of orphaned under a `null` mapping. It is deliberately KEPT DISTINCT from the
 * detached-HEAD `unknown` bucket (see {@link RESERVED_BRANCH_BUCKETS}).
 */
export const UNASSIGNED_WORK_ITEM_ID = '__unassigned__';

/**
 * Branch buckets that never map to a real work item and must never be folded
 * into the {@link UNASSIGNED_WORK_ITEM_ID} holding item. `unknown` is the
 * detached-HEAD / no-branch fallback used across the extension and stays its own
 * standalone bucket by design (issue #12).
 */
const RESERVED_BRANCH_BUCKETS = new Set<string>(['unknown']);

/**
 * Work item ids that are NOT real, user-facing work items and must be shielded
 * from being force-merged into a project (see {@link Database.setProjectForWorkItem}).
 * `unknown` is the detached-HEAD bucket; `__unassigned__` is the issue #12
 * holding item — it is a visible work item in listings but should not be dragged
 * into a project by automation.
 */
const NON_WORK_ITEM_IDS = new Set<string>(['unknown', UNASSIGNED_WORK_ITEM_ID]);

/**
 * Derive a work item id from a branch name (issue #12 single source of truth).
 *
 * This is the SAME detection the live tracker applies on branch switch — the
 * tracker's `GitTracker.extractWorkItemId` delegates here so the regex lives in
 * exactly ONE place and migration + live tracking can never drift. Matches
 * `feature/1234-something`, `bugfix/1234`, `1234-auth`, etc. Pure.
 */
export function extractWorkItemId(branch: string): string | undefined {
  // Matches patterns like: feature/1234-something, bugfix/1234, 1234-something
  const match = branch.match(/(?:^|[/_-])(\d{3,6})(?:[_-]|$)/);
  return match?.[1];
}

function isEnvelope(parsed: unknown): parsed is PersistedStore {
  return (
    !!parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as PersistedStore).schemaVersion === 'number' &&
    !!(parsed as PersistedStore).branches &&
    typeof (parsed as PersistedStore).branches === 'object'
  );
}

/**
 * Back-fill {@link WorkItem} entities from branch records that already carry a
 * `workItemId` (set by auto-detection). Existing work items are never overwritten,
 * so titles/estimates added later survive re-migration. Pure + side-effect-free on
 * inputs other than the passed `workItems` map, so it is easy to unit test.
 */
export function backfillWorkItems(
  branches: Store,
  workItems: Record<string, WorkItem>
): void {
  for (const data of Object.values(branches)) {
    const id = data?.workItemId;
    if (!id || NON_WORK_ITEM_IDS.has(id) || workItems[id]) continue;
    workItems[id] = {
      id,
      title: null,
      projectId: null,
      estimate: null,
      externalRef: null,
      createdAt: Date.now()
    };
  }
}

/**
 * Back-migrate every ORPHANED branch (issue #12) into the work-item model so no
 * historical effort is left invisible under a `null` mapping. For each branch
 * whose `workItemId` is still `null` (and which is NOT a sticky manual mapping):
 *  1. run the SAME branch-name `detect` used by the live tracker; if it yields
 *     an id, adopt it and ensure the work item entity exists;
 *  2. otherwise, if the branch is a reserved bucket (detached-HEAD `unknown`),
 *     leave it as its own standalone bucket — never fold it into the holding item;
 *  3. otherwise park it in the {@link UNASSIGNED_WORK_ITEM_ID} holding work item
 *     (created lazily with a clear 'Unassigned' title) so its effort stays visible.
 *
 * Strictly additive and idempotent: it only ever SETS a previously-null
 * `workItemId` (and may create a work item), never clears, overwrites or drops
 * any branch field. A branch already mapped — manual or auto — is skipped, so a
 * second run changes nothing. Pure over the passed structures (the `detect`
 * function is injected) for easy unit testing.
 */
export function assignUnmappedBranches(
  branches: Store,
  workItems: Record<string, WorkItem>,
  detect: (branch: string) => string | undefined
): void {
  for (const [name, data] of Object.entries(branches)) {
    if (!data || typeof data !== 'object') continue;
    // Only touch orphaned branches; never override an existing (manual OR auto) mapping.
    if (data.workItemId != null || data.workItemIdManual) continue;

    const detected = detect(name);
    if (detected && !NON_WORK_ITEM_IDS.has(detected)) {
      data.workItemId = detected;
      if (!workItems[detected]) {
        workItems[detected] = {
          id: detected,
          title: null,
          projectId: null,
          estimate: null,
          externalRef: null,
          createdAt: Date.now()
        };
      }
      continue;
    }

    // Detached-HEAD `unknown` (and other reserved buckets) stay standalone.
    if (RESERVED_BRANCH_BUCKETS.has(name)) continue;

    // Everything else that carries effort but has no work item lands in the holding item.
    data.workItemId = UNASSIGNED_WORK_ITEM_ID;
    if (!workItems[UNASSIGNED_WORK_ITEM_ID]) {
      workItems[UNASSIGNED_WORK_ITEM_ID] = {
        id: UNASSIGNED_WORK_ITEM_ID,
        title: 'Unassigned',
        projectId: null,
        estimate: null,
        externalRef: null,
        createdAt: Date.now()
      };
    }
  }
}
export function newLedgerId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Extremely old runtimes without randomUUID — fall back to a unique-enough id.
    return `led-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Infer a ledger {@link LedgerSource} from a legacy credit note. */
export function inferLedgerSource(note?: string): LedgerSource {
  return note && note.startsWith('auto') ? 'auto' : 'manual';
}

/**
 * Canonicalize a repository identity for project ↔ repo mapping (issue #8).
 *
 * The extension already identifies the workspace by its git checkout (see
 * {@link GitTracker}), so the PREFERRED identity is the `origin` remote URL
 * normalized to a stable `host/owner/repo` form (protocol/credentials/`.git`
 * suffix stripped, scp-style `git@host:owner/repo` rewritten, host lower-cased).
 * When there is no remote (local-only repo) the caller passes the workspace
 * folder path instead, which is returned as-is aside from trailing-slash
 * trimming. Pure and idempotent so it is safe to run on already-normalized ids.
 */
export function normalizeRepoId(repoIdOrRemoteUrl: string): string {
  const raw = (repoIdOrRemoteUrl ?? '').trim();
  if (!raw) return '';
  // A filesystem path fallback (Windows drive, UNC, or POSIX absolute) — leave
  // the path intact but drop any trailing separators for a stable key.
  const looksLikePath = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/');
  if (looksLikePath) return raw.replace(/[\\/]+$/, '');

  let s = raw;
  // scp-style: git@github.com:owner/repo(.git) → github.com/owner/repo
  const scp = s.match(/^[^@/]+@([^:]+):(.+)$/);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // Strip a URL scheme and any embedded credentials.
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    s = s.replace(/^[^@/]+@/, '');
  }
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  const slash = s.indexOf('/');
  if (slash > 0) {
    // Lower-case just the host segment; owner/repo casing is preserved.
    s = s.slice(0, slash).toLowerCase() + s.slice(slash);
  }
  return s;
}

/**
 * Fold every branch's legacy per-branch `creditsLog` into the top-level
 * {@link LedgerEntry} ledger (issue #11), attributing `branch` and resolving
 * `workItemId`/`projectId` from the branch/work item AT MIGRATION TIME. The
 * consumed `creditsLog` is removed from the branch so the fold is idempotent:
 * re-running finds nothing left to move and never double-counts. Pure over the
 * passed structures, so it is easy to unit test. No credit data is lost.
 */
export function foldCreditsLogIntoLedger(
  branches: Store,
  workItems: Record<string, WorkItem>,
  ledger: LedgerEntry[]
): void {
  for (const [branch, data] of Object.entries(branches)) {
    if (!data || typeof data !== 'object') continue;
    const log = data.creditsLog;
    if (!Array.isArray(log) || log.length === 0) {
      // Nothing to fold — still drop any empty legacy array for a clean shape.
      if ('creditsLog' in data) delete data.creditsLog;
      continue;
    }
    const workItemId = data.workItemId ?? null;
    const projectId =
      workItemId && workItems[workItemId] ? workItems[workItemId].projectId ?? null : null;
    for (const e of log) {
      ledger.push({
        id: newLedgerId(),
        ts: e.ts,
        model: e.model,
        credits: e.credits,
        source: inferLedgerSource(e.note),
        branch,
        workItemId,
        projectId,
        chatSessionId: null,
        note: e.note
      });
    }
    delete data.creditsLog;
  }
}

/**
 * Normalize any parsed JSON into the current {@link PersistedStore} shape.
 * Accepts both the legacy flat `Record<branch, BranchData>` (schemaVersion 0,
 * unversioned) and the current envelope. Never discards unknown fields on the
 * branch records — only the top-level container is reshaped.
 */
export function migrateStore(parsed: unknown): PersistedStore {
  let branches: Store;
  let workItems: Record<string, WorkItem>;
  let creditLedger: LedgerEntry[];
  let projects: Record<string, Project>;
  let manualEffort: ManualEffortEntry[];
  let reassignments: ReassignmentRecord[];
  let timeEntries: TimeEntry[];
  if (isEnvelope(parsed)) {
    branches = (parsed.branches ?? {}) as Store;
    workItems = (parsed.workItems ?? {}) as Record<string, WorkItem>;
    const existing = (parsed as PersistedStore).creditLedger;
    creditLedger = Array.isArray(existing) ? existing : [];
    const existingProjects = (parsed as PersistedStore).projects;
    projects =
      existingProjects && typeof existingProjects === 'object'
        ? (existingProjects as Record<string, Project>)
        : {};
    // #21: default to [] for any pre-v6 file, which had no manualEffort array.
    manualEffort = sanitizeManualEffort((parsed as PersistedStore).manualEffort);
    // #22: default to [] for any pre-v7 file, which had no reassignments array.
    reassignments = sanitizeReassignments((parsed as PersistedStore).reassignments);
    // #60: default to [] for any pre-v10 file, which had no timeEntries array.
    timeEntries = sanitizeTimeEntries((parsed as PersistedStore).timeEntries);
  } else {
    branches = (parsed && typeof parsed === 'object' ? parsed : {}) as Store;
    workItems = {};
    creditLedger = [];
    projects = {};
    manualEffort = [];
    reassignments = [];
    timeEntries = [];
  }
  backfillWorkItems(branches, workItems);
  // #46: default/sanitize the optional billableHours override on every work item
  // for BOTH shapes (envelope + legacy flat map converge on `workItems` here).
  normalizeWorkItemBillableHours(workItems);
  // #47: default/sanitize the optional per-branch timeAdjustment deltas for BOTH
  // shapes (envelope + legacy flat map converge on `branches` here).
  sanitizeBranchTimeAdjustments(branches);
  // #12: adopt or park orphaned (null-mapped) branches BEFORE folding credits so
  // their legacy credit log is attributed to the resolved/holding work item.
  assignUnmappedBranches(branches, workItems, extractWorkItemId);
  foldCreditsLogIntoLedger(branches, workItems, creditLedger);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    branches,
    workItems,
    creditLedger,
    projects,
    manualEffort,
    reassignments,
    timeEntries
  };
}

/**
 * Sanitize the optional {@link WorkItem.billableHours} override on every work
 * item in place (issue #46 / schema v8). Deletes the field whenever it is not a
 * finite, non-negative number; a valid override is left untouched. Pure over its
 * inputs, idempotent (re-running on already-clean data is a no-op) and zero-loss
 * (only invalid values — which the ROI math would ignore anyway — are removed),
 * so it can never introduce a NaN or drop real data. Mirrors the defaulting done
 * for `manualEffort`/`reassignments`.
 */
export function normalizeWorkItemBillableHours(workItems: Record<string, WorkItem>): void {
  if (!workItems || typeof workItems !== 'object') return;
  for (const wi of Object.values(workItems)) {
    if (!wi || typeof wi !== 'object') continue;
    const bh = (wi as WorkItem).billableHours;
    if (bh === undefined) continue;
    if (typeof bh !== 'number' || !Number.isFinite(bh) || bh < 0) {
      delete (wi as WorkItem).billableHours;
    }
  }
}

/**
 * Sanitize the optional per-branch {@link BranchData.timeAdjustment} deltas in
 * place (issue #47 / schema v9). For every branch it strips the field entirely
 * when it is absent, not an object, or reduces to empty, and drops any per-mode
 * entry that is not a finite, NON-ZERO number for one of the four known
 * {@link TrackingMode}s. Pure over its inputs, idempotent (re-running on clean
 * data is a no-op) and zero-loss: a valid signed delta round-trips untouched, a
 * delta of 0 means "no adjustment" (effective === raw) and is dropped, and only
 * garbage the effective-time math would ignore anyway is removed — so it can
 * never introduce a NaN or drop real tracked time (the raw `time` buckets are
 * left completely untouched). Mirrors the defaulting done for
 * `manualEffort`/`reassignments`/`billableHours`.
 */
export function sanitizeBranchTimeAdjustments(branches: Store): void {
  if (!branches || typeof branches !== 'object') return;
  const modes: TrackingMode[] = ['humanCoding', 'aiGenerating', 'reviewing', 'idle'];
  for (const data of Object.values(branches)) {
    if (!data || typeof data !== 'object') continue;
    const adj = (data as BranchData).timeAdjustment;
    if (adj === undefined) continue;
    if (typeof adj !== 'object' || adj === null) {
      delete (data as BranchData).timeAdjustment;
      continue;
    }
    const clean: Partial<Record<TrackingMode, number>> = {};
    for (const mode of modes) {
      const v = (adj as Record<string, unknown>)[mode];
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
        clean[mode] = v;
      }
    }
    if (Object.keys(clean).length === 0) {
      delete (data as BranchData).timeAdjustment;
    } else {
      (data as BranchData).timeAdjustment = clean;
    }
  }
}

/**
 * Coerce persisted reassignment JSON into a clean {@link ReassignmentRecord}[]
 * (issue #22). Drops non-object rows and rows without a usable `branch` +
 * `toWorkItemId`, fills a missing `id`, and normalizes `fromWorkItemId` to
 * `string | null`. Pure + idempotent so a re-migration of already-clean data is
 * a no-op with zero data loss — mirrors {@link sanitizeManualEffort}.
 */
export function sanitizeReassignments(input: unknown): ReassignmentRecord[] {
  if (!Array.isArray(input)) return [];
  const out: ReassignmentRecord[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<ReassignmentRecord>;
    if (typeof r.branch !== 'string' || !r.branch) continue;
    if (typeof r.toWorkItemId !== 'string' || !r.toWorkItemId) continue;
    const rec: ReassignmentRecord = {
      id: typeof r.id === 'string' && r.id ? r.id : newLedgerId(),
      ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : Date.now(),
      branch: r.branch,
      fromWorkItemId: typeof r.fromWorkItemId === 'string' ? r.fromWorkItemId : null,
      toWorkItemId: r.toWorkItemId
    };
    if (typeof r.note === 'string') rec.note = r.note;
    if (typeof r.batchId === 'string') rec.batchId = r.batchId;
    out.push(rec);
  }
  return out;
}

/**
 * Coerce persisted manual-effort JSON into a clean {@link ManualEffortEntry}[]
 * (issue #21). Drops non-object rows and rows without a usable `workItemId`,
 * fills a missing `id`, and pins `source` to `'manual'`. Pure + idempotent so a
 * re-migration of already-clean data is a no-op with zero data loss.
 */
export function sanitizeManualEffort(input: unknown): ManualEffortEntry[] {
  if (!Array.isArray(input)) return [];
  const out: ManualEffortEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<ManualEffortEntry>;
    if (typeof r.workItemId !== 'string' || !r.workItemId) continue;
    const entry: ManualEffortEntry = {
      id: typeof r.id === 'string' && r.id ? r.id : newLedgerId(),
      ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : Date.now(),
      workItemId: r.workItemId,
      source: 'manual'
    };
    if (r.mode !== undefined) entry.mode = r.mode;
    if (r.category !== undefined) entry.category = r.category;
    if (typeof r.durationMs === 'number') entry.durationMs = r.durationMs;
    if (typeof r.linesAdded === 'number') entry.linesAdded = r.linesAdded;
    if (typeof r.linesDeleted === 'number') entry.linesDeleted = r.linesDeleted;
    if (typeof r.isAi === 'boolean') entry.isAi = r.isAi;
    if (typeof r.note === 'string') entry.note = r.note;
    out.push(entry);
  }
  return out;
}

/** True when `m` is one of the four {@link TrackingMode} values. */
function isTrackingMode(m: unknown): m is TrackingMode {
  return m === 'humanCoding' || m === 'aiGenerating' || m === 'reviewing' || m === 'idle';
}

/** True when `c` is one of the allowed {@link TimeEntryCategory} values. */
function isTimeEntryCategory(c: unknown): c is TimeEntryCategory {
  return typeof c === 'string' && (TIME_ENTRY_CATEGORIES as readonly string[]).includes(c);
}

/**
 * Coerce persisted time-log JSON into a clean {@link TimeEntry}[] (issue #60).
 * Mirrors {@link sanitizeManualEffort}: drops non-object rows and rows without a
 * usable duration (a finite `durationMs` ≥ 0, else derived from a valid
 * `startTs`/`endTs` interval), fills a missing `id`/`createdAt`, pins `source` to
 * `'manual'`/`'auto'` (default `'manual'`), and keeps only valid optional fields.
 * Pure + idempotent so a re-migration of already-clean data is a no-op with zero
 * data loss.
 */
export function sanitizeTimeEntries(input: unknown): TimeEntry[] {
  if (!Array.isArray(input)) return [];
  const out: TimeEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<TimeEntry>;
    const start = typeof r.startTs === 'number' && Number.isFinite(r.startTs) ? r.startTs : undefined;
    const end = typeof r.endTs === 'number' && Number.isFinite(r.endTs) ? r.endTs : undefined;
    let dur = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : NaN;
    if (!Number.isFinite(dur) && start !== undefined && end !== undefined && end >= start) {
      dur = end - start;
    }
    if (!Number.isFinite(dur) || dur < 0) continue;
    const entry: TimeEntry = {
      id: typeof r.id === 'string' && r.id ? r.id : newLedgerId(),
      durationMs: dur,
      source: r.source === 'auto' ? 'auto' : 'manual',
      createdAt:
        typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now()
    };
    if (typeof r.workItemId === 'string' && r.workItemId) entry.workItemId = r.workItemId;
    if (typeof r.branch === 'string' && r.branch) entry.branch = r.branch;
    if (typeof r.projectId === 'string' && r.projectId) entry.projectId = r.projectId;
    if (start !== undefined) entry.startTs = start;
    if (end !== undefined) entry.endTs = end;
    if (isTrackingMode(r.mode)) entry.mode = r.mode;
    if (isTimeEntryCategory(r.category)) entry.category = r.category;
    if (typeof r.note === 'string') entry.note = r.note;
    out.push(entry);
  }
  return out;
}

/** Maps a {@link TrackingMode} to its millisecond bucket key on a rollup. */
const MODE_TO_MS_FIELD: Record<
  TrackingMode,
  'humanCodingMs' | 'aiGeneratingMs' | 'reviewingMs' | 'idleMs'
> = {
  humanCoding: 'humanCodingMs',
  aiGenerating: 'aiGeneratingMs',
  reviewing: 'reviewingMs',
  idle: 'idleMs'
};

/** A fresh, all-zero {@link ManualRollup}. */
export function emptyManualRollup(): ManualRollup {
  return {
    humanCodingMs: 0, aiGeneratingMs: 0, reviewingMs: 0, idleMs: 0,
    linesHumanAdded: 0, linesHumanDeleted: 0, linesAiAdded: 0, linesAiDeleted: 0,
    entries: 0, byCategory: emptyCategoryMap()
  };
}

/**
 * Accumulate ONE manual entry into a {@link ManualRollup} (issue #21). Time
 * lands on the entry's mode bucket; lines land on the entry's category bucket on
 * the AI or human side per `isAi`. Non-finite/absent numbers are treated as 0 so
 * the result can never be NaN. Pure (mutates only `roll`).
 */
export function accumulateManualEntry(roll: ManualRollup, e: ManualEffortEntry): void {
  roll.entries += 1;
  const dur = Number(e.durationMs);
  if (e.mode && MODE_TO_MS_FIELD[e.mode] && Number.isFinite(dur)) {
    roll[MODE_TO_MS_FIELD[e.mode]] += dur;
  }
  const added = Number(e.linesAdded);
  const deleted = Number(e.linesDeleted);
  const a = Number.isFinite(added) ? added : 0;
  const d = Number.isFinite(deleted) ? deleted : 0;
  if (a !== 0 || d !== 0) {
    if (e.isAi) { roll.linesAiAdded += a; roll.linesAiDeleted += d; }
    else { roll.linesHumanAdded += a; roll.linesHumanDeleted += d; }
    if (e.category) {
      const bucket = (roll.byCategory[e.category] ??= {
        human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 }
      });
      const side = e.isAi ? bucket.ai : bucket.human;
      side.added += a;
      side.deleted += d;
    }
  }
}

/**
 * Merge a {@link ManualRollup} INTO an automatic {@link BranchRollup} (issue #21)
 * so manual corrections are additive to the tracked totals. Mode ms, flat line
 * totals, per-category lines and the AI-line cost estimate are all folded in.
 * Pure (mutates only `target`); a zero rollup leaves `target` untouched.
 */
export function mergeManualRollup(target: BranchRollup, m: ManualRollup): void {
  target.humanCodingMs += m.humanCodingMs;
  target.aiGeneratingMs += m.aiGeneratingMs;
  target.reviewingMs += m.reviewingMs;
  target.idleMs += m.idleMs;
  target.linesHumanAdded += m.linesHumanAdded;
  target.linesHumanDeleted += m.linesHumanDeleted;
  target.linesAiAdded += m.linesAiAdded;
  target.linesAiDeleted += m.linesAiDeleted;
  // Keep the AI-line cost estimate consistent with the folded-in AI lines.
  target.estimatedCostUsd += m.linesAiAdded * COST_PER_AI_LINE_USD;
  for (const cat of Object.keys(m.byCategory)) {
    const src = m.byCategory[cat];
    const dst = (target.byCategory[cat] ??= {
      human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 }
    });
    dst.human.added += src.human.added;
    dst.human.deleted += src.human.deleted;
    dst.ai.added += src.ai.added;
    dst.ai.deleted += src.ai.deleted;
  }
}

/** A per-{@link TrackingMode} millisecond accumulator (issue #60). */
export type ModeMs = Record<TrackingMode, number>;

/** A fresh, all-zero {@link ModeMs}. */
export function emptyModeMs(): ModeMs {
  return { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 };
}

/** The effective timestamp of a {@link TimeEntry} for ordering/grouping (issue
 * #60): its explicit `startTs` when present, else `createdAt`. */
export function timeEntryTs(e: TimeEntry): number {
  return typeof e.startTs === 'number' && Number.isFinite(e.startTs) ? e.startTs : e.createdAt;
}

/**
 * Accumulate ONE manual {@link TimeEntry}'s duration into a {@link ModeMs} on its
 * mode bucket (issue #60). The mode is the entry's `mode` when set, else the
 * default billable bucket `humanCoding`, so a plain/category-only entry still adds
 * to billable time + ROI (documented choice). Non-finite/non-positive durations
 * are ignored so the result can never be NaN or negative. Pure (mutates `acc`).
 */
export function accumulateTimeEntryMs(acc: ModeMs, e: TimeEntry): void {
  const dur = Number(e.durationMs);
  if (!Number.isFinite(dur) || dur <= 0) return;
  const mode: TrackingMode = isTrackingMode(e.mode) ? e.mode : 'humanCoding';
  acc[mode] += dur;
}

/** Add a {@link ModeMs} into a {@link BranchRollup}'s per-mode ms fields (issue
 * #60). Pure (mutates only `target`); a zero {@link ModeMs} is a no-op. */
export function addModeMsToRollup(target: BranchRollup, ms: ModeMs): void {
  target.humanCodingMs += ms.humanCoding;
  target.aiGeneratingMs += ms.aiGenerating;
  target.reviewingMs += ms.reviewing;
  target.idleMs += ms.idle;
}

/**
 * Apply one optional field of a {@link ManualEffortPatch} to an entry (issue
 * #21): `undefined` leaves it unchanged, `null` clears it, any other value sets
 * it. Keeps {@link Database.updateManualEffort} terse and consistent.
 */
type OptionalManualKey =
  'mode' | 'category' | 'durationMs' | 'linesAdded' | 'linesDeleted' | 'isAi' | 'note';
function applyManualOptional<K extends OptionalManualKey>(
  entry: ManualEffortEntry,
  key: K,
  value: ManualEffortEntry[K] | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) delete entry[key];
  else entry[key] = value;
}

/** Apply an optional STRING patch field to a {@link TimeEntry} (issue #60):
 * `undefined` leaves it, `null`/'' clears it, a non-empty string sets it. */
function applyTimeEntryString(
  entry: TimeEntry,
  key: 'workItemId' | 'branch' | 'projectId',
  value: string | null | undefined
): void {
  if (value === undefined) return;
  if (value === null || value === '') delete entry[key];
  else entry[key] = value;
}

/** Apply an optional NUMBER patch field to a {@link TimeEntry} (issue #60):
 * `undefined` leaves it, `null`/non-finite clears it, a finite number sets it. */
function applyTimeEntryNumber(
  entry: TimeEntry,
  key: 'startTs' | 'endTs',
  value: number | null | undefined
): void {
  if (value === undefined) return;
  if (value === null || !Number.isFinite(value)) delete entry[key];
  else entry[key] = value;
}

function emptyCategoryMap(): Record<string, { human: LineStats; ai: LineStats }> {
  const map: Record<string, { human: LineStats; ai: LineStats }> = {};
  for (const cat of ALL_CATEGORIES) {
    map[cat] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
  }
  return map;
}

/**
 * Roll up a set of per-branch summaries into a single combined total. Pure
 * function over {@link BranchSummary} values — used to aggregate a work item's
 * branches, but framework-free and unit-testable in isolation.
 */
export function rollupBranchSummaries(summaries: BranchSummary[]): BranchRollup {
  const byCategory = emptyCategoryMap();
  const byExt: Record<string, ExtStats> = {};
  const creditsMap: Record<string, { credits: number; turns: number }> = {};
  const t: BranchRollup = {
    humanCodingMs: 0, aiGeneratingMs: 0, reviewingMs: 0, idleMs: 0,
    linesHumanAdded: 0, linesHumanDeleted: 0, linesAiAdded: 0, linesAiDeleted: 0,
    copilotAcceptances: 0, estimatedCostUsd: 0, chatCharsHuman: 0, chatTurnsHuman: 0,
    humanChars: 0, aiChars: 0, humanKeystrokes: 0, aiInserts: 0,
    aiInlineLines: 0, aiChatLines: 0, aiInlineChars: 0, aiChatChars: 0,
    creditsTotal: 0, creditsByModel: [], byExt, byCategory
  };

  for (const s of summaries) {
    t.humanCodingMs += s.humanCodingMs;
    t.aiGeneratingMs += s.aiGeneratingMs;
    t.reviewingMs += s.reviewingMs;
    t.idleMs += s.idleMs;
    t.linesHumanAdded += s.linesHumanAdded;
    t.linesHumanDeleted += s.linesHumanDeleted;
    t.linesAiAdded += s.linesAiAdded;
    t.linesAiDeleted += s.linesAiDeleted;
    t.copilotAcceptances += s.copilotAcceptances;
    t.estimatedCostUsd += s.estimatedCostUsd;
    t.chatCharsHuman += s.chatCharsHuman;
    t.chatTurnsHuman += s.chatTurnsHuman;
    t.humanChars += s.humanChars;
    t.aiChars += s.aiChars;
    t.humanKeystrokes += s.humanKeystrokes;
    t.aiInserts += s.aiInserts;
    t.aiInlineLines += s.aiInlineLines;
    t.aiChatLines += s.aiChatLines;
    t.aiInlineChars += s.aiInlineChars;
    t.aiChatChars += s.aiChatChars;
    t.creditsTotal += s.creditsTotal;

    for (const [ext, st] of Object.entries(s.byExt)) {
      if (!byExt[ext]) {
        byExt[ext] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
      }
      byExt[ext].human.added += st.human.added;
      byExt[ext].human.deleted += st.human.deleted;
      byExt[ext].ai.added += st.ai.added;
      byExt[ext].ai.deleted += st.ai.deleted;
    }

    for (const [cat, src] of Object.entries(s.byCategory)) {
      if (!byCategory[cat]) {
        byCategory[cat] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
      }
      byCategory[cat].human.added += src.human.added;
      byCategory[cat].human.deleted += src.human.deleted;
      byCategory[cat].ai.added += src.ai.added;
      byCategory[cat].ai.deleted += src.ai.deleted;
    }

    for (const c of s.creditsByModel) {
      if (!creditsMap[c.model]) creditsMap[c.model] = { credits: 0, turns: 0 };
      creditsMap[c.model].credits += c.credits;
      creditsMap[c.model].turns += c.turns;
    }
  }

  t.creditsByModel = Object.entries(creditsMap)
    .map(([model, v]) => ({ model, credits: v.credits, turns: v.turns }))
    .sort((a, b) => b.credits - a.credits);

  return t;
}

function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyBucket(): DailyBucket {
  return {
    humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0,
    linesHuman: 0, linesAi: 0, hours: new Array(24).fill(0),
    hoursByMode: {
      humanCoding: new Array(24).fill(0),
      aiGenerating: new Array(24).fill(0),
      reviewing: new Array(24).fill(0)
    }
  };
}

const COST_PER_AI_LINE_USD = 0.00003;

export class Database {
  private filePath: string;
  private tmpPath: string;
  private bakPath: string;
  private store: Store;
  private workItems: Record<string, WorkItem>;
  private creditLedger: LedgerEntry[];
  private projects: Record<string, Project>;
  private manualEffort: ManualEffortEntry[];
  private reassignments: ReassignmentRecord[];
  private timeEntries: TimeEntry[];
  private schemaVersion: number;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing = false;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'effort-tracker.json');
    this.tmpPath = this.filePath + '.tmp';
    this.bakPath = this.filePath + '.bak';
    // Clean up any stray temp file left behind by a crashed/interrupted write.
    try { fs.unlinkSync(this.tmpPath); } catch { /* nothing to clean */ }
    const loaded = this.load();
    this.schemaVersion = loaded.schemaVersion;
    this.store = loaded.branches;
    this.workItems = loaded.workItems;
    this.creditLedger = loaded.creditLedger;
    this.projects = loaded.projects;
    this.manualEffort = loaded.manualEffort;
    this.reassignments = loaded.reassignments;
    this.timeEntries = loaded.timeEntries;
  }

  /** Build the on-disk envelope from the in-memory state. */
  private serialize(): string {
    const envelope: PersistedStore = {
      schemaVersion: this.schemaVersion,
      branches: this.store,
      workItems: this.workItems,
      creditLedger: this.creditLedger,
      projects: this.projects,
      manualEffort: this.manualEffort,
      reassignments: this.reassignments,
      timeEntries: this.timeEntries
    };
    return JSON.stringify(envelope, null, 2);
  }

  private load(): PersistedStore {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Main file missing (first run, or lost). Recover from backup if present,
      // otherwise start fresh — no warning needed for a normal first run.
      return this.loadFromBackup() ?? migrateStore({});
    }
    try {
      // migrateStore upgrades legacy flat files to the current envelope in place.
      const store = migrateStore(JSON.parse(raw));
      // Successful load — refresh the known-good backup.
      this.writeBackup(raw);
      return store;
    } catch {
      return this.recoverFromCorruptMain();
    }
  }

  /** Attempt to read, parse and migrate the backup file. Returns undefined if unusable. */
  private loadFromBackup(): PersistedStore | undefined {
    try {
      return migrateStore(JSON.parse(fs.readFileSync(this.bakPath, 'utf8')));
    } catch {
      return undefined;
    }
  }

  /**
   * The main file exists but failed to parse. Try to recover from the backup;
   * if that fails, move the corrupt file aside (never overwrite it) and start
   * fresh. The user is warned in both cases.
   */
  private recoverFromCorruptMain(): PersistedStore {
    const recovered = this.loadFromBackup();
    if (recovered) {
      // Promote the good backup back to the main file so future saves build on it.
      try {
        fs.copyFileSync(this.bakPath, this.filePath);
      } catch { /* best effort — an upcoming save will rewrite it */ }
      void vscode.window.showWarningMessage(
        'AI Effort Tracker: the data file was corrupt and has been recovered from the last known-good backup.'
      );
      return recovered;
    }

    // No usable backup — preserve the corrupt file for manual inspection.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const corruptPath = this.filePath + '.corrupt-' + stamp;
    let preserved = false;
    try {
      fs.renameSync(this.filePath, corruptPath);
      preserved = true;
    } catch { /* fall through to warning */ }
    void vscode.window.showWarningMessage(
      preserved
        ? `AI Effort Tracker: the data file was corrupt and could not be recovered. It was saved as "${path.basename(corruptPath)}" and tracking has started fresh.`
        : 'AI Effort Tracker: the data file was corrupt and could not be recovered. Tracking has started fresh.'
    );
    return migrateStore({});
  }

  /** Best-effort write of the known-good backup copy. Never throws. */
  private writeBackup(data: string): void {
    try {
      fs.writeFileSync(this.bakPath, data, 'utf8');
    } catch { /* backup is best effort */ }
  }

  /**
   * Debounced, asynchronous save. Editor events fire extremely frequently
   * (every keystroke, cursor move, and during language-server symbol loading),
   * so we must NEVER block the extension host thread with a synchronous write.
   * Writes are coalesced and flushed at most once every 2s, off the hot path.
   */
  private save() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flushAsync();
    }, 2000);
  }

  private async flushAsync(): Promise<void> {
    if (this.writing || !this.dirty) return;
    this.writing = true;
    this.dirty = false;
    const data = this.serialize();
    let handle: fs.promises.FileHandle | undefined;
    try {
      // Atomic write: write to a temp file, fsync, then rename over the target.
      handle = await fs.promises.open(this.tmpPath, 'w');
      await handle.writeFile(data, 'utf8');
      try { await handle.sync(); } catch { /* fsync unsupported — proceed */ }
      await handle.close();
      handle = undefined;
      await fs.promises.rename(this.tmpPath, this.filePath);
      // Refresh the known-good backup after a successful save.
      await fs.promises.writeFile(this.bakPath, data, 'utf8');
    } catch {
      this.dirty = true; // retry on next save
      if (handle) {
        try { await handle.close(); } catch { /* ignore */ }
      }
      // Never leave a partial temp file behind.
      try { await fs.promises.unlink(this.tmpPath); } catch { /* nothing to clean */ }
    } finally {
      this.writing = false;
    }
  }

  /** Synchronous flush — only for extension deactivation. */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const data = this.serialize();
    try {
      // Atomic write: write to a temp file, fsync, then rename over the target.
      const fd = fs.openSync(this.tmpPath, 'w');
      try {
        fs.writeFileSync(fd, data, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* fsync unsupported — proceed */ }
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(this.tmpPath, this.filePath);
      this.writeBackup(data);
    } catch {
      this.dirty = true; // retry on next save
      try { fs.unlinkSync(this.tmpPath); } catch { /* nothing to clean */ }
    }
  }

  private ensureBranch(branch: string): BranchData {
    if (!this.store[branch]) {
      this.store[branch] = {
        workItemId: null,
        time: { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 },
        copilotAcceptances: 0,
        lineChanges: {}
      };
    }
    // Migrate old records missing lineChanges
    if (!this.store[branch].lineChanges) {
      this.store[branch].lineChanges = {};
    }
    return this.store[branch];
  }

  private ensureBucket(data: BranchData, key: string): DailyBucket {
    if (!data.daily) data.daily = {};
    if (!data.daily[key]) data.daily[key] = emptyBucket();
    const b = data.daily[key];
    if (!b.hours || b.hours.length !== 24) b.hours = new Array(24).fill(0);
    if (!b.hoursByMode) {
      b.hoursByMode = {
        humanCoding: new Array(24).fill(0),
        aiGenerating: new Array(24).fill(0),
        reviewing: new Array(24).fill(0)
      };
    }
    return b;
  }

  recordTime(branch: string, mode: TrackingMode, durationMs: number) {
    const data = this.ensureBranch(branch);
    data.time[mode] = (data.time[mode] ?? 0) + durationMs;
    const now = Date.now();
    const bucket = this.ensureBucket(data, dayKey(now));
    bucket[mode] = (bucket[mode] ?? 0) + durationMs;
    if (mode !== 'idle') {
      const hour = new Date(now).getHours();
      bucket.hours[hour] = (bucket.hours[hour] ?? 0) + durationMs;
      const hbm = bucket.hoursByMode![mode];
      if (hbm) hbm[hour] = (hbm[hour] ?? 0) + durationMs;
    }
    this.save();
  }

  /** Records a completed uninterrupted focus session. */
  recordFocusSession(branch: string, ms: number, humanMs: number, aiMs: number) {
    const data = this.ensureBranch(branch);
    if (!data.focusSessions) data.focusSessions = [];
    data.focusSessions.push({ ts: Date.now(), ms, humanMs, aiMs });
    // Cap stored history to keep the file small (most recent 500 sessions).
    if (data.focusSessions.length > 500) {
      data.focusSessions = data.focusSessions.slice(-500);
    }
    this.save();
  }

  recordLineChange(
    branch: string,
    ext: string,
    source: 'human' | 'ai',
    linesAdded: number,
    linesDeleted: number,
    filePath?: string
  ) {
    const data = this.ensureBranch(branch);
    if (!data.lineChanges[ext]) {
      data.lineChanges[ext] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
    }
    data.lineChanges[ext][source].added += linesAdded;
    data.lineChanges[ext][source].deleted += linesDeleted;

    const bucket = this.ensureBucket(data, dayKey());
    if (source === 'ai') {
      data.copilotAcceptances += 1;
      bucket.linesAi += linesAdded;
    } else {
      bucket.linesHuman += linesAdded;
    }

    if (filePath) {
      if (!data.files) data.files = {};
      if (!data.files[filePath]) {
        data.files[filePath] = { humanAdded: 0, humanDeleted: 0, aiAdded: 0, aiDeleted: 0, edits: 0, lastTs: 0 };
      }
      const f = data.files[filePath];
      if (source === 'ai') { f.aiAdded += linesAdded; f.aiDeleted += linesDeleted; }
      else { f.humanAdded += linesAdded; f.humanDeleted += linesDeleted; }
      f.edits += 1;
      f.lastTs = Date.now();
    }
    this.save();
  }

  /** Record inserted characters by source — feeds keystroke ratio + token estimate. */
  recordChars(branch: string, source: 'human' | 'ai', chars: number) {
    if (chars <= 0) return;
    const data = this.ensureBranch(branch);
    if (source === 'ai') {
      data.aiCharsInserted = (data.aiCharsInserted ?? 0) + chars;
      data.aiInserts = (data.aiInserts ?? 0) + 1;
    } else {
      data.humanCharsInserted = (data.humanCharsInserted ?? 0) + chars;
      data.humanKeystrokes = (data.humanKeystrokes ?? 0) + 1;
    }
    this.save();
  }

  /** Split AI insertions into inline completions vs chat/agent edits. */
  recordAiSplit(branch: string, kind: 'inline' | 'chat', lines: number, chars: number) {
    const data = this.ensureBranch(branch);
    if (kind === 'inline') {
      data.aiInlineLines = (data.aiInlineLines ?? 0) + lines;
      data.aiInlineChars = (data.aiInlineChars ?? 0) + chars;
    } else {
      data.aiChatLines = (data.aiChatLines ?? 0) + lines;
      data.aiChatChars = (data.aiChatChars ?? 0) + chars;
    }
    this.save();
  }

  recordChatChars(branch: string, chars: number) {
    const data = this.ensureBranch(branch);
    data.chatCharsHuman = (data.chatCharsHuman ?? 0) + chars;
    this.save();
  }

  /** A "chat turn" = one human message sent to the AI (interaction count). */
  recordChatTurn(branch: string) {
    const data = this.ensureBranch(branch);
    data.chatTurnsHuman = (data.chatTurnsHuman ?? 0) + 1;
    this.save();
  }

  /**
   * Append a row to the top-level credit ledger, resolving work item / project
   * attribution from the branch at write time. Central path for all writers so
   * the ledger stays the single source of truth (issue #11).
   */
  private appendLedger(
    branch: string,
    model: string,
    credits: number,
    source: LedgerSource,
    note?: string,
    extra?: { cost?: number; chatSessionId?: string | null }
  ): LedgerEntry {
    const data = this.ensureBranch(branch);
    const workItemId = data.workItemId ?? null;
    const projectId =
      workItemId && this.workItems[workItemId] ? this.workItems[workItemId].projectId ?? null : null;
    const entry: LedgerEntry = {
      id: newLedgerId(),
      ts: Date.now(),
      model,
      credits,
      source,
      branch,
      workItemId,
      projectId,
      chatSessionId: extra?.chatSessionId ?? null,
      note
    };
    if (extra?.cost !== undefined) entry.cost = extra.cost;
    this.creditLedger.push(entry);
    return entry;
  }

  recordCredits(branch: string, model: string, credits: number, note?: string) {
    const data = this.ensureBranch(branch);
    this.appendLedger(branch, model, credits, 'manual', note);
    data.chatTurnsHuman = (data.chatTurnsHuman ?? 0) + 1;
    this.save();
  }

  /**
   * Record model usage auto-captured from the Copilot chat log. Unlike
   * recordCredits (manual entry), this does NOT count as a human chat turn,
   * so the human interaction metric stays clean. `credits` is an ESTIMATED
   * premium-request weight (stored with source `auto` so it can be separated
   * from manual/import totals); the GitHub billing import remains authoritative.
   */
  recordAutoModelUsage(branch: string, model: string, credits: number, note?: string) {
    const data = this.ensureBranch(branch);
    this.appendLedger(branch, model, credits, 'auto', note ?? 'auto');
    data.autoModelRequests = (data.autoModelRequests ?? 0) + 1;
    this.save();
  }

  /**
   * Record REAL per-request chat usage captured from VS Code chat session
   * storage (issue #59), keyed idempotently on `requestId`. Unlike
   * {@link recordAutoModelUsage} (log-based, model-only estimate), this stores the
   * real `promptTokens`/`completionTokens` and the AIU `credits` — either the
   * per-model token-rate ESTIMATE or, when the live tailer caught a request's
   * `copilot_usage.total_nano_aiu` before compaction, the EXACT cost (`exact`).
   *
   * Idempotency & dedup: the row is upserted by its `auto:jsonl:<requestId>`
   * note, so re-reading the same request (across polls OR an extension restart)
   * updates the SAME row in place — never a second ledger entry, never a double
   * count — and `autoModelRequests` increments only on first insert. This is also
   * the estimate→exact UPGRADE path: a later exact capture overwrites the earlier
   * estimate for that requestId; an already-exact row is never downgraded by a
   * later estimate. Uses a distinct note namespace from the #17 log tracker
   * (`auto:ccreq:`), so the two never collide or double-count.
   *
   * Attribution (`branch`/`workItemId`/`projectId`) is resolved at write time via
   * {@link appendLedger}, exactly like every other ledger writer, so captured
   * credits flow into the existing credits→ROI roll-ups automatically. Fully
   * defensive: `credits` is clamped to a finite, non-negative number (never NaN).
   */
  recordAutoChatUsage(
    branch: string,
    model: string,
    credits: number,
    opts: {
      requestId: string;
      promptTokens?: number;
      completionTokens?: number;
      exact?: boolean;
      chatSessionId?: string | null;
    }
  ): void {
    const safeCredits = Number.isFinite(credits) && credits >= 0 ? credits : 0;
    const note = `auto:jsonl:${opts.requestId}`;
    const existing = this.creditLedger.find(e => e.source === 'auto' && e.note === note);
    if (existing) {
      // Never let a later estimate clobber an already-exact capture.
      if (existing.exact && !opts.exact) return;
      existing.model = model;
      existing.credits = safeCredits;
      if (opts.promptTokens !== undefined) existing.promptTokens = opts.promptTokens;
      if (opts.completionTokens !== undefined) existing.completionTokens = opts.completionTokens;
      existing.exact = opts.exact ?? existing.exact ?? false;
      this.save();
      return;
    }
    const data = this.ensureBranch(branch);
    const entry = this.appendLedger(branch, model, safeCredits, 'auto', note, {
      chatSessionId: opts.chatSessionId ?? null
    });
    if (opts.promptTokens !== undefined) entry.promptTokens = opts.promptTokens;
    if (opts.completionTokens !== undefined) entry.completionTokens = opts.completionTokens;
    entry.exact = opts.exact ?? false;
    data.autoModelRequests = (data.autoModelRequests ?? 0) + 1;
    this.save();
  }

  /**
   * Record the EXACT AIU cost of one chat turn imported from a Copilot Chat Debug
   * export (issue #70). Unlike {@link recordAutoChatUsage} (a token-rate estimate
   * tailed live from `chatSessions/*.jsonl`), this stores the authoritative
   * `copilot_usage.total_nano_aiu` summed across the turn's internal model
   * requests, so credit totals match GitHub billing exactly.
   *
   * Idempotency & upgrade: the row is upserted by its `import:debug:<promptId>`
   * note. Re-importing the same export (or a periodic "export all" that re-covers
   * the turn) updates the SAME row in place — never a second entry, never a double
   * count. A later, MORE COMPLETE export (more requests captured for a turn that
   * was mid-flight when first exported) simply raises the value. Rows are always
   * marked `exact` and use `source:'import'`, a distinct namespace from the `auto`
   * estimators, so the "exact-only" reconciliation ({@link purgeAutoLedger}) can
   * drop estimates without touching imports or manual entries.
   *
   * Attribution (`branch`/`workItemId`/`projectId`) is resolved at import time via
   * {@link appendLedger} — identical to manual credit logging — so imported
   * credits flow straight into the existing credits→ROI roll-ups. Defensive:
   * `credits` is clamped finite/non-negative (never NaN).
   */
  recordImportedUsage(
    branch: string,
    model: string,
    credits: number,
    opts: {
      promptId: string;
      promptTokens?: number;
      completionTokens?: number;
      requests?: number;
      analysis?: TurnAnalysis;
    }
  ): { inserted: boolean } {
    const safeCredits = Number.isFinite(credits) && credits >= 0 ? credits : 0;
    const note = `import:debug:${opts.promptId}`;
    const existing = this.creditLedger.find(e => e.source === 'import' && e.note === note);
    if (existing) {
      existing.model = model;
      existing.credits = safeCredits;
      if (opts.promptTokens !== undefined) existing.promptTokens = opts.promptTokens;
      if (opts.completionTokens !== undefined) existing.completionTokens = opts.completionTokens;
      if (opts.analysis !== undefined) existing.analysis = opts.analysis;
      existing.exact = true;
      this.save();
      return { inserted: false };
    }
    this.ensureBranch(branch);
    const entry = this.appendLedger(branch, model, safeCredits, 'import', note);
    if (opts.promptTokens !== undefined) entry.promptTokens = opts.promptTokens;
    if (opts.completionTokens !== undefined) entry.completionTokens = opts.completionTokens;
    if (opts.analysis !== undefined) entry.analysis = opts.analysis;
    entry.exact = true;
    this.save();
    return { inserted: true };
  }

  /**
   * Remove every ESTIMATED `source:'auto'` credit row (issue #70, exact-only
   * mode). Called when exact debug-export imports become the source of truth, so
   * the inaccurate live estimates can never double-count against the exact values.
   * Leaves `manual` and `import` rows untouched. Returns the number of rows
   * removed. Totals/ROI recompute automatically (they derive from the ledger).
   */
  purgeAutoLedger(): number {
    const before = this.creditLedger.length;
    this.creditLedger = this.creditLedger.filter(e => e.source !== 'auto');
    const removed = before - this.creditLedger.length;
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * Edit an existing ledger row in place (issue #19 — manual correction). Only
   * the fields present in `patch` are changed; everything else (id, source,
   * branch, chatSessionId) is preserved so the row's identity and provenance
   * stay intact. When `workItemId` is changed the row's `projectId` is
   * re-resolved from the destination work item — mirroring the resolution
   * {@link appendLedger} does at write time — so credit roll-ups by project stay
   * correct. Passing `cost: null` clears the optional cost. Safe no-op returning
   * `undefined` when `id` is not found (never throws). Totals/ROI recompute
   * automatically because they derive from the ledger.
   */
  updateLedgerEntry(id: string, patch: LedgerEntryPatch): LedgerEntry | undefined {
    const entry = this.creditLedger.find(e => e.id === id);
    if (!entry) return undefined;
    if (patch.model !== undefined) entry.model = patch.model;
    if (patch.credits !== undefined) entry.credits = patch.credits;
    if (patch.note !== undefined) entry.note = patch.note;
    if (patch.ts !== undefined) entry.ts = patch.ts;
    if (patch.cost !== undefined) {
      if (patch.cost === null) delete entry.cost;
      else entry.cost = patch.cost;
    }
    if (patch.workItemId !== undefined) {
      const workItemId = patch.workItemId ?? null;
      entry.workItemId = workItemId;
      entry.projectId =
        workItemId && this.workItems[workItemId]
          ? this.workItems[workItemId].projectId ?? null
          : null;
    }
    this.save();
    return entry;
  }

  /**
   * Remove a ledger row by id (issue #19 — manual correction). Returns `true`
   * when a row was removed, `false` when `id` was not found (safe no-op, never
   * throws). Because the ledger is the single source of truth, deleting a row
   * automatically drops its credits/cost from every derived total.
   */
  deleteLedgerEntry(id: string): boolean {
    const idx = this.creditLedger.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.creditLedger.splice(idx, 1);
    this.save();
    return true;
  }

  // ---- Manual effort entry & adjustment (issue #21 / milestone M5) -----------

  /**
   * Record a hand-entered effort adjustment for a work item (issue #21). Mirrors
   * {@link recordCredits}/{@link appendLedger} for the effort dimension: the row
   * lands in the top-level `manualEffort` array with a generated id, `ts`
   * defaulting to now, and `source: 'manual'`. The target work item is ensured
   * so the entry shows up in roll-ups even if no branch maps to it yet. This is
   * a SEPARATE write path from the #17 auto-capture, which is left untouched.
   */
  addManualEffort(input: ManualEffortInput): ManualEffortEntry {
    this.ensureWorkItem(input.workItemId);
    const entry: ManualEffortEntry = {
      id: newLedgerId(),
      ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : Date.now(),
      workItemId: input.workItemId,
      source: 'manual'
    };
    if (input.mode !== undefined) entry.mode = input.mode;
    if (input.category !== undefined) entry.category = input.category;
    if (input.durationMs !== undefined) entry.durationMs = input.durationMs;
    if (input.linesAdded !== undefined) entry.linesAdded = input.linesAdded;
    if (input.linesDeleted !== undefined) entry.linesDeleted = input.linesDeleted;
    if (input.isAi !== undefined) entry.isAi = input.isAi;
    if (input.note !== undefined) entry.note = input.note;
    this.manualEffort.push(entry);
    this.save();
    return entry;
  }

  /**
   * Edit a manual-effort entry in place (issue #21). Only the fields present in
   * `patch` change; `id`/`source` are preserved so the row's identity survives.
   * Passing `null` for an optional measurement field clears it; when `workItemId`
   * changes the destination work item is ensured. Safe no-op returning
   * `undefined` when `id` is not found (never throws). Roll-ups recompute
   * automatically because they derive from `manualEffort`.
   */
  updateManualEffort(id: string, patch: ManualEffortPatch): ManualEffortEntry | undefined {
    const entry = this.manualEffort.find(e => e.id === id);
    if (!entry) return undefined;
    if (patch.workItemId !== undefined && patch.workItemId) {
      entry.workItemId = patch.workItemId;
      this.ensureWorkItem(patch.workItemId);
    }
    if (patch.ts !== undefined && patch.ts !== null) entry.ts = patch.ts;
    applyManualOptional(entry, 'mode', patch.mode);
    applyManualOptional(entry, 'category', patch.category);
    applyManualOptional(entry, 'durationMs', patch.durationMs);
    applyManualOptional(entry, 'linesAdded', patch.linesAdded);
    applyManualOptional(entry, 'linesDeleted', patch.linesDeleted);
    applyManualOptional(entry, 'isAi', patch.isAi);
    applyManualOptional(entry, 'note', patch.note);
    this.save();
    return entry;
  }

  /**
   * Remove a manual-effort entry by id (issue #21). Returns `true` when a row
   * was removed, `false` when `id` was not found (safe no-op, never throws).
   * Because roll-ups derive from `manualEffort`, deleting a row drops its
   * contribution from every derived total automatically.
   */
  deleteManualEffort(id: string): boolean {
    const idx = this.manualEffort.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.manualEffort.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * List manual-effort entries (issue #21), newest-first. Pass a `workItemId` to
   * scope to a single work item. Returns a shallow copy so callers can't mutate
   * the stored array.
   */
  getManualEffort(workItemId?: string): ManualEffortEntry[] {
    return this.manualEffort
      .filter(e => workItemId === undefined || e.workItemId === workItemId)
      .sort((a, b) => b.ts - a.ts);
  }

  /** Roll a work item's manual entries into a {@link ManualRollup}. */
  private manualRollupForWorkItem(workItemId: string): ManualRollup {
    const roll = emptyManualRollup();
    for (const e of this.manualEffort) {
      if (e.workItemId !== workItemId) continue;
      accumulateManualEntry(roll, e);
    }
    return roll;
  }

  // ---------------------------------------------------------------------------
  // Time Log (issue #60 / milestone M5)
  //
  // Roll-up precedence — each MANUAL entry contributes to effective time at
  // EXACTLY ONE level so it is never double-counted: `branch` → branch level (it
  // flows up to the work item/project through the existing branch rollup); else
  // `workItemId` → work-item level (mirrors #21 manual effort; flows up to the
  // project); else `projectId` → project level. `source:'auto'` entries never
  // roll up (display-only) so a future auto-surfacing can't double-count the auto
  // buckets. This layer is fully independent of the auto buckets, the #47 delta
  // and #21 manual effort.
  // ---------------------------------------------------------------------------

  /** Branch-scoped manual time entries → per-mode ms (issue #60). */
  private timeEntryMsForBranch(branch: string): ModeMs {
    const acc = emptyModeMs();
    for (const e of this.timeEntries) {
      if (e.source !== 'manual') continue;
      if (typeof e.branch === 'string' && e.branch === branch) accumulateTimeEntryMs(acc, e);
    }
    return acc;
  }

  /** Branch-LESS manual time entries attached directly to a work item → per-mode
   * ms (issue #60). Branch-scoped entries are counted at the branch level. */
  private timeEntryMsForWorkItemDirect(workItemId: string): ModeMs {
    const acc = emptyModeMs();
    for (const e of this.timeEntries) {
      if (e.source !== 'manual') continue;
      if (e.branch) continue;
      if (e.workItemId === workItemId) accumulateTimeEntryMs(acc, e);
    }
    return acc;
  }

  /** Branch-LESS, work-item-LESS manual time entries attached directly to a
   * project → per-mode ms (issue #60). */
  private timeEntryMsForProjectDirect(projectId: string): ModeMs {
    const acc = emptyModeMs();
    for (const e of this.timeEntries) {
      if (e.source !== 'manual') continue;
      if (e.branch || e.workItemId) continue;
      if (e.projectId === projectId) accumulateTimeEntryMs(acc, e);
    }
    return acc;
  }

  /** The time entries attached to a branch (issue #60), newest first. */
  private timeEntriesForBranch(branch: string): TimeEntry[] {
    return this.timeEntries
      .filter(e => e.branch === branch)
      .sort((a, b) => timeEntryTs(b) - timeEntryTs(a));
  }

  /** The time entries that roll up into a work item (issue #60), newest first:
   * branch-scoped entries on the work item's mapped branches + branch-less
   * entries attached directly to it. */
  private timeEntriesForWorkItem(workItemId: string): TimeEntry[] {
    const branches = new Set(this.getBranchesForWorkItem(workItemId));
    return this.timeEntries
      .filter(
        e =>
          (typeof e.branch === 'string' && branches.has(e.branch)) ||
          (!e.branch && e.workItemId === workItemId)
      )
      .sort((a, b) => timeEntryTs(b) - timeEntryTs(a));
  }

  /**
   * Add one time-log entry (issue #60). `durationMs` is derived from
   * `startTs`/`endTs` when omitted; the row is dropped-safe via
   * {@link sanitizeTimeEntries} on the next load anyway, but we compute a clean
   * duration up front. A target work item (when given) is ensured so the entry
   * shows in roll-ups even if no branch maps to it yet. Persists via {@link save}.
   */
  addTimeEntry(input: TimeEntryInput): TimeEntry {
    if (input.workItemId) this.ensureWorkItem(input.workItemId);
    const start =
      typeof input.startTs === 'number' && Number.isFinite(input.startTs) ? input.startTs : undefined;
    const end =
      typeof input.endTs === 'number' && Number.isFinite(input.endTs) ? input.endTs : undefined;
    let dur =
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? input.durationMs
        : NaN;
    if (!Number.isFinite(dur) && start !== undefined && end !== undefined && end >= start) {
      dur = end - start;
    }
    const entry: TimeEntry = {
      id: newLedgerId(),
      durationMs: Number.isFinite(dur) && dur > 0 ? dur : 0,
      source: input.source === 'auto' ? 'auto' : 'manual',
      createdAt: Date.now()
    };
    if (input.workItemId) entry.workItemId = input.workItemId;
    if (input.branch) entry.branch = input.branch;
    if (input.projectId) entry.projectId = input.projectId;
    if (start !== undefined) entry.startTs = start;
    if (end !== undefined) entry.endTs = end;
    if (isTrackingMode(input.mode)) entry.mode = input.mode;
    if (isTimeEntryCategory(input.category)) entry.category = input.category;
    if (typeof input.note === 'string' && input.note) entry.note = input.note;
    this.timeEntries.push(entry);
    this.save();
    return entry;
  }

  /**
   * Edit a time-log entry in place (issue #60). Only the fields present in `patch`
   * change; `id`/`source`/`createdAt` are preserved. Passing `null` clears an
   * optional field. When `startTs`/`endTs` change (and no explicit `durationMs` is
   * given) the duration is recomputed from the resulting interval. When
   * `workItemId` is set the destination work item is ensured. Safe no-op returning
   * `undefined` when `id` is not found. Persists via {@link save}.
   */
  updateTimeEntry(id: string, patch: TimeEntryPatch): TimeEntry | undefined {
    const entry = this.timeEntries.find(e => e.id === id);
    if (!entry) return undefined;
    applyTimeEntryString(entry, 'workItemId', patch.workItemId);
    if (patch.workItemId) this.ensureWorkItem(patch.workItemId);
    applyTimeEntryString(entry, 'branch', patch.branch);
    applyTimeEntryString(entry, 'projectId', patch.projectId);
    applyTimeEntryNumber(entry, 'startTs', patch.startTs);
    applyTimeEntryNumber(entry, 'endTs', patch.endTs);
    if (isTrackingMode(patch.mode)) entry.mode = patch.mode;
    else if (patch.mode === null) delete entry.mode;
    if (isTimeEntryCategory(patch.category)) entry.category = patch.category;
    else if (patch.category === null) delete entry.category;
    if (patch.note !== undefined) {
      if (patch.note === null || !patch.note) delete entry.note;
      else entry.note = patch.note;
    }
    if (typeof patch.durationMs === 'number' && Number.isFinite(patch.durationMs)) {
      entry.durationMs = patch.durationMs > 0 ? patch.durationMs : 0;
    } else if (
      (patch.startTs !== undefined || patch.endTs !== undefined) &&
      typeof entry.startTs === 'number' &&
      typeof entry.endTs === 'number' &&
      entry.endTs >= entry.startTs
    ) {
      entry.durationMs = entry.endTs - entry.startTs;
    }
    this.save();
    return entry;
  }

  /**
   * Remove a time-log entry by id (issue #60). Returns `true` when a row was
   * removed, `false` when `id` was not found (safe no-op). Because roll-ups derive
   * from `timeEntries`, deleting a row drops its contribution automatically.
   */
  deleteTimeEntry(id: string): boolean {
    const idx = this.timeEntries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.timeEntries.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * List time-log entries (issue #60), newest-first by effective timestamp
   * (`startTs ?? createdAt`). Optional filter narrows by attachment and/or an
   * inclusive timestamp window. Returns a shallow copy so callers can't mutate the
   * stored array.
   */
  getTimeEntries(filter?: TimeEntryQuery): TimeEntry[] {
    return this.timeEntries
      .filter(e => {
        if (filter?.workItemId !== undefined && e.workItemId !== filter.workItemId) return false;
        if (filter?.branch !== undefined && e.branch !== filter.branch) return false;
        if (filter?.projectId !== undefined && e.projectId !== filter.projectId) return false;
        const ts = timeEntryTs(e);
        if (filter?.from !== undefined && ts < filter.from) return false;
        if (filter?.to !== undefined && ts > filter.to) return false;
        return true;
      })
      .sort((a, b) => timeEntryTs(b) - timeEntryTs(a));
  }

  /**
   * Auto-associate a branch with a work item (from branch-name detection).
   * Sticky manual overrides are respected: if the branch was mapped manually
   * (see {@link reassignBranchToWorkItem}) this is a no-op so the user's choice
   * survives later auto-detection passes (issue #10).
   */
  setWorkItemForBranch(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    // Never clobber a manual override with auto-detection.
    if (data.workItemIdManual) return;
    data.workItemId = workItemId;
    // A branch may be auto-detected before the work item entity exists; make sure
    // the persisted work item is present so aggregation can find it.
    this.ensureWorkItem(workItemId);
    this.save();
  }

  /**
   * Manually map — or reassign — a branch to a work item and make the choice
   * STICK (issue #10). Unlike auto-detection ({@link setWorkItemForBranch}) this:
   *  - marks the branch as a manual override so later auto-detection skips it,
   *  - ensures the destination work item entity exists,
   *  - reconciles historical credit-ledger rows for the branch so their
   *    `workItemId` (and `projectId`, derived from the destination work item's
   *    project) point at the new work item — mirroring
   *    {@link setProjectForWorkItem}'s reconciliation loop but keyed by branch.
   *
   * Because effort is stored PER BRANCH and rolled up by work item at query
   * time, re-pointing `data.workItemId` moves ALL accrued effort with the branch;
   * the ledger loop does the same for recorded credits/cost. A detached-HEAD /
   * `unknown` branch can be attached here after the fact and its accrued effort
   * follows — but such branches are never force-merged automatically.
   *
   * Also records ONE {@link ReassignmentRecord} audit row per call (issue #22):
   * the previous mapping is captured as `fromWorkItemId` BEFORE the re-point, so
   * the history survives even though the live mapping is overwritten. `note` is
   * optional and stored verbatim on the audit row.
   */
  reassignBranchToWorkItem(branch: string, workItemId: string, note?: string) {
    // A single move is just a bulk batch of one — share the core so the ledger
    // reconciliation and audit write are never duplicated.
    this.reassignBranchesToWorkItem([branch], workItemId, note);
  }

  /**
   * BULK reassign: re-home MANY branches to one work item in a single operation
   * (issue #22). Reuses the exact per-branch logic of the single move via
   * {@link reassignBranchCore} (sticky manual override + effort follows the
   * branch + credit-ledger reconciliation), then records the whole set under one
   * shared `batchId` so the audit trail can group them. Idempotent-safe: a branch
   * already on `workItemId` is still recorded (from == to) but loses no field, and
   * the end state is identical to calling the single move once per branch. Blank/
   * duplicate branch names are ignored; a single `save()` covers the batch.
   */
  reassignBranchesToWorkItem(branches: string[], workItemId: string, note?: string): ReassignmentRecord[] {
    this.ensureWorkItem(workItemId);
    const projectId = this.workItems[workItemId]?.projectId ?? null;
    // De-duplicate while preserving order; drop empty names.
    const seen = new Set<string>();
    const targets = branches.filter(b => {
      if (typeof b !== 'string' || !b || seen.has(b)) return false;
      seen.add(b);
      return true;
    });
    if (targets.length === 0) return [];
    const batchId = newLedgerId();
    const ts = Date.now();
    const records: ReassignmentRecord[] = [];
    for (const branch of targets) {
      const from = this.reassignBranchCore(branch, workItemId, projectId);
      const rec: ReassignmentRecord = {
        id: newLedgerId(),
        ts,
        branch,
        fromWorkItemId: from,
        toWorkItemId: workItemId,
        batchId
      };
      if (note && note.trim()) rec.note = note.trim();
      this.reassignments.push(rec);
      records.push(rec);
    }
    this.save();
    return records;
  }

  /**
   * The shared core of a single/bulk reassignment (issue #22). Captures and
   * RETURNS the branch's previous work item (for the audit `fromWorkItemId`),
   * re-points the branch, marks it a sticky manual override, and reconciles the
   * branch's credit-ledger rows onto `workItemId`/`projectId`. Does NOT persist or
   * write an audit row — the caller owns batching, the audit trail and `save()`.
   */
  private reassignBranchCore(branch: string, workItemId: string, projectId: string | null): string | null {
    const data = this.ensureBranch(branch);
    const from = data.workItemId ?? null;
    data.workItemId = workItemId;
    data.workItemIdManual = true;
    for (const e of this.creditLedger) {
      if (e.branch === branch) {
        e.workItemId = workItemId;
        e.projectId = projectId;
      }
    }
    return from;
  }

  /**
   * List reassignment audit records (issue #22), newest-first. Pass a `branch` to
   * scope to a single branch's history, or omit it for the full trail. Returns a
   * shallow copy so callers can't mutate the stored array.
   */
  getReassignments(branch?: string): ReassignmentRecord[] {
    return this.reassignments
      .filter(r => branch === undefined || r.branch === branch)
      .sort((a, b) => b.ts - a.ts);
  }

  /** The work item id currently mapped to a branch (or null). */
  getWorkItemForBranch(branch: string): string | null {
    return this.store[branch]?.workItemId ?? null;
  }

  /** Whether a branch's work item mapping was set manually (sticky). */
  isBranchMappingManual(branch: string): boolean {
    return !!this.store[branch]?.workItemIdManual;
  }

  /** Create the work item entity if missing. Does not persist on its own. */
  private ensureWorkItem(id: string, seed?: Partial<WorkItem>): WorkItem {
    if (!this.workItems[id]) {
      this.workItems[id] = {
        id,
        title: seed?.title ?? null,
        projectId: seed?.projectId ?? null,
        estimate: seed?.estimate ?? null,
        externalRef: seed?.externalRef ?? null,
        createdAt: seed?.createdAt ?? Date.now(),
        ...(seed?.estimateBreakdown !== undefined
          ? { estimateBreakdown: seed.estimateBreakdown }
          : {}),
        ...(seed?.estimateUnit !== undefined ? { estimateUnit: seed.estimateUnit } : {})
      };
    }
    return this.workItems[id];
  }

  /**
   * Create or update a work item's metadata (title/estimate/projectId/externalRef/
   * estimateBreakdown/estimateUnit). Only provided fields are changed; `id`/
   * `createdAt` are preserved. When an `estimateBreakdown` is supplied the scalar
   * `estimate` is resynced to its sum so it stays the canonical total (issue #16).
   */
  upsertWorkItem(
    id: string,
    fields: Partial<Omit<WorkItem, 'id' | 'createdAt'>> = {}
  ): WorkItem {
    const wi = this.ensureWorkItem(id);
    if (fields.title !== undefined) wi.title = fields.title;
    if (fields.projectId !== undefined) wi.projectId = fields.projectId;
    if (fields.estimate !== undefined) wi.estimate = fields.estimate;
    if (fields.externalRef !== undefined) wi.externalRef = fields.externalRef;
    if (fields.estimateUnit !== undefined) wi.estimateUnit = fields.estimateUnit;
    if (fields.estimateBreakdown !== undefined) {
      this.applyBreakdown(wi, fields.estimateBreakdown);
    }
    this.save();
    return wi;
  }

  /**
   * Set (or clear) a work item's per-category estimate breakdown and keep the
   * scalar total in sync (issue #16). Passing `null`/`undefined` clears the
   * breakdown and leaves the scalar `estimate` untouched as the fallback total.
   * `unit` is optional and only updated when provided.
   */
  setEstimateBreakdown(
    workItemId: string,
    breakdown: EstimateBreakdown | null | undefined,
    unit?: EstimateUnit
  ): WorkItem {
    const wi = this.ensureWorkItem(workItemId);
    this.applyBreakdown(wi, breakdown);
    if (unit !== undefined) wi.estimateUnit = unit;
    this.save();
    return wi;
  }

  /**
   * Set (or clear) a work item's manual 'could-charge' billable-hours override
   * (issue #46). Pass a finite, non-negative number to pin the billable hours;
   * pass `null` (or a NaN/negative value) to CLEAR the override so the effective
   * billable hours fall back to the estimate-in-hours and then the actual worked
   * hours (see {@link effectiveBillableHours}). Persists via the durable
   * {@link save} path. Never stores a NaN.
   */
  setBillableHours(workItemId: string, hours: number | null): WorkItem {
    const wi = this.ensureWorkItem(workItemId);
    if (hours === null || typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
      delete wi.billableHours;
    } else {
      wi.billableHours = hours;
    }
    this.save();
    return wi;
  }

  /**
   * Resolve a work item's effective 'could-charge' billable hours (issue #46):
   * the manual {@link WorkItem.billableHours} override when set; else the total
   * estimate ONLY when it is expressed in hours; else the `actualHours` worked.
   * A 'points' estimate never counts (it is not a duration). Always returns a
   * finite, non-negative number. Pure over its inputs.
   */
  private effectiveBillableHours(wi: WorkItem, actualHours: number): number {
    const override = wi.billableHours;
    if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
      return override;
    }
    const unit = wi.estimateUnit ?? 'hours';
    if (unit === 'hours') {
      const est = workItemTotalEstimate(wi);
      if (est !== null && Number.isFinite(est) && est >= 0) return est;
    }
    return actualHours;
  }

  /**
   * Normalize + store a breakdown on a work item and resync the scalar total.
   * Keeps only finite numeric category entries; an empty/absent breakdown is
   * removed and the scalar `estimate` is left as-is. Does not persist on its own.
   */
  private applyBreakdown(wi: WorkItem, breakdown: EstimateBreakdown | null | undefined): void {
    if (!breakdown) {
      delete wi.estimateBreakdown;
      return;
    }
    const clean: EstimateBreakdown = {};
    for (const cat of ALL_CATEGORIES) {
      const v = breakdown[cat];
      if (typeof v === 'number' && Number.isFinite(v)) clean[cat] = v;
    }
    const sum = sumBreakdown(clean);
    if (sum === null) {
      delete wi.estimateBreakdown;
      return;
    }
    wi.estimateBreakdown = clean;
    wi.estimate = sum;
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.workItems[id];
  }

  getAllWorkItemIds(): string[] {
    return Object.keys(this.workItems).sort();
  }

  getAllWorkItems(): WorkItem[] {
    return this.getAllWorkItemIds().map(id => this.workItems[id]);
  }

  /**
   * Count what {@link deleteWorkItem} would detach, WITHOUT mutating anything, so
   * the UI can confirm the impact before removing the entity. Synthetic buckets
   * (`__unassigned__`, `unknown`) and unknown ids report all zeros.
   */
  workItemDeletionImpact(
    id: string
  ): { branches: number; ledger: number; manualEffort: number; timeEntries: number } {
    if (id === UNASSIGNED_WORK_ITEM_ID || id === 'unknown' || !this.workItems[id]) {
      return { branches: 0, ledger: 0, manualEffort: 0, timeEntries: 0 };
    }
    return {
      branches: Object.keys(this.store).filter(b => this.store[b].workItemId === id).length,
      ledger: this.creditLedger.filter(e => (e.workItemId ?? null) === id).length,
      manualEffort: this.manualEffort.filter(m => m.workItemId === id).length,
      timeEntries: this.timeEntries.filter(t => (t.workItemId ?? null) === id).length
    };
  }

  /**
   * Delete a work item entity the user created by mistake. ZERO-LOSS: any branch,
   * credit-ledger row, manual-effort correction or work-item-direct time-log entry
   * that pointed at this work item is DETACHED to the synthetic `__unassigned__`
   * bucket (derived project cleared) rather than destroyed, so its recorded
   * effort/credits stay visible under "Unassigned" and can be re-homed later.
   * Detached branches are marked a sticky manual override so live git
   * auto-detection cannot immediately re-create the very work item just removed.
   * Synthetic buckets and unknown ids can never be deleted (returns removed:false).
   * Reassignment audit rows are left intact as history. Persists via {@link save}.
   */
  deleteWorkItem(
    id: string
  ): { removed: boolean; branches: number; ledger: number; manualEffort: number; timeEntries: number } {
    const impact = this.workItemDeletionImpact(id);
    if (id === UNASSIGNED_WORK_ITEM_ID || id === 'unknown' || !this.workItems[id]) {
      return { removed: false, ...impact };
    }
    // Detach branches -> unassigned, sticky so auto-detect won't re-create `id`.
    for (const b of Object.keys(this.store)) {
      if (this.store[b].workItemId === id) {
        this.store[b].workItemId = UNASSIGNED_WORK_ITEM_ID;
        this.store[b].workItemIdManual = true;
      }
    }
    // Detach ledger rows -> unassigned, clearing the derived project.
    for (const e of this.creditLedger) {
      if ((e.workItemId ?? null) === id) {
        e.workItemId = UNASSIGNED_WORK_ITEM_ID;
        e.projectId = null;
      }
    }
    // Detach manual-effort corrections.
    for (const m of this.manualEffort) {
      if (m.workItemId === id) m.workItemId = UNASSIGNED_WORK_ITEM_ID;
    }
    // Detach work-item-direct time entries (branch-scoped ones follow their branch).
    for (const t of this.timeEntries) {
      if ((t.workItemId ?? null) === id) {
        t.workItemId = UNASSIGNED_WORK_ITEM_ID;
        t.projectId = undefined;
      }
    }
    delete this.workItems[id];
    this.save();
    return { removed: true, ...impact };
  }

  /** Branch names that currently roll up into the given work item. */
  private getBranchesForWorkItem(workItemId: string): string[] {
    return Object.keys(this.store)
      .filter(b => this.store[b].workItemId === workItemId)
      .sort();
  }

  /**
   * Aggregate a work item's effort across ALL of its branches. Per-branch detail
   * stays intact underneath; this is a read-only rollup mirroring
   * {@link getSummaryForBranch}/{@link BranchSummary}.
   */
  getWorkItemSummary(workItemId: string): WorkItemSummary {
    const wi = this.ensureWorkItem(workItemId);
    const branches = this.getBranchesForWorkItem(workItemId);
    const rollup = rollupBranchSummaries(branches.map(b => this.getSummaryForBranch(b)));
    // #21: fold hand-entered corrections into the tracked totals (additive) and
    // expose them separately as `manual` so the UI can show the auto/manual split.
    const manual = this.manualRollupForWorkItem(workItemId);
    mergeManualRollup(rollup, manual);
    // #60: fold branch-less time-log entries attached directly to this work item
    // (branch-scoped entries are already in `rollup` via their branch summaries).
    addModeMsToRollup(rollup, this.timeEntryMsForWorkItemDirect(workItemId));
    const billableMs = rollup.humanCodingMs + rollup.aiGeneratingMs + rollup.reviewingMs;
    // #46: decouple the 'could-charge' billable hours from the actual worked
    // hours before computing ROI, so invoice value / net gain / profit reflect
    // AI leverage instead of just wall-clock time.
    const actualHours = billableMs / MS_PER_HOUR;
    const billableHours = this.effectiveBillableHours(wi, actualHours);
    const roi = this.roiForSubject(
      wi.projectId ?? null,
      billableMs,
      this.getCreditsForWorkItem(workItemId),
      billableHours
    );
    // #48: value of the generated lines (human + AI added, rolled up) at the
    // global baseline authoring speed and the project's effective sell rate.
    // equivalentHours doubles as the suggested billable-hours input. Shares the
    // same effective-rate source as `roi`; null (never NaN) when a rate is unset.
    const generated = computeGeneratedValue({
      linesAdded: rollup.linesHumanAdded + rollup.linesAiAdded,
      baselineLocPerMinute: this.readBaselineLocPerMinute(),
      sellRate: roi.hourlySellRate
    });
    return {
      workItemId: wi.id,
      title: wi.title ?? null,
      projectId: wi.projectId ?? null,
      // `estimate` is the canonical TOTAL: sum of the breakdown when present,
      // otherwise the scalar (issue #16).
      estimate: workItemTotalEstimate(wi),
      ...(wi.estimateBreakdown !== undefined
        ? { estimateBreakdown: wi.estimateBreakdown }
        : {}),
      estimateUnit: wi.estimateUnit ?? 'hours',
      externalRef: wi.externalRef ?? null,
      createdAt: wi.createdAt,
      branches,
      ...rollup,
      manual,
      roi,
      generated,
      timeEntries: this.timeEntriesForWorkItem(workItemId)
    };
  }

  getAllWorkItemSummaries(): WorkItemSummary[] {
    return this.getAllWorkItemIds().map(id => this.getWorkItemSummary(id));
  }

  /**
   * The EFFECTIVE tracked time for a branch (issue #47): the raw auto-tracked ms
   * plus the per-mode adjustment DELTA, CLAMPED at 0 so a correction can never
   * drive a bucket negative. The raw {@link BranchData.time} buckets are never
   * mutated, so this is a pure read-through — the single funnel every
   * summary/rollup/ROI read of tracked time goes through, which is why a
   * correction propagates to the branch summary, work-item rollup, project
   * rollups and ROI while the original value stays restorable via
   * {@link clearTimeAdjustment}.
   */
  private effectiveTime(data: BranchData): Record<TrackingMode, number> {
    const adj = data.timeAdjustment;
    const eff = (mode: TrackingMode): number => {
      const raw = data.time[mode] ?? 0;
      const d = adj ? adj[mode] : undefined;
      const delta = typeof d === 'number' && Number.isFinite(d) ? d : 0;
      const v = raw + delta;
      return v > 0 ? v : 0;
    };
    return {
      humanCoding: eff('humanCoding'),
      aiGenerating: eff('aiGenerating'),
      reviewing: eff('reviewing'),
      idle: eff('idle')
    };
  }

  /**
   * Raw auto-tracked time buckets for a branch (issue #47) — a defensive copy of
   * the untouched {@link BranchData.time}. Useful for a UI that wants to show the
   * original value next to the corrected one, or to compute a delta from a
   * desired absolute value.
   */
  getRawTime(branch: string): Record<TrackingMode, number> {
    const data = this.ensureBranch(branch);
    return {
      humanCoding: data.time.humanCoding ?? 0,
      aiGenerating: data.time.aiGenerating ?? 0,
      reviewing: data.time.reviewing ?? 0,
      idle: data.time.idle ?? 0
    };
  }

  /**
   * The EFFECTIVE (raw ± adjustment, clamped at 0) time buckets for a branch
   * (issue #47) — the same values every rollup/ROI read uses. Public wrapper over
   * {@link effectiveTime}.
   */
  getEffectiveTime(branch: string): Record<TrackingMode, number> {
    return this.effectiveTime(this.ensureBranch(branch));
  }

  /**
   * The per-mode adjustment DELTAs currently applied to a branch (issue #47), as
   * a defensive copy. An empty object means the branch is on its raw value.
   */
  getTimeAdjustment(branch: string): Partial<Record<TrackingMode, number>> {
    const data = this.ensureBranch(branch);
    return { ...(data.timeAdjustment ?? {}) };
  }

  /**
   * Set the per-mode adjustment DELTA (issue #47) for a branch — the signed ms
   * offset applied on top of the raw auto-tracked bucket (may be negative). A
   * delta of exactly 0, or any non-finite value, CLEARS that mode's adjustment so
   * it falls back to the raw value; when the branch's last adjustment is cleared
   * the whole `timeAdjustment` object is dropped so the persisted shape stays
   * clean. The raw {@link BranchData.time} bucket is NEVER touched, so the
   * original auto value stays intact and restorable. Persists via the durable
   * {@link save} path.
   */
  setTimeAdjustment(branch: string, mode: TrackingMode, deltaMs: number): void {
    const data = this.ensureBranch(branch);
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs === 0) {
      if (data.timeAdjustment) {
        delete data.timeAdjustment[mode];
        if (Object.keys(data.timeAdjustment).length === 0) delete data.timeAdjustment;
      }
    } else {
      if (!data.timeAdjustment) data.timeAdjustment = {};
      data.timeAdjustment[mode] = deltaMs;
    }
    this.save();
  }

  /**
   * Set the EFFECTIVE (corrected) time for a branch's mode to an absolute
   * `desiredMs` (issue #47) by storing the delta = `desiredMs − rawMs` under the
   * hood, so the UI can let the user type the value they want to SEE rather than
   * a signed offset. `desiredMs` is clamped at 0; when it equals the raw value
   * the adjustment is cleared (back to auto). The raw bucket is never mutated.
   * Persists via the durable {@link save} path.
   */
  setEffectiveTime(branch: string, mode: TrackingMode, desiredMs: number): void {
    const data = this.ensureBranch(branch);
    const raw = data.time[mode] ?? 0;
    const desired =
      typeof desiredMs === 'number' && Number.isFinite(desiredMs) && desiredMs > 0 ? desiredMs : 0;
    this.setTimeAdjustment(branch, mode, desired - raw);
  }

  /**
   * Clear the adjustment on a branch (issue #47), restoring the exact raw
   * auto-tracked value. Pass a `mode` to reset only that mode; omit it to reset
   * ALL modes on the branch back to auto. Persists via the durable {@link save}
   * path. A no-op (still persisted-safe) when the branch has no adjustment.
   */
  clearTimeAdjustment(branch: string, mode?: TrackingMode): void {
    const data = this.ensureBranch(branch);
    if (!data.timeAdjustment) return;
    if (mode) {
      delete data.timeAdjustment[mode];
      if (Object.keys(data.timeAdjustment).length === 0) delete data.timeAdjustment;
    } else {
      delete data.timeAdjustment;
    }
    this.save();
  }

  /**
   * Compare a work item's per-category ESTIMATE against its tracked ACTUAL
   * (issue #16). The `actual` measure is LINES ADDED per category
   * (`human.added + ai.added` from the rolled-up {@link WorkItemSummary.byCategory}),
   * because tracked TIME is bucketed by mode — not by file category — so it
   * cannot be attributed per category. Estimate numbers come from the work
   * item's breakdown (a missing category counts as 0); when no breakdown exists
   * every category estimate is 0 and `hasEstimate` is false. Safe by
   * construction: it only sums, never divides, so an unestimated work item (or
   * effort logged before any estimate existed) yields plain zeros — never NaN.
   */
  getEstimateVsActual(workItemId: string): EstimateVsActual {
    const wi = this.ensureWorkItem(workItemId);
    const summary = this.getWorkItemSummary(workItemId);
    const breakdown = wi.estimateBreakdown;
    const total = workItemTotalEstimate(wi);
    const rows: EstimateActualRow[] = ALL_CATEGORIES.map(cat => {
      const est = breakdown && typeof breakdown[cat] === 'number' ? breakdown[cat]! : 0;
      const bucket = summary.byCategory[cat];
      const actual = bucket ? bucket.human.added + bucket.ai.added : 0;
      return { category: cat, estimate: est, actual };
    });
    return {
      workItemId: wi.id,
      unit: wi.estimateUnit ?? 'hours',
      hasEstimate: total !== null,
      byCategory: rows,
      total: {
        estimate: total,
        actual: rows.reduce((n, r) => n + r.actual, 0)
      }
    };
  }

  getSummaryForBranch(branch: string): BranchSummary {
    const data = this.ensureBranch(branch);
    const { categorize, categorizeExt, ALL_CATEGORIES } = require('../util/fileTypes');

    let linesHumanAdded = 0, linesHumanDeleted = 0;
    let linesAiAdded = 0, linesAiDeleted = 0;
    const byCategory: Record<string, { human: LineStats; ai: LineStats }> = {};
    for (const cat of ALL_CATEGORIES as string[]) {
      byCategory[cat] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
    }
    const bucketFor = (cat: string) =>
      (byCategory[cat] ??= { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } });

    // Totals come from the extension-keyed line changes (backward compatible).
    for (const stats of Object.values(data.lineChanges)) {
      linesHumanAdded += stats.human.added;
      linesHumanDeleted += stats.human.deleted;
      linesAiAdded += stats.ai.added;
      linesAiDeleted += stats.ai.deleted;
    }

    // Prefer per-file paths so folder rules apply; fall back to ext-only data.
    const files = data.files ?? {};
    if (Object.keys(files).length > 0) {
      for (const [filePath, f] of Object.entries(files)) {
        const b = bucketFor(categorize(filePath));
        b.human.added += f.humanAdded;
        b.human.deleted += f.humanDeleted;
        b.ai.added += f.aiAdded;
        b.ai.deleted += f.aiDeleted;
      }
    } else {
      for (const [ext, stats] of Object.entries(data.lineChanges)) {
        const b = bucketFor(categorizeExt(ext));
        b.human.added += stats.human.added;
        b.human.deleted += stats.human.deleted;
        b.ai.added += stats.ai.added;
        b.ai.deleted += stats.ai.deleted;
      }
    }

    const creditTotals = this.getCreditsForBranch(branch);
    const projectId = data.workItemId
      ? this.workItems[data.workItemId]?.projectId ?? null
      : null;
    // #47: read the EFFECTIVE (raw ± adjustment, clamped) tracked time so a
    // correction flows into this summary, the work-item/project rollups and ROI.
    // The raw buckets are exposed separately so the UI can prove they're intact.
    const eff = this.effectiveTime(data);
    // #60: fold this branch's manual time-log entries additively onto the
    // effective buckets so the branch summary, its work-item/project rollups and
    // ROI all include them (counted once, at the branch level).
    const teMs = this.timeEntryMsForBranch(branch);
    eff.humanCoding += teMs.humanCoding;
    eff.aiGenerating += teMs.aiGenerating;
    eff.reviewing += teMs.reviewing;
    eff.idle += teMs.idle;
    const billableMs = eff.humanCoding + eff.aiGenerating + eff.reviewing;
    return {
      branch,
      workItemId: data.workItemId,
      humanCodingMs: eff.humanCoding,
      aiGeneratingMs: eff.aiGenerating,
      reviewingMs: eff.reviewing,
      idleMs: eff.idle,
      rawTime: {
        humanCoding: data.time.humanCoding ?? 0,
        aiGenerating: data.time.aiGenerating ?? 0,
        reviewing: data.time.reviewing ?? 0,
        idle: data.time.idle ?? 0
      },
      timeAdjustment: { ...(data.timeAdjustment ?? {}) },
      linesHumanAdded,
      linesHumanDeleted,
      linesAiAdded,
      linesAiDeleted,
      copilotAcceptances: data.copilotAcceptances,
      estimatedCostUsd: linesAiAdded * COST_PER_AI_LINE_USD,
      chatCharsHuman: data.chatCharsHuman ?? 0,
      chatTurnsHuman: data.chatTurnsHuman ?? 0,
      humanChars: data.humanCharsInserted ?? 0,
      aiChars: data.aiCharsInserted ?? 0,
      humanKeystrokes: data.humanKeystrokes ?? 0,
      aiInserts: data.aiInserts ?? 0,
      aiInlineLines: data.aiInlineLines ?? 0,
      aiChatLines: data.aiChatLines ?? 0,
      aiInlineChars: data.aiInlineChars ?? 0,
      aiChatChars: data.aiChatChars ?? 0,
      creditsTotal: creditTotals.credits,
      creditsByModel: creditTotals.byModel,
      byExt: data.lineChanges,
      byCategory,
      timeEntries: this.timeEntriesForBranch(branch),
      roi: this.roiForSubject(projectId, billableMs, creditTotals)
    };
  }

  getAllBranches(): string[] {
    return Object.keys(this.store).sort();
  }

  getAllBranchesSummaries(): BranchSummary[] {
    return this.getAllBranches().map(b => this.getSummaryForBranch(b));
  }

  /** Daily activity aggregated across ALL branches for the last `days` days. */
  getDailySeries(days: number = 30): DailyPoint[] {
    const out: DailyPoint[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const key = dayKey(d.getTime());
      const point: DailyPoint = {
        date: key, humanCoding: 0, aiGenerating: 0, reviewing: 0,
        idle: 0, linesHuman: 0, linesAi: 0
      };
      for (const branch of Object.values(this.store)) {
        const b = branch.daily?.[key];
        if (!b) continue;
        point.humanCoding += b.humanCoding ?? 0;
        point.aiGenerating += b.aiGenerating ?? 0;
        point.reviewing += b.reviewing ?? 0;
        point.idle += b.idle ?? 0;
        point.linesHuman += b.linesHuman ?? 0;
        point.linesAi += b.linesAi ?? 0;
      }
      out.push(point);
    }
    return out;
  }

  /**
   * Activity heatmap: 7 weekdays x 24 hours of active ms, aggregated across all
   * branches and all history. weekday 0 = Sunday.
   */
  getHourHeatmap(): number[][] {
    const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const branch of Object.values(this.store)) {
      if (!branch.daily) continue;
      for (const [key, bucket] of Object.entries(branch.daily)) {
        if (!bucket.hours) continue;
        const wd = new Date(key + 'T00:00:00').getDay();
        for (let h = 0; h < 24; h++) {
          heat[wd][h] += bucket.hours[h] ?? 0;
        }
      }
    }
    return heat;
  }

  getFocusStats(goalMinutes: number = 240): FocusStats {
    const now = Date.now();
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const startWeek = now - 7 * 86400000;
    let sessionsToday = 0, sessionsWeek = 0;
    let totalToday = 0, totalWeek = 0, longest = 0, totalAll = 0, countAll = 0;
    for (const branch of Object.values(this.store)) {
      for (const s of branch.focusSessions ?? []) {
        countAll++; totalAll += s.ms;
        if (s.ms > longest) longest = s.ms;
        if (s.ts >= startWeek) { sessionsWeek++; totalWeek += s.ms; }
        if (s.ts >= startToday.getTime()) { sessionsToday++; totalToday += s.ms; }
      }
    }
    const goalMs = Math.max(1, goalMinutes) * 60000;
    return {
      sessionsToday, sessionsWeek,
      totalFocusMsToday: totalToday, totalFocusMsWeek: totalWeek,
      longestMs: longest,
      avgMs: countAll > 0 ? totalAll / countAll : 0,
      goalProgressPct: Math.min(100, (totalToday / goalMs) * 100)
    };
  }

  /** Active ms (human + ai + review) accrued today, across all branches. */
  getTodayActiveMs(): number {
    const key = dayKey();
    let ms = 0;
    for (const branch of Object.values(this.store)) {
      const b = branch.daily?.[key];
      if (b) ms += (b.humanCoding ?? 0) + (b.aiGenerating ?? 0) + (b.reviewing ?? 0);
    }
    return ms;
  }

  /** Consecutive-day coding streak (current run ending today/yesterday) + longest ever. */
  getStreak(): StreakStats {
    const active = new Set<string>();
    for (const branch of Object.values(this.store)) {
      for (const [k, b] of Object.entries(branch.daily ?? {})) {
        if (((b.humanCoding ?? 0) + (b.aiGenerating ?? 0) + (b.reviewing ?? 0)) > 0) active.add(k);
      }
    }
    // Current run: start today; if today has no activity yet, start at yesterday
    // so a fresh morning doesn't read as a broken streak.
    let start = new Date(); start.setHours(0, 0, 0, 0);
    if (!active.has(dayKey(start.getTime()))) start = new Date(start.getTime() - 86400000);
    let current = 0;
    let cur = new Date(start.getTime());
    while (active.has(dayKey(cur.getTime()))) { current++; cur = new Date(cur.getTime() - 86400000); }
    // Longest run across all recorded days.
    const keys = [...active].sort();
    let longest = 0, run = 0;
    let prev: string | null = null;
    for (const k of keys) {
      if (prev) {
        const diff = (Date.parse(k + 'T00:00:00') - Date.parse(prev + 'T00:00:00')) / 86400000;
        run = diff === 1 ? run + 1 : 1;
      } else { run = 1; }
      if (run > longest) longest = run;
      prev = k;
    }
    return { current, longest: Math.max(longest, current) };
  }

  /** This-week (last 7 days) vs prior 7 days: active time, lines, AI share. */
  getWeekComparison(): WeekComparison {
    const series = this.getDailySeries(14);
    const cut = series.length - 7;
    const agg = (arr: DailyPoint[]): WeekAgg => {
      let active = 0, lh = 0, la = 0;
      for (const d of arr) {
        active += d.humanCoding + d.aiGenerating + d.reviewing;
        lh += d.linesHuman; la += d.linesAi;
      }
      const lines = lh + la;
      return { activeMs: active, lines, aiShare: lines > 0 ? (la / lines) * 100 : 0 };
    };
    return { thisWeek: agg(series.slice(cut)), lastWeek: agg(series.slice(0, cut)) };
  }

  /** Most-edited files across all branches (hotspots), ranked by lines touched. */
  getTopFiles(limit: number = 12): TopFile[] {
    const map: Record<string, FileStat> = {};
    for (const branch of Object.values(this.store)) {
      for (const [p, f] of Object.entries(branch.files ?? {})) {
        if (!map[p]) map[p] = { humanAdded: 0, humanDeleted: 0, aiAdded: 0, aiDeleted: 0, edits: 0, lastTs: 0 };
        const m = map[p];
        m.humanAdded += f.humanAdded; m.humanDeleted += f.humanDeleted;
        m.aiAdded += f.aiAdded; m.aiDeleted += f.aiDeleted;
        m.edits += f.edits;
        if (f.lastTs > m.lastTs) m.lastTs = f.lastTs;
      }
    }
    return Object.entries(map)
      .map(([path, f]) => {
        const human = f.humanAdded, ai = f.aiAdded, total = human + ai;
        return { path, human, ai, edits: f.edits, total, aiShare: total > 0 ? (ai / total) * 100 : 0, lastTs: f.lastTs };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  /** Today's active ms per hour, split by mode — drives the timeline ribbon. */
  getTodayTimeline(): TodayTimeline {
    const key = dayKey();
    const out: TodayTimeline = {
      humanCoding: new Array(24).fill(0),
      aiGenerating: new Array(24).fill(0),
      reviewing: new Array(24).fill(0)
    };
    for (const branch of Object.values(this.store)) {
      const b = branch.daily?.[key];
      if (!b?.hoursByMode) continue;
      for (let h = 0; h < 24; h++) {
        out.humanCoding[h] += b.hoursByMode.humanCoding?.[h] ?? 0;
        out.aiGenerating[h] += b.hoursByMode.aiGenerating?.[h] ?? 0;
        out.reviewing[h] += b.hoursByMode.reviewing?.[h] ?? 0;
      }
    }
    return out;
  }

  // ---- Credit ledger queries (issue #11) --------------------------------

  /** Raw ledger rows matching a filter, sorted newest-first. */
  getCreditEntries(query: CreditQuery = {}): LedgerEntry[] {
    return this.creditLedger
      .filter(e => this.matchesCreditQuery(e, query))
      .sort((a, b) => b.ts - a.ts);
  }

  private matchesCreditQuery(e: LedgerEntry, q: CreditQuery): boolean {
    if (q.branch !== undefined && e.branch !== q.branch) return false;
    if (q.workItemId !== undefined && (e.workItemId ?? null) !== q.workItemId) return false;
    if (q.projectId !== undefined && (e.projectId ?? null) !== q.projectId) return false;
    if (q.source !== undefined && e.source !== q.source) return false;
    if (q.from !== undefined && e.ts < q.from) return false;
    if (q.to !== undefined && e.ts > q.to) return false;
    return true;
  }

  /**
   * Summable credit/cost totals for a ledger slice (issue #11). Splitting by
   * `source` lets callers separate ESTIMATED auto credits from manual/import
   * (addresses the #17 over-counting concern).
   */
  getCredits(query: CreditQuery = {}): CreditTotals {
    const byModel: Record<string, { credits: number; turns: number }> = {};
    const totals: CreditTotals = {
      credits: 0,
      cost: 0,
      entries: 0,
      byModel: [],
      bySource: { manual: 0, auto: 0, import: 0 }
    };
    for (const e of this.creditLedger) {
      if (!this.matchesCreditQuery(e, query)) continue;
      totals.credits += e.credits;
      totals.cost += e.cost ?? 0;
      totals.entries += 1;
      totals.bySource[e.source] += e.credits;
      if (!byModel[e.model]) byModel[e.model] = { credits: 0, turns: 0 };
      byModel[e.model].credits += e.credits;
      byModel[e.model].turns += 1;
    }
    totals.byModel = Object.entries(byModel)
      .map(([model, v]) => ({ model, credits: v.credits, turns: v.turns }))
      .sort((a, b) => b.credits - a.credits);
    return totals;
  }

  /** Credit totals for one branch (optionally filtered by period/source). */
  getCreditsForBranch(branch: string, query: Omit<CreditQuery, 'branch'> = {}): CreditTotals {
    return this.getCredits({ ...query, branch });
  }

  /** Credit totals rolled up for a work item across all its branches. */
  getCreditsForWorkItem(
    workItemId: string,
    query: Omit<CreditQuery, 'workItemId'> = {}
  ): CreditTotals {
    return this.getCredits({ ...query, workItemId });
  }

  /** Credit totals rolled up for a project across all its work items/branches. */
  getCreditsForProject(
    projectId: string,
    query: Omit<CreditQuery, 'projectId'> = {}
  ): CreditTotals {
    return this.getCredits({ ...query, projectId });
  }

  // ---------------------------------------------------------------------------
  // Projects (issue #8 / milestone M2)
  //
  // A Project groups repositories and, transitively, the work items whose
  // projectId points at it. Effort rolls up branch → work item → project; credits
  // roll up from the top-level ledger via getCreditsForProject. This layer is
  // backend-only — a management UI to create projects / link the repo lands in a
  // later issue (#27) and will call the public methods below.
  // ---------------------------------------------------------------------------

  /**
   * Create or update a {@link Project}. When `fields.id` is omitted (or unknown)
   * a new project is created with a fresh uuid; otherwise the existing project is
   * updated and only the provided fields change. `createdAt`/`id` are preserved.
   * `repos` are normalized and de-duplicated via {@link normalizeRepoId}.
   */
  upsertProject(fields: {
    id?: string;
    name?: string;
    repos?: string[];
    settings?: ProjectSettings;
  } = {}): Project {
    const id = fields.id && this.projects[fields.id] ? fields.id : fields.id ?? newLedgerId();
    let project = this.projects[id];
    if (!project) {
      project = {
        id,
        name: fields.name ?? id,
        repos: [],
        createdAt: Date.now()
      };
      this.projects[id] = project;
    }
    if (fields.name !== undefined) project.name = fields.name;
    if (fields.repos !== undefined) {
      const seen = new Set<string>();
      project.repos = [];
      for (const r of fields.repos) {
        const norm = normalizeRepoId(r);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          project.repos.push(norm);
        }
      }
    }
    if (fields.settings !== undefined) project.settings = fields.settings;
    this.save();
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects[id];
  }

  getAllProjects(): Project[] {
    return Object.keys(this.projects)
      .sort()
      .map(id => this.projects[id]);
  }

  /**
   * Attach a repository identity to a project (idempotent, many-to-many capable).
   * The id is normalized via {@link normalizeRepoId} so callers can pass a raw
   * `origin` URL or workspace path. Returns the updated project, or `undefined`
   * if the project id is unknown.
   */
  linkRepoToProject(projectId: string, repoId: string): Project | undefined {
    const project = this.projects[projectId];
    if (!project) return undefined;
    const norm = normalizeRepoId(repoId);
    if (norm && !project.repos.includes(norm)) {
      project.repos.push(norm);
      this.save();
    }
    return project;
  }

  /** Detach a repository identity from a project. Returns the updated project (or undefined). */
  unlinkRepoFromProject(projectId: string, repoId: string): Project | undefined {
    const project = this.projects[projectId];
    if (!project) return undefined;
    const norm = normalizeRepoId(repoId);
    const idx = project.repos.indexOf(norm);
    if (idx >= 0) {
      project.repos.splice(idx, 1);
      this.save();
    }
    return project;
  }

  /**
   * Resolve which project owns a repository. `repoId` is normalized first, so it
   * accepts a raw `origin` URL or workspace path. Returns the first project that
   * lists the repo (creation order by id), or `undefined` when unmapped.
   */
  getProjectForRepo(repoId: string): Project | undefined {
    const norm = normalizeRepoId(repoId);
    if (!norm) return undefined;
    for (const project of this.getAllProjects()) {
      if (project.repos.includes(norm)) return project;
    }
    return undefined;
  }

  /**
   * Assign a work item to a project (or clear it with `null`). Also reconciles
   * historical ledger rows for the work item so {@link getCreditsForProject}
   * reflects credits recorded before the link — appendLedger only resolves
   * projectId at write time, so without this, past credits would stay orphaned.
   * Detached-HEAD / non-work-item buckets are never forced into a project.
   */
  setProjectForWorkItem(workItemId: string, projectId: string | null): WorkItem | undefined {
    if (NON_WORK_ITEM_IDS.has(workItemId)) return undefined;
    const wi = this.ensureWorkItem(workItemId);
    if (wi.projectId === projectId) return wi;
    wi.projectId = projectId;
    for (const e of this.creditLedger) {
      if ((e.workItemId ?? null) === workItemId) e.projectId = projectId;
    }
    this.save();
    return wi;
  }

  /** Work item ids whose projectId points at the given project (sorted). */
  private getWorkItemIdsForProject(projectId: string): string[] {
    return Object.keys(this.workItems)
      .filter(id => this.workItems[id].projectId === projectId)
      .sort();
  }

  /** Branch names that roll up into a project via its work items (sorted, deduped). */
  private getBranchesForProject(projectId: string): string[] {
    const wiIds = new Set(this.getWorkItemIdsForProject(projectId));
    return Object.keys(this.store)
      .filter(b => {
        const id = this.store[b].workItemId;
        return !!id && wiIds.has(id);
      })
      .sort();
  }

  /**
   * Aggregate a project's effort across ALL of its work items and their branches
   * (read-only rollup), plus ledger-derived credit totals. Reuses
   * {@link rollupBranchSummaries}/{@link getSummaryForBranch} rather than
   * duplicating aggregation logic — mirroring {@link getWorkItemSummary}.
   */
  getProjectSummary(projectId: string): ProjectSummary {
    const project = this.projects[projectId];
    const workItemIds = this.getWorkItemIdsForProject(projectId);
    const branches = this.getBranchesForProject(projectId);
    const rollup = this.projectRollupWithManual(projectId, branches, workItemIds);
    const credits = this.getCreditsForProject(projectId);
    return {
      projectId,
      name: project?.name ?? projectId,
      repos: project?.repos ?? [],
      createdAt: project?.createdAt ?? 0,
      workItemIds,
      branches,
      credits,
      roi: this.computeProjectRoi(projectId, rollup, credits),
      ...rollup
    };
  }

  getAllProjectSummaries(): ProjectSummary[] {
    return this.getAllProjects().map(p => this.getProjectSummary(p.id));
  }

  // ---------------------------------------------------------------------------
  // Rates & ROI (issue #15 / milestone M3)
  //
  // Rate resolution precedence: project setting > new global default > legacy
  // setting (`hourlyRateUsd` for cost, `usdPerCredit` for credit cost). The pure
  // precedence + math live in util/rates.ts; this layer only reads VS Code
  // configuration and the project's stored settings and delegates.
  // ---------------------------------------------------------------------------

  /** Read the global rate-related settings from VS Code configuration. */
  private readRateGlobals(): RateGlobals {
    const c = vscode.workspace.getConfiguration('aiEffortTracker');
    return {
      defaultHourlyCostRate: c.get<number>('defaultHourlyCostRate'),
      defaultHourlySellRate: c.get<number>('defaultHourlySellRate'),
      currency: c.get<string>('currency'),
      creditCostPerUnit: c.get<number>('creditCostPerUnit'),
      // Legacy fallbacks so pre-#15 configuration keeps working unchanged.
      legacyHourlyRateUsd: c.get<number>('hourlyRateUsd'),
      legacyUsdPerCredit: c.get<number>('usdPerCredit')
    };
  }

  /**
   * Read the global baseline authoring speed (`aiEffortTracker.baselineLocPerMinute`,
   * default 5) used by the generated-value math (issue #48). Mirrors
   * {@link readRateGlobals}: reads the same VS Code configuration the ROI rates
   * come from so the work-item summary can be computed without threading extra
   * arguments. Returns `null` when the setting is unusable (≤0 / non-finite) so
   * {@link computeGeneratedValue} falls through to a null (never NaN) result.
   * There is intentionally no per-project override: none exists in the persisted
   * shape and this feature adds no new persisted settings.
   */
  private readBaselineLocPerMinute(): number | null {
    const c = vscode.workspace.getConfiguration('aiEffortTracker');
    const v = c.get<number>('baselineLocPerMinute') ?? 5;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * Resolve the EFFECTIVE rates for a project (or the global defaults when no
   * project id / no project is given): project override → global default →
   * legacy setting. Never throws; missing money rates resolve to `null` (never
   * NaN) and currency always resolves to a string. See {@link resolveEffectiveRates}.
   */
  getEffectiveRates(projectId?: string): EffectiveRates {
    const overrides = projectId ? this.projects[projectId]?.settings : undefined;
    return resolveEffectiveRates(overrides, this.readRateGlobals());
  }

  /**
   * Compute the economic ROI figures for any subject (branch / work item /
   * project) from its owning project's EFFECTIVE rates + its billable time and
   * ledger credits (issue #45). Centralises the rate source so branch, work-item
   * and project ROI are always mutually consistent. `ledgerCost` (recorded
   * ledger `cost`) wins over `credits * creditCostPerUnit` when present. Pure
   * delegation to {@link computeRoiFigures}; never throws, never NaN.
   */
  private roiForSubject(
    projectId: string | null | undefined,
    billableMs: number,
    credits: CreditTotals,
    billableHours?: number
  ): RoiFigures {
    return computeRoiFigures({
      billableMs,
      credits: credits.credits,
      ledgerCost: credits.cost,
      rates: this.getEffectiveRates(projectId ?? undefined),
      ...(billableHours !== undefined ? { billableHours } : {})
    });
  }

  /** Shared ROI computation used by {@link getProjectRoi} and {@link getProjectSummary}. */
  private computeProjectRoi(
    projectId: string,
    rollup: BranchRollup,
    credits: CreditTotals
  ): ProjectRoi {
    // Billable = active work (human coding + AI generating + reviewing); idle
    // is never billed. Documented convention for issue #15.
    const billableMs = rollup.humanCodingMs + rollup.aiGeneratingMs + rollup.reviewingMs;
    const figures = computeRoiFigures({
      billableMs,
      credits: credits.credits,
      ledgerCost: credits.cost,
      rates: this.getEffectiveRates(projectId)
    });
    return { projectId, ...figures };
  }

  /**
   * Economic ROI figures for a project (issue #15): its effective rates applied
   * to its rolled-up billable time + ledger credits. Provided both here as a
   * standalone method and inline on {@link ProjectSummary.roi}. The full ROI
   * report is milestone M7 (#29).
   */
  getProjectRoi(projectId: string): ProjectRoi {
    const branches = this.getBranchesForProject(projectId);
    const workItemIds = this.getWorkItemIdsForProject(projectId);
    const rollup = this.projectRollupWithManual(projectId, branches, workItemIds);
    return this.computeProjectRoi(projectId, rollup, this.getCreditsForProject(projectId));
  }

  /**
   * Roll a project's branches up and fold in the manual effort of all its work
   * items (issue #21) so project totals stay equal to the SUM of their work-item
   * totals (which include manual). Shared by {@link getProjectSummary} and
   * {@link getProjectRoi} so their numbers can never drift. When no manual
   * effort exists this is byte-for-byte the old branch-only rollup.
   */
  private projectRollupWithManual(projectId: string, branches: string[], workItemIds: string[]): BranchRollup {
    const rollup = rollupBranchSummaries(branches.map(b => this.getSummaryForBranch(b)));
    for (const id of workItemIds) {
      mergeManualRollup(rollup, this.manualRollupForWorkItem(id));
      // #60: branch-less time-log entries attached directly to each work item.
      addModeMsToRollup(rollup, this.timeEntryMsForWorkItemDirect(id));
    }
    // #60: time-log entries attached directly to the project (no branch/work item).
    addModeMsToRollup(rollup, this.timeEntryMsForProjectDirect(projectId));
    return rollup;
  }
}
