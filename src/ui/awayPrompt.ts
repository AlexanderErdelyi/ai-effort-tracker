import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { atomicWrite } from '../store/persistence';
import { TIME_ENTRY_CATEGORIES, type Database, type TimeEntryCategory } from '../store/database';
import type { TimeTracker } from '../trackers/timeTracker';
import {
  HEARTBEAT_FILE,
  addBeat,
  awayPeriod,
  describeAway,
  otherWindowsActivity,
  parseHeartbeats,
  type AwayPeriod
} from '../analysis/away';

const BEAT_MS = 15_000;
const MEETING = 'Meeting';
const REVIEW = 'Review / thinking';
const OTHER = 'Other work\u2026';
const SKIP = 'Don\u2019t count';

/**
 * Away detection (issue #103). Every window records when it was active in a
 * shared heartbeat file; when the user comes back after an idle/away stretch
 * that no other VS Code window covered, ask how to count it and log a time entry.
 */
export class AwayController implements vscode.Disposable {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly sub: vscode.Disposable;
  private readonly file: string;
  private readonly windowId = vscode.env.sessionId;

  constructor(private readonly db: Database, private readonly tracker: TimeTracker, storageDir: string) {
    this.file = path.join(storageDir, HEARTBEAT_FILE);
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.sub = tracker.onAwayEnded((start, end) => void this.onReturn(start, end));
  }

  private static config() {
    const c = vscode.workspace.getConfiguration('aiEffortTracker');
    const num = (k: string, d: number) => { const v = c.get<number>(k); return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d; };
    return {
      prompt: c.get<boolean>('away.prompt') ?? true,
      minMs: num('away.minMinutes', 15) * 60_000,
      maxMs: num('away.maxMinutes', 240) * 60_000
    };
  }

  private read() {
    try { return parseHeartbeats(fs.readFileSync(this.file, 'utf8')); } catch { return parseHeartbeats(null); }
  }

  private beat(): void {
    if (this.tracker.getMode() === 'idle') return;
    const now = Date.now();
    try {
      atomicWrite(this.file, JSON.stringify(addBeat(this.read(), this.windowId, now - BEAT_MS, now)));
    } catch (error) {
      console.error('AI Effort Tracker: heartbeat write failed', error);
    }
  }

  private async onReturn(start: number, end: number): Promise<void> {
    const cfg = AwayController.config();
    if (!cfg.prompt) return;
    const period = awayPeriod(start, end, otherWindowsActivity(this.read(), this.windowId), cfg);
    if (!period) return;
    const pick = await vscode.window.showInformationMessage(
      `AI Effort Tracker: you were away ${describeAway(period)}. Count it as?`, MEETING, REVIEW, OTHER, SKIP);
    if (pick === MEETING) this.log(period, 'reviewing', 'other', 'Meeting (away)');
    else if (pick === REVIEW) this.log(period, 'reviewing', undefined, 'Review / thinking (away)');
    else if (pick === OTHER) await this.logOther(period);
  }

  private log(p: AwayPeriod, mode: 'reviewing' | 'humanCoding', category: TimeEntryCategory | undefined, note: string, workItemId?: string): void {
    const branch = workItemId ? undefined : this.tracker.getBranch();
    const wi = workItemId ?? (branch ? this.db.getWorkItemForBranch(branch) ?? undefined : undefined);
    this.db.addTimeEntry({
      ...(branch ? { branch } : {}),
      ...(wi ? { workItemId: wi } : {}),
      startTs: p.start,
      endTs: p.end,
      durationMs: p.durationMs,
      mode,
      ...(category ? { category } : {}),
      note
    });
    const target = wi ? `#${wi}` : branch ?? 'the current branch';
    void vscode.window.showInformationMessage(`AI Effort Tracker: logged ${Math.round(p.durationMs / 60_000)} min to ${target}.`);
  }

  private async logOther(p: AwayPeriod): Promise<void> {
    const current = this.db.getWorkItemForBranch(this.tracker.getBranch());
    const items = this.db.getAllWorkItems()
      .filter(w => w.id !== '__unassigned__')
      .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
    const wi = await vscode.window.showQuickPick(
      items.map(w => ({ label: '#' + w.id, description: w.title ?? undefined, detail: w.id === current ? 'current branch' : undefined, id: w.id })),
      { placeHolder: `Which work item were you working on (${describeAway(p)})?` });
    if (!wi) return;
    const cat = await vscode.window.showQuickPick([...TIME_ENTRY_CATEGORIES], { placeHolder: 'Category' });
    if (!cat) return;
    this.log(p, 'humanCoding', cat as TimeEntryCategory, 'Other work (away)', wi.id);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sub.dispose();
  }
}
