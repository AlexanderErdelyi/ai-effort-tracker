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
  type EffectiveRates,
  type RateGlobals,
  type RoiFigures
} from '../util/rates';

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
}

/** The numeric/breakdown portion of a {@link WorkItemSummary} (identity omitted). */
export type BranchRollup = Omit<
  WorkItemSummary,
  | 'workItemId' | 'title' | 'projectId' | 'estimate' | 'estimateBreakdown'
  | 'estimateUnit' | 'externalRef' | 'createdAt' | 'branches'
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
 */
export const CURRENT_SCHEMA_VERSION = 5;

/** Branch buckets that never map to a real work item (detached HEAD / worktrees). */
const NON_WORK_ITEM_IDS = new Set<string>(['unknown']);

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

/** Generate a collision-resistant ledger id without adding a runtime dependency. */
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
  } else {
    branches = (parsed && typeof parsed === 'object' ? parsed : {}) as Store;
    workItems = {};
    creditLedger = [];
    projects = {};
  }
  backfillWorkItems(branches, workItems);
  foldCreditsLogIntoLedger(branches, workItems, creditLedger);
  return { schemaVersion: CURRENT_SCHEMA_VERSION, branches, workItems, creditLedger, projects };
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
  }

  /** Build the on-disk envelope from the in-memory state. */
  private serialize(): string {
    const envelope: PersistedStore = {
      schemaVersion: this.schemaVersion,
      branches: this.store,
      workItems: this.workItems,
      creditLedger: this.creditLedger,
      projects: this.projects
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
   */
  reassignBranchToWorkItem(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    this.ensureWorkItem(workItemId);
    data.workItemId = workItemId;
    data.workItemIdManual = true;
    const projectId = this.workItems[workItemId]?.projectId ?? null;
    for (const e of this.creditLedger) {
      if (e.branch === branch) {
        e.workItemId = workItemId;
        e.projectId = projectId;
      }
    }
    this.save();
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
      ...rollup
    };
  }

  getAllWorkItemSummaries(): WorkItemSummary[] {
    return this.getAllWorkItemIds().map(id => this.getWorkItemSummary(id));
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
    return {
      branch,
      workItemId: data.workItemId,
      humanCodingMs: data.time.humanCoding ?? 0,
      aiGeneratingMs: data.time.aiGenerating ?? 0,
      reviewingMs: data.time.reviewing ?? 0,
      idleMs: data.time.idle ?? 0,
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
      byCategory
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
    const rollup = rollupBranchSummaries(branches.map(b => this.getSummaryForBranch(b)));
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
   * Resolve the EFFECTIVE rates for a project (or the global defaults when no
   * project id / no project is given): project override → global default →
   * legacy setting. Never throws; missing money rates resolve to `null` (never
   * NaN) and currency always resolves to a string. See {@link resolveEffectiveRates}.
   */
  getEffectiveRates(projectId?: string): EffectiveRates {
    const overrides = projectId ? this.projects[projectId]?.settings : undefined;
    return resolveEffectiveRates(overrides, this.readRateGlobals());
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
    const rollup = rollupBranchSummaries(branches.map(b => this.getSummaryForBranch(b)));
    return this.computeProjectRoi(projectId, rollup, this.getCreditsForProject(projectId));
  }
}
