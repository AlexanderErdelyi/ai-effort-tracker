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

interface InsightsConfig {
  baselineLocPerMinute: number;
  hourlyRateUsd: number;
  usdPerCredit: number;
  dailyActiveGoalMinutes: number;
}

function getInsightsConfig(): InsightsConfig {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  return {
    baselineLocPerMinute: c.get<number>('baselineLocPerMinute') ?? 5,
    hourlyRateUsd: c.get<number>('hourlyRateUsd') ?? 80,
    usdPerCredit: c.get<number>('usdPerCredit') ?? 0.04,
    dailyActiveGoalMinutes: c.get<number>('dailyActiveGoalMinutes') ?? 240,
  };
}

/** Bundle of time-series analytics (daily trend, heatmap, focus) for the dashboard. */
function getAnalytics() {
  const goal = getInsightsConfig().dailyActiveGoalMinutes;
  return {
    daily: db.getDailySeries(90),
    heatmap: db.getHourHeatmap(),
    focus: db.getFocusStats(goal),
    streak: db.getStreak(),
    week: db.getWeekComparison(),
    todayActiveMs: db.getTodayActiveMs(),
    topFiles: db.getTopFiles(12),
    timeline: db.getTodayTimeline(),
  };
}

const KNOWN_MODELS = [
  'Claude Opus 4.8', 'Claude Sonnet 4.6', 'GPT-5', 'GPT-4o',
  'o1', 'Gemini 2.5 Pro', 'Other'
];

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
    vscode.commands.registerCommand('aiEffortTracker.logCredits', async () => {
      const branch = await GitTracker.getCurrentBranch() ?? timeTracker.getBranch();
      const model = await vscode.window.showQuickPick(KNOWN_MODELS, {
        placeHolder: 'Which model did you use?'
      });
      if (!model) return;
      const input = await vscode.window.showInputBox({
        prompt: `Credits used on "${branch}" with ${model} (number shown in the chat response)`,
        placeHolder: 'e.g. 272.3',
        validateInput: v => (v && !isNaN(parseFloat(v))) ? null : 'Enter a number'
      });
      if (input == null) return;
      const credits = parseFloat(input);
      db.recordCredits(branch, model, credits);
      vscode.window.showInformationMessage(
        `Logged ${credits} credits (${model}) on ${branch}.`
      );
      refreshDashboard();
    }),
    vscode.commands.registerCommand('aiEffortTracker.logChatTurn', async () => {
      const branch = await GitTracker.getCurrentBranch() ?? timeTracker.getBranch();
      db.recordChatTurn(branch);
      refreshDashboard();
    }),
    vscode.commands.registerCommand('aiEffortTracker.weeklyReport', () => generateWeeklyReport(db)),
    vscode.commands.registerCommand('aiEffortTracker.exportCsv', () => exportCsv(db)),
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
  db?.flushSync();
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
  dashboardPanel.webview.html = renderDashboardHtml(db.getAllBranchesSummaries(), branch, nonce, ghMetrics, getInsightsConfig(), getAnalytics());

  dashboardPanel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === 'cmd' && m.value) {
      await vscode.commands.executeCommand('aiEffortTracker.' + m.value);
      refreshDashboard();
    }
  });

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
      ghMetrics: ghData,
      config: getInsightsConfig(),
      analytics: getAnalytics()
    });
  }, 5000);

  dashboardPanel.onDidDispose(() => {
    clearInterval(refreshInterval);
    dashboardPanel = undefined;
  });
}

