import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { TrackingMode } from '../trackers/timeTracker';
import { ALL_CATEGORIES } from '../util/fileTypes';

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
}

/** Aggregated effort for a single work item, rolled up across all its branches. */
export interface WorkItemSummary {
  workItemId: string;
  title: string | null;
  projectId: string | null;
  estimate: number | null;
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
  'workItemId' | 'title' | 'projectId' | 'estimate' | 'externalRef' | 'createdAt' | 'branches'
>;

/** Current persisted schema version. Bump when the on-disk shape changes. */
export const CURRENT_SCHEMA_VERSION = 2;

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
  if (isEnvelope(parsed)) {
    branches = (parsed.branches ?? {}) as Store;
    workItems = (parsed.workItems ?? {}) as Record<string, WorkItem>;
    const existing = (parsed as PersistedStore).creditLedger;
    creditLedger = Array.isArray(existing) ? existing : [];
  } else {
    branches = (parsed && typeof parsed === 'object' ? parsed : {}) as Store;
    workItems = {};
    creditLedger = [];
  }
  backfillWorkItems(branches, workItems);
  foldCreditsLogIntoLedger(branches, workItems, creditLedger);
  return { schemaVersion: CURRENT_SCHEMA_VERSION, branches, workItems, creditLedger };
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
  }

  /** Build the on-disk envelope from the in-memory state. */
  private serialize(): string {
    const envelope: PersistedStore = {
      schemaVersion: this.schemaVersion,
      branches: this.store,
      workItems: this.workItems,
      creditLedger: this.creditLedger
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

  setWorkItemForBranch(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    data.workItemId = workItemId;
    // A branch may be auto-detected before the work item entity exists; make sure
    // the persisted work item is present so aggregation can find it.
    this.ensureWorkItem(workItemId);
    this.save();
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
        createdAt: seed?.createdAt ?? Date.now()
      };
    }
    return this.workItems[id];
  }

  /**
   * Create or update a work item's metadata (title/estimate/projectId/externalRef).
   * Only provided fields are changed; `id`/`createdAt` are preserved.
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
    this.save();
    return wi;
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
      estimate: wi.estimate ?? null,
      externalRef: wi.externalRef ?? null,
      createdAt: wi.createdAt,
      branches,
      ...rollup
    };
  }

  getAllWorkItemSummaries(): WorkItemSummary[] {
    return this.getAllWorkItemIds().map(id => this.getWorkItemSummary(id));
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
}
