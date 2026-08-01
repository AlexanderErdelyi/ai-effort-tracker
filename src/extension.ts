import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TimeTracker } from './trackers/timeTracker';
import { GitTracker } from './trackers/gitTracker';
import { CopilotTracker } from './trackers/copilotTracker';
import { ChatUsageTracker } from './trackers/chatUsageTracker';
import { Database } from './store/database';
import type { EstimateBreakdown, EstimateUnit } from './store/database';
import { CATEGORY_LABELS } from './util/fileTypes';
import type { FileCategory } from './util/fileTypes';
import { StatusBarManager } from './ui/statusBar';
import { renderDashboardHtml } from './ui/dashboard';
import { GitHubService, BillingUsage } from './services/githubService';

let timeTracker: TimeTracker;
let gitTracker: GitTracker;
let copilotTracker: CopilotTracker;
let chatUsageTracker: ChatUsageTracker;
let db: Database;
let statusBar: StatusBarManager;
let dashboardPanel: vscode.WebviewPanel | undefined;
let lastBilling: BillingUsage | null = null;
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
  chatUsageTracker = new ChatUsageTracker(db, timeTracker, context.logUri);

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
      // Lower-friction manual entry: default to the model/value you used last.
      const lastModel = context.globalState.get<string>('lastCreditModel');
      const lastCredits = context.globalState.get<number>('lastCreditValue');
      const ordered = lastModel
        ? [lastModel, ...KNOWN_MODELS.filter(m => m !== lastModel)]
        : KNOWN_MODELS;
      const model = await vscode.window.showQuickPick(ordered, {
        placeHolder: lastModel ? `Which model? (last: ${lastModel})` : 'Which model did you use?'
      });
      if (!model) return;
      const input = await vscode.window.showInputBox({
        prompt: `Credits used on "${branch}" with ${model} (number shown in the chat response)`,
        placeHolder: 'e.g. 272.3',
        value: lastCredits != null ? String(lastCredits) : undefined,
        validateInput: v => (v && !isNaN(parseFloat(v))) ? null : 'Enter a number'
      });
      if (input == null) return;
      const credits = parseFloat(input);
      db.recordCredits(branch, model, credits);
      void context.globalState.update('lastCreditModel', model);
      void context.globalState.update('lastCreditValue', credits);
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
    vscode.commands.registerCommand('aiEffortTracker.assignBranchToWorkItem', () =>
      assignBranchToWorkItem()
    ),
    // Reassignment is the same manual-override flow, framed as moving an
    // already-mapped branch to a different work item (issue #10).
    vscode.commands.registerCommand('aiEffortTracker.reassignBranch', () =>
      assignBranchToWorkItem()
    ),
    vscode.commands.registerCommand('aiEffortTracker.setWorkItemEstimate', () =>
      setWorkItemEstimate()
    ),
    vscode.commands.registerCommand('aiEffortTracker.setProjectRates', () =>
      setProjectRates()
    ),
    vscode.commands.registerCommand('aiEffortTracker.weeklyReport', () => generateWeeklyReport(db)),
    vscode.commands.registerCommand('aiEffortTracker.exportCsv', () => exportCsv(db)),
    vscode.commands.registerCommand('aiEffortTracker.importCredits', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Copilot premium-request usage…' },
        async () => {
          lastBilling = await ghService.getBillingUsage(true);
        }
      );
      if (lastBilling?.ok) {
        vscode.window.showInformationMessage(
          `Copilot usage (${lastBilling.period}, ${lastBilling.scope}): ${lastBilling.premiumRequests} premium requests · $${lastBilling.netUsd.toFixed(2)} net.`
        );
      } else if (lastBilling?.error === 'no-token') {
        vscode.window.showWarningMessage('No GitHub token. Set aiEffortTracker.githubToken or sign in to GitHub in VS Code.');
      } else if (lastBilling?.error === 'no-copilot') {
        vscode.window.showInformationMessage('No Copilot premium-request usage found for this billing period.');
      } else {
        vscode.window.showErrorMessage('Could not fetch Copilot usage. ' + (lastBilling?.errorDetail ?? ''));
      }
      refreshDashboard();
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
    chatUsageTracker,
    statusBar
  );

  timeTracker.startTracking();
  gitTracker.start(context);
  copilotTracker.start(context);
  chatUsageTracker.start(context);
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
  try { lastBilling = await ghService.getBillingUsage(); } catch { /* ignore */ }
  dashboardPanel.webview.html = renderDashboardHtml(db.getAllBranchesSummaries(), branch, nonce, ghMetrics, getInsightsConfig(), getAnalytics(), lastBilling);

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
      analytics: getAnalytics(),
      billing: lastBilling
    });
  }, 5000);

  dashboardPanel.onDidDispose(() => {
    clearInterval(refreshInterval);
    dashboardPanel = undefined;
  });
}

/**
 * Manually assign — or reassign — the CURRENT branch to a work item (issue #10).
 * Offers existing work items plus a "new work item" option, then applies a
 * sticky manual override that also moves the branch's accrued effort/credits to
 * the chosen work item. Works for detached-HEAD / `unknown` branches too, so a
 * mis-detected or unlabeled branch can be corrected after the fact.
 */
