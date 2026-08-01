import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TimeTracker } from './trackers/timeTracker';
import { GitTracker } from './trackers/gitTracker';
import { CopilotTracker } from './trackers/copilotTracker';
import { ChatUsageTracker } from './trackers/chatUsageTracker';
import { Database } from './store/database';
import { UNASSIGNED_WORK_ITEM_ID } from './store/database';
import type { EstimateBreakdown, EstimateUnit, LedgerEntry, LedgerEntryPatch } from './store/database';
import type { ManualEffortEntry, ManualEffortInput, ManualEffortPatch } from './store/database';
import { CATEGORY_LABELS, ALL_CATEGORIES } from './util/fileTypes';
import type { FileCategory } from './util/fileTypes';
import type { TrackingMode } from './trackers/timeTracker';
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
      // Optional free-text note (issue #19). Empty = no note.
      const note = await vscode.window.showInputBox({
        prompt: 'Note for this entry (optional)',
        placeHolder: 'e.g. refactor pass, missed by auto-capture'
      });
      if (note === undefined) return;
      // Optional work-item override (issue #19). Default: attribute via the
      // branch's current mapping (what recordCredits does on its own).
      const wiOverride = await pickWorkItemOverride(
        'Attribute to a work item?',
        `$(check) Use branch mapping${db.getWorkItemForBranch(branch) ? ' (#' + db.getWorkItemForBranch(branch) + ')' : ''}`,
        db.getWorkItemForBranch(branch)
      );
      if (wiOverride === CANCELLED) return;
      // Optional timestamp override (issue #19). Blank = now.
      const ts = await promptTimestamp('When did this happen? (blank = now)', Date.now());
      if (ts === CANCELLED) return;

      db.recordCredits(branch, model, credits, note.trim() ? note.trim() : undefined);
      // recordCredits appends to the end of the ledger; it is the newest manual
      // entry for this branch, so getCreditEntries (newest-first) returns it at [0].
      if (wiOverride !== undefined || ts !== undefined) {
        const justAdded = db.getCreditEntries({ branch, source: 'manual' })[0];
        if (justAdded) {
          const patch: LedgerEntryPatch = {};
          if (wiOverride !== undefined) patch.workItemId = wiOverride;
          if (ts !== undefined) patch.ts = ts;
          db.updateLedgerEntry(justAdded.id, patch);
        }
      }
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
    vscode.commands.registerCommand('aiEffortTracker.editLedgerEntry', (id?: string) =>
      editLedgerEntry(id)
    ),
    vscode.commands.registerCommand('aiEffortTracker.deleteLedgerEntry', (id?: string) =>
      deleteLedgerEntry(id)
    ),
    vscode.commands.registerCommand('aiEffortTracker.addManualEffort', (workItemId?: string) =>
      addManualEffort(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.editManualEffort', (id?: string) =>
      editManualEffort(id)
    ),
    vscode.commands.registerCommand('aiEffortTracker.deleteManualEffort', (id?: string) =>
      deleteManualEffort(id)
    ),
    vscode.commands.registerCommand('aiEffortTracker.assignBranchToWorkItem', () =>
      assignBranchToWorkItem()
    ),
    // Reassignment is the same manual-override flow, framed as moving an
    // already-mapped branch to a different work item (issue #10).
    vscode.commands.registerCommand('aiEffortTracker.reassignBranch', () =>
      assignBranchToWorkItem()
    ),
    // #22: move a SINGLE named branch (from a work-item drill-down row) to another
    // work item, recording an audit entry.
    vscode.commands.registerCommand('aiEffortTracker.moveBranchToWorkItem', (branch?: string) =>
      moveBranchToWorkItem(branch)
    ),
    // #22: BULK reassign — multi-select branches of a work item and move them all
    // to a chosen destination in one audited batch.
    vscode.commands.registerCommand('aiEffortTracker.reassignBranchesBulk', (workItemId?: string) =>
      reassignBranchesBulk(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setWorkItemEstimate', (workItemId?: string) =>
      setWorkItemEstimate(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setBillableHours', (workItemId?: string) =>
      setBillableHours(workItemId)
    ),
    // #47: adjust/correct the AUTO-tracked time for a branch's mode (delta stored
    // under the hood; raw kept intact). `arg` encodes "branch\u0000mode" from the
    // dashboard ✎ affordance; falls back to QuickPicks from the palette.
    vscode.commands.registerCommand('aiEffortTracker.adjustTrackedTime', (arg?: string) =>
      adjustTrackedTime(arg)
    ),
    // #47: reset a branch's adjustments back to the raw auto-tracked value. `arg`
    // is the branch name from the dashboard; falls back to a QuickPick.
    vscode.commands.registerCommand('aiEffortTracker.resetTrackedTime', (arg?: string) =>
      resetTrackedTime(arg)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setProjectRates', (projectId?: string) =>
      setProjectRates(projectId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.createProject', () => createProject()),
    vscode.commands.registerCommand('aiEffortTracker.linkRepoToProject', () => linkRepoToProject()),
    vscode.commands.registerCommand('aiEffortTracker.createWorkItem', () => createWorkItem()),
    vscode.commands.registerCommand('aiEffortTracker.editWorkItem', () => editWorkItem()),
    vscode.commands.registerCommand('aiEffortTracker.assignWorkItemToProject', () => assignWorkItemToProject()),
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
  dashboardPanel.webview.html = renderDashboardHtml(db.getAllBranchesSummaries(), branch, nonce, ghMetrics, getInsightsConfig(), getAnalytics(), lastBilling, db.getAllProjectSummaries(), db.getAllWorkItemSummaries(), db.getCreditEntries(), db.getManualEffort(), db.getReassignments());

  dashboardPanel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === 'cmd' && m.value) {
      await vscode.commands.executeCommand('aiEffortTracker.' + m.value, m.arg);
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
      billing: lastBilling,
      projectSummaries: db.getAllProjectSummaries(),
      workItemSummaries: db.getAllWorkItemSummaries(),
      ledger: db.getCreditEntries(),
      manualEffort: db.getManualEffort(),
      reassignments: db.getReassignments()
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
 * QuickPick a branch from all tracked branches (issue #22 command-palette
 * fallback). Returns the branch name or undefined on cancel.
 */
async function pickBranch(placeHolder: string): Promise<string | undefined> {
  const picks = db.getAllBranchesSummaries().map(s => ({
    label: s.branch,
    description: s.workItemId ? '#' + s.workItemId : undefined
  }));
  if (picks.length === 0) {
    vscode.window.showWarningMessage('No branches tracked yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  return picked?.label;
}

/**
 * QuickPick a DESTINATION work item for a reassignment (issue #22). Offers all
 * real work items (marking `currentId`) plus a "New work item…" option that
 * creates the entity. Returns the chosen/created work item id, or undefined on
 * cancel. Mirrors the {@link assignBranchToWorkItem} picker so the reassign flows
 * feel identical to the existing #10 assign flow.
 */
async function pickDestinationWorkItem(placeHolder: string, currentId?: string): Promise<string | undefined> {
  type WiPick = vscode.QuickPickItem & { id?: string; create?: boolean };
  const picks: WiPick[] = db.getAllWorkItems()
    .filter(w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID)
    .map(w => ({
      label: (w.id === currentId ? '\u25b6 ' : '') + '#' + w.id,
      description: w.title ?? undefined,
      detail: w.id === currentId ? 'current work item' : undefined,
      id: w.id
    }));
  picks.push({ label: '$(add) New work item\u2026', create: true });
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return undefined;
  if (picked.create) {
    const id = await vscode.window.showInputBox({
      prompt: 'New work item id (e.g. 1234 or JIRA-42)',
      validateInput: v => (v && v.trim()) ? null : 'Enter a work item id'
    });
    if (!id) return undefined;
    const workItemId = id.trim();
    const title = await vscode.window.showInputBox({
      prompt: `Title for work item #${workItemId} (optional)`
    });
    if (title === undefined) return undefined;
    db.upsertWorkItem(workItemId, title.trim() ? { title: title.trim() } : {});
    return workItemId;
  }
  return picked.id;
}

/**
 * Move a SINGLE branch to another work item (issue #22), invoked from a
 * work-item drill-down row (or the command palette, which falls back to a branch
 * QuickPick). Picks a destination work item, takes an optional note, and calls
 * the audited single-branch reassignment. Accrued effort/lines and reconciled
 * credit-ledger rows follow the branch (see {@link Database.reassignBranchToWorkItem}).
 */
async function moveBranchToWorkItem(branch?: string) {
  let target = branch;
  if (!target) {
    target = await pickBranch('Move which branch to a different work item?');
    if (!target) return;
  }
  const current = db.getWorkItemForBranch(target);
  const dest = await pickDestinationWorkItem(
    `Move branch "${target}" to which work item?`,
    current ?? undefined
  );
  if (!dest) return;
  const note = await vscode.window.showInputBox({
    prompt: 'Reassignment note (optional)',
    placeHolder: 'e.g. was tracked under the wrong work item'
  });
  if (note === undefined) return; // Esc cancels the whole move.
  db.reassignBranchToWorkItem(target, dest, note.trim() || undefined);
  vscode.window.showInformationMessage(`Branch "${target}" moved to work item #${dest}.`);
  refreshDashboard();
}

/**
 * BULK reassign the branches of a work item (issue #22). Invoked from a work-item
 * drill-down (or the palette, which falls back to picking a source work item):
 * multi-selects branches of the source, picks a destination work item, takes an
 * optional shared note, and calls the audited bulk method so all moves share one
 * `batchId`. All accrued effort/credits follow the branches, and one audit row is
 * recorded per branch.
 */
async function reassignBranchesBulk(workItemId?: string) {
  let sourceId = workItemId;
  if (!sourceId) {
    sourceId = await pickWorkItem('Reassign branches FROM which work item?');
    if (!sourceId) return;
  }
  const branches = db.getWorkItemSummary(sourceId).branches;
  if (branches.length === 0) {
    vscode.window.showWarningMessage(`Work item #${sourceId} has no branches to reassign.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    branches.map(b => ({ label: b, picked: true })),
    { canPickMany: true, placeHolder: `Select branches to move from #${sourceId}` }
  );
  if (!picked || picked.length === 0) return;
  const dest = await pickDestinationWorkItem(
    `Move ${picked.length} branch(es) to which work item?`,
    sourceId
  );
  if (!dest) return;
  const note = await vscode.window.showInputBox({
    prompt: 'Reassignment note (optional)',
    placeHolder: 'e.g. re-homing mis-detected branches'
  });
  if (note === undefined) return;
  const moved = db.reassignBranchesToWorkItem(
    picked.map(p => p.label),
    dest,
    note.trim() || undefined
  );
  vscode.window.showInformationMessage(`Moved ${moved.length} branch(es) to work item #${dest}.`);
  refreshDashboard();
}

/**
 * Enter a granular estimate for a work item (issue #16 / M3). Flow: pick a work
 * item (reusing the #10 QuickPick pattern) → choose a unit (hours/points) →
 * choose to enter a single TOTAL or a per-category breakdown. A per-category
 * breakdown is captured through a short sequence of input boxes for the four
 * primary categories (programming / specification / documentation / deployment);
 * a blank entry means "skip" (0). Persists via the store API and refreshes the
 * dashboard. When a `preselectedId` is passed (issue #50 — the dashboard
 * Estimate ✎ affordance forwards `m.arg`), the QuickPick is skipped and that
 * work item is edited directly, prefilled with its current estimate. Kept
 * intentionally minimal — the estimate-vs-actual report UI is milestone M7
 * (#28/#29).
 */
async function setWorkItemEstimate(preselectedId?: string) {
  let workItemId: string;
  if (preselectedId) {
    // Called from a dashboard card that already knows the target — edit it
    // directly, skipping the QuickPick (mirrors setBillableHours). Ensure the
    // work item exists so downstream summary/prefill lookups are safe.
    workItemId = preselectedId;
    db.upsertWorkItem(workItemId);
  } else {
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
 * Set (or clear) a work item's manual 'could-charge' billable-hours override
 * (issue #46), DECOUPLED from the actual tracked time. Accepts an optional
 * `arg` (mirroring the `m.arg` pattern) so a dashboard button can target a
 * specific item; otherwise it QuickPicks one. The arg may be either a bare
 * `workItemId`, or `"workItemId\u0000hours"` (issue #48) so the "Use as billable
 * hours" affordance can PREFILL a suggested value (the equivalent hours of the
 * generated lines) — NUL is an unambiguous delimiter, matching
 * {@link adjustTrackedTime}. The InputBox is prefilled with that suggested value
 * when supplied, else the CURRENT effective billable hours (the override when
 * set, else the estimate-in-hours / actual-hours default); its prompt names that
 * default; submitting blank CLEARS the override so it falls back to the default.
 */
async function setBillableHours(arg?: string) {
  let id = arg;
  let prefill: number | undefined;
  // #48: split an optional `id\u0000hours` suggestion (mirrors adjustTrackedTime).
  if (id) {
    const sep = id.indexOf('\u0000');
    if (sep >= 0) {
      const h = Number(id.slice(sep + 1));
      if (Number.isFinite(h) && h >= 0) prefill = h;
      id = id.slice(0, sep);
    }
  }
  if (!id) {
    id = await pickWorkItem('Set billable (could-charge) hours for which work item?');
    if (!id) return;
  }

  const summary = db.getWorkItemSummary(id);
  const roi = summary.roi;
  const override = db.getWorkItem(id)?.billableHours;
  // The estimate-derived default the effective hours would fall back to when no
  // override is set (estimate-in-hours, else actual worked hours).
  const estUnit = summary.estimateUnit ?? 'hours';
  const estimate = summary.estimate;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const actualHours = round2(roi.actualHours ?? 0);
  const defaultHours =
    estimate !== null && estUnit === 'hours' ? round2(estimate) : actualHours;
  const defaultLabel =
    estimate !== null && estUnit === 'hours'
      ? `estimate ${defaultHours}h`
      : `actual ${actualHours}h`;
  // Effective = what invoicing uses right now (override else default).
  const effective = round2(roi.chargeableHours ?? defaultHours);
  // #48: a suggested value (generated-lines equivalent hours) wins the prefill.
  const initialValue =
    prefill !== undefined
      ? String(round2(prefill))
      : override !== undefined
        ? String(round2(override))
        : String(effective);

  const raw = await vscode.window.showInputBox({
    prompt:
      `Billable (could-charge) hours for #${id} — blank to clear the override ` +
      `(default = ${defaultLabel}, actual worked = ${actualHours}h)`,
    value: initialValue,
    placeHolder: `e.g. ${defaultHours} — leverage lets you charge more hours than you worked`,
    validateInput: v => {
      if (!v.trim()) return null; // blank = clear
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? null : 'Enter a non-negative number';
    }
  });
  if (raw === undefined) return;

  if (!raw.trim()) {
    db.setBillableHours(id, null);
    vscode.window.showInformationMessage(
      `Billable-hours override for #${id} cleared — now defaults to ${defaultLabel}.`
    );
  } else {
    const hours = Number(raw);
    db.setBillableHours(id, hours);
    vscode.window.showInformationMessage(
      `Billable (could-charge) hours for #${id} set to ${hours}h.`
    );
  }
  refreshDashboard();
}

/**
 * Adjust/CORRECT a branch's automatically-tracked time for one mode (issue #47).
 * Stores a per-mode adjustment DELTA under the hood via
 * {@link Database.setEffectiveTime} so the user simply types the value they want
 * to SEE; the raw auto-tracked bucket is never mutated, so auto-tracking keeps
 * running and the original number stays restorable. `arg`, when present, encodes
 * `"branch\u0000mode"` (forwarded by the dashboard Time-tab ✎ affordance — NUL
 * is illegal in git ref names so it is an unambiguous delimiter); otherwise the
 * branch and mode are QuickPicked. The InputBox is prefilled with the current
 * EFFECTIVE value (minutes, `h:mm`, or blank to reset that mode to auto).
 */
async function adjustTrackedTime(arg?: string) {
  let branch: string | undefined;
  let mode: TrackingMode | undefined;

  if (arg) {
    const sep = arg.indexOf('\u0000');
    if (sep >= 0) {
      branch = arg.slice(0, sep);
      const m = arg.slice(sep + 1);
      if (m === 'humanCoding' || m === 'aiGenerating' || m === 'reviewing' || m === 'idle') {
        mode = m;
      }
    } else {
      branch = arg;
    }
  }

  if (!branch) {
    branch = await pickBranch('Adjust tracked time for which branch?');
    if (!branch) return;
  }
  if (!mode) {
    const picked = await pickTrackingMode(`Which mode's tracked time on "${branch}"?`);
    if (picked === CANCELLED || picked == null) return;
    mode = picked;
  }

  const raw = db.getRawTime(branch)[mode];
  const effective = db.getEffectiveTime(branch)[mode];
  const rawTxt = msToHm(raw);
  const effTxt = msToHm(effective);

  const value = await vscode.window.showInputBox({
    prompt:
      `Corrected ${modeLabel(mode)} time for "${branch}" ` +
      `(minutes or h:mm; blank to reset this mode to auto). ` +
      `Auto-tracked raw = ${rawTxt}, currently showing ${effTxt}.`,
    value: effTxt,
    placeHolder: 'e.g. 45 or 1:30',
    validateInput: v => {
      if (!v.trim()) return null; // blank = reset to auto
      return parseDurationMs(v) === null ? 'Enter minutes (e.g. 45) or h:mm (e.g. 1:30)' : null;
    }
  });
  if (value === undefined) return;

  if (!value.trim()) {
    db.clearTimeAdjustment(branch, mode);
    vscode.window.showInformationMessage(
      `${modeLabel(mode)} time for "${branch}" reset to auto (${rawTxt}).`
    );
  } else {
    const desiredMs = parseDurationMs(value)!;
    db.setEffectiveTime(branch, mode, desiredMs);
    const nowTxt = msToHm(db.getEffectiveTime(branch)[mode]);
    vscode.window.showInformationMessage(
      `${modeLabel(mode)} time for "${branch}" set to ${nowTxt} (auto-tracked raw ${rawTxt} preserved).`
    );
  }
  refreshDashboard();
}

/**
 * Reset ALL of a branch's per-mode time adjustments back to the raw auto-tracked
 * values (issue #47). `arg`, when present, is the branch name (forwarded by the
 * dashboard "Reset to auto" affordance); otherwise it is QuickPicked. A no-op
 * with an info message when the branch has no adjustment.
 */
async function resetTrackedTime(arg?: string) {
  let branch = arg;
  if (!branch) {
    branch = await pickBranch('Reset tracked-time adjustments for which branch?');
    if (!branch) return;
  }
  const hadAdjustment = Object.keys(db.getTimeAdjustment(branch)).length > 0;
  db.clearTimeAdjustment(branch);
  vscode.window.showInformationMessage(
    hadAdjustment
      ? `Tracked-time adjustments for "${branch}" reset to auto.`
      : `"${branch}" has no time adjustments — already on auto.`
  );
  refreshDashboard();
}

/**
 * Set per-project ROI rates (issue #15 / M3): pick a project, then enter its
 * hourly COST, hourly SELL rate, currency, and credit cost. Blank leaves a field
 * unset so it inherits the global default (and, for cost/credit, the legacy
 * setting). Persists into `Project.settings` via {@link Database.upsertProject},
 * merging with any existing settings so unrelated keys survive. When a
 * `preselectedId` is passed (issue #50 — the project card ✎ Edit Rates button
 * forwards `m.arg`), the QuickPick is skipped and that project is edited
 * directly, prefilled with its current settings. The full project setup UI is
 * #27; this is intentionally the command + persistence only.
 */
async function setProjectRates(preselectedId?: string) {
  const projects = db.getAllProjects();
  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      'No projects yet. Projects are created when a repository is linked; rates can be set once a project exists.'
    );
    return;
  }

  let projectId: string;
  let projectLabel: string;
  if (preselectedId) {
    // Called from a project card that already knows the target — edit it
    // directly, skipping the QuickPick (mirrors setBillableHours).
    const proj = db.getProject(preselectedId);
    if (!proj) {
      vscode.window.showWarningMessage('That project no longer exists.');
      return;
    }
    projectId = proj.id;
    projectLabel = proj.name;
  } else {
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
    projectId = picked.id;
    projectLabel = picked.label;
  }

  const project = db.getProject(projectId);
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
    `Hourly COST for "${projectLabel}" (what an hour costs) — blank to inherit default`,
    existing.hourlyCostRate
  );
  if (!cost.ok) return;
  const sell = await numInput(
    `Hourly SELL rate for "${projectLabel}" (what an hour is billed for) — blank to inherit`,
    existing.hourlySellRate
  );
  if (!sell.ok) return;

  const currencyRaw = await vscode.window.showInputBox({
    prompt: `Currency for "${projectLabel}" (e.g. USD, EUR) — blank to inherit`,
    value: typeof existing.currency === 'string' ? existing.currency : ''
  });
  if (currencyRaw === undefined) return;

  const creditCost = await numInput(
    `Credit cost for "${projectLabel}" (money per 1 credit/premium request) — blank to inherit`,
    existing.creditCostPerUnit
  );
  if (!creditCost.ok) return;

  // Merge onto existing settings; assigning undefined clears an override.
  const settings = { ...existing };
  settings.hourlyCostRate = cost.value;
  settings.hourlySellRate = sell.value;
  settings.currency = currencyRaw.trim() ? currencyRaw.trim() : undefined;
  settings.creditCostPerUnit = creditCost.value;
  db.upsertProject({ id: projectId, settings });

  const eff = db.getEffectiveRates(projectId);
  const fmt = (n: number | null) => (n === null ? '\u2014' : String(n));
  vscode.window.showInformationMessage(
    `Rates for "${projectLabel}" saved. Effective: cost ${fmt(eff.hourlyCostRate)}, ` +
    `sell ${fmt(eff.hourlySellRate)}, credit ${fmt(eff.creditCostPerUnit)} (${eff.currency}).`
  );
  refreshDashboard();
}

/**
 * Create a new project (issue #27 / M7): prompt for a name, create it, then
 * offer to link the current workspace repo so this repo's effort rolls up under
 * the project. Mirrors the QuickPick/InputBox style used elsewhere.
 */
async function createProject() {
  const name = await vscode.window.showInputBox({
    prompt: 'New project name',
    validateInput: v => (v && v.trim()) ? null : 'Enter a project name'
  });
  if (!name) return;
  const project = db.upsertProject({ name: name.trim() });

  const repoId = await GitTracker.getRepoId();
  if (repoId) {
    const link = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: `Link the current repository to "${project.name}"?`
    });
    if (link === 'Yes') {
      db.linkRepoToProject(project.id, repoId);
      vscode.window.showInformationMessage(`Project "${project.name}" created and linked to this repo.`);
    } else {
      vscode.window.showInformationMessage(`Project "${project.name}" created.`);
    }
  } else {
    vscode.window.showInformationMessage(`Project "${project.name}" created. (No repository detected to link.)`);
  }
  refreshDashboard();
}

/** Link the current workspace repo to an existing project (issue #27). */
async function linkRepoToProject() {
  const repoId = await GitTracker.getRepoId();
  if (!repoId) {
    vscode.window.showWarningMessage('No repository detected in the current workspace to link.');
    return;
  }
  const projects = db.getAllProjects();
  if (projects.length === 0) {
    vscode.window.showWarningMessage('No projects yet. Create one with "New Project" first.');
    return;
  }
  type ProjPick = vscode.QuickPickItem & { id: string };
  const picks: ProjPick[] = projects.map(p => {
    const linked = p.repos.includes(repoId);
    return {
      label: (linked ? '\u2713 ' : '') + p.name,
      description: p.repos.join(', ') || undefined,
      detail: linked ? 'already linked to this repo' : undefined,
      id: p.id
    };
  });
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: `Link this repository (${repoId}) to which project?`
  });
  if (!picked) return;
  db.linkRepoToProject(picked.id, repoId);
  vscode.window.showInformationMessage(`Linked this repo to "${db.getProject(picked.id)?.name ?? picked.id}".`);
  refreshDashboard();
}

/**
 * QuickPick a REAL work item (issue #27). Excludes the synthetic holding buckets
 * (`unknown`, `__unassigned__`) which are not user-managed work items.
 */
async function pickWorkItem(placeHolder: string): Promise<string | undefined> {
  type WiPick = vscode.QuickPickItem & { id: string };
  const items = db.getAllWorkItems().filter(
    w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID
  );
  if (items.length === 0) {
    vscode.window.showWarningMessage('No work items yet. Create one with "New Work Item" first.');
    return undefined;
  }
  const picks: WiPick[] = items.map(w => ({
    label: '#' + w.id,
    description: w.title ?? undefined,
    detail: w.projectId
      ? `project: ${db.getProject(w.projectId)?.name ?? w.projectId}`
      : 'no project',
    id: w.id
  }));
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  return picked?.id;
}

/**
 * QuickPick a project or "no project" (issue #27). Returns the chosen project id,
 * `null` to unassign, or `undefined` when the user cancels.
 */
async function pickProjectOrNone(placeHolder: string, current?: string | null): Promise<string | null | undefined> {
  type ProjPick = vscode.QuickPickItem & { id?: string; none?: boolean };
  const picks: ProjPick[] = [
    { label: '$(circle-slash) No project (unassign)', none: true, description: current == null ? 'current' : undefined },
    ...db.getAllProjects().map(p => ({
      label: (p.id === current ? '\u25b6 ' : '') + p.name,
      description: p.repos.join(', ') || undefined,
      id: p.id
    }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return undefined;
  return picked.none ? null : (picked.id ?? null);
}

// ---- Manual credit ledger correction (issue #19) --------------------------

/**
 * Sentinel returned by the ledger prompt helpers when the user cancels (Esc).
 * Distinct from `undefined`, which those helpers use to mean "keep the existing
 * value / use the default" — a real choice we must not confuse with a cancel.
 */
const CANCELLED = Symbol('cancelled');

/**
 * QuickPick a work-item override for a ledger entry (issue #19). Returns:
 *  - `undefined` — keep the default/current attribution (no change),
 *  - `null` — explicitly clear the work item,
 *  - a work-item id string, or
 *  - {@link CANCELLED} when the user escapes.
 */
async function pickWorkItemOverride(
  placeHolder: string,
  keepLabel: string,
  current?: string | null
): Promise<string | null | undefined | typeof CANCELLED> {
  type WiPick = vscode.QuickPickItem & { id?: string; keep?: boolean; none?: boolean };
  const items = db.getAllWorkItems().filter(
    w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID
  );
  const picks: WiPick[] = [
    { label: keepLabel, keep: true },
    { label: '$(circle-slash) No work item', none: true, description: current == null ? 'current' : undefined },
    ...items.map(w => ({
      label: (w.id === current ? '\u25b6 ' : '') + '#' + w.id,
      description: w.title ?? undefined,
      id: w.id
    }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.keep) return undefined;
  if (picked.none) return null;
  return picked.id ?? null;
}

/**
 * Prompt for a timestamp (issue #19). Accepts an ISO date-time (or anything
 * `Date.parse` understands) or an epoch-ms number. Returns:
 *  - a millisecond timestamp when the user enters one,
 *  - `undefined` when left blank (caller decides what "blank" means), or
 *  - {@link CANCELLED} when the user escapes.
 */
async function promptTimestamp(
  prompt: string,
  defaultMs: number
): Promise<number | undefined | typeof CANCELLED> {
  const input = await vscode.window.showInputBox({
    prompt,
    value: new Date(defaultMs).toISOString(),
    placeHolder: 'e.g. 2026-08-01T09:30:00Z (blank to skip)',
    validateInput: v => {
      if (!v || !v.trim()) return null;
      const t = v.trim();
      const asNum = Number(t);
      if (Number.isFinite(asNum)) return null;
      return Number.isNaN(Date.parse(t)) ? 'Enter an ISO date-time or epoch-ms number' : null;
    }
  });
  if (input === undefined) return CANCELLED;
  const t = input.trim();
  if (!t) return undefined;
  const asNum = Number(t);
  return Number.isFinite(asNum) ? asNum : Date.parse(t);
}

/** Short human label for a ledger entry, used in QuickPicks and messages. */
function ledgerLabel(e: LedgerEntry): string {
  const when = new Date(e.ts).toLocaleString();
  const attr = e.workItemId ? ` #${e.workItemId}` : e.branch ? ` ${e.branch}` : '';
  const note = e.note ? ` — ${e.note}` : '';
  return `${e.credits} cr · ${e.model} · ${e.source}${attr} · ${when}${note}`;
}

/** QuickPick an existing ledger entry (newest-first). */
async function pickLedgerEntry(placeHolder: string): Promise<LedgerEntry | undefined> {
  const entries = db.getCreditEntries();
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No credit entries to correct yet. Log one with "Log Credits" first.');
    return undefined;
  }
  type EntryPick = vscode.QuickPickItem & { entry: LedgerEntry };
  const picks: EntryPick[] = entries.map(e => ({ label: ledgerLabel(e), entry: e }));
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  return picked?.entry;
}

/**
 * Resolve a ledger entry either from an id passed by the dashboard row buttons
 * or, when invoked from the command palette without one, via a QuickPick.
 */
async function resolveLedgerEntry(id: string | undefined, placeHolder: string): Promise<LedgerEntry | undefined> {
  if (id) {
    const found = db.getCreditEntries().find(e => e.id === id);
    if (!found) {
      vscode.window.showWarningMessage('That credit entry no longer exists.');
      return undefined;
    }
    return found;
  }
  return pickLedgerEntry(placeHolder);
}

/**
 * Edit an existing ledger entry by hand (issue #19): model, credits, cost, note,
 * work-item attribution and timestamp. Any prompt escaped mid-flow cancels the
 * whole edit. Totals/ROI recompute automatically because they derive from the
 * ledger (the single source of truth).
 */
async function editLedgerEntry(id?: string) {
  const entry = await resolveLedgerEntry(id, 'Edit which credit entry?');
  if (!entry) return;

  const model = await vscode.window.showInputBox({
    prompt: 'Model', value: entry.model,
    validateInput: v => (v && v.trim()) ? null : 'Enter a model name'
  });
  if (model === undefined) return;

  const creditsIn = await vscode.window.showInputBox({
    prompt: 'Credits', value: String(entry.credits),
    validateInput: v => (v && !isNaN(parseFloat(v))) ? null : 'Enter a number'
  });
  if (creditsIn === undefined) return;

  const costIn = await vscode.window.showInputBox({
    prompt: 'Cost in USD (blank to clear)',
    value: entry.cost != null ? String(entry.cost) : '',
    validateInput: v => (!v || !v.trim() || !isNaN(parseFloat(v))) ? null : 'Enter a number or leave blank'
  });
  if (costIn === undefined) return;

  const noteIn = await vscode.window.showInputBox({ prompt: 'Note (optional)', value: entry.note ?? '' });
  if (noteIn === undefined) return;

  const wi = await pickWorkItemOverride(
    'Work item attribution', '$(check) Keep current', entry.workItemId ?? null
  );
  if (wi === CANCELLED) return;

  const ts = await promptTimestamp('Timestamp (blank to keep current)', entry.ts);
  if (ts === CANCELLED) return;

  const patch: LedgerEntryPatch = {
    model: model.trim(),
    credits: parseFloat(creditsIn),
    cost: costIn.trim() ? parseFloat(costIn) : null,
    note: noteIn.trim()
  };
  if (wi !== undefined) patch.workItemId = wi;
  if (ts !== undefined) patch.ts = ts;

  const updated = db.updateLedgerEntry(entry.id, patch);
  if (!updated) {
    vscode.window.showWarningMessage('That credit entry no longer exists.');
    return;
  }
  vscode.window.showInformationMessage(`Updated credit entry (${updated.credits} cr · ${updated.model}).`);
  refreshDashboard();
}

/**
 * Delete a ledger entry by hand (issue #19), after a confirmation modal. Because
 * the ledger is the single source of truth, removing a row drops its credits/cost
 * from every derived total automatically.
 */
async function deleteLedgerEntry(id?: string) {
  const entry = await resolveLedgerEntry(id, 'Delete which credit entry?');
  if (!entry) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete this credit entry?\n\n${ledgerLabel(entry)}`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  if (db.deleteLedgerEntry(entry.id)) {
    vscode.window.showInformationMessage('Credit entry deleted.');
    refreshDashboard();
  }
}

// ---- Manual effort entry & adjustment (issue #21 / milestone M5) -----------

/** Human-readable label for a {@link TrackingMode}. */
function modeLabel(mode: TrackingMode): string {
  const labels: Record<TrackingMode, string> = {
    humanCoding: 'human coding',
    aiGenerating: 'AI generating',
    reviewing: 'reviewing',
    idle: 'idle'
  };
  return labels[mode];
}

/** Parse a duration entered as plain minutes (`90`) or `h:mm` (`1:30`). */
function parseDurationMs(v: string): number | null {
  if (!v || !v.trim()) return null;
  const t = v.trim();
  const hm = t.match(/^(\d+):([0-5]?\d)$/);
  if (hm) return (parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10)) * 60000;
  const mins = Number(t);
  if (Number.isFinite(mins) && mins >= 0) return Math.round(mins * 60000);
  return null;
}

/** Render a millisecond duration back to `h:mm` (or plain minutes under an hour). */
function msToHm(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(totalMin);
}

/** Pick a work item for a NEW manual entry, with an inline "new work item" option. */
async function pickOrCreateWorkItem(placeHolder: string): Promise<string | undefined> {
  type WiPick = vscode.QuickPickItem & { id?: string; create?: boolean };
  const items = db.getAllWorkItems().filter(
    w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID
  );
  const picks: WiPick[] = items.map(w => ({
    label: '#' + w.id,
    description: w.title ?? undefined,
    detail: w.projectId ? `project: ${db.getProject(w.projectId)?.name ?? w.projectId}` : 'no project',
    id: w.id
  }));
  picks.push({ label: '$(add) New work item\u2026', create: true });
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return undefined;
  if (picked.create) {
    const id = await vscode.window.showInputBox({
      prompt: 'New work item id (e.g. 1234 or JIRA-42)',
      validateInput: v => (v && v.trim()) ? null : 'Enter a work item id'
    });
    if (!id) return undefined;
    const wid = id.trim();
    db.upsertWorkItem(wid);
    return wid;
  }
  return picked.id;
}

/** Pick a work item when EDITING an entry: keep current, choose another, or create. */
async function pickWorkItemForManual(current: string): Promise<string | undefined | typeof CANCELLED> {
  type WiPick = vscode.QuickPickItem & { id?: string; keep?: boolean; create?: boolean };
  const items = db.getAllWorkItems().filter(
    w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID
  );
  const picks: WiPick[] = [
    { label: `$(check) Keep current (#${current})`, keep: true },
    ...items.map(w => ({
      label: (w.id === current ? '\u25b6 ' : '') + '#' + w.id,
      description: w.title ?? undefined,
      id: w.id
    })),
    { label: '$(add) New work item\u2026', create: true }
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder: 'Work item attribution' });
  if (!picked) return CANCELLED;
  if (picked.keep) return undefined;
  if (picked.create) {
    const id = await vscode.window.showInputBox({
      prompt: 'New work item id (e.g. 1234 or JIRA-42)',
      validateInput: v => (v && v.trim()) ? null : 'Enter a work item id'
    });
    if (!id) return CANCELLED;
    const wid = id.trim();
    db.upsertWorkItem(wid);
    return wid;
  }
  return picked.id;
}

/**
 * Pick a {@link TrackingMode} for a manual entry, or "no time" (returns `null`).
 * Returns {@link CANCELLED} on escape.
 */
async function pickTrackingMode(
  placeHolder: string,
  current?: TrackingMode | null
): Promise<TrackingMode | null | typeof CANCELLED> {
  type MP = vscode.QuickPickItem & { mode?: TrackingMode; none?: boolean };
  const modes: TrackingMode[] = ['humanCoding', 'aiGenerating', 'reviewing', 'idle'];
  const picks: MP[] = [
    { label: '$(circle-slash) No time (lines only)', none: true, description: current == null ? 'current' : undefined },
    ...modes.map(m => ({ label: (m === current ? '\u25b6 ' : '') + modeLabel(m), mode: m }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
  return picked.mode ?? null;
}

/**
 * Pick a {@link FileCategory} for a manual entry's lines, or "no lines" (`null`).
 * Returns {@link CANCELLED} on escape.
 */
async function pickCategory(
  placeHolder: string,
  current?: FileCategory | null
): Promise<FileCategory | null | typeof CANCELLED> {
  type CP = vscode.QuickPickItem & { cat?: FileCategory; none?: boolean };
  const picks: CP[] = [
    { label: '$(circle-slash) No lines / skip', none: true, description: current == null ? 'current' : undefined },
    ...ALL_CATEGORIES.map(c => ({ label: (c === current ? '\u25b6 ' : '') + CATEGORY_LABELS[c], cat: c }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
  return picked.cat ?? null;
}

/** Pick whether a manual entry's lines are human- or AI-authored. */
async function pickIsAi(placeHolder: string, current?: boolean): Promise<boolean | typeof CANCELLED> {
  type P = vscode.QuickPickItem & { ai: boolean };
  const picks: P[] = [
    { label: (current === false ? '\u25b6 ' : '') + 'Human', ai: false },
    { label: (current === true ? '\u25b6 ' : '') + 'AI', ai: true }
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  return picked.ai;
}

/** Prompt for a duration; blank returns `undefined`, escape returns {@link CANCELLED}. */
async function promptDurationMs(
  prompt: string,
  defaultMs?: number
): Promise<number | undefined | typeof CANCELLED> {
  const input = await vscode.window.showInputBox({
    prompt,
    value: defaultMs != null ? msToHm(defaultMs) : undefined,
    placeHolder: 'e.g. 90 (minutes) or 1:30 (h:mm)',
    validateInput: v => (!v || !v.trim() || parseDurationMs(v) !== null) ? null : 'Enter minutes (e.g. 90) or h:mm (e.g. 1:30)'
  });
  if (input === undefined) return CANCELLED;
  const ms = parseDurationMs(input);
  return ms == null ? undefined : ms;
}

/** Prompt for a non-negative whole line count; blank = 0, escape = {@link CANCELLED}. */
async function promptLineCount(prompt: string, defaultVal?: number): Promise<number | typeof CANCELLED> {
  const input = await vscode.window.showInputBox({
    prompt,
    value: defaultVal != null ? String(defaultVal) : undefined,
    placeHolder: 'e.g. 42',
    validateInput: v => {
      if (!v || !v.trim()) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? null : 'Enter a non-negative whole number';
    }
  });
  if (input === undefined) return CANCELLED;
  const t = input.trim();
  if (!t) return 0;
  return Math.round(Number(t));
}

/** Short human label for a manual entry, used in QuickPicks and messages. */
function manualEffortLabel(e: ManualEffortEntry): string {
  const when = new Date(e.ts).toLocaleString();
  const parts: string[] = [];
  if (e.mode && e.durationMs) parts.push(`${modeLabel(e.mode)} ${fmtDuration(e.durationMs)}`);
  if (e.category) {
    parts.push(`${e.isAi ? 'AI' : 'human'} ${CATEGORY_LABELS[e.category]} +${e.linesAdded || 0}/-${e.linesDeleted || 0}`);
  }
  const body = parts.join(' \u00b7 ') || 'no measures';
  const note = e.note ? ` \u2014 ${e.note}` : '';
  return `#${e.workItemId} \u00b7 ${body} \u00b7 ${when}${note}`;
}

/** QuickPick an existing manual entry (newest-first). */
async function pickManualEntry(placeHolder: string): Promise<ManualEffortEntry | undefined> {
  const entries = db.getManualEffort();
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No manual effort entries yet. Add one with "Add Effort" first.');
    return undefined;
  }
  type EP = vscode.QuickPickItem & { entry: ManualEffortEntry };
  const picks: EP[] = entries.map(e => ({ label: manualEffortLabel(e), entry: e }));
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  return picked?.entry;
}

/** Resolve a manual entry from a dashboard-supplied id or, failing that, a QuickPick. */
async function resolveManualEntry(id: string | undefined, placeHolder: string): Promise<ManualEffortEntry | undefined> {
  if (id) {
    const found = db.getManualEffort().find(e => e.id === id);
    if (!found) {
      vscode.window.showWarningMessage('That manual entry no longer exists.');
      return undefined;
    }
    return found;
  }
  return pickManualEntry(placeHolder);
}

/**
 * Add a manual effort adjustment (issue #21): pick a work item, then optionally
 * a mode + duration and/or a category + human/AI line counts, plus an optional
 * note and timestamp. Any prompt escaped mid-flow cancels the whole add. Written
 * to the SEPARATE manual-effort store, so the auto-capture path is untouched.
 */
async function addManualEffort(workItemId?: string) {
  const wi = workItemId && db.getWorkItem(workItemId)
    ? workItemId
    : await pickOrCreateWorkItem('Add manual effort to which work item?');
  if (!wi) return;

  const input: ManualEffortInput = { workItemId: wi };

  const mode = await pickTrackingMode('What kind of time? (or lines only)');
  if (mode === CANCELLED) return;
  if (mode) {
    const dur = await promptDurationMs(`How much ${modeLabel(mode)} time?`);
    if (dur === CANCELLED) return;
    if (dur !== undefined && dur > 0) {
      input.mode = mode;
      input.durationMs = dur;
    }
  }

  const cat = await pickCategory('Log lines for a category? (optional)');
  if (cat === CANCELLED) return;
  if (cat) {
    const isAi = await pickIsAi('Were these lines written by a human or AI?');
    if (isAi === CANCELLED) return;
    const added = await promptLineCount('Lines ADDED (blank = 0)');
    if (added === CANCELLED) return;
    const deleted = await promptLineCount('Lines DELETED (blank = 0)');
    if (deleted === CANCELLED) return;
    if (added !== 0 || deleted !== 0) {
      input.category = cat;
      input.isAi = isAi;
      if (added !== 0) input.linesAdded = added;
      if (deleted !== 0) input.linesDeleted = deleted;
    }
  }

  if (input.durationMs === undefined && input.category === undefined) {
    vscode.window.showWarningMessage('Nothing entered \u2014 no manual effort added.');
    return;
  }

  const note = await vscode.window.showInputBox({
    prompt: 'Note (optional)',
    placeHolder: 'e.g. offline work, missed by auto-capture'
  });
  if (note === undefined) return;
  if (note.trim()) input.note = note.trim();

  const ts = await promptTimestamp('When did this happen? (blank = now)', Date.now());
  if (ts === CANCELLED) return;
  if (ts !== undefined) input.ts = ts;

  db.addManualEffort(input);
  vscode.window.showInformationMessage(`Added manual effort to #${wi}.`);
  refreshDashboard();
}

/**
 * Edit a manual effort entry (issue #21). Re-runs the same prompts pre-filled
 * with the current values and writes a patch; choosing "no time"/"no lines"
 * clears those measures. Escaping any prompt cancels. Safe when the row was
 * deleted meanwhile.
 */
async function editManualEffort(id?: string) {
  const entry = await resolveManualEntry(id, 'Edit which manual entry?');
  if (!entry) return;

  const wi = await pickWorkItemForManual(entry.workItemId);
  if (wi === CANCELLED) return;

  const mode = await pickTrackingMode('What kind of time? (or lines only)', entry.mode ?? null);
  if (mode === CANCELLED) return;
  let durationMs: number | null = null;
  if (mode) {
    const dur = await promptDurationMs(`How much ${modeLabel(mode)} time?`, entry.durationMs ?? undefined);
    if (dur === CANCELLED) return;
    durationMs = (dur !== undefined && dur > 0) ? dur : null;
  }

  const cat = await pickCategory('Log lines for a category? (optional)', entry.category ?? null);
  if (cat === CANCELLED) return;
  let isAi: boolean | null = null;
  let added: number | null = null;
  let deleted: number | null = null;
  if (cat) {
    const ai = await pickIsAi('Were these lines written by a human or AI?', entry.isAi ?? undefined);
    if (ai === CANCELLED) return;
    isAi = ai;
    const a = await promptLineCount('Lines ADDED (blank = 0)', entry.linesAdded);
    if (a === CANCELLED) return;
    const d = await promptLineCount('Lines DELETED (blank = 0)', entry.linesDeleted);
    if (d === CANCELLED) return;
    added = a !== 0 ? a : null;
    deleted = d !== 0 ? d : null;
  }

  const noteIn = await vscode.window.showInputBox({ prompt: 'Note (optional)', value: entry.note ?? '' });
  if (noteIn === undefined) return;

  const ts = await promptTimestamp('Timestamp (blank to keep current)', entry.ts);
  if (ts === CANCELLED) return;

  const patch: ManualEffortPatch = {
    mode,
    durationMs,
    category: cat,
    isAi,
    linesAdded: added,
    linesDeleted: deleted,
    note: noteIn.trim() ? noteIn.trim() : null
  };
  if (wi !== undefined) patch.workItemId = wi;
  if (ts !== undefined) patch.ts = ts;

  const updated = db.updateManualEffort(entry.id, patch);
  if (!updated) {
    vscode.window.showWarningMessage('That manual entry no longer exists.');
    return;
  }
  vscode.window.showInformationMessage(`Updated manual effort on #${updated.workItemId}.`);
  refreshDashboard();
}

/** Delete a manual effort entry (issue #21) after a confirmation modal. */
async function deleteManualEffort(id?: string) {
  const entry = await resolveManualEntry(id, 'Delete which manual entry?');
  if (!entry) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete this manual effort entry?\n\n${manualEffortLabel(entry)}`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  if (db.deleteManualEffort(entry.id)) {
    vscode.window.showInformationMessage('Manual effort entry deleted.');
    refreshDashboard();
  }
}


async function createWorkItem() {
  const id = await vscode.window.showInputBox({
    prompt: 'New work item id (e.g. 1234 or JIRA-42)',
    validateInput: v => {
      if (!v || !v.trim()) return 'Enter a work item id';
      if (db.getWorkItem(v.trim())) return `Work item #${v.trim()} already exists`;
      return null;
    }
  });
  if (!id) return;
  const workItemId = id.trim();
  const title = await vscode.window.showInputBox({
    prompt: `Title for work item #${workItemId} (optional)`
  });
  if (title === undefined) return;
  db.upsertWorkItem(workItemId, title.trim() ? { title: title.trim() } : {});

  if (db.getAllProjects().length > 0) {
    const sel = await pickProjectOrNone(`Assign #${workItemId} to a project? (optional)`, null);
    if (sel) db.setProjectForWorkItem(workItemId, sel);
  }
  vscode.window.showInformationMessage(`Work item #${workItemId} created.`);
  refreshDashboard();
}

/**
 * Edit an existing work item (issue #27): change its title and optionally
 * reassign its project. Excludes the synthetic holding buckets.
 */
async function editWorkItem() {
  const wi = await pickWorkItem('Edit which work item?');
  if (!wi) return;
  const existing = db.getWorkItem(wi);
  const title = await vscode.window.showInputBox({
    prompt: `Title for work item #${wi}`,
    value: existing?.title ?? ''
  });
  if (title === undefined) return;
  db.upsertWorkItem(wi, { title: title.trim() ? title.trim() : null });

  const sel = await pickProjectOrNone(`Project for #${wi} (Esc to keep current)`, existing?.projectId ?? null);
  if (sel !== undefined) db.setProjectForWorkItem(wi, sel);

  vscode.window.showInformationMessage(`Work item #${wi} updated.`);
  refreshDashboard();
}

/** Assign (or unassign) a work item to a project (issue #27). */
async function assignWorkItemToProject() {
  const wi = await pickWorkItem('Assign which work item to a project?');
  if (!wi) return;
  const current = db.getWorkItem(wi)?.projectId ?? null;
  const sel = await pickProjectOrNone(`Assign #${wi} to which project?`, current);
  if (sel === undefined) return;
  db.setProjectForWorkItem(wi, sel);
  const name = sel ? (db.getProject(sel)?.name ?? sel) : 'no project';
  vscode.window.showInformationMessage(`Work item #${wi} assigned to ${name}.`);
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
      billing: lastBilling,
      projectSummaries: db.getAllProjectSummaries(),
      workItemSummaries: db.getAllWorkItemSummaries(),
      ledger: db.getCreditEntries(),
      manualEffort: db.getManualEffort(),
      reassignments: db.getReassignments()
    });
  });
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

/** Currency symbol for common codes; falls back to the code itself (issue #45). */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', CHF: 'CHF ',
  CAD: 'CA$', AUD: 'A$', INR: '\u20b9', CNY: '\u00a5'
};

/** Format money in a currency (symbol when known, else the code). Pure. */
function fmtCurrency(value: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[(currency || 'USD').toUpperCase()];
  const n = value.toFixed(2);
  return sym ? `${sym}${n}` : `${currency || 'USD'} ${n}`;
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

  const totLinesAi = summaries.reduce((a, s) => a + s.linesAiAdded, 0);
  const totLinesHuman = summaries.reduce((a, s) => a + s.linesHumanAdded, 0);
  const credits = summaries.reduce((a, s) => a + (s.creditsTotal || 0), 0);
  // Credit cost via the ECONOMIC model's global effective rates (issue #45),
  // not the legacy usdPerCredit constant. Cross-project totals use the global
  // currency; '' when no credit rate is configured (never a bogus $ figure).
  const rates = db.getEffectiveRates();
  const creditCostNote =
    rates.creditCostPerUnit != null
      ? ` (~${fmtCurrency(credits * rates.creditCostPerUnit, rates.currency)})`
      : '';

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
  lines.push(`- **Credits logged:** ${credits.toFixed(1)}${creditCostNote}`);
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


