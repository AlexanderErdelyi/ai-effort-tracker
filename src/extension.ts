import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimeTracker } from './trackers/timeTracker';
import { GitTracker } from './trackers/gitTracker';
import { CopilotTracker } from './trackers/copilotTracker';
import { ChatUsageTracker } from './trackers/chatUsageTracker';
import { ChatSessionUsageTracker } from './trackers/chatSessionUsageTracker';
import { CreditImportTracker } from './trackers/creditImportTracker';
import { DebugLogUsageTracker } from './trackers/debugLogUsageTracker';
import { CorrectionTracker } from './trackers/correctionTracker';
import { CorrectionStore } from './store/correctionStore';
import { LessonStore } from './store/lessonStore';
import { createRule, GENERATED_MARKER, lessonGroups, updateRule, writeLessonExport, rulesForRepo, type LessonRule, type RulePatch, type RuleStatus } from './analysis/lessons';
import { correctionsMarkdown, listCorrections } from './analysis/corrections';
import { correctionRateReport, correctionTrackingSince, type CorrectionRateReport } from './analysis/correctionRate';
import { acceptSuggestionsDelta, correctionsView, DEFAULT_KEYWORD_RULES, DEFAULT_LESSON_CATEGORIES, labelDelta } from './analysis/correctionLabels';
import { Database } from './store/database';
import {
  BACKUP_FORMAT, BACKUP_VERSION, buildBundle, DATA_SETS, dataSet, listCheckpoints, listSafetyCopies, parseBackup,
  restoreSideStore, SECRET_SETTINGS, serializeBundle, writeSafetyCopy, type BackupBundle, type DataSetId
} from './store/backup';
import { CURRENT_SCHEMA_VERSION, UNASSIGNED_WORK_ITEM_ID } from './store/database';
import type { EstimateBreakdown, EstimateUnit, LedgerEntry, LedgerEntryPatch } from './store/database';
import type { ManualEffortEntry, ManualEffortInput, ManualEffortPatch } from './store/database';
import type { TimeEntry, TimeEntryInput, TimeEntryPatch } from './store/database';
import { TIME_ENTRY_CATEGORIES } from './store/database';
import type { TimeEntryCategory } from './store/database';
import { CATEGORY_LABELS, ALL_CATEGORIES } from './util/fileTypes';
import type { FileCategory } from './util/fileTypes';
import type { TrackingMode } from './trackers/timeTracker';
import { StatusBarManager } from './ui/statusBar';
import { renderDashboardHtml } from './ui/dashboard';
import { GitHubService, BillingUsage } from './services/githubService';
import { registerUsageInsightsMcp } from './mcp/provider';
import { handleSessionsMessage } from './ui/sessionsPanel';
import { handleSettingsMessage } from './ui/settingsPanel';
import { SENIORITY_PRESETS } from './util/settingsModel';
import { BudgetMonitor } from './ui/budgetMonitor';
import { AwayController } from './ui/awayPrompt';
import { newChatWithHandoff } from './ui/handoff';
import { buildTimesheet, normalizeRounding, timesheetCsv, weekStartOf } from './analysis/timesheet';
import { defaultClassifier, modelEfficiency, toolProfile } from './analysis/efficiency';
import { checkDataHealth, HEALTH_SNAPSHOT_FILE, type HealthReport } from './analysis/dataHealth';
import { buildCreditOverview } from './analysis/creditOverview';
import { DEFAULT_FILTER, filterWindow, isScoped, matchesScope, normalizeFilter, parseDay, type DashboardFilter } from './analysis/dashboardFilter';
import { readUserRules } from './util/fileTypes';
import { suggestEstimate, adjustForBias, toEstimationItem, estimateAccuracy, isFinished } from './analysis/estimation';
import { NudgeController } from './ui/nudgeController';
import { ReviewController } from './ui/reviewController';
import { listSessions, optimizationFindings, usageOverview, type InsightFilter } from './analysis/usageInsights';

let timeTracker: TimeTracker;
let gitTracker: GitTracker;
let copilotTracker: CopilotTracker;
let chatUsageTracker: ChatUsageTracker;
let chatSessionUsageTracker: ChatSessionUsageTracker;
let creditImportTracker: CreditImportTracker;
let debugLogUsageTracker: DebugLogUsageTracker;
let db: Database;
let statusBar: StatusBarManager;
let dashboardPanel: vscode.WebviewPanel | undefined;
let pendingOpenWorkItem: string | undefined;
let pendingOpenTab: string | undefined;
let budgetMonitor: BudgetMonitor | undefined;
let nudgeController: NudgeController | undefined;
let reviewController: ReviewController | undefined;
let correctionStore: CorrectionStore | undefined;
let lessonStore: LessonStore | undefined;
let lastBilling: BillingUsage | null = null;
let dashFilter: DashboardFilter = DEFAULT_FILTER;
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
    daily: db.getDailySeries(filterDays()),
    heatmap: db.getHourHeatmap(),
    calendar: db.getCalendar(),
    focus: db.getFocusStats(goal),
    streak: db.getStreak(),
    week: db.getWeekComparison(),
    todayActiveMs: db.getTodayActiveMs(),
    topFiles: db.getTopFiles(12),
    timeline: db.getTodayTimeline(),
    credits: getCreditOverview(),
    confidence: db.getConfidence(),
    corrections: correctionRateOverview(),
  };
}

const renewalDay = () => vscode.workspace.getConfiguration('aiEffortTracker').get<number>('credits.renewalDay') ?? 1;

/** Days of daily history the global filter needs (at least 90, at most 366). */
function filterDays(now = Date.now()): number {
  const w = filterWindow(dashFilter, now, renewalDay());
  if (w.from === undefined) return dashFilter.range === 'all' || dashFilter.range === 'custom' ? 366 : 90;
  return Math.min(366, Math.max(90, Math.ceil((now - w.from) / 86_400_000) + 1));
}

/**
 * Credit overview for the dashboard. Breakdowns follow the global filter's
 * scope (#146); the budget always uses every entry, because the allowance is
 * shared across projects.
 */
function getCreditOverview() {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  const now = Date.now();
  const all = db.getCreditEntries();
  const opts = { now, monthlyBudget: c.get<number>('credits.monthlyBudget') ?? 0, renewalDay: renewalDay() };
  const custom = dashFilter.range === 'all' || dashFilter.range === 'custom';
  const scoped = buildCreditOverview(isScoped(dashFilter) ? all.filter(e => matchesScope(e, dashFilter)) : all, {
    ...opts,
    days: filterDays(now),
    ...(custom ? { window: filterWindow(dashFilter, now, opts.renewalDay) } : {}),
  });
  if (!isScoped(dashFilter)) return scoped;
  return { ...scoped, budget: buildCreditOverview(all, opts).budget };
}

async function setMonthlyCreditBudget(): Promise<void> {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  const current = c.get<number>('credits.monthlyBudget') ?? 0;
  const budget = await vscode.window.showInputBox({
    title: 'Monthly Copilot credit budget',
    prompt: 'Credits you plan to spend per billing period. 0 turns the budget off.',
    value: current > 0 ? String(current) : '',
    validateInput: v => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0) ? undefined : 'Enter a number of credits (0 or more).',
  });
  if (budget === undefined) return;
  const day = await vscode.window.showInputBox({
    title: 'Billing period start',
    prompt: 'Day of the month your Copilot plan renews (1–31). Days past the end of a short month use its last day.',
    value: String(c.get<number>('credits.renewalDay') ?? 1),
    validateInput: v => /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 31 ? undefined : 'Enter a day between 1 and 31.',
  });
  if (day === undefined) return;
  await c.update('credits.monthlyBudget', Number(budget.trim() || 0), vscode.ConfigurationTarget.Global);
  await c.update('credits.renewalDay', Number(day.trim()), vscode.ConfigurationTarget.Global);
}

const KNOWN_MODELS = [
  'Claude Opus 4.8', 'Claude Sonnet 4.6', 'GPT-5', 'GPT-4o',
  'o1', 'Gemini 2.5 Pro', 'Other'
];

