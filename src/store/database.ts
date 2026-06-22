import * as fs from 'fs';
import * as path from 'path';
import type { TrackingMode } from '../trackers/timeTracker';
import type { FileCategory } from '../util/fileTypes';

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
  creditsTotal: number;
  creditsByModel: { model: string; credits: number; turns: number }[];
  // Breakdown by file extension: { "al": { human: {...}, ai: {...} }, ... }
  byExt: Record<string, ExtStats>;
  // Breakdown by category (code/spec/config/other)
  byCategory: Record<FileCategory, { human: LineStats; ai: LineStats }>;
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
  private store: Store;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing = false;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'effort-tracker.json');
    this.store = this.load();
  }

  private load(): Store {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
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
    try {
      await fs.promises.writeFile(this.filePath, data, 'utf8');
    } catch {
      this.dirty = true; // retry on next save
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
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch { /* ignore */ }
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
    const { categorizeExt } = require('../util/fileTypes');

    let linesHumanAdded = 0, linesHumanDeleted = 0;
    let linesAiAdded = 0, linesAiDeleted = 0;
    const byCategory: Record<FileCategory, { human: LineStats; ai: LineStats }> = {
      code: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      spec: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      config: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      other: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } }
    };

    for (const [ext, stats] of Object.entries(data.lineChanges)) {
      linesHumanAdded += stats.human.added;
      linesHumanDeleted += stats.human.deleted;
      linesAiAdded += stats.ai.added;
      linesAiDeleted += stats.ai.deleted;

      const cat: FileCategory = categorizeExt(ext);
      byCategory[cat].human.added += stats.human.added;
      byCategory[cat].human.deleted += stats.human.deleted;
      byCategory[cat].ai.added += stats.ai.added;
      byCategory[cat].ai.deleted += stats.ai.deleted;
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
