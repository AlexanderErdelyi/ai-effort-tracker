import * as vscode from 'vscode';
import { Database } from '../store/database';
import { StatusBarManager } from '../ui/statusBar';

export type TrackingMode = 'humanCoding' | 'aiGenerating' | 'reviewing' | 'idle';

const TICK_MS = 1000;
// Ignore gaps larger than this between ticks (machine sleep, debugger pause,
// extension host stall) so we never attribute hours of phantom time.
const MAX_TICK_GAP_MS = 6000;

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
      vscode.window.onDidChangeTextEditorSelection(() => { this.lastActivityAt = Date.now(); }),
      vscode.window.onDidChangeActiveTextEditor(() => { this.lastActivityAt = Date.now(); })
    );

    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  stopTracking() {
    if (!this.isTracking) return;
    this.tick(); // final accrual
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
    }
    this.setMode(this.computeMode(now));
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
