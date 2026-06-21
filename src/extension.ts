import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TimeTracker } from './trackers/timeTracker';
import { GitTracker } from './trackers/gitTracker';
import { CopilotTracker } from './trackers/copilotTracker';
import { Database } from './store/database';
import { StatusBarManager } from './ui/statusBar';
import { renderDashboardHtml } from './ui/dashboard';
import { GitHubService } from './services/githubService';

let timeTracker: TimeTracker;
let gitTracker: GitTracker;
let copilotTracker: CopilotTracker;
let db: Database;
let statusBar: StatusBarManager;
let dashboardPanel: vscode.WebviewPanel | undefined;
const ghService = new GitHubService();

export function activate(context: vscode.ExtensionContext) {
  db = new Database(context.globalStorageUri.fsPath);
  statusBar = new StatusBarManager();
  timeTracker = new TimeTracker(db, statusBar);
  gitTracker = new GitTracker(db, timeTracker);
  copilotTracker = new CopilotTracker(db, timeTracker);

  context.subscriptions.push(
    vscode.commands.registerCommand('aiEffortTracker.showSummary', () =>
      openDashboard(db, timeTracker, context)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setMode', async () => {
      type ModeItem = vscode.QuickPickItem & { mode: 'humanCoding' | 'aiGenerating' | 'reviewing' | 'idle' };
      const items: ModeItem[] = [
        { label: 'Coding',    description: 'Human coding — typing, editing',  mode: 'humanCoding'  },
        { label: 'AI Gen',    description: 'AI is generating code',            mode: 'aiGenerating' },
        { label: 'Reviewing', description: 'Reading, reviewing, navigating',   mode: 'reviewing'    },
        { label: 'Idle',      description: 'Away / taking a break',            mode: 'idle'         },
      ];
      const cur = items.find(i => i.mode === timeTracker.getMode());
      if (cur) { cur.label = '▶ ' + cur.label; cur.description += ' (current)'; }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Switch tracking mode' });
      if (picked) {
        timeTracker.setModeManual(picked.mode);
        vscode.window.showInformationMessage(`AI Effort Tracker: mode set to ${picked.mode}`);
      }
    }),
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

async function openDashboard(db: Database, tracker: TimeTracker, context: vscode.ExtensionContext) {
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  dashboardPanel = vscode.window.createWebviewPanel(
    'aiEffortTracker',
    'AI Effort Tracker',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const branch = await GitTracker.getCurrentBranch() ?? 'unknown';
  let ghMetrics = null;
  try { ghMetrics = await ghService.getCopilotMetrics(); } catch { /* ignore */ }
  dashboardPanel.webview.html = renderDashboardHtml(db.getAllBranchesSummaries(), branch, nonce, ghMetrics);

  // Push live updates every 5 seconds; refresh GitHub metrics every 5 minutes
  let lastGhFetch = Date.now();
  const refreshInterval = setInterval(async () => {
    if (!dashboardPanel) { clearInterval(refreshInterval); return; }
    const currentBranch = await GitTracker.getCurrentBranch() ?? 'unknown';

    let ghData = ghMetrics;
    if (Date.now() - lastGhFetch > 5 * 60 * 1000) {
      try { ghData = await ghService.getCopilotMetrics(true); } catch { /* ignore */ }
      lastGhFetch = Date.now();
    }

    dashboardPanel.webview.postMessage({
      type: 'update',
      summaries: db.getAllBranchesSummaries(),
      currentBranch,
      ghMetrics: ghData
    });
  }, 5000);

  dashboardPanel.onDidDispose(() => {
    clearInterval(refreshInterval);
    dashboardPanel = undefined;
  });
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