export function activate(context: vscode.ExtensionContext) {
  db = new Database(context.globalStorageUri.fsPath);
  ghService.useSecrets(context.secrets);
  statusBar = new StatusBarManager();
  timeTracker = new TimeTracker(db, statusBar);
  gitTracker = new GitTracker(db, timeTracker);
  copilotTracker = new CopilotTracker(db, timeTracker);
  chatUsageTracker = new ChatUsageTracker(db, timeTracker, context.logUri);
  chatSessionUsageTracker = new ChatSessionUsageTracker(db, timeTracker, context.storageUri);
  creditImportTracker = new CreditImportTracker(db, timeTracker, () => refreshDashboard());
  nudgeController = new NudgeController(db, context);
  context.subscriptions.push(nudgeController);
  debugLogUsageTracker = new DebugLogUsageTracker(db, context.storageUri, () => {
    refreshDashboard();
    nudgeController?.onUsage(debugLogUsageTracker?.lastChangedSessions ?? []);
  });

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
    vscode.commands.registerCommand('aiEffortTracker.importDebugSession', async () => {
      try {
        const sessions = await debugLogUsageTracker.sessions();
        if (!sessions.length) {
          vscode.window.showInformationMessage('No Copilot debug logs found in this workspace.');
          return;
        }
        const picked = await vscode.window.showQuickPick(sessions.map(session => ({
          label: session.sessionId,
          description: new Date(session.modified).toLocaleString(),
          session
        })), { title: 'Import recorded credits and edit details', placeHolder: 'Choose a chat session in this workspace' });
        if (!picked) return;
        const current = await GitTracker.getCurrentBranch() ?? timeTracker.getBranch();
        const branch = await vscode.window.showQuickPick([...new Set([current, ...db.getAllBranches()])], {
          title: 'Attribute this chat history to a branch',
          placeHolder: 'Historical logs do not identify the branch. Choose explicitly; existing attribution is preserved.'
        });
        if (!branch) return;
        const result = await debugLogUsageTracker.importSession(picked.session, branch);
        vscode.window.showInformationMessage(
          `Debug session: ${result.credits.toFixed(6)} recorded credits across ${result.turns} turn(s). ` +
          (result.unpriced ? `${result.unpriced} request(s) have unknown charges; the total is partial. ` : '') +
          (result.warnings ? `${result.warnings} log warning(s): some records or edit counts could not be read; see Debug Usage output. ` : '') +
          'Edit details are available in the credit ledger; editor effort is not added twice.'
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Could not import debug session: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand('aiEffortTracker.importRealCredits', async () => {
      // Import EXACT credits from Copilot Chat Debug export(s) (issue #70). Uses
      // the configured folder when set; otherwise prompts for file(s).
      let files: string[];
      const folder = CreditImportTracker.folder();
      if (folder && CreditImportTracker.isConfigured()) {
        files = []; // sentinel: import the whole configured folder
      } else {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: { 'Chat Debug export': ['json'] },
          openLabel: 'Import credits',
          title: 'Select Copilot Chat Debug export(s)'
        });
        if (!picked || picked.length === 0) return;
        files = picked.map(u => u.fsPath);
      }
      const targets = files.length > 0 ? files : CreditImportTracker.listConfiguredFolderFiles();
      if (targets.length === 0) {
        vscode.window.showWarningMessage(
          folder
            ? `No .json exports found in credit-import folder: ${folder}`
            : 'No export files selected.'
        );
        return;
      }
      const branch = (await GitTracker.getCurrentBranch()) ?? timeTracker.getBranch();
      const summary = creditImportTracker.importFiles(targets, branch);
      vscode.window.showInformationMessage(
        `Imported ${summary.credits.toFixed(1)} exact credits to "${branch}" — ${summary.turns} turn(s), ` +
          `${summary.requests} request(s) from ${summary.files} file(s). ` +
          `${summary.inserted} new, ${summary.updated} updated` +
          (summary.purgedAuto > 0 ? `, ${summary.purgedAuto} estimate(s) replaced.` : '.')
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
    // #60: per-entry Time Log. `arg` on add encodes "workItemId\u0000branch" from the
    // dashboard ➕ affordance (either part may be empty); edit/delete take an entry id.
    vscode.commands.registerCommand('aiEffortTracker.addTimeEntry', (arg?: string) =>
      addTimeEntry(arg)
    ),
    vscode.commands.registerCommand('aiEffortTracker.editTimeEntry', (id?: string) =>
      editTimeEntry(id)
    ),
    vscode.commands.registerCommand('aiEffortTracker.deleteTimeEntry', (id?: string) =>
      deleteTimeEntry(id)
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
    // Delete a work item created by mistake (zero-loss: attached branches/credits/
    // effort move to "Unassigned"). Invoked from the work-item detail or palette.
    vscode.commands.registerCommand('aiEffortTracker.deleteWorkItem', (workItemId?: string) =>
      deleteWorkItemCmd(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setWorkItemEstimate', (workItemId?: string) =>
      setWorkItemEstimate(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setBillableHours', (workItemId?: string) =>
      setBillableHours(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.markWorkItemDone', (workItemId?: string) =>
      setWorkItemDone(workItemId, true)
    ),
    vscode.commands.registerCommand('aiEffortTracker.reopenWorkItem', (workItemId?: string) =>
      setWorkItemDone(workItemId, false)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setWorkItemBudget', (workItemId?: string) =>
      setWorkItemBudget(workItemId)
    ),
    vscode.commands.registerCommand('aiEffortTracker.setMonthlyCreditBudget', () => setMonthlyCreditBudget()),
    vscode.commands.registerCommand('aiEffortTracker.openWorkItem', async (workItemId?: string) => {
      const id = workItemId || await pickWorkItem('Open which work item?');
      if (!id) return;
      pendingOpenWorkItem = id;
      if (dashboardPanel) {
        dashboardPanel.reveal(vscode.ViewColumn.One);
        flushPendingOpenWorkItem();
      } else {
        await openDashboard(db, timeTracker, context);
      }
    }),
    vscode.commands.registerCommand('aiEffortTracker.openDashboardTab', async (tab?: string) => {
      pendingOpenTab = typeof tab === 'string' && tab ? tab : 'optimize';
      if (dashboardPanel) {
        dashboardPanel.reveal(vscode.ViewColumn.One);
        flushPendingOpenWorkItem();
      } else {
        await openDashboard(db, timeTracker, context);
      }
    }),
    // #104: data health check + one-click repairs.
    vscode.commands.registerCommand('aiEffortTracker.checkDataHealth', async () => {
      const r = healthReport();
      await vscode.commands.executeCommand('aiEffortTracker.openDashboardTab', 'health');
      const msg = r.status === 'ok'
        ? 'AI Effort Tracker: data health OK \u2013 no problems found.'
        : `AI Effort Tracker: data health ${r.score}/100 \u2013 ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} hints.`;
      if (r.counts.error) void vscode.window.showWarningMessage(msg); else void vscode.window.showInformationMessage(msg);
    }),
    vscode.commands.registerCommand('aiEffortTracker.fixDataHealth', (checkId?: string) => fixDataHealth(checkId)),
    // #6: full backup, restore and data folder.
    vscode.commands.registerCommand('aiEffortTracker.revealDataFolder', () =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(context.globalStorageUri.fsPath, 'effort-tracker.json')))),
    vscode.commands.registerCommand('aiEffortTracker.exportBackup', () => exportBackup(context)),
    vscode.commands.registerCommand('aiEffortTracker.restoreBackup', () => restoreBackup(context)),
    // #100: continue a large chat in a new one with a summary.
    vscode.commands.registerCommand('aiEffortTracker.newChatWithHandoff', (sessionId?: string) => newChatWithHandoff(db, context, sessionId)),
    // #101: timesheet week grid.
    vscode.commands.registerCommand('aiEffortTracker.openTimesheet', () =>
      vscode.commands.executeCommand('aiEffortTracker.openDashboardTab', 'timesheet')),
    // #132: label captured corrections.
    vscode.commands.registerCommand('aiEffortTracker.labelCorrections', () =>
      vscode.commands.executeCommand('aiEffortTracker.openDashboardTab', 'corrections')),
    // #134: approved rules → Copilot instructions files + review skill.
    vscode.commands.registerCommand('aiEffortTracker.exportLessons', () => exportLessons()),
    vscode.commands.registerCommand('aiEffortTracker.timesheetAddEntry', (arg?: string) => timesheetAddEntry(arg)),
    vscode.commands.registerCommand('aiEffortTracker.exportTimesheetCsv', (arg?: string) => exportTimesheetCsv(arg)),
    vscode.commands.registerCommand('aiEffortTracker.resetNudgeMutes', async () => {
      await nudgeController?.resetMutes();
      vscode.window.showInformationMessage('AI Effort Tracker: all live nudges are unmuted.');
    }),
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
    vscode.commands.registerCommand('aiEffortTracker.setDeveloperProfile', () =>
      setDeveloperProfile()
    ),
    vscode.commands.registerCommand('aiEffortTracker.createProject', () => createProject()),
    vscode.commands.registerCommand('aiEffortTracker.linkRepoToProject', () => linkRepoToProject()),
    vscode.commands.registerCommand('aiEffortTracker.createWorkItem', () => createWorkItem()),
    vscode.commands.registerCommand('aiEffortTracker.editWorkItem', () => editWorkItem()),
    vscode.commands.registerCommand('aiEffortTracker.assignWorkItemToProject', (workItemId?: string) => assignWorkItemToProject(workItemId)),
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
        vscode.window.showWarningMessage('No GitHub token. Set one in Dashboard → ⚙ Settings → Integrations (kept in secure storage) or sign in to GitHub in VS Code.');
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
    chatSessionUsageTracker,
    statusBar
  );

  timeTracker.startTracking();
  gitTracker.start(context);
  copilotTracker.start(context);
  // Use exactly one automatic source. Recorded debug logs take precedence;
  // disabling them opts into the export-folder mode or one legacy estimator.
  if (DebugLogUsageTracker.enabled()) {
    // A single live source: neither token estimates nor legacy request weights
    // may charge for the same model calls. Historical exports remain manual.
    debugLogUsageTracker.start();
  } else if (CreditImportTracker.isConfigured()) {
    creditImportTracker.start(context);
  } else if (vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('autoCaptureRealCredits') ?? true) {
    chatSessionUsageTracker.start(context);
  } else {
    chatUsageTracker.start(context);
  }
  context.subscriptions.push(debugLogUsageTracker, creditImportTracker);
  budgetMonitor = new BudgetMonitor(db, context.globalStorageUri.fsPath, () => ({ [HEALTH_SNAPSHOT_FILE]: { report: healthReport() } }));
  context.subscriptions.push(budgetMonitor);
  context.subscriptions.push(new AwayController(db, timeTracker, context.globalStorageUri.fsPath));
  try {
    reviewController = new ReviewController(context, context.globalStorageUri.fsPath);
    context.subscriptions.push(reviewController);
  } catch (error) {
    console.error('AI Effort Tracker: review tracking failed to start', error);
  }
  const corrections = new CorrectionStore(context.globalStorageUri.fsPath);
  correctionStore = corrections;
  lessonStore = new LessonStore(context.globalStorageUri.fsPath);
  try {
    const correctionTracker = new CorrectionTracker(db, corrections, () => DebugLogUsageTracker.enabled());
    copilotTracker.setEditListener(edit => correctionTracker.onEdit(edit));
    debugLogUsageTracker.onUserMessages = msgs => correctionTracker.onUserMessages(msgs);
    context.subscriptions.push(correctionTracker);
  } catch (error) {
    console.error('AI Effort Tracker: correction capture failed to start', error);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('aiEffortTracker.showCorrections', async () => {
      try {
        const content = correctionsMarkdown(listCorrections(corrections.load(), { limit: 500 }));
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        vscode.window.showErrorMessage(`AI Effort Tracker: cannot read corrections: ${String(error)}`);
      }
    })
  );
  try { registerUsageInsightsMcp(context); } catch (error) {
    console.error('AI Effort Tracker: MCP server registration failed', error);
  }
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
  dashFilter = normalizeFilter(context.globalState.get('dashboardFilter'));
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
  const initialNet = await GitTracker.getNetLineChange();
  if (initialNet) db.seedEffectiveLinesFromGit(initialNet.branch, initialNet.byCategory);
  dashboardPanel.webview.html = renderDashboardHtml(db.getAllBranchesSummaries(), branch, nonce, ghMetrics, getInsightsConfig(), getAnalytics(), lastBilling, db.getAllProjectSummaries(), withRework(withReview(db.getAllWorkItemSummaries())), db.getCreditEntries(),   db.getManualEffort(), db.getReassignments(), initialNet, dashFilter);

  dashboardPanel.webview.onDidReceiveMessage(async (m) => {
    if (m?.type === 'ready') { flushPendingOpenWorkItem(); return; }
      if (m?.type === 'filter') {
        dashFilter = normalizeFilter(m.filter);
        void context.globalState.update('dashboardFilter', dashFilter);
        refreshDashboard();
        return;
      }
      if (m?.type === 'optimize') {
        dashboardPanel?.webview.postMessage({ type: 'optimizeData', ...optimizePayload(m.days, m.workItemId, m.projectId, m.from, m.to) });
        return;
      }
    if (m?.type === 'health') {
      dashboardPanel?.webview.postMessage({ type: 'healthData', report: healthReport() });
      return;
    }
    if (m?.type === 'corrections' || m?.type === 'labelCorrections' || m?.type === 'acceptCorrectionSuggestions') {
      try {
        if (m.type === 'labelCorrections' && Array.isArray(m.ids) && correctionStore) {
          const ids = m.ids.filter((x: unknown): x is string => typeof x === 'string');
          correctionStore.apply(labelDelta(correctionStore.load(), ids, {
            category: typeof m.category === 'string' ? m.category : '',
            ...(typeof m.scope === 'string' ? { scope: m.scope } : {}),
            ...(typeof m.note === 'string' ? { note: m.note } : {})
          }, 'user'));
        } else if (m.type === 'acceptCorrectionSuggestions') {
          correctionStore?.apply(acceptSuggestionsDelta(correctionsPayload()));
        }
        dashboardPanel?.webview.postMessage({ type: 'correctionsData', ...correctionsPayload() });
      } catch (error) {
        dashboardPanel?.webview.postMessage({ type: 'correctionsData', error: String(error) });
      }
      return;
    }
    if (m?.type === 'lessonRule' || m?.type === 'exportLessons') {
      try {
        if (m.type === 'exportLessons') await exportLessons();
        else applyRuleMessage(m);
      } catch (error) {
        void vscode.window.showWarningMessage(`AI Effort Tracker: ${error instanceof Error ? error.message : String(error)}`);
      }
      dashboardPanel?.webview.postMessage({ type: 'correctionsData', ...correctionsPayload() });
      return;
    }
    if (m?.type === 'timesheet') {
      dashboardPanel?.webview.postMessage({ type: 'timesheetData', ...timesheetPayload(m.weekStart, m.rounding) });
      return;
    }
    if (m?.type === 'estimates') {
      dashboardPanel?.webview.postMessage({ type: 'estimatesData', ...estimatesPayload(m.projectId, m.workItemId) });
      return;
    }
    if (m && typeof m === 'object' && await handleSettingsMessage(m, context, ghService, msg => dashboardPanel?.webview.postMessage(msg))) {
      if (m.type === 'setToken' || m.type === 'clearToken' || m.type === 'moveTokenToSecure') {
        try { lastBilling = await ghService.getBillingUsage(); } catch { /* ignore */ }
      }
      return;
    }
    if (m && typeof m === 'object' && await handleSessionsMessage(m, db, context, msg => dashboardPanel?.webview.postMessage(msg))) return;
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

    const netChange = await GitTracker.getNetLineChange();
    if (netChange) db.seedEffectiveLinesFromGit(netChange.branch, netChange.byCategory);
    dashboardPanel.webview.postMessage({
      type: 'update',
      summaries: db.getAllBranchesSummaries(),
      currentBranch,
      ghMetrics: ghData,
      config: getInsightsConfig(),
      analytics: getAnalytics(),
      billing: lastBilling,
      projectSummaries: db.getAllProjectSummaries(),
      workItemSummaries: withRework(withReview(db.getAllWorkItemSummaries())),
      ledger: db.getCreditEntries(),
      manualEffort: db.getManualEffort(),
      reassignments: db.getReassignments(),
      netChange
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

  // #97: suggest from finished comparable work items (hours only).
  const target = db.getWorkItem(workItemId);
  const suggestion = unit === 'hours'
    ? suggestEstimate(estimationItems(), { title: target?.title, projectId: target?.projectId, excludeId: workItemId }, localDay())
    : null;

  type ModePick = vscode.QuickPickItem & { mode: 'total' | 'breakdown' | 'suggested' };
  const modeItems: ModePick[] = [];
  if (suggestion?.hours && suggestion.hours.median > 0) {
    modeItems.push({
      label: `$(lightbulb) Use suggestion: ${suggestion.hours.median} h`,
      mode: 'suggested',
      description: `range ${suggestion.hours.low}–${suggestion.hours.high} h`,
      detail: suggestion.note + (suggestion.comparables.length
        ? ' Based on ' + suggestion.comparables.slice(0, 3).map(c => `#${c.id} (${c.actualHours} h)`).join(', ') : '')
    });
  }
  modeItems.push(
    { label: 'Single total', mode: 'total', detail: 'Enter one overall estimate' },
    { label: 'Per-category breakdown', mode: 'breakdown', detail: 'Programming / specification / documentation / deployment' }
  );
  const modePick = await vscode.window.showQuickPick<ModePick>(modeItems, { placeHolder: 'How do you want to estimate?' });
  if (!modePick) return;

  const parseNum = (v: string): string | null => {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? null : 'Enter a non-negative number';
  };

  if (modePick.mode === 'suggested' && suggestion?.hours) {
    db.setEstimateBreakdown(workItemId, null);
    db.upsertWorkItem(workItemId, { estimate: suggestion.hours.median, estimateUnit: unit });
  } else if (modePick.mode === 'total') {
    const hint = suggestion?.hours ? ` — similar work took ${suggestion.hours.low}–${suggestion.hours.high} h` : '';
    const raw = await vscode.window.showInputBox({
      prompt: `Total estimate for #${workItemId} (${unit})${hint}`,
      value: db.getWorkItemSummary(workItemId).estimate?.toString() ?? '',
      validateInput: v => (v.trim() ? parseNum(v) : 'Enter a number')
    });
    if (raw === undefined) return;
    // Setting a scalar total clears any prior breakdown so the two never disagree.
    db.setEstimateBreakdown(workItemId, null);
    db.upsertWorkItem(workItemId, { estimate: Number(raw), estimateUnit: unit });
  } else {
    const categories: FileCategory[] = ['programming', 'specification', 'documentation', 'translation', 'deployment'];
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
  refreshDashboard();
  // #98: surface the historical bias so the user can correct optimistic estimates.
  const adjusted = unit === 'hours' && total !== null ? adjustForBias(total, suggestion?.biasFactor ?? null) : null;
  if (adjusted !== null && suggestion?.biasFactor !== null && Math.abs((suggestion?.biasFactor ?? 1) - 1) > 0.2 && adjusted !== total) {
    const use = `Use ${adjusted} h`;
    const choice = await vscode.window.showInformationMessage(
      `Estimate for #${workItemId} set to ${total} h. Historically your actuals run ${suggestion!.biasFactor}× your estimates ` +
      `(${suggestion!.biasSamples} finished items) — a bias-adjusted estimate is ${adjusted} h.`,
      use, 'Keep'
    );
    if (choice === use) {
      db.setEstimateBreakdown(workItemId, null);
      db.upsertWorkItem(workItemId, { estimate: adjusted, estimateUnit: 'hours' });
      refreshDashboard();
    }
    return;
  }
  vscode.window.showInformationMessage(
    `Estimate for #${workItemId} set to ${total} ${unit}.`
  );
}

/** All work items projected for the estimation engine (issues #97/#98). */
function estimationItems() {
  return db.getAllWorkItemSummaries()
    .filter(s => s.workItemId !== UNASSIGNED_WORK_ITEM_ID && s.workItemId !== 'unknown')
    .map(toEstimationItem);
}

/** Today's local date as YYYY-MM-DD. */
function localDay(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Mark a work item done or reopen it (issue #97). `arg` is the id or "id\u0000reopen". */
async function setWorkItemDone(arg: string | undefined, done: boolean) {
  const id = arg || await pickWorkItem(done ? 'Mark which work item as done?' : 'Reopen which work item?');
  if (!id) return;
  db.setWorkItemStatus(id, done ? 'done' : 'active');
  refreshDashboard();
  if (!done) { vscode.window.showInformationMessage(`#${id} reopened.`); return; }
  const s = db.getWorkItemSummary(id);
  const actual = Math.round((s.humanCodingMs + s.aiGeneratingMs + s.reviewingMs) / 36_000) / 100;
  const est = s.estimate !== null && (s.estimateUnit ?? 'hours') === 'hours' ? s.estimate : null;
  vscode.window.showInformationMessage(est
    ? `#${id} done: ${actual} h actual vs ${est} h estimated (${Math.round(actual / est * 100)} %).`
    : `#${id} marked done (${actual} h actual). It now counts toward estimate suggestions.`);
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

/** Ask the dashboard (once its script is ready) to show a work item's detail or a tab. */
function flushPendingOpenWorkItem() {
  if (!dashboardPanel) return;
  if (pendingOpenTab) {
    const tab = pendingOpenTab;
    pendingOpenTab = undefined;
    void dashboardPanel.webview.postMessage({ type: 'openTab', tab });
  }
  if (!pendingOpenWorkItem) return;
  const id = pendingOpenWorkItem;
  pendingOpenWorkItem = undefined;
  void dashboardPanel.webview.postMessage({ type: 'openWorkItem', id });
}

/**
 * Set or clear a work item's explicit credit and money budgets (issue #94).
 * Blank input clears the override so the budget is derived from the estimate.
 */
async function setWorkItemBudget(arg?: string) {
  const id = arg || await pickWorkItem('Set a budget for which work item?');
  if (!id) return;
  const wi = db.getWorkItem(id);
  const summary = db.getWorkItemSummary(id);
  const b = summary.budget;
  const currency = summary.roi?.currency ?? '';
  const ask = async (prompt: string, current: number | undefined, derived: string) => {
    const raw = await vscode.window.showInputBox({
      prompt,
      value: typeof current === 'number' ? String(current) : '',
      placeHolder: derived,
      validateInput: v => {
        if (!v.trim()) return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? null : 'Enter a non-negative number (or leave blank to derive it)';
      }
    });
    if (raw === undefined) return { ok: false as const };
    const n = raw.trim() ? Number(raw) : 0;
    return { ok: true as const, value: n > 0 ? n : null };
  };
  const derivedOf = (dim: 'credits' | 'cost', unit: string) => {
    const d = b?.dims[dim];
    return d && d.source !== 'explicit' ? `blank = derived ${d.budget} ${unit}` : 'blank = derive from the estimate (if possible)';
  };

  const credits = await ask(
    `Credit budget for #${id} \u2014 blank to derive it from estimate \u00d7 credits per estimated hour`,
    wi?.creditBudget, derivedOf('credits', 'credits')
  );
  if (!credits.ok) return;
  const cost = await ask(
    `Money budget${currency ? ` (${currency})` : ''} for #${id} \u2014 blank to derive it from estimate \u00d7 hourly cost + credit budget`,
    wi?.costBudget, derivedOf('cost', currency)
  );
  if (!cost.ok) return;

  db.setWorkItemBudget(id, { creditBudget: credits.value, costBudget: cost.value });
  const after = db.getWorkItemSummary(id).budget;
  vscode.window.showInformationMessage(
    after && after.state !== 'unestimated'
      ? `Budget for #${id} saved \u2014 ${after.pct}% used (${after.worst}).`
      : `Budget for #${id} saved. Set an hour estimate or a budget to track consumption.`
  );
  refreshDashboard();
  void budgetMonitor?.refresh();
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
 * Seniority presets for issue #13: a sensible hand-coding baseline (lines of code
 * per minute) per seniority level. These PRE-FILL the single global
 * `aiEffortTracker.baselineLocPerMinute` setting the ROI/generated-value math reads
 * ({@link getInsightsConfig}, `Database.readBaselineLocPerMinute`) — they are only a
 * starting point and the user's adjusted value always wins and persists. `custom`
 * intentionally has no preset: it means "leave the baseline as-is, don't auto-fill".
 */
type Seniority = keyof typeof SENIORITY_PRESETS | 'custom';

/**
 * Resolve the effective baseline lines/min for a work category (issue #13, optional
 * per-category baselines). Prefers a finite, positive value from
 * `aiEffortTracker.baselineLocPerMinuteByCategory[category]`, else falls back to the
 * flat `aiEffortTracker.baselineLocPerMinute` (default 5). Exposed additively for
 * future wiring; the #48 generated-value math still uses the flat baseline as its
 * effective input (see `Database.readBaselineLocPerMinute`), so this never changes
 * existing behaviour. Never throws; returns the flat baseline when the per-category
 * map is missing/unusable.
 */
export function resolveBaselineLocPerMinute(category?: string): number {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  const flat = c.get<number>('baselineLocPerMinute');
  const flatBaseline =
    typeof flat === 'number' && Number.isFinite(flat) && flat > 0 ? flat : 5;
  if (!category) return flatBaseline;
  const byCat = c.get<Record<string, number>>('baselineLocPerMinuteByCategory');
  const v = byCat?.[category];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : flatBaseline;
}

/**
 * Set the developer profile (issue #13): pick a seniority level whose preset
 * PRE-FILLS the global baseline lines-of-code-per-minute, then adjust that value in
 * an InputBox. The seniority is stored in `aiEffortTracker.seniority` and the
 * (possibly-adjusted) number is written to `aiEffortTracker.baselineLocPerMinute` —
 * the single source the generated-value / ROI math reads, so no read path is forked.
 *
 * Acceptance: the preset fills a sensible default that REMAINS EDITABLE — the user's
 * adjusted value wins and persists. Choosing `custom` skips the auto-fill and simply
 * lets them edit the raw baseline, and leaving it blank/unchanged never clobbers an
 * existing baseline. All writes go through the VS Code settings API
 * (`ConfigurationTarget.Global`), never the store.
 */
export async function setDeveloperProfile() {
  const c = vscode.workspace.getConfiguration('aiEffortTracker');
  const currentLevel = (c.get<string>('seniority') ?? 'custom') as Seniority;
  const currentBaselineRaw = c.get<number>('baselineLocPerMinute');
  const currentBaseline =
    typeof currentBaselineRaw === 'number' && Number.isFinite(currentBaselineRaw) && currentBaselineRaw > 0
      ? currentBaselineRaw
      : 5;

  type LevelPick = vscode.QuickPickItem & { level: Seniority };
  const picks: LevelPick[] = [
    {
      level: 'junior',
      label: (currentLevel === 'junior' ? '\u25b6 ' : '') + 'Junior',
      detail: `Preset baseline ${SENIORITY_PRESETS.junior} lines/min`,
    },
    {
      level: 'mid',
      label: (currentLevel === 'mid' ? '\u25b6 ' : '') + 'Mid-level',
      detail: `Preset baseline ${SENIORITY_PRESETS.mid} lines/min`,
    },
    {
      level: 'senior',
      label: (currentLevel === 'senior' ? '\u25b6 ' : '') + 'Senior',
      detail: `Preset baseline ${SENIORITY_PRESETS.senior} lines/min`,
    },
    {
      level: 'custom',
      label: (currentLevel === 'custom' ? '\u25b6 ' : '') + 'Custom',
      detail: `No auto-fill — keep your current baseline (${currentBaseline} lines/min)`,
    },
  ];

  const chosen = await vscode.window.showQuickPick(picks, {
    title: 'Developer Profile — Seniority',
    placeHolder: 'Pick a seniority level; its preset pre-fills your baseline (still editable)',
  });
  if (!chosen) return;

  const level = chosen.level;
  await c.update('seniority', level, vscode.ConfigurationTarget.Global);

  // A preset fills a sensible default; `custom` keeps the current baseline. Either
  // way the value stays editable and whatever the user types wins.
  const prefill = level === 'custom' ? currentBaseline : SENIORITY_PRESETS[level];

  const raw = await vscode.window.showInputBox({
    title: `Developer Profile — Baseline (${level})`,
    prompt:
      `Baseline hand-coding speed in lines of code per minute (used to estimate time saved by AI). ` +
      (level === 'custom'
        ? 'Adjust as you like.'
        : `Pre-filled from the ${level} preset — adjust up or down to fit you.`),
    value: String(prefill),
    validateInput: v => {
      if (!v.trim()) return null; // blank = keep current baseline
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? null : 'Enter a positive number';
    },
  });
  if (raw === undefined) return; // cancelled — seniority was still updated above

  if (!raw.trim()) {
    // Blank: never clobber the existing baseline.
    vscode.window.showInformationMessage(
      `Developer profile set to ${level}. Baseline left at ${currentBaseline} lines/min.`
    );
  } else {
    const value = Number(raw);
    await c.update('baselineLocPerMinute', value, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Developer profile set to ${level}. Baseline is now ${value} lines/min.`
    );
  }
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
  const creditsPerHour = await numInput(
    `Credit budget per estimated hour for "${projectLabel}" work items (issue #94) \u2014 blank to inherit the global setting`,
    existing.creditsPerEstimatedHour
  );
  if (!creditsPerHour.ok) return;

  // Merge onto existing settings; assigning undefined clears an override.
  const settings = { ...existing };
  settings.hourlyCostRate = cost.value;
  settings.hourlySellRate = sell.value;
  settings.currency = currencyRaw.trim() ? currencyRaw.trim() : undefined;
  settings.creditCostPerUnit = creditCost.value;
  settings.creditsPerEstimatedHour = creditsPerHour.value && creditsPerHour.value > 0 ? creditsPerHour.value : undefined;
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

/**
 * Delete a work item the user created by mistake (zero-loss). Confirms the detach
 * impact first, then removes the entity — its branches, credit entries, manual
 * effort and work-item-direct time entries move to "Unassigned" (nothing is
 * destroyed) and can be re-homed afterwards. Invoked from the work-item detail
 * (passes the id) or the command palette (prompts for one).
 */
async function deleteWorkItemCmd(workItemId?: string) {
  const id = workItemId ?? await pickWorkItem('Delete which work item?');
  if (!id) return;
  const wi = db.getWorkItem(id);
  if (!wi) {
    vscode.window.showWarningMessage(`Work item #${id} not found.`);
    return;
  }
  const imp = db.workItemDeletionImpact(id);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (imp.branches) parts.push(plural(imp.branches, 'branch', 'branches'));
  if (imp.ledger) parts.push(plural(imp.ledger, 'credit entry', 'credit entries'));
  if (imp.manualEffort) parts.push(plural(imp.manualEffort, 'manual-effort entry', 'manual-effort entries'));
  if (imp.timeEntries) parts.push(plural(imp.timeEntries, 'time-log entry', 'time-log entries'));
  const detail = parts.length
    ? `\n\nIts ${parts.join(', ')} will move to "Unassigned" (nothing is deleted) \u2014 you can re-assign them afterwards.`
    : '\n\nIt has no attached data.';
  const label = wi.title ? `#${id} \u2014 ${wi.title}` : `#${id}`;
  const ok = await vscode.window.showWarningMessage(
    `Delete work item ${label}?${detail}`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  const res = db.deleteWorkItem(id);
  if (res.removed) {
    vscode.window.showInformationMessage(`Work item #${id} deleted.`);
    refreshDashboard();
  } else {
    vscode.window.showWarningMessage(`Work item #${id} could not be deleted.`);
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

// ---- Time Log entries (issue #60) -----------------------------------------

/** Short human label for a time-log entry, used in QuickPicks and messages. */
function timeEntryLabel(e: TimeEntry): string {
  const when = new Date(e.startTs ?? e.createdAt).toLocaleString();
  const bits: string[] = [fmtDuration(e.durationMs)];
  if (e.mode) bits.push(modeLabel(e.mode));
  if (e.category) bits.push(e.category);
  const attr = e.workItemId
    ? `#${e.workItemId}`
    : e.branch
      ? e.branch
      : e.projectId
        ? `project ${e.projectId}`
        : 'unattached';
  const note = e.note ? ` \u2014 ${e.note}` : '';
  return `${attr} \u00b7 ${bits.join(' \u00b7 ')} \u00b7 ${when}${note}`;
}

/**
 * Pick a work item for a time-log entry, allowing "No work item" (for work not
 * tied to any item) and "New work item…". Returns a work-item id, `null` for
 * none, or {@link CANCELLED} on escape.
 */
async function pickWorkItemOptional(
  placeHolder: string,
  current?: string | null
): Promise<string | null | typeof CANCELLED> {
  type WiPick = vscode.QuickPickItem & { id?: string; none?: boolean; create?: boolean };
  const items = db.getAllWorkItems().filter(
    w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID
  );
  const picks: WiPick[] = [
    { label: '$(circle-slash) No work item', none: true, description: current == null ? 'current' : undefined },
    ...items.map(w => ({
      label: (w.id === current ? '\u25b6 ' : '') + '#' + w.id,
      description: w.title ?? undefined,
      id: w.id
    })),
    { label: '$(add) New work item\u2026', create: true }
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
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
  return picked.id ?? null;
}

/**
 * Pick a branch for a time-log entry, allowing "No branch" so work done outside
 * VS Code can attach to a work item/project only. Returns a branch name, `null`
 * for none, or {@link CANCELLED} on escape.
 */
async function pickBranchOptional(
  placeHolder: string,
  current?: string | null
): Promise<string | null | typeof CANCELLED> {
  type BP = vscode.QuickPickItem & { branch?: string; none?: boolean };
  const summaries = db.getAllBranchesSummaries();
  const picks: BP[] = [
    { label: '$(circle-slash) No branch (work outside VS Code)', none: true, description: current == null ? 'current' : undefined },
    ...summaries.map(s => ({
      label: (s.branch === current ? '\u25b6 ' : '') + s.branch,
      description: s.workItemId ? '#' + s.workItemId : undefined,
      branch: s.branch
    }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
  return picked.branch ?? null;
}

/** Pick a descriptive category for a time-log entry, or "No category" (`null`). */
async function pickTimeEntryCategory(
  placeHolder: string,
  current?: TimeEntryCategory | null
): Promise<TimeEntryCategory | null | typeof CANCELLED> {
  type CP = vscode.QuickPickItem & { cat?: TimeEntryCategory; none?: boolean };
  const picks: CP[] = [
    { label: '$(circle-slash) No category', none: true, description: current == null ? 'current' : undefined },
    ...TIME_ENTRY_CATEGORIES.map(c => ({ label: (c === current ? '\u25b6 ' : '') + c, cat: c }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
  return picked.cat ?? null;
}

/**
 * Pick a {@link TrackingMode} for a time-log entry. "Default (human coding)"
 * returns `null` — the roll-up then counts the entry as billable human-coding
 * time. Returns {@link CANCELLED} on escape.
 */
async function pickTimeEntryMode(
  placeHolder: string,
  current?: TrackingMode | null
): Promise<TrackingMode | null | typeof CANCELLED> {
  type MP = vscode.QuickPickItem & { mode?: TrackingMode; none?: boolean };
  const modes: TrackingMode[] = ['humanCoding', 'aiGenerating', 'reviewing', 'idle'];
  const picks: MP[] = [
    { label: '$(circle-slash) Default (human coding)', none: true, description: current == null ? 'current' : undefined },
    ...modes.map(m => ({ label: (m === current ? '\u25b6 ' : '') + modeLabel(m), mode: m }))
  ];
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!picked) return CANCELLED;
  if (picked.none) return null;
  return picked.mode ?? null;
}

/** A resolved time specification: either a direct duration OR a start/end interval. */
type TimeSpec = { startTs?: number; endTs?: number; durationMs?: number };

/**
 * Prompt for a time-log entry's time, either as a direct duration or a
 * start+end interval (the store derives the duration from the interval). Returns
 * the spec, `undefined` when nothing usable was entered, or {@link CANCELLED} on
 * escape.
 */
async function promptTimeSpec(
  defaults?: TimeSpec
): Promise<TimeSpec | undefined | typeof CANCELLED> {
  type MP = vscode.QuickPickItem & { value: 'dur' | 'interval' };
  const method = await vscode.window.showQuickPick<MP>(
    [
      { label: '$(watch) Enter a duration', value: 'dur' },
      { label: '$(calendar) Enter start and end times', value: 'interval' }
    ],
    { placeHolder: 'How do you want to log this time?' }
  );
  if (!method) return CANCELLED;
  if (method.value === 'dur') {
    const dur = await promptDurationMs('How long? (e.g. 90 or 1:30)', defaults?.durationMs);
    if (dur === CANCELLED) return CANCELLED;
    if (dur === undefined || dur <= 0) return undefined;
    return { durationMs: dur };
  }
  const start = await promptTimestamp('Start time', defaults?.startTs ?? Date.now());
  if (start === CANCELLED) return CANCELLED;
  const end = await promptTimestamp('End time', defaults?.endTs ?? (start ?? Date.now()));
  if (end === CANCELLED) return CANCELLED;
  if (start === undefined || end === undefined || end < start) {
    vscode.window.showWarningMessage('Need a valid start and end (end at or after start).');
    return undefined;
  }
  return { startTs: start, endTs: end };
}

/**
 * Add a Time Log entry (issue #60). `arg` from the dashboard encodes
 * "workItemId\u0000branch" (either part may be empty). From the palette, the user
 * picks a work item and/or branch (allowing "work item only, no branch" for work
 * done outside VS Code), then either a direct duration or a start/end interval,
 * plus an optional category, mode and note. Written to the SEPARATE timeEntries
 * store; auto-capture is untouched.
 */
async function addTimeEntry(arg?: string) {
  let workItemId: string | undefined;
  let branch: string | undefined;
  let fromDashboard = false;
  if (arg) {
    fromDashboard = true;
    const sep = arg.indexOf('\u0000');
    if (sep >= 0) {
      workItemId = arg.slice(0, sep) || undefined;
      branch = arg.slice(sep + 1) || undefined;
    } else {
      workItemId = arg || undefined;
    }
  }

  if (!fromDashboard) {
    const wi = await pickWorkItemOptional('Log time to which work item? (or none)');
    if (wi === CANCELLED) return;
    workItemId = wi ?? undefined;
    const br = await pickBranchOptional('Attach to which branch? (or none for non-VS-Code work)');
    if (br === CANCELLED) return;
    branch = br ?? undefined;
  }

  if (!workItemId && !branch) {
    vscode.window.showWarningMessage('Pick a work item and/or a branch to log time against.');
    return;
  }

  const spec = await promptTimeSpec();
  if (spec === CANCELLED) return;
  if (!spec) {
    vscode.window.showWarningMessage('No time entered \u2014 nothing logged.');
    return;
  }

  const input: TimeEntryInput = { source: 'manual' };
  if (workItemId) input.workItemId = workItemId;
  if (branch) input.branch = branch;
  if (spec.durationMs !== undefined) input.durationMs = spec.durationMs;
  if (spec.startTs !== undefined) input.startTs = spec.startTs;
  if (spec.endTs !== undefined) input.endTs = spec.endTs;

  const cat = await pickTimeEntryCategory('Category? (optional)');
  if (cat === CANCELLED) return;
  if (cat) input.category = cat;

  const mode = await pickTimeEntryMode('Kind of time? (optional)');
  if (mode === CANCELLED) return;
  if (mode) input.mode = mode;

  const note = await vscode.window.showInputBox({
    prompt: 'Note (optional)',
    placeHolder: 'e.g. pairing session, offline work'
  });
  if (note === undefined) return;
  if (note.trim()) input.note = note.trim();

  const entry = db.addTimeEntry(input);
  const target = workItemId ? `#${workItemId}` : branch;
  vscode.window.showInformationMessage(`Logged ${fmtDuration(entry.durationMs)} to ${target}.`);
  refreshDashboard();
}

/** QuickPick an existing time-log entry (newest-first). */
async function pickTimeEntry(placeHolder: string): Promise<TimeEntry | undefined> {
  const entries = db.getTimeEntries();
  if (entries.length === 0) {
    vscode.window.showWarningMessage('No time-log entries yet. Add one with "Add Time Entry" first.');
    return undefined;
  }
  type EP = vscode.QuickPickItem & { entry: TimeEntry };
  const picks: EP[] = entries.map(e => ({ label: timeEntryLabel(e), entry: e }));
  const picked = await vscode.window.showQuickPick(picks, { placeHolder });
  return picked?.entry;
}

/** Resolve a time-log entry from a dashboard-supplied id or, failing that, a QuickPick. */
async function resolveTimeEntry(id: string | undefined, placeHolder: string): Promise<TimeEntry | undefined> {
  if (id) {
    const found = db.getTimeEntries().find(e => e.id === id);
    if (!found) {
      vscode.window.showWarningMessage('That time entry no longer exists.');
      return undefined;
    }
    return found;
  }
  return pickTimeEntry(placeHolder);
}

/**
 * Edit a Time Log entry (issue #60). Re-runs the prompts pre-filled with current
 * values and writes a patch. Choosing "No work item"/"No branch"/"No category"/
 * "Default" clears those fields. Escaping any prompt cancels. Safe when the row
 * was deleted meanwhile.
 */
async function editTimeEntry(id?: string) {
  const entry = await resolveTimeEntry(id, 'Edit which time entry?');
  if (!entry) return;

  const wi = await pickWorkItemOptional('Work item (or none)', entry.workItemId ?? null);
  if (wi === CANCELLED) return;
  const br = await pickBranchOptional('Branch (or none)', entry.branch ?? null);
  if (br === CANCELLED) return;

  const spec = await promptTimeSpec({ startTs: entry.startTs, endTs: entry.endTs, durationMs: entry.durationMs });
  if (spec === CANCELLED) return;
  if (!spec) {
    vscode.window.showWarningMessage('No time entered \u2014 entry unchanged.');
    return;
  }

  const cat = await pickTimeEntryCategory('Category? (optional)', entry.category ?? null);
  if (cat === CANCELLED) return;
  const mode = await pickTimeEntryMode('Kind of time? (optional)', entry.mode ?? null);
  if (mode === CANCELLED) return;
  const noteIn = await vscode.window.showInputBox({ prompt: 'Note (optional)', value: entry.note ?? '' });
  if (noteIn === undefined) return;

  const patch: TimeEntryPatch = {
    workItemId: wi,
    branch: br,
    category: cat,
    mode,
    note: noteIn.trim() ? noteIn.trim() : null
  };
  if (spec.durationMs !== undefined) {
    // Direct duration: drop any prior interval so start/end don't override it.
    patch.durationMs = spec.durationMs;
    patch.startTs = null;
    patch.endTs = null;
  } else {
    patch.startTs = spec.startTs ?? null;
    patch.endTs = spec.endTs ?? null;
  }

  const updated = db.updateTimeEntry(entry.id, patch);
  if (!updated) {
    vscode.window.showWarningMessage('That time entry no longer exists.');
    return;
  }
  vscode.window.showInformationMessage(`Updated time entry (${fmtDuration(updated.durationMs)}).`);
  refreshDashboard();
}

/** Delete a Time Log entry (issue #60) after a confirmation modal. */
async function deleteTimeEntry(id?: string) {
  const entry = await resolveTimeEntry(id, 'Delete which time entry?');
  if (!entry) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete this time entry?\n\n${timeEntryLabel(entry)}`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  if (db.deleteTimeEntry(entry.id)) {
    vscode.window.showInformationMessage('Time entry deleted.');
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
async function assignWorkItemToProject(workItemId?: string) {
  const wi = workItemId || await pickWorkItem('Assign which work item to a project?');
  if (!wi) return;
  const current = db.getWorkItem(wi)?.projectId ?? null;
  const sel = await pickProjectOrNone(`Assign #${wi} to which project?`, current);
  if (sel === undefined) return;
  db.setProjectForWorkItem(wi, sel);
  const name = sel ? (db.getProject(sel)?.name ?? sel) : 'no project';
  vscode.window.showInformationMessage(`Work item #${wi} assigned to ${name}.`);
  refreshDashboard();
}

/** Correction rate (#130), recomputed at most every 30 seconds or when corrections/rules change. */
let rateMemo: { key: unknown[]; report: CorrectionRateReport } | undefined;
function correctionRate(): CorrectionRateReport | undefined {
  if (!correctionStore) return undefined;
  const data = correctionStore.load();
  const lessons = lessonStore?.load();
  const key = [data, lessons, Math.floor(Date.now() / 30_000)];
  if (rateMemo && rateMemo.key.every((k, i) => k === key[i])) return rateMemo.report;
  const inputs = db.getCorrectionRateInputs();
  const report = correctionRateReport(data.corrections, inputs.aiDays, lessons?.rules ?? [], {
    ...inputs, since: correctionTrackingSince(data)
  });
  rateMemo = { key, report };
  return report;
}

/** Overview card (#130): headline rate, trend and top categories; undefined until something was corrected. */
function correctionRateOverview() {
  const r = correctionRate();
  if (!r || !r.total.corrections) return undefined;
  return {
    since: r.since, total: r.total, recent: r.recent, previous: r.previous, trendWeeks: r.trendWeeks,
    weeks: r.weeks.slice(-8).map(w => ({ week: w.week, rate: w.rate, aiLines: w.aiLines, correctedLines: w.correctedLines })),
    categories: r.categories.slice(0, 6)
  };
}

/** Work item ROI (#130): estimated rework time and corrected AI lines per work item. */
function withRework<T extends { workItemId: string }>(list: T[]): (T & { rework?: unknown })[] {
  const r = correctionRate();
  if (!r) return list;
  const by = new Map(r.workItems.map(g => [g.key, g]));
  return list.map(w => {
    const g = by.get(w.workItemId);
    return g ? { ...w, rework: { ms: g.reworkMs, episodes: g.episodes, corrections: g.corrections, correctedLines: g.correctedLines, aiLines: g.aiLines, rate: g.rate } } : w;
  });
}

/** Corrections tab (#132): captured corrections with labels and suggestions, plus rules (#133). */
function correctionsPayload() {
  const cfg = vscode.workspace.getConfiguration('aiEffortTracker.corrections');
  const categories = cfg.get<string[]>('categories');
  const rules = cfg.get<unknown>('keywordRules');
  const data = correctionStore?.load() ?? { version: 1 as const, owned: {}, corrections: [] };
  const view = correctionsView(
    data,
    Array.isArray(categories) && categories.length ? categories : DEFAULT_LESSON_CATEGORIES,
    Array.isArray(rules) ? rules : DEFAULT_KEYWORD_RULES
  );
  const lcfg = vscode.workspace.getConfiguration('aiEffortTracker.lessons');
  const lessonRules = lessonStore?.load().rules ?? [];
  return {
    ...view,
    lessons: {
      rules: lessonRules,
      groups: lessonGroups(data.corrections, lessonRules, { minOccurrences: lcfg.get<number>('minOccurrences'), minWorkItems: lcfg.get<number>('minWorkItems') }),
      minOccurrences: lcfg.get<number>('minOccurrences') ?? 3,
      minWorkItems: lcfg.get<number>('minWorkItems') ?? 2
    },
    rate: correctionRate()
  };
}

/** Rule changes from the Corrections tab (#133). */
function applyRuleMessage(m: { op?: unknown; id?: unknown; rule?: unknown; patch?: unknown }): void {
  if (!lessonStore) throw new Error('The rules store is not available.');
  const s = (v: unknown) => typeof v === 'string' ? v : undefined;
  const rec = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : {};
  if (m.op === 'create') {
    const r = rec(m.rule);
    const rule = createRule({
      category: s(r.category) ?? '', scope: s(r.scope) ?? '**', text: s(r.text) ?? '',
      examples: Array.isArray(r.examples) ? r.examples.filter((x): x is string => typeof x === 'string') : [],
      ...(s(r.repo) ? { repo: s(r.repo) } : {})
    }, 'user');
    lessonStore.apply({ upsert: [rule], remove: [] });
    return;
  }
  const id = s(m.id);
  const current = lessonStore.load().rules.find(r => r.id === id);
  if (!id || !current) throw new Error('This rule no longer exists. Refresh the tab.');
  if (m.op === 'delete') { lessonStore.apply({ upsert: [], remove: [id] }); return; }
  if (m.op === 'update') {
    const p = rec(m.patch);
    const patch: RulePatch = {
      ...(s(p.category) !== undefined ? { category: s(p.category) } : {}),
      ...(s(p.scope) !== undefined ? { scope: s(p.scope) } : {}),
      ...(s(p.text) !== undefined ? { text: s(p.text) } : {}),
      ...(s(p.repo) !== undefined ? { repo: s(p.repo) } : {}),
      ...(s(p.status) !== undefined ? { status: s(p.status) as RuleStatus } : {})
    };
    lessonStore.apply({ upsert: [updateRule(current, patch)], remove: [] });
  }
}

/** #134: writes the approved rules as Copilot instructions files and the review skill. */
async function exportLessons(): Promise<void> {
  if (!lessonStore) throw new Error('The rules store is not available.');
  const rules: LessonRule[] = lessonStore.load().rules;
  const cfg = vscode.workspace.getConfiguration('aiEffortTracker.lessons');
  const folderSetting = (cfg.get<string>('exportFolder') ?? '').trim();
  const skillMode = cfg.get<string>('reviewSkill') ?? 'personal';
  const folders = vscode.workspace.workspaceFolders ?? [];
  const targets: Array<{ dir: string; rules: LessonRule[]; skillsDir?: string }> = [];
  const personalSkills = skillMode === 'personal' ? path.join(os.homedir(), '.copilot', 'skills') : undefined;
  if (folderSetting && path.isAbsolute(folderSetting)) {
    targets.push({ dir: folderSetting, rules, skillsDir: personalSkills });
  } else {
    if (!folders.length) throw new Error('Open a folder to export the rules into, or set aiEffortTracker.lessons.exportFolder to an absolute folder.');
    folders.forEach((f, i) => targets.push({
      dir: path.resolve(f.uri.fsPath, folderSetting || path.join('.github', 'instructions')),
      rules: rulesForRepo(rules, f.name),
      skillsDir: skillMode === 'workspace' ? path.join(f.uri.fsPath, '.github', 'skills') : i === 0 ? personalSkills : undefined
    }));
  }
  const results = targets.map(t => writeLessonExport(t.rules, t.dir, t.skillsDir));
  const approved = results.reduce((n, r) => Math.max(n, r.rules), 0);
  const files = results.reduce((n, r) => n + r.written.length, 0);
  const removed = results.reduce((n, r) => n + r.removed.length, 0);
  const where = results.map(r => r.dir).join(', ');
  const skipped = results.flatMap(r => r.skipped);
  const msg = (approved
    ? `AI Effort Tracker: exported ${approved} approved rule${approved === 1 ? '' : 's'} into ${files} instructions file${files === 1 ? '' : 's'} in ${where}${removed ? ` (removed ${removed} old file${removed === 1 ? '' : 's'})` : ''}.`
    : `AI Effort Tracker: no approved rules to export${removed ? `; removed ${removed} old file${removed === 1 ? '' : 's'}` : ''}. Approve rules in the Corrections tab (Rules) first.`)
    + (skipped.length ? ` Kept your edited ${skipped.join(', ')} (no "${GENERATED_MARKER}" line).` : '');
  const open = results.find(r => r.written.length);
  void vscode.window.showInformationMessage(msg, ...(open ? ['Open file'] : [])).then(pick => {
    if (pick === 'Open file' && open) void vscode.window.showTextDocument(vscode.Uri.file(path.join(open.dir, open.written[0])));
  });
}

/** Data health (issue #104): store contents + file facts through the pure checker. */
function healthReport(): HealthReport {
  const h = db.getHealthData();
  const size = (p: string) => { try { return fs.statSync(p); } catch { return undefined; } };
  const main = size(h.filePath);
  let history: { size: number; mtime: number }[] = [];
  try {
    const dir = h.filePath + '.history';
    history = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
      .map(n => size(path.join(dir, n))).filter((s): s is fs.Stats => !!s).map(s => ({ size: s.size, mtime: s.mtimeMs }));
  } catch { /* no history yet */ }
  const oldest = history.sort((a, b) => a.mtime - b.mtime)[0];
  const rates: Record<string, { cost: number | null; sell: number | null }> = {};
  for (const p of db.getAllProjects()) {
    const r = db.getEffectiveRates(p.id);
    rates[p.id] = { cost: r.hourlyCostRate, sell: r.hourlySellRate };
  }
  return checkDataHealth(h.data, {
    schemaVersion: h.schemaVersion,
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    file: main ? {
      sizeBytes: main.size,
      hasBackup: !!size(h.filePath + '.bak'),
      historyCount: history.length,
      oldestHistoryBytes: oldest?.size ?? null,
      oldestHistoryAgeMs: oldest ? Date.now() - oldest.mtime : null
    } : undefined,
    lastSaveError: h.lastSaveError,
    rates,
    review: reviewCoverageByWorkItem(h.data.branches)
  });
}

/** Saved review coverage per work item across all its branches (#109); undefined when review tracking is off. */
function reviewCoverageByWorkItem(branches: Record<string, { workItemId: string | null }>): Record<string, { total: number; reviewed: number; openIssues: number }> | undefined {
  if (!reviewController || !(vscode.workspace.getConfiguration('aiEffortTracker.review').get<boolean>('enabled') ?? true)) return undefined;
  const byWi = new Map<string, string[]>();
  for (const [name, b] of Object.entries(branches ?? {})) {
    if (!b?.workItemId || b.workItemId === UNASSIGNED_WORK_ITEM_ID) continue;
    byWi.set(b.workItemId, [...(byWi.get(b.workItemId) ?? []), name]);
  }
  const out: Record<string, { total: number; reviewed: number; openIssues: number }> = {};
  for (const [wi, names] of byWi) {
    const r = reviewController.rollup(names);
    if (r) out[wi] = { total: r.total, reviewed: r.reviewed, openIssues: r.openIssues };
  }
  return out;
}

async function fixDataHealth(checkId?: string) {
  if (checkId === 'duplicate-ledger') {
    const ok = await vscode.window.showWarningMessage('Remove duplicate credit rows? The most complete copy of each chat turn is kept; a backup of the data file is written before saving.', { modal: true }, 'Remove duplicates');
    if (ok !== 'Remove duplicates') return;
    const n = db.removeDuplicateLedgerEntries();
    vscode.window.showInformationMessage(`AI Effort Tracker: removed ${n} duplicate credit row(s).`);
  } else if (checkId === 'stale-credit-attribution') {
    const n = db.reattributeUnassignedCredits();
    vscode.window.showInformationMessage(`AI Effort Tracker: ${n} credit row(s) now count for their branch's work item.`);
  } else {
    void vscode.commands.executeCommand('aiEffortTracker.checkDataHealth');
    return;
  }
  refreshDashboard();
}

/** Usage-optimization data for the dashboard's Optimize tab (same engine as the MCP server). */
function optimizePayload(days: unknown, workItemId: unknown, projectId?: unknown, from?: unknown, to?: unknown) {
  try {
    const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(parseDay(v));
    const fromMs = isDay(from) ? parseDay(from) : undefined;
    const toMs = isDay(to) ? parseDay(to) + 86_400_000 - 1 : undefined;
    const filter: InsightFilter = {
      ...(fromMs !== undefined ? { from: fromMs } : { days: typeof days === 'number' && days > 0 ? Math.min(days, 3650) : 30 }),
      ...(toMs !== undefined ? { to: toMs } : {}),
      ...(typeof workItemId === 'string' && workItemId ? { workItemId } : {}),
      ...(typeof projectId === 'string' && projectId ? { projectId } : {})
    };
    const data = db.getUsageData();
    return {
      overview: usageOverview(data, filter),
      findings: optimizationFindings(data, filter),
      sessions: listSessions(data, filter, 15),
      efficiency: modelEfficiency(data, filter, defaultClassifier(readUserRules())),
      toolProfile: toolProfile(data, filter)
    };
  } catch (error) {
    return { error: `Cannot analyse usage: ${String(error)}` };
  }
}

/** Timesheet tab (issue #101): one week of hours per work item and day. */
function timesheetPayload(weekStart: unknown, rounding: unknown) {
  try {
    const r = rounding === undefined || rounding === null || rounding === ''
      ? normalizeRounding(vscode.workspace.getConfiguration('aiEffortTracker').get<string>('timesheet.rounding'))
      : normalizeRounding(rounding);
    const ws = typeof weekStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : weekStartOf(Date.now());
    return { sheet: buildTimesheet(db.getTimesheetSource(), ws, r), currentWeek: weekStartOf(Date.now()), today: localDay() };
  } catch (error) {
    return { error: `Cannot build timesheet: ${String(error)}` };
  }
}

/** Add a time entry for a work item on a given day from a timesheet cell ("workItemId\u0000YYYY-MM-DD"). */
async function timesheetAddEntry(arg?: string) {
  const [rawWi, rawDay] = (arg ?? '').split('\u0000');
  let workItemId = rawWi && rawWi !== UNASSIGNED_WORK_ITEM_ID ? rawWi : undefined;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay ?? '') ? rawDay : localDay();
  if (!workItemId) {
    const wi = await pickWorkItemOptional(`Log time on ${day} to which work item?`);
    if (wi === CANCELLED || !wi) return;
    workItemId = wi;
  }
  const dur = await promptDurationMs(`Hours for #${workItemId} on ${day}? (minutes, e.g. 90, or h:mm, e.g. 1:30)`);
  if (dur === CANCELLED || dur === undefined || dur <= 0) return;
  const cat = await pickTimeEntryCategory('Category? (optional)');
  if (cat === CANCELLED) return;
  const note = await vscode.window.showInputBox({ prompt: 'Note (optional)', placeHolder: 'e.g. meeting, offline work' });
  if (note === undefined) return;
  const [y, mo, d] = day.split('-').map(Number);
  const startTs = new Date(y, mo - 1, d, 9, 0, 0).getTime();
  const input: TimeEntryInput = { source: 'manual', workItemId, startTs, endTs: startTs + dur, durationMs: dur };
  if (cat) input.category = cat;
  if (note.trim()) input.note = note.trim();
  const entry = db.addTimeEntry(input);
  vscode.window.showInformationMessage(`Logged ${fmtDuration(entry.durationMs)} to #${workItemId} on ${day}.`);
  refreshDashboard();
}

/** Export one timesheet week as CSV ("weekStart\u0000rounding"). */
async function exportTimesheetCsv(arg?: string) {
  const [ws, rounding] = (arg ?? '').split('\u0000');
  const p = timesheetPayload(ws, rounding);
  if (!('sheet' in p) || !p.sheet) { vscode.window.showErrorMessage(p.error ?? 'Cannot build timesheet.'); return; }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`timesheet-${p.sheet.weekStart}.csv`),
    filters: { CSV: ['csv'] }
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from('\uFEFF' + timesheetCsv(p.sheet), 'utf8'));
  vscode.window.showInformationMessage(`Timesheet exported to ${uri.fsPath}`);
}

/** Estimates tab (issues #97/#98): accuracy of finished items + suggestions for open ones. */
function estimatesPayload(projectId: unknown, workItemId?: unknown) {
  try {
    const scope = normalizeFilter({ projectId, workItemId });
    const today = localDay();
    const items = estimationItems();
    const inScope = items.filter(i => matchesScope({ projectId: i.projectId, workItemId: i.id }, scope));
    const accuracy = estimateAccuracy(inScope, today);
    const open = inScope
      .filter(i => !isFinished(i, today))
      .map(i => {
        const s = suggestEstimate(items, { title: i.title, projectId: i.projectId, excludeId: i.id }, today);
        return {
          id: i.id, title: i.title, projectId: i.projectId, status: i.status ?? null,
          estimateHours: i.estimateHours, estimatePoints: i.estimatePoints, actualHours: i.actualHours, credits: i.credits,
          lastDay: i.lastDay, suggestion: s.hours, suggestionCredits: s.credits, basis: s.basis,
          adjusted: i.estimateHours !== null ? adjustForBias(i.estimateHours, s.biasFactor) : null, biasFactor: s.biasFactor
        };
      })
      .sort((a, b) => (b.lastDay ?? '').localeCompare(a.lastDay ?? ''));
    return { accuracy, open, projectId: scope.projectId };
  } catch (error) {
    return { error: `Cannot analyse estimates: ${String(error)}` };
  }
}

/** Attach the saved review coverage of each work item's branches (#109) for the dashboard. */
function withReview<T extends { branches: string[] }>(list: T[]): (T & { review?: unknown })[] {
  if (!reviewController || !(vscode.workspace.getConfiguration('aiEffortTracker.review').get<boolean>('enabled') ?? true)) return list;
  return list.map(w => {
    const r = w.branches.length ? reviewController!.rollup(w.branches) : null;
    return r ? { ...w, review: { ...r, filesLeft: r.filesLeft.slice(0, 8), issues: r.issues.slice(0, 8) } } : w;
  });
}
/** Push an immediate refresh to the dashboard (e.g. after logging credits). */
function refreshDashboard() {
  if (!dashboardPanel) return;
  Promise.all([GitTracker.getCurrentBranch(), GitTracker.getNetLineChange()]).then(([b, netChange]) => {
    if (netChange) db.seedEffectiveLinesFromGit(netChange.branch, netChange.byCategory);
    dashboardPanel?.webview.postMessage({
      type: 'update',
      summaries: db.getAllBranchesSummaries(),
      currentBranch: b ?? 'unknown',
      config: getInsightsConfig(),
      analytics: getAnalytics(),
      billing: lastBilling,
      projectSummaries: db.getAllProjectSummaries(),
      workItemSummaries: withRework(withReview(db.getAllWorkItemSummaries())),
      ledger: db.getCreditEntries(),
      manualEffort: db.getManualEffort(),
      reassignments: db.getReassignments(),
      netChange
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

// ---------- #6: full backup / restore ----------

/** Global (user-level) `aiEffortTracker.*` settings; secrets are never included. */
function exportableSettings(context: vscode.ExtensionContext): Record<string, unknown> {
  const props = context.extension.packageJSON?.contributes?.configuration?.properties ?? {};
  const config = vscode.workspace.getConfiguration();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (SECRET_SETTINGS.has(key)) continue;
    const value = config.inspect(key)?.globalValue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function currentBundle(context: vscode.ExtensionContext): BackupBundle {
  return buildBundle({
    dir: context.globalStorageUri.fsPath,
    effort: db.backupSnapshot(),
    settings: exportableSettings(context),
    extensionVersion: context.extension.packageJSON?.version
  });
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function exportBackup(context: vscode.ExtensionContext) {
  let bundle: BackupBundle;
  try { bundle = currentBundle(context); }
  catch (error) {
    vscode.window.showErrorMessage(`AI Effort Tracker: cannot read the current data for a backup: ${errorText(error)}`);
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    title: 'Export full AI Effort Tracker backup',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `ai-effort-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`)),
    filters: { JSON: ['json'] }
  });
  if (!uri) return;
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeBundle(bundle), 'utf8'));
  } catch (error) {
    vscode.window.showErrorMessage(`AI Effort Tracker: could not write the backup: ${errorText(error)}`);
    return;
  }
  const saved = `AI Effort Tracker: full backup saved (${dataSet('effort').summarize(bundle.data.effort)}).`;
  const choice = bundle.skipped?.length
    ? await vscode.window.showWarningMessage(`${saved} Not included because unreadable: ${bundle.skipped.join(' | ')}`, 'Reveal in Explorer')
    : await vscode.window.showInformationMessage(`${saved} Restore it with "Restore Data from Backup".`, 'Reveal in Explorer');
  if (choice) void vscode.commands.executeCommand('revealFileInOS', uri);
}

type RestorePick = vscode.QuickPickItem & { action?: 'file' | 'safety' | 'checkpoint'; file?: string; set?: DataSetId };

async function restoreBackup(context: vscode.ExtensionContext) {
  const dir = context.globalStorageUri.fsPath;
  const when = (ms: number) => new Date(ms).toLocaleString();
  const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const kinds = { previous: 'previous save', hourly: 'hourly checkpoint', daily: 'daily checkpoint' } as const;
  const items: RestorePick[] = [{
    label: '$(folder-opened) Restore from a backup file\u2026', action: 'file',
    detail: 'A file made with "Export Full Backup", or an effort-tracker.json copied from another machine.'
  }];
  const safety = listSafetyCopies(dir);
  if (safety.length) {
    items.push({ label: 'Safety copies made before a restore (undo a restore)', kind: vscode.QuickPickItemKind.Separator });
    for (const s of safety) {
      items.push({ label: `$(history) ${when(s.mtime)}`, description: `all data \u00b7 ${size(s.size)}`, action: 'safety', file: s.file });
    }
  }
  const checkpoints = listCheckpoints(dir);
  for (const set of DATA_SETS) {
    const own = checkpoints.filter(c => c.set === set.id);
    if (!own.length) continue;
    items.push({ label: `${set.label}: automatic checkpoints`, kind: vscode.QuickPickItemKind.Separator });
    for (const c of own) {
      items.push({ label: `$(clock) ${when(c.mtime)}`, description: `${kinds[c.kind]} \u00b7 ${size(c.size)}`, action: 'checkpoint', file: c.file, set: set.id });
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Restore AI Effort Tracker data', placeHolder: 'Choose a backup file or a checkpoint', matchOnDescription: true
  });
  if (!pick?.action) return;

  let bundle: BackupBundle;
  let source: string;
  try {
    if (pick.action === 'file') {
      const uris = await vscode.window.showOpenDialog({
        title: 'Choose an AI Effort Tracker backup', canSelectMany: false, filters: { JSON: ['json'], 'All files': ['*'] }
      });
      if (!uris?.[0]) return;
      const raw = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
      bundle = parseBackup(raw, uris[0].fsPath);
      source = `"${path.basename(uris[0].fsPath)}"`;
    } else if (pick.action === 'safety') {
      bundle = parseBackup(fs.readFileSync(pick.file!, 'utf8'), pick.file);
      source = `the safety copy of ${pick.label.replace(/^\$\([^)]*\)\s*/, '')}`;
    } else {
      const set = dataSet(pick.set!);
      bundle = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '', data: { [set.id]: set.decode(fs.readFileSync(pick.file!, 'utf8')) } };
      source = `the ${pick.description?.split(' \u00b7 ')[0]} of ${pick.label.replace(/^\$\([^)]*\)\s*/, '')}`;
    }
  } catch (error) {
    vscode.window.showErrorMessage(`AI Effort Tracker: this backup cannot be restored. ${errorText(error)}`);
    return;
  }

  const included = DATA_SETS.filter(s => bundle.data[s.id] !== undefined);
  let chosen: DataSetId[] = included.map(s => s.id);
  let withSettings = !!bundle.settings;
  if (included.length + (bundle.settings ? 1 : 0) > 1) {
    type Part = vscode.QuickPickItem & { id: DataSetId | 'settings' };
    const parts: Part[] = included.map(s => ({ label: s.label, detail: s.summarize(bundle.data[s.id]), picked: true, id: s.id }));
    if (bundle.settings) {
      parts.push({
        label: 'Settings', picked: true, id: 'settings',
        detail: `${Object.keys(bundle.settings).length} user settings (rates, profile, category rules\u2026). The GitHub token is never part of a backup.`
      });
    }
    const selected = await vscode.window.showQuickPick(parts, { title: 'What should be restored?', canPickMany: true });
    if (!selected?.length) return;
    chosen = selected.filter(p => p.id !== 'settings').map(p => p.id as DataSetId);
    withSettings = selected.some(p => p.id === 'settings');
  }

  let current: BackupBundle;
  try { current = currentBundle(context); }
  catch (error) {
    vscode.window.showErrorMessage(`AI Effort Tracker: cannot read the current data, so nothing was restored. ${errorText(error)}`);
    return;
  }
  const compare = chosen.map(id => {
    const set = dataSet(id);
    return `${set.label}\nBackup:  ${set.summarize(bundle.data[id])}\nCurrent: ${current.data[id] !== undefined ? set.summarize(current.data[id]) : 'empty'}`;
  });
  if (withSettings) compare.push('Settings: the backup\u2019s values replace your current user settings.');
  const confirm = await vscode.window.showWarningMessage(
    `Restore AI Effort Tracker data from ${source}?`,
    {
      modal: true,
      detail: `${compare.join('\n\n')}\n\nThe restored data REPLACES the current data. A safety copy of everything is saved first, so you can undo this with the same command.`
    },
    'Restore'
  );
  if (confirm !== 'Restore') return;

  let safetyFile: string;
  try {
    // Fresh snapshot: include anything tracked while the dialog was open.
    safetyFile = writeSafetyCopy(dir, currentBundle(context));
  } catch (error) {
    vscode.window.showErrorMessage(`AI Effort Tracker: could not save a safety copy, so nothing was restored. ${errorText(error)}`);
    return;
  }
  const failed: string[] = [];
  for (const id of chosen) {
    try {
      if (id === 'effort') db.restoreSnapshot(bundle.data.effort);
      else restoreSideStore(dir, id, bundle.data[id]);
    } catch (error) {
      failed.push(`${dataSet(id).label}: ${errorText(error)}`);
    }
  }
  if (withSettings && bundle.settings) {
    const known = context.extension.packageJSON?.contributes?.configuration?.properties ?? {};
    const config = vscode.workspace.getConfiguration();
    for (const [key, value] of Object.entries(bundle.settings)) {
      if (!(key in known) || SECRET_SETTINGS.has(key)) continue;
      try { await config.update(key, value, vscode.ConfigurationTarget.Global); }
      catch (error) { failed.push(`Setting ${key}: ${errorText(error)}`); }
    }
  }
  refreshDashboard();
  if (chosen.includes('reviews')) void vscode.commands.executeCommand('aiEffortTracker.review.refresh');
  const reveal = 'Show Safety Copy';
  const choice = failed.length
    ? await vscode.window.showErrorMessage(`AI Effort Tracker: restore incomplete. ${failed.join(' | ')}`, reveal)
    : await vscode.window.showInformationMessage(
      `AI Effort Tracker: restored ${chosen.map(id => dataSet(id).label.replace(/ \(.*\)$/, '').toLowerCase()).concat(withSettings ? ['settings'] : []).join(', ')} from ${source}.`,
      reveal
    );
  if (choice === reveal) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(safetyFile));
}
