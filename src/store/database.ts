import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TrackingMode } from '../trackers/timeTracker';

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
  daily?: Record<string, DailyBucket>;
  focusSessions?: FocusSession[];
  files?: Record<string, FileStat>;
  // line changes keyed by ext → source → { added, deleted }
  lineChanges: Record<string, { human: LineStats; ai: LineStats }>;
}

type Store = Record<string, BranchData>;

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
    this.store = this.load();
  }

  private load(): Store {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Main file missing (first run, or lost). Recover from backup if present,
      // otherwise start fresh — no warning needed for a normal first run.
      return this.loadFromBackup() ?? {};
    }
    try {
      const store = JSON.parse(raw) as Store;
      // Successful load — refresh the known-good backup.
      this.writeBackup(raw);
      return store;
    } catch {
      return this.recoverFromCorruptMain();
    }
  }

  /** Attempt to read and parse the backup file. Returns undefined if unusable. */
  private loadFromBackup(): Store | undefined {
    try {
      const store = JSON.parse(fs.readFileSync(this.bakPath, 'utf8')) as Store;
      return store;
    } catch {
      return undefined;
    }
  }

  /**
   * The main file exists but failed to parse. Try to recover from the backup;
   * if that fails, move the corrupt file aside (never overwrite it) and start
   * fresh. The user is warned in both cases.
   */
  private recoverFromCorruptMain(): Store {
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
    return {};
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
    const data = JSON.stringify(this.store, null, 2);
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
    const data = JSON.stringify(this.store, null, 2);
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

  recordCredits(branch: string, model: string, credits: number, note?: string) {
    const data = this.ensureBranch(branch);
    if (!data.creditsLog) data.creditsLog = [];
    data.creditsLog.push({ ts: Date.now(), model, credits, note });
    data.chatTurnsHuman = (data.chatTurnsHuman ?? 0) + 1;
    this.save();
  }

  setWorkItemForBranch(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    data.workItemId = workItemId;
    this.save();
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
      creditsTotal: (data.creditsLog ?? []).reduce((a, e) => a + e.credits, 0),
      creditsByModel: this.aggregateCredits(data.creditsLog ?? []),
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

  private aggregateCredits(log: CreditEntry[]): { model: string; credits: number; turns: number }[] {
    const map: Record<string, { credits: number; turns: number }> = {};
    for (const e of log) {
      if (!map[e.model]) map[e.model] = { credits: 0, turns: 0 };
      map[e.model].credits += e.credits;
      map[e.model].turns += 1;
    }
    return Object.entries(map)
      .map(([model, v]) => ({ model, credits: v.credits, turns: v.turns }))
      .sort((a, b) => b.credits - a.credits);
  }
}