/** Push an immediate refresh to the dashboard (e.g. after logging credits). */
function refreshDashboard() {
  if (!dashboardPanel) return;
  GitTracker.getCurrentBranch().then(b => {
    dashboardPanel?.webview.postMessage({
      type: 'update',
      summaries: db.getAllBranchesSummaries(),
      currentBranch: b ?? 'unknown',
      config: getInsightsConfig(),
      analytics: getAnalytics()
    });
  });
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function pctDelta(now: number, prev: number): string {
  if (prev === 0) return now > 0 ? '▲ new' : '–';
  const d = ((now - prev) / prev) * 100;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
  return `${arrow} ${Math.abs(d).toFixed(0)}%`;
}

async function generateWeeklyReport(db: Database) {
  const w = db.getWeekComparison();
  const focus = db.getFocusStats(getInsightsConfig().dailyActiveGoalMinutes);
  const streak = db.getStreak();
  const series = db.getDailySeries(7);
  const summaries = db.getAllBranchesSummaries();
  const cfg = getInsightsConfig();

  const totLinesAi = summaries.reduce((a, s) => a + s.linesAiAdded, 0);
  const totLinesHuman = summaries.reduce((a, s) => a + s.linesHumanAdded, 0);
  const credits = summaries.reduce((a, s) => a + (s.creditsTotal || 0), 0);

  const lines: string[] = [];
  lines.push('# AI Effort Tracker — Weekly Report');
  lines.push('');
  lines.push(`_Generated ${new Date().toLocaleString()}_`);
  lines.push('');
  lines.push('## This Week vs Last Week');
  lines.push('');
  lines.push('| Metric | This Week | Last Week | Change |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| Active time | ${fmtDuration(w.thisWeek.activeMs)} | ${fmtDuration(w.lastWeek.activeMs)} | ${pctDelta(w.thisWeek.activeMs, w.lastWeek.activeMs)} |`);
  lines.push(`| Lines written | ${w.thisWeek.lines} | ${w.lastWeek.lines} | ${pctDelta(w.thisWeek.lines, w.lastWeek.lines)} |`);
  lines.push(`| AI share | ${w.thisWeek.aiShare.toFixed(0)}% | ${w.lastWeek.aiShare.toFixed(0)}% | ${pctDelta(w.thisWeek.aiShare, w.lastWeek.aiShare)} |`);
  lines.push('');
  lines.push('## Focus & Consistency');
  lines.push('');
  lines.push(`- **Coding streak:** ${streak.current} day(s) (longest ${streak.longest})`);
  lines.push(`- **Focus this week:** ${fmtDuration(focus.totalFocusMsWeek)} across ${focus.sessionsWeek} session(s)`);
  lines.push(`- **Longest focus session:** ${fmtDuration(focus.longestMs)}`);
  lines.push('');
  lines.push('## Daily Active Time (last 7 days)');
  lines.push('');
  lines.push('| Day | Active | Lines | AI % |');
  lines.push('| --- | --- | --- | --- |');
  for (const d of series) {
    const active = d.humanCoding + d.aiGenerating + d.reviewing;
    const lns = d.linesHuman + d.linesAi;
    const ai = lns > 0 ? Math.round((d.linesAi / lns) * 100) : 0;
    lines.push(`| ${d.date} | ${fmtDuration(active)} | ${lns} | ${ai}% |`);
  }
  lines.push('');
  lines.push('## AI Contribution');
  lines.push('');
  const totLines = totLinesAi + totLinesHuman;
  const aiShareAll = totLines > 0 ? Math.round((totLinesAi / totLines) * 100) : 0;
  lines.push(`- **AI-written lines (all time):** ${totLinesAi} (${aiShareAll}% of ${totLines})`);
  lines.push(`- **Human-written lines (all time):** ${totLinesHuman}`);
  lines.push(`- **Credits logged:** ${credits.toFixed(1)} (~$${(credits * cfg.usdPerCredit).toFixed(2)})`);
  lines.push('');

  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(doc);
}

async function exportCsv(db: Database) {
  const series = db.getDailySeries(90);
  const rows = ['date,human_ms,ai_ms,review_ms,idle_ms,active_ms,lines_human,lines_ai,ai_share_pct'];
  for (const d of series) {
    const active = d.humanCoding + d.aiGenerating + d.reviewing;
    const lns = d.linesHuman + d.linesAi;
    const ai = lns > 0 ? ((d.linesAi / lns) * 100).toFixed(1) : '0';
    rows.push([d.date, d.humanCoding, d.aiGenerating, d.reviewing, d.idle, active, d.linesHuman, d.linesAi, ai].join(','));
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file('ai-effort-daily.csv'),
    filters: { CSV: ['csv'] }
  });
  if (uri) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(rows.join('\n'), 'utf8'));
    vscode.window.showInformationMessage(`Daily activity exported to ${uri.fsPath}`);
  }
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


