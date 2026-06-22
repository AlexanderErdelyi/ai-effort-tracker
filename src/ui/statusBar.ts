import * as vscode from 'vscode';
import type { TrackingMode } from '../trackers/timeTracker';

const ICONS: Record<TrackingMode, string> = {
  humanCoding: '⌨️',
  aiGenerating: '🤖',
  reviewing: '👀',
  idle: '☕'
};

const LABELS: Record<TrackingMode, string> = {
  humanCoding: 'Coding',
  aiGenerating: 'AI Gen',
  reviewing: 'Reviewing',
  idle: 'Idle'
};

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private todayItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'aiEffortTracker.setMode';
    this.item.tooltip = 'AI Effort Tracker — click to switch mode';
    this.item.show();

    this.todayItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.todayItem.command = 'aiEffortTracker.showSummary';
    this.todayItem.tooltip = "Today's active time and daily goal — click for dashboard";
    this.todayItem.show();

    this.update('idle', 0, 0);
    this.updateToday(0, 240);
  }

  update(mode: TrackingMode, linesHuman: number, linesAi: number) {
    this.item.text = `${ICONS[mode]} ${LABELS[mode]}`;
    if (linesHuman + linesAi > 0) {
      const aiPct = Math.round((linesAi / (linesHuman + linesAi)) * 100);
      this.item.text += `  AI ${aiPct}%`;
    }
  }

  /** Shows today's active time and progress toward the daily goal. */
  updateToday(activeMs: number, goalMinutes: number) {
    const min = Math.floor(activeMs / 60000);
    const h = Math.floor(min / 60);
    const label = h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
    const goal = Math.max(1, goalMinutes);
    const pct = Math.min(999, Math.round((min / goal) * 100));
    const check = pct >= 100 ? ' $(check)' : '';
    this.todayItem.text = `$(watch) ${label} · ${pct}%${check}`;
    this.todayItem.tooltip = `Today: ${label} active · ${pct}% of ${goal}m goal`;
  }

  dispose() {
    this.item.dispose();
    this.todayItem.dispose();
  }
}
