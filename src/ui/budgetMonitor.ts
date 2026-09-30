import * as path from 'path';
import * as vscode from 'vscode';
import { atomicWrite } from '../store/persistence';
import { UNASSIGNED_WORK_ITEM_ID, type Database } from '../store/database';
import { GitTracker } from '../trackers/gitTracker';
import {
  BUDGET_SNAPSHOT_FILE,
  budgetAlertChanges,
  budgetIsActive,
  budgetStatusLabel,
  formatBudgetAmount,
  type BudgetDimension,
  type BudgetStatus
} from '../analysis/budget';

const CHECK_MS = 60_000;
const DIM_LABEL: Record<BudgetDimension, string> = { time: 'time', credits: 'credit', cost: 'money' };

/**
 * Work-item budgets (issue #94): a status-bar entry for the current branch's
 * work item and a once-per-crossing threshold notification. Notified
 * thresholds are stored on the work item (merge-safe), so alerts survive
 * reloads and are not repeated by other windows.
 */
export class BudgetMonitor implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly first: ReturnType<typeof setTimeout>;
  private readonly sub: vscode.Disposable;
  private running = false;

  private lastSnapshot = '';

  constructor(private readonly db: Database, private readonly storageDir?: string) {
    this.timer = setInterval(() => void this.refresh(), CHECK_MS);
    this.first = setTimeout(() => void this.refresh(), 5_000);
    this.sub = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiEffortTracker.budget')) void this.refresh();
    });
  }

  private static config() {
    const c = vscode.workspace.getConfiguration('aiEffortTracker');
    return {
      alerts: c.get<boolean>('budget.alerts') ?? true,
      statusBar: c.get<boolean>('budget.showStatusBar') ?? true
    };
  }

  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = BudgetMonitor.config();
      await this.updateStatusBar(cfg.statusBar);
      this.checkAll(cfg.alerts && vscode.window.state.focused);
    } catch (error) {
      console.error('AI Effort Tracker: budget check failed', error);
    } finally {
      this.running = false;
    }
  }

  private async updateStatusBar(enabled: boolean): Promise<void> {
    const branch = enabled ? await GitTracker.getCurrentBranch() : undefined;
    const id = branch ? this.db.getWorkItemForBranch(branch) : null;
    if (!id || id === UNASSIGNED_WORK_ITEM_ID) { this.item.hide(); return; }
    const summary = this.db.getWorkItemSummary(id);
    const b = summary.budget;
    if (!b) { this.item.hide(); return; }
    const currency = summary.roi?.currency;
    this.item.text = `$(target) ${budgetStatusLabel(id, b, currency)}`;
    this.item.backgroundColor = b.state === 'over'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : b.state === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = tooltip(id, summary.title, b, currency);
    this.item.command = b.state === 'unestimated'
      ? { title: 'Set estimate', command: 'aiEffortTracker.setWorkItemEstimate', arguments: [id] }
      : { title: 'Open work item', command: 'aiEffortTracker.openWorkItem', arguments: [id] };
    this.item.show();
  }

  /** Alert on newly crossed thresholds (focused window only) and refresh the MCP snapshot. */
  private checkAll(alerts: boolean): void {
    const snapshot: Record<string, BudgetSnapshotItem> = {};
    for (const wi of this.db.getAllWorkItems()) {
      if (wi.id === UNASSIGNED_WORK_ITEM_ID) continue;
      const summary = this.db.getWorkItemSummary(wi.id);
      const b = summary.budget;
      if (!b) continue;
      snapshot[wi.id] = snapshotOf(b, summary.roi?.currency);
      if (!alerts) continue;
      const { fire, rearm, next } = budgetAlertChanges(b.crossed, wi.budgetAlerts);
      if (!fire.length && !rearm.length) continue;
      this.db.setBudgetAlerts(wi.id, next);
      // Dormant items are recorded silently so the first run does not flood
      // the user with alerts for old, finished work.
      if (fire.length && budgetIsActive(b)) void notify(wi.id, summary.title, b, Math.max(...fire), summary.roi?.currency);
    }
    this.writeSnapshot(snapshot);
  }

  /**
   * Derived budget status per work item for the MCP server, which cannot read
   * VS Code settings. Per machine, outside the synced store; rewritten only
   * when it changes.
   */
  private writeSnapshot(workItems: Record<string, BudgetSnapshotItem>): void {
    if (!this.storageDir) return;
    const body = JSON.stringify(workItems);
    if (body === this.lastSnapshot) return;
    try {
      atomicWrite(path.join(this.storageDir, BUDGET_SNAPSHOT_FILE), JSON.stringify({ generatedAt: new Date().toISOString(), workItems }));
      this.lastSnapshot = body;
    } catch (error) {
      console.error('AI Effort Tracker: budget snapshot write failed', error);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.first);
    this.sub.dispose();
    this.item.dispose();
  }
}

type BudgetSnapshotItem = Omit<BudgetStatus, 'series'> & { currency: string | null };

function snapshotOf(b: BudgetStatus, currency?: string): BudgetSnapshotItem {
  const rest: Partial<BudgetStatus> = { ...b };
  delete rest.series;
  return { ...(rest as Omit<BudgetStatus, 'series'>), currency: currency ?? null };
}

function tooltip(id: string, title: string | null | undefined, b: BudgetStatus, currency?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Budget \u2014 #${id}${title ? ` ${escapeMd(title)}` : ''}**\n\n`);
  if (b.state === 'unestimated') {
    md.appendMarkdown('No hour estimate or budget yet. Click to set an estimate.\n\n');
  } else {
    for (const k of ['time', 'credits', 'cost'] as BudgetDimension[]) {
      const d = b.dims[k];
      if (!d) continue;
      md.appendMarkdown(`- ${DIM_LABEL[k]}: ${formatBudgetAmount(k, d.used, currency)} / ${formatBudgetAmount(k, d.budget, currency)} (${d.pct}%)\n`);
    }
    if (b.projection) {
      md.appendMarkdown(b.projection.daysLeft <= 0
        ? `\nThe ${DIM_LABEL[b.projection.dimension]} budget is used up.\n`
        : `\nAt the last ${b.burn.days} days' pace the ${DIM_LABEL[b.projection.dimension]} budget runs out in ${b.projection.daysLeft} days (${b.projection.date}).\n`);
    }
  }
  return md;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

async function notify(id: string, title: string | null | undefined, b: BudgetStatus, threshold: number, currency?: string) {
  const dim = b.worst ?? 'time';
  const d = b.dims[dim];
  const detail = d ? ` (${formatBudgetAmount(dim, d.used, currency)} of ${formatBudgetAmount(dim, d.budget, currency)})` : '';
  const name = `#${id}${title ? ` "${title}"` : ''}`;
  const msg = threshold >= 100
    ? `Work item ${name} is over its ${DIM_LABEL[dim]} budget: ${b.pct}%${detail}.`
    : `Work item ${name} has used ${b.pct}% of its ${DIM_LABEL[dim]} budget${detail}.`;
  const pick = await vscode.window.showWarningMessage(msg, 'Open work item', 'Adjust estimate');
  if (pick === 'Open work item') await vscode.commands.executeCommand('aiEffortTracker.openWorkItem', id);
  else if (pick === 'Adjust estimate') await vscode.commands.executeCommand('aiEffortTracker.setWorkItemEstimate', id);
}
