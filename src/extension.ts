import * as vscode from 'vscode';
import { TimeTracker } from './trackers/timeTracker';
import { GitTracker } from './trackers/gitTracker';
import { CopilotTracker } from './trackers/copilotTracker';
import { Database } from './store/database';
import { StatusBarManager } from './ui/statusBar';

let timeTracker: TimeTracker;
let gitTracker: GitTracker;
let copilotTracker: CopilotTracker;
let db: Database;
let statusBar: StatusBarManager;

export function activate(context: vscode.ExtensionContext) {
  db = new Database(context.globalStorageUri.fsPath);
  statusBar = new StatusBarManager();
  timeTracker = new TimeTracker(db, statusBar);
  gitTracker = new GitTracker(db, timeTracker);
  copilotTracker = new CopilotTracker(db, timeTracker);

  context.subscriptions.push(
    vscode.commands.registerCommand('aiEffortTracker.showSummary', () =>
      showSummary(db, timeTracker)
    ),
    vscode.commands.registerCommand('aiEffortTracker.startSession', () => {
      timeTracker.startTracking();
      vscode.window.showInformationMessage('AI Effort Tracker: Tracking started.');
    }),
    vscode.commands.registerCommand('aiEffortTracker.stopSession', () => {
      timeTracker.stopTracking();
      vscode.window.showInformationMessage('AI Effort Tracker: Tracking stopped.');
    }),
    vscode.commands.registerCommand('aiEffortTracker.exportReport', () =>
      exportReport(db, timeTracker)
    ),
    timeTracker,
    gitTracker,
    copilotTracker,
    statusBar
  );

  timeTracker.startTracking();
  gitTracker.start(context);
  copilotTracker.start(context);
}

export function deactivate() {
  timeTracker?.stopTracking();
}

async function showSummary(db: Database, tracker: TimeTracker) {
  const branch = await GitTracker.getCurrentBranch();
  const summary = db.getSummaryForBranch(branch ?? 'unknown');

  const panel = vscode.window.createWebviewPanel(
    'aiEffortTracker',
    `Effort Summary: ${branch ?? 'unknown'}`,
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  panel.webview.html = renderSummaryHtml(summary, branch ?? 'unknown');
}

async function exportReport(db: Database, tracker: TimeTracker) {
  const branch = await GitTracker.getCurrentBranch();
  const summary = db.getSummaryForBranch(branch ?? 'unknown');
  const json = JSON.stringify(summary, null, 2);

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`effort-report-${branch ?? 'unknown'}.json`),
    filters: { JSON: ['json'] }
  });
  if (uri) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
    vscode.window.showInformationMessage(`Report saved to ${uri.fsPath}`);
  }
}

function renderSummaryHtml(summary: ReturnType<Database['getSummaryForBranch']>, branch: string): string {
  const fmt = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}h ${m}m ${s}s`;
  };

  const totalMs = summary.humanCodingMs + summary.aiGeneratingMs + summary.reviewingMs;
  const pct = (ms: number) => totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : '0.0';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  h1 { font-size: 1.4em; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  th { background: var(--vscode-editor-lineHighlightBackground); }
  .cost { color: var(--vscode-charts-yellow); font-weight: bold; }
</style></head>
<body>
  <h1>📊 Effort Summary — <code>${branch}</code></h1>
  <p>Work Item: <strong>${summary.workItemId ?? 'n/a'}</strong></p>
  <table>
    <tr><th>Mode</th><th>Duration</th><th>%</th></tr>
    <tr><td>⌨️ Human Coding</td><td>${fmt(summary.humanCodingMs)}</td><td>${pct(summary.humanCodingMs)}%</td></tr>
    <tr><td>🤖 AI Generating</td><td>${fmt(summary.aiGeneratingMs)}</td><td>${pct(summary.aiGeneratingMs)}%</td></tr>
    <tr><td>👀 Reviewing</td><td>${fmt(summary.reviewingMs)}</td><td>${pct(summary.reviewingMs)}%</td></tr>
    <tr><td>☕ Idle</td><td>${fmt(summary.idleMs)}</td><td>—</td></tr>
  </table>
  <table style="margin-top:16px">
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Lines Human</td><td>${summary.linesHuman}</td></tr>
    <tr><td>Lines AI (Copilot)</td><td>${summary.linesAi}</td></tr>
    <tr><td>AI %</td><td>${summary.linesHuman + summary.linesAi > 0 ? ((summary.linesAi / (summary.linesHuman + summary.linesAi)) * 100).toFixed(1) : 0}%</td></tr>
    <tr><td>Copilot Completions Accepted</td><td>${summary.copilotAcceptances}</td></tr>
    <tr><td class="cost">Estimated AI Cost</td><td class="cost">$${summary.estimatedCostUsd.toFixed(4)}</td></tr>
  </table>
</body></html>`;
}
