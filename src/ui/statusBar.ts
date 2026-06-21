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

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'aiEffortTracker.setMode';
    this.item.tooltip = 'AI Effort Tracker — click to switch mode';
    this.item.show();
    this.update('idle', 0, 0);
  }

  update(mode: TrackingMode, linesHuman: number, linesAi: number) {
    this.item.text = `${ICONS[mode]} ${LABELS[mode]}`;
    if (linesHuman + linesAi > 0) {
      const aiPct = Math.round((linesAi / (linesHuman + linesAi)) * 100);
      this.item.text += `  AI ${aiPct}%`;
    }
  }

  dispose() {
    this.item.dispose();
  }
}