async function assignBranchToWorkItem() {
  const branch = await GitTracker.getCurrentBranch() ?? timeTracker.getBranch() ?? 'unknown';
  const current = db.getWorkItemForBranch(branch);
  type WiPick = vscode.QuickPickItem & { id?: string; create?: boolean };
  const picks: WiPick[] = db.getAllWorkItems().map(wi => ({
    label: (wi.id === current ? '\u25b6 ' : '') + '#' + wi.id,
    description: wi.title ?? undefined,
    detail: wi.id === current ? 'current mapping' : undefined,
    id: wi.id
  }));
  picks.push({ label: '$(add) New work item\u2026', create: true });
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: `Assign branch "${branch}" to a work item` + (current ? ` (current: #${current})` : '')
  });
  if (!picked) return;

  let workItemId: string;
  if (picked.create) {
    const id = await vscode.window.showInputBox({
      prompt: 'New work item id (e.g. 1234 or JIRA-42)',
      validateInput: v => (v && v.trim()) ? null : 'Enter a work item id'
    });
    if (!id) return;
    workItemId = id.trim();
    const title = await vscode.window.showInputBox({
      prompt: `Title for work item #${workItemId} (optional)`
    });
    db.reassignBranchToWorkItem(branch, workItemId);
    if (title && title.trim()) db.upsertWorkItem(workItemId, { title: title.trim() });
  } else {
    if (!picked.id) return;
    workItemId = picked.id;
    db.reassignBranchToWorkItem(branch, workItemId);
  }
  vscode.window.showInformationMessage(
    `Branch "${branch}" assigned to work item #${workItemId}.`
  );
  refreshDashboard();
}

/**
 * Enter a granular estimate for a work item (issue #16 / M3). Flow: pick a work
 * item (reusing the #10 QuickPick pattern) → choose a unit (hours/points) →
 * choose to enter a single TOTAL or a per-category breakdown. A per-category
 * breakdown is captured through a short sequence of input boxes for the four
 * primary categories (programming / specification / documentation / deployment);
 * a blank entry means "skip" (0). Persists via the store API and refreshes the
 * dashboard. Kept intentionally minimal — the estimate-vs-actual report UI is
 * milestone M7 (#28/#29).
 */
async function setWorkItemEstimate() {
  type WiPick = vscode.QuickPickItem & { id?: string; create?: boolean };
  const picks: WiPick[] = db.getAllWorkItems().map(wi => {
    const total = db.getWorkItemSummary(wi.id).estimate;
    const unit = wi.estimateUnit ?? 'hours';
    return {
      label: '#' + wi.id,
      description: wi.title ?? undefined,
      detail: total !== null ? `current estimate: ${total} ${unit}` : 'no estimate yet',
      id: wi.id
    };
  });
  picks.push({ label: '$(add) New work item\u2026', create: true });
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Set the estimate for which work item?'
  });
  if (!picked) return;

  let workItemId: string;
  if (picked.create) {
    const id = await vscode.window.showInputBox({
      prompt: 'New work item id (e.g. 1234 or JIRA-42)',
      validateInput: v => (v && v.trim()) ? null : 'Enter a work item id'
    });
    if (!id) return;
    workItemId = id.trim();
    db.upsertWorkItem(workItemId);
  } else {
    if (!picked.id) return;
    workItemId = picked.id;
  }

  const existingUnit = db.getWorkItem(workItemId)?.estimateUnit ?? 'hours';
  type UnitItem = vscode.QuickPickItem & { unit: EstimateUnit };
  const unitItems: UnitItem[] = [
    { label: 'Hours', unit: 'hours', description: existingUnit === 'hours' ? 'current' : undefined },
    { label: 'Story points', unit: 'points', description: existingUnit === 'points' ? 'current' : undefined }
  ];
  const unitPick = await vscode.window.showQuickPick(unitItems, {
    placeHolder: 'Estimate unit'
  });
  if (!unitPick) return;
  const unit = unitPick.unit;

  type ModePick = vscode.QuickPickItem & { mode: 'total' | 'breakdown' };
  const modePick = await vscode.window.showQuickPick<ModePick>(
    [
      { label: 'Single total', mode: 'total', detail: 'Enter one overall estimate' },
      { label: 'Per-category breakdown', mode: 'breakdown', detail: 'Programming / specification / documentation / deployment' }
    ],
    { placeHolder: 'How do you want to estimate?' }
  );
  if (!modePick) return;

  const parseNum = (v: string): string | null => {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? null : 'Enter a non-negative number';
  };

  if (modePick.mode === 'total') {
    const raw = await vscode.window.showInputBox({
      prompt: `Total estimate for #${workItemId} (${unit})`,
      value: db.getWorkItemSummary(workItemId).estimate?.toString() ?? '',
      validateInput: v => (v.trim() ? parseNum(v) : 'Enter a number')
    });
    if (raw === undefined) return;
    // Setting a scalar total clears any prior breakdown so the two never disagree.
    db.setEstimateBreakdown(workItemId, null);
    db.upsertWorkItem(workItemId, { estimate: Number(raw), estimateUnit: unit });
  } else {
    const categories: FileCategory[] = ['programming', 'specification', 'documentation', 'deployment'];
    const existing = db.getWorkItem(workItemId)?.estimateBreakdown;
    const breakdown: EstimateBreakdown = {};
    for (const cat of categories) {
      const raw = await vscode.window.showInputBox({
        prompt: `${CATEGORY_LABELS[cat]} estimate (${unit}) — blank to skip`,
        value: existing && typeof existing[cat] === 'number' ? String(existing[cat]) : '',
        validateInput: parseNum
      });
      if (raw === undefined) return; // user cancelled the whole flow
      if (raw.trim()) breakdown[cat] = Number(raw);
    }
    if (Object.keys(breakdown).length === 0) {
      vscode.window.showWarningMessage('No estimate entered — nothing changed.');
      return;
    }
    db.setEstimateBreakdown(workItemId, breakdown, unit);
  }

  const total = db.getWorkItemSummary(workItemId).estimate;
  vscode.window.showInformationMessage(
    `Estimate for #${workItemId} set to ${total} ${unit}.`
  );
  refreshDashboard();
}

