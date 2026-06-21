import * as vscode from 'vscode';
import { Database } from '../store/database';
import { StatusBarManager } from '../ui/statusBar';

export type TrackingMode = 'humanCoding' | 'aiGenerating' | 'reviewing' | 'idle';

export class TimeTracker implements vscode.Disposable {
  private mode: TrackingMode = 'idle';
  private modeStartedAt: number = Date.now();
  private isTracking = false;
  private activityTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private currentBranch: string = 'unknown';

  constructor(private db: Database, private statusBar: StatusBarManager) {}

  startTracking() {
    if (this.isTracking) return;
    this.isTracking = true;
    this.setMode('humanCoding');

    const idleMs = (vscode.workspace.getConfiguration('aiEffortTracker').get<number>('idleThresholdSeconds') ?? 120) * 1000;
    const reviewMs = (vscode.workspace.getConfiguration('aiEffortTracker').get<number>('reviewThresholdSeconds') ?? 10) * 1000;

    // Keystroke / edit activity
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => this.onUserActivity('humanCoding', idleMs, reviewMs)),
      vscode.window.onDidChangeTextEditorSelection(() => this.onUserActivity('humanCoding', idleMs, reviewMs)),
      vscode.window.onDidChangeActiveTextEditor(() => this.onUserActivity('reviewing', idleMs, reviewMs))
    );
  }

  stopTracking() {
    if (!this.isTracking) return;
    this.flushCurrentMode();
    this.isTracking = false;
    clearTimeout(this.activityTimer);
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.statusBar.update('idle', 0, 0);
  }

  setMode(mode: TrackingMode) {
    if (mode === this.mode) return;
    this.flushCurrentMode();
    this.mode = mode;
    this.modeStartedAt = Date.now();
    this.statusBar.update(mode, 0, 0);
  }

  /** Manual override — locks mode for 60s so auto-detection doesn't immediately flip it back */
  setModeManual(mode: TrackingMode) {
    clearTimeout(this.activityTimer);
    this.flushCurrentMode();
    this.mode = mode;
    this.modeStartedAt = Date.now();
    this.statusBar.update(mode, 0, 0);
    // After 60s, resume normal auto-detection on next keystroke
    this.activityTimer = setTimeout(() => { /* no-op, just prevents auto-flip for 60s */ }, 60_000);
  }

  /** Called by CopilotTracker when AI generation starts/ends */
  setAiGenerating(active: boolean) {
    if (!this.isTracking) return;
    this.setMode(active ? 'aiGenerating' : 'reviewing');
  }

  setBranch(branch: string) {
    this.currentBranch = branch;
  }

  getMode(): TrackingMode { return this.mode; }
  getBranch(): string { return this.currentBranch; }

  private onUserActivity(intendedMode: TrackingMode, idleMs: number, reviewMs: number) {
    if (!this.isTracking) return;
    if (this.mode === 'aiGenerating') return; // don't interrupt AI mode on user scroll etc.

    if (intendedMode === 'humanCoding') {
      this.setMode('humanCoding');
    } else if (this.mode === 'idle') {
      this.setMode('reviewing');
    }

    clearTimeout(this.activityTimer);
    // After reviewMs of no keystrokes, switch to reviewing
    this.activityTimer = setTimeout(() => {
      if (this.mode === 'humanCoding') this.setMode('reviewing');
      // After idleMs total, switch to idle
      setTimeout(() => {
        if (this.mode === 'reviewing') this.setMode('idle');
      }, idleMs - reviewMs);
    }, reviewMs);
  }

  private flushCurrentMode() {
    const durationMs = Date.now() - this.modeStartedAt;
    if (durationMs < 500) return; // ignore sub-second blips
    this.db.recordTime(this.currentBranch, this.mode, durationMs);
  }

  dispose() {
    this.stopTracking();
  }
}
