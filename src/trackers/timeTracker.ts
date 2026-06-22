import * as vscode from 'vscode';
import { Database } from '../store/database';
import { StatusBarManager } from '../ui/statusBar';

export type TrackingMode = 'humanCoding' | 'aiGenerating' | 'reviewing' | 'idle';

const TICK_MS = 1000;
// Ignore gaps larger than this between ticks (machine sleep, debugger pause,
// extension host stall) so we never attribute hours of phantom time.
const MAX_TICK_GAP_MS = 6000;
// A continuous active streak of at least this long is recorded as a focus session.
const MIN_FOCUS_MS = 60_000;

/**
 * Heartbeat-based tracker. A single 1s ticker accrues elapsed time into the
 * current mode and then re-derives the mode from recent-activity timestamps
 * plus the VS Code window focus state. This means:
 *   - While the window is focused, you are never "idle" until a real pause.
 *   - While Copilot / an agent is writing files, mode = aiGenerating.
 *   - Watching the chat panel (focused, no edits) counts as reviewing.
 */
export class TimeTracker implements vscode.Disposable {
  private mode: TrackingMode = 'idle';
  private isTracking = false;
  private disposables: vscode.Disposable[] = [];
  private currentBranch: string = 'unknown';

  private ticker: NodeJS.Timeout | undefined;
  private lastTickAt = Date.now();
  private lastEditAt = 0;     // last human keystroke / edit
  private lastAiAt = 0;       // last AI / agent write or inline accept
  private lastActivityAt = 0; // any interaction: edit, selection, focus regained
  private focused = true;
  private manualUntil = 0;    // manual override expiry timestamp

  // Continuous active-work streak → recorded as a "focus session" when it ends.
  private focusMs = 0;
  private focusHumanMs = 0;
  private focusAiMs = 0;
  private statusTick = 0;

  constructor(private db: Database, private statusBar: StatusBarManager) {}

  private cfg() {
    const c = vscode.workspace.getConfiguration('aiEffortTracker');
    return {
      aiActiveMs: (c.get<number>('aiActiveSeconds') ?? 5) * 1000,
      codingActiveMs: (c.get<number>('codingActiveSeconds') ?? 5) * 1000,
      reviewIdleMs: (c.get<number>('idleThresholdSeconds') ?? 120) * 1000,
    };
  }

  startTracking() {
    if (this.isTracking) return;
    this.isTracking = true;
    const now = Date.now();
    this.focused = vscode.window.state.focused;
    this.lastTickAt = now;
    this.lastActivityAt = now;
    this.mode = this.focused ? 'reviewing' : 'idle';
    this.statusBar.update(this.mode, 0, 0);

    this.disposables.push(
      vscode.window.onDidChangeWindowState(s => {
        this.focused = s.focused;
        if (s.focused) this.lastActivityAt = Date.now();
      }),
      // Clicks, cursor moves, keyboard navigation (selection changes).
      vscode.window.onDidChangeTextEditorSelection(() => { this.markActivity(); }),
      // Scrolling through code — the key "reading / reviewing" signal.
      vscode.window.onDidChangeTextEditorVisibleRanges(() => { this.markActivity(); }),
      // Switching files / split editors / opening-closing tabs.
      vscode.window.onDidChangeActiveTextEditor(() => { this.markActivity(); }),
      vscode.window.onDidChangeVisibleTextEditors(() => { this.markActivity(); }),
      vscode.window.onDidChangeTextEditorViewColumn(() => { this.markActivity(); }),
      // Working in the integrated terminal.
      vscode.window.onDidChangeActiveTerminal(() => { this.markActivity(); }),
      vscode.window.onDidOpenTerminal(() => { this.markActivity(); }),
      // Editing documents (also drives human/AI split via CopilotTracker.markEdit).
      vscode.workspace.onDidChangeTextDocument(() => { this.markActivity(); })
    );

    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  stopTracking() {
    if (!this.isTracking) return;
    this.tick(); // final accrual
    this.endFocusSession(); // persist any in-progress focus streak
    this.isTracking = false;
    if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.statusBar.update('idle', 0, 0);
  }

  /** Called by CopilotTracker for each document edit, pre-classified. */
  markEdit(source: 'human' | 'ai') {
    const now = Date.now();
    this.lastActivityAt = now;
    if (source === 'ai') this.lastAiAt = now; else this.lastEditAt = now;
  }

  /** Any non-edit interaction in VS Code (click, scroll, file switch, terminal). */
  private markActivity() {
    this.lastActivityAt = Date.now();
  }

  setMode(mode: TrackingMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.statusBar.update(mode, 0, 0);
  }

  /** Manual override — locks mode for 60s so auto-detection doesn't flip it back. */
  setModeManual(mode: TrackingMode) {
    this.manualUntil = Date.now() + 60_000;
    this.setMode(mode);
  }

  /** Back-compat hook: nudge AI activity (used if anything signals AI generation). */
  setAiGenerating(active: boolean) {
    if (active) this.lastAiAt = Date.now();
  }

  setBranch(branch: string) {
    this.currentBranch = branch;
  }

  getMode(): TrackingMode { return this.mode; }
  getBranch(): string { return this.currentBranch; }

  private tick() {
    if (!this.isTracking) return;
    const now = Date.now();
    const delta = now - this.lastTickAt;
    this.lastTickAt = now;
    if (delta > 0 && delta <= MAX_TICK_GAP_MS) {
      this.db.recordTime(this.currentBranch, this.mode, delta);
      this.accrueFocus(this.mode, delta);
    } else if (delta > MAX_TICK_GAP_MS) {
      // A long gap (sleep / stall) breaks the current focus streak.
      this.endFocusSession();
    }
    this.setMode(this.computeMode(now));

    // Refresh the "today / goal" status bar item every ~5s (cheap aggregation).
    if (++this.statusTick % 5 === 0) {
      const goal = vscode.workspace.getConfiguration('aiEffortTracker').get<number>('dailyActiveGoalMinutes') ?? 240;
      this.statusBar.updateToday(this.db.getTodayActiveMs(), goal);
    }
  }

  /** Accrue continuous active time; flush a focus session when work pauses. */
  private accrueFocus(mode: TrackingMode, delta: number) {
    if (mode === 'idle') {
      this.endFocusSession();
      return;
    }
    this.focusMs += delta;
    if (mode === 'humanCoding') this.focusHumanMs += delta;
    else if (mode === 'aiGenerating') this.focusAiMs += delta;
  }

  private endFocusSession() {
    if (this.focusMs >= MIN_FOCUS_MS) {
      this.db.recordFocusSession(this.currentBranch, this.focusMs, this.focusHumanMs, this.focusAiMs);
    }
    this.focusMs = 0;
    this.focusHumanMs = 0;
    this.focusAiMs = 0;
  }

  private computeMode(now: number): TrackingMode {
    if (now < this.manualUntil) return this.mode;
    const { aiActiveMs, codingActiveMs, reviewIdleMs } = this.cfg();
    if (!this.focused) return 'idle';
    if (now - this.lastAiAt < aiActiveMs) return 'aiGenerating';
    if (now - this.lastEditAt < codingActiveMs) return 'humanCoding';
    if (now - this.lastActivityAt < reviewIdleMs) return 'reviewing';
    return 'idle';
  }

  dispose() {
    this.stopTracking();
  }
}