/**
 * Set per-project ROI rates (issue #15 / M3): pick a project, then enter its
 * hourly COST, hourly SELL rate, currency, and credit cost. Blank leaves a field
 * unset so it inherits the global default (and, for cost/credit, the legacy
 * setting). Persists into `Project.settings` via {@link Database.upsertProject},
 * merging with any existing settings so unrelated keys survive. The full project
 * setup UI is #27; this is intentionally the command + persistence only.
 */
async function setProjectRates() {
  const projects = db.getAllProjects();
  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      'No projects yet. Projects are created when a repository is linked; rates can be set once a project exists.'
    );
    return;
  }

  type ProjPick = vscode.QuickPickItem & { id: string };
  const picks: ProjPick[] = projects.map(p => {
    const r = p.settings ?? {};
    const bits: string[] = [];
    if (typeof r.hourlyCostRate === 'number') bits.push(`cost ${r.hourlyCostRate}`);
    if (typeof r.hourlySellRate === 'number') bits.push(`sell ${r.hourlySellRate}`);
    return {
      label: p.name,
      description: p.repos.join(', ') || undefined,
      detail: bits.length ? `current: ${bits.join(' \u00b7 ')} ${r.currency ?? ''}`.trim() : 'no rates set',
      id: p.id
    };
  });
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Set rates for which project?'
  });
  if (!picked) return;

  const project = db.getProject(picked.id);
  const existing = project?.settings ?? {};

  // Blank input ⇒ leave the field unset (inherit global/legacy). Non-negative number otherwise.
  const numInput = async (
    prompt: string,
    current: unknown
  ): Promise<{ ok: boolean; value: number | undefined }> => {
    const raw = await vscode.window.showInputBox({
      prompt,
      value: typeof current === 'number' ? String(current) : '',
      validateInput: v => {
        if (!v.trim()) return null; // blank = inherit
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? null : 'Enter a non-negative number (or leave blank to inherit)';
      }
    });
    if (raw === undefined) return { ok: false, value: undefined };
    return { ok: true, value: raw.trim() ? Number(raw) : undefined };
  };

  const cost = await numInput(
    `Hourly COST for "${picked.label}" (what an hour costs) — blank to inherit default`,
    existing.hourlyCostRate
  );
  if (!cost.ok) return;
  const sell = await numInput(
    `Hourly SELL rate for "${picked.label}" (what an hour is billed for) — blank to inherit`,
    existing.hourlySellRate
  );
  if (!sell.ok) return;

  const currencyRaw = await vscode.window.showInputBox({
    prompt: `Currency for "${picked.label}" (e.g. USD, EUR) — blank to inherit`,
    value: typeof existing.currency === 'string' ? existing.currency : ''
  });
  if (currencyRaw === undefined) return;

  const creditCost = await numInput(
    `Credit cost for "${picked.label}" (money per 1 credit/premium request) — blank to inherit`,
    existing.creditCostPerUnit
  );
  if (!creditCost.ok) return;

  // Merge onto existing settings; assigning undefined clears an override.
  const settings = { ...existing };
  settings.hourlyCostRate = cost.value;
  settings.hourlySellRate = sell.value;
  settings.currency = currencyRaw.trim() ? currencyRaw.trim() : undefined;
  settings.creditCostPerUnit = creditCost.value;
  db.upsertProject({ id: picked.id, settings });

  const eff = db.getEffectiveRates(picked.id);
  const fmt = (n: number | null) => (n === null ? '\u2014' : String(n));
  vscode.window.showInformationMessage(
    `Rates for "${picked.label}" saved. Effective: cost ${fmt(eff.hourlyCostRate)}, ` +
    `sell ${fmt(eff.hourlySellRate)}, credit ${fmt(eff.creditCostPerUnit)} (${eff.currency}).`
  );
  refreshDashboard();
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
      analytics: getAnalytics(),
      billing: lastBilling
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


