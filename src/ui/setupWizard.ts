/**
 * Setup wizard (#144): a QuickPick hub that runs each setup step and returns
 * to the list, plus the step commands the Get Started walkthrough links to.
 * Every step can be skipped and re-run; nothing here deletes data.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Database } from '../store/database';
import { UNASSIGNED_WORK_ITEM_ID } from '../store/database';
import type { GitHubService } from '../services/githubService';
import { ALL_CATEGORIES, CATEGORY_LABELS, readUserRules, type FileCategory } from '../util/fileTypes';
import { CURRENCIES } from '../util/settingsModel';
import {
  COPILOT_PLANS, SETUP_SETTING_KEYS, SETUP_STEPS, mergeRules, planCreditCost, proposeCategoryRules,
  setupStatus, type SetupSnapshot, type SetupStepId,
} from '../util/setupWizard';

export const WALKTHROUGH_ID = 'aiEffortTracker.setup';
const COMPLETED_KEY = 'setup.completedSteps';
const SHOWN_KEY = 'setup.walkthroughShown';
const SCAN_EXCLUDE = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/bin/**,**/obj/**,**/.vscode-test/**,**/.alpackages/**,**/.snapshots/**,**/coverage/**}';

export interface SetupDeps {
  context: vscode.ExtensionContext;
  db: Database;
  gh: GitHubService;
  getRepoId: () => Promise<string | undefined>;
  refresh: () => void;
}

function cfg() { return vscode.workspace.getConfiguration('aiEffortTracker'); }

function isSet(key: string): boolean {
  const i = cfg().inspect(key);
  if (!i) return false;
  return [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some(v =>
    v !== undefined && !(v && typeof v === 'object' && Object.keys(v as object).length === 0));
}

export function hasTrackedData(db: Database): boolean {
  return db.getAllProjects().length > 0
    || db.getAllWorkItems().some(w => w.id !== 'unknown' && w.id !== UNASSIGNED_WORK_ITEM_ID)
    || db.getCreditEntries().length > 0
    || db.getAllBranchesSummaries().length > 0;
}

export async function setupSnapshot(d: SetupDeps): Promise<SetupSnapshot> {
  const repoId = await d.getRepoId().catch(() => undefined);
  const projects = d.db.getAllProjects();
  return {
    configured: SETUP_SETTING_KEYS.filter(isSet),
    projectCount: projects.length,
    ...(repoId ? { repoId } : {}),
    repoLinked: !!repoId && projects.some(p => p.repos.includes(repoId)),
    tokenSource: await d.gh.tokenSource().catch(() => 'none' as const),
    completed: d.context.globalState.get<string[]>(COMPLETED_KEY) ?? [],
    hasData: hasTrackedData(d.db),
  };
}

/** Context keys `aiEffortTracker.setup.<step>Done` drive walkthrough check marks. */
export async function updateSetupContext(d: SetupDeps): Promise<void> {
  try {
    const st = setupStatus(await setupSnapshot(d));
    for (const step of SETUP_STEPS) {
      await vscode.commands.executeCommand('setContext', `aiEffortTracker.setup.${step.id}Done`, st[step.id] === 'done');
    }
  } catch { /* best effort */ }
}

async function markCompleted(d: SetupDeps, id: SetupStepId): Promise<void> {
  const done = new Set(d.context.globalState.get<string[]>(COMPLETED_KEY) ?? []);
  done.add(id);
  await d.context.globalState.update(COMPLETED_KEY, [...done]);
}

/** Open the walkthrough once on a fresh install (no tracked data yet). */
export async function maybeShowWalkthrough(d: SetupDeps): Promise<void> {
  if (d.context.globalState.get<boolean>(SHOWN_KEY)) return;
  await d.context.globalState.update(SHOWN_KEY, true);
  if (hasTrackedData(d.db)) return;
  try {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${d.context.extension.id}#${WALKTHROUGH_ID}`, false);
  } catch {
    const pick = await vscode.window.showInformationMessage('AI Effort Tracker is installed. Set it up in about two minutes?', 'Run setup');
    if (pick) await vscode.commands.executeCommand('aiEffortTracker.runSetup');
  }
}

const ICON: Record<string, string> = { done: '$(pass-filled)', todo: '$(circle-large-outline)', optional: '$(circle-large-outline)' };

type HubItem = vscode.QuickPickItem & { step?: SetupStepId; finish?: boolean; walkthrough?: boolean };

function pickHub(items: HubItem[], active: HubItem | undefined, title: string): Promise<HubItem | undefined> {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<HubItem>();
    qp.title = title;
    qp.placeholder = 'Pick a step. Each step can be skipped and re-run later.';
    qp.items = items;
    qp.matchOnDetail = true;
    if (active) qp.activeItems = [active];
    let picked: HubItem | undefined;
    qp.onDidAccept(() => { picked = qp.selectedItems[0]; qp.hide(); });
    qp.onDidHide(() => { qp.dispose(); resolve(picked); });
    qp.show();
  });
}

/** The guided setup: pick a step, run it, come back to the list. */
export async function runSetup(d: SetupDeps): Promise<void> {
  for (;;) {
    const status = setupStatus(await setupSnapshot(d));
    const required = SETUP_STEPS.filter(s => !s.optional);
    const doneCount = required.filter(s => status[s.id] === 'done').length;
    const items: HubItem[] = SETUP_STEPS.map(s => ({
      label: `${ICON[status[s.id]]} ${s.title}`,
      description: status[s.id] === 'done' ? 'done' : s.optional ? 'optional' : '',
      detail: s.detail,
      step: s.id,
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(dashboard) Finish and open the dashboard', finish: true });
    items.push({ label: '$(book) Open the Get Started walkthrough', walkthrough: true });
    const firstTodo = items.find(i => i.step && status[i.step] === 'todo');
    const picked = await pickHub(items, firstTodo ?? items.find(i => i.finish),
      `AI Effort Tracker setup \u2014 ${doneCount}/${required.length} steps done`);
    if (!picked) break;
    if (picked.finish) {
      await vscode.commands.executeCommand('aiEffortTracker.showSummary');
      break;
    }
    if (picked.walkthrough) {
      await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${d.context.extension.id}#${WALKTHROUGH_ID}`, false);
      break;
    }
    if (picked.step) await runStep(d, picked.step);
  }
  await updateSetupContext(d);
}

export async function runStep(d: SetupDeps, id: SetupStepId): Promise<boolean> {
  let ok = false;
  try {
    switch (id) {
      case 'restore': await vscode.commands.executeCommand('aiEffortTracker.restoreBackup'); break;
      case 'profile': await vscode.commands.executeCommand('aiEffortTracker.setDeveloperProfile'); break;
      case 'rates': ok = await stepRates(); break;
      case 'credits': ok = await stepCredits(); break;
      case 'categories': ok = await stepCategoryRules(); break;
      case 'project': ok = await stepProject(d); break;
      case 'token': ok = await stepGitHubToken(d); break;
    }
  } catch (e) {
    void vscode.window.showWarningMessage(`AI Effort Tracker setup: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (ok) await markCompleted(d, id);
  d.refresh();
  await updateSetupContext(d);
  return ok;
}

function numberBox(title: string, prompt: string, value: number | undefined, opts: { min?: number; integer?: boolean; max?: number } = {}): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title, prompt,
    value: value === undefined ? '' : String(value),
    validateInput: v => {
      if (!v.trim()) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < (opts.min ?? 0)) return `Enter a number of at least ${opts.min ?? 0}, or leave it blank.`;
      if (opts.max !== undefined && n > opts.max) return `Enter a number up to ${opts.max}.`;
      if (opts.integer && !Number.isInteger(n)) return 'Enter a whole number.';
      return null;
    },
  });
}

async function pickCurrency(current: string): Promise<string | undefined> {
  const list = [current, ...CURRENCIES.filter(c => c !== current)];
  const items: vscode.QuickPickItem[] = list.map(c => ({ label: c, description: c === current ? 'current' : undefined }));
  items.push({ label: 'Other\u2026', description: 'type an ISO currency code' });
  const p = await vscode.window.showQuickPick(items, { title: 'Setup \u2014 Currency', placeHolder: 'Currency for rates, costs and ROI' });
  if (!p) return undefined;
  if (p.label !== 'Other\u2026') return p.label;
  const v = await vscode.window.showInputBox({
    title: 'Setup \u2014 Currency', prompt: 'Three-letter currency code, e.g. RON',
    validateInput: x => /^[A-Za-z]{3}$/.test(x.trim()) ? null : 'Enter three letters.',
  });
  return v?.trim().toUpperCase();
}

export async function stepRates(): Promise<boolean> {
  const c = cfg();
  const currency = await pickCurrency(c.get<string>('currency') || 'USD');
  if (!currency) return false;
  const cost = await numberBox('Setup \u2014 Hourly cost',
    `What one developer hour COSTS you, in ${currency}. Used for ROI and project cost. Projects can override it.`,
    c.get<number>('defaultHourlyCostRate') ?? c.get<number>('hourlyRateUsd'));
  if (cost === undefined) return false;
  const sell = await numberBox('Setup \u2014 Hourly sell rate',
    `What one hour is SOLD for, in ${currency}. Leave blank if you don\u2019t bill hours.`,
    c.get<number>('defaultHourlySellRate'));
  if (sell === undefined) return false;
  const g = vscode.ConfigurationTarget.Global;
  await c.update('currency', currency, g);
  if (cost.trim()) await c.update('defaultHourlyCostRate', Number(cost), g);
  if (sell.trim()) await c.update('defaultHourlySellRate', Number(sell), g);
  void vscode.window.showInformationMessage(`Rates saved: cost ${cost.trim() || '\u2014'}, sell ${sell.trim() || '\u2014'} ${currency}/h.`);
  return true;
}

export async function stepCredits(): Promise<boolean> {
  const c = cfg();
  type PlanItem = vscode.QuickPickItem & { planId?: string };
  const items: PlanItem[] = COPILOT_PLANS.map(p => ({
    label: p.label,
    description: p.credits ? `${p.credits.toLocaleString('en-US')} AI credits / month` : 'allowance not published',
    detail: p.priceUsd ? `$${p.priceUsd} per month${p.id === 'business' || p.id === 'enterprise' ? ' per seat' : ''}` : 'free',
    planId: p.id,
  }));
  items.push({ label: 'Custom', description: 'enter your own numbers' });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Setup \u2014 Copilot plan',
    placeHolder: 'Your plan pre-fills the budget and cost per credit; you can change both',
  });
  if (!picked) return false;
  const plan = COPILOT_PLANS.find(p => p.id === picked.planId);
  const curBudget = c.get<number>('credits.monthlyBudget') ?? 0;
  const budget = await numberBox('Setup \u2014 Monthly credit budget',
    'Credits you plan to use per billing period. 0 turns the budget off.',
    plan?.credits ?? (curBudget > 0 ? curBudget : undefined));
  if (budget === undefined) return false;
  const day = await numberBox('Setup \u2014 Renewal day',
    'Day of the month your Copilot billing period starts (1\u201331).',
    c.get<number>('credits.renewalDay') ?? 1, { min: 1, max: 31, integer: true });
  if (day === undefined) return false;
  const currency = c.get<string>('currency') || 'USD';
  const curCost = c.get<number>('creditCostPerUnit');
  const planCost = plan ? planCreditCost(plan) : undefined;
  const cost = await numberBox('Setup \u2014 Cost per credit',
    `Money per credit, in ${currency}, used to turn credits into cost. ` +
    (planCost !== undefined ? `Pre-filled from the plan price ($${plan!.priceUsd} \u00f7 ${plan!.credits} credits)` + (currency !== 'USD' ? ' in USD \u2014 convert it.' : '.') : 'Leave blank to keep the default.'),
    planCost ?? curCost);
  if (cost === undefined) return false;
  const g = vscode.ConfigurationTarget.Global;
  await c.update('credits.monthlyBudget', Number(budget.trim() || 0), g);
  if (day.trim()) await c.update('credits.renewalDay', Number(day), g);
  if (cost.trim()) await c.update('creditCostPerUnit', Number(cost), g);
  return true;
}

function ruleTarget(key: string): vscode.ConfigurationTarget {
  const i = cfg().inspect(key);
  const ws = i?.workspaceValue;
  return ws && typeof ws === 'object' && Object.keys(ws).length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

export async function stepCategoryRules(): Promise<boolean> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showWarningMessage('Open a folder or workspace first; the step scans its files to propose rules.');
    return false;
  }
  const uris = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Scanning workspace file types\u2026' },
    () => vscode.workspace.findFiles('**/*', SCAN_EXCLUDE, 20000));
  const files = uris.map(u => vscode.workspace.asRelativePath(u, false));
  const rules = readUserRules();
  const prop = proposeCategoryRules(files, rules);
  if (!prop.extensions.length && !prop.folders.length) {
    void vscode.window.showInformationMessage(`All ${files.length} scanned files already map to a category. Nothing to add.`);
    return true;
  }

  type RuleItem = vscode.QuickPickItem & { kind2: 'ext' | 'folder'; key: string; cat?: FileCategory };
  const items: Array<RuleItem | vscode.QuickPickItem> = [];
  if (prop.folders.length) {
    items.push({ label: 'Folders', kind: vscode.QuickPickItemKind.Separator });
    for (const f of prop.folders) items.push({
      label: `$(folder) ${f.folder}/ \u2192 ${CATEGORY_LABELS[f.suggested]}`,
      description: `${f.count} of ${f.total} files change category`,
      picked: true, kind2: 'folder', key: f.folder, cat: f.suggested,
    } as RuleItem);
  }
  if (prop.extensions.length) {
    items.push({ label: 'File types currently counted as Other', kind: vscode.QuickPickItemKind.Separator });
    for (const e of prop.extensions) items.push({
      label: `$(file) *.${e.ext} \u2192 ${e.suggested ? CATEGORY_LABELS[e.suggested] : 'choose\u2026'}`,
      description: `${e.count} file${e.count === 1 ? '' : 's'}`,
      picked: !!e.suggested, kind2: 'ext', key: e.ext, ...(e.suggested ? { cat: e.suggested } : {}),
    } as RuleItem);
  }
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Setup \u2014 Category rules (${files.length} files scanned)`,
    placeHolder: 'Tick the rules to add. Unticked ones are skipped; you can edit rules later in Settings.',
  }) as RuleItem[] | undefined;
  if (!chosen) return false;

  const acc: { extensions: Record<string, FileCategory>; folders: Record<string, FileCategory> } = { extensions: {}, folders: {} };
  for (const it of chosen) {
    let cat = it.cat;
    if (!cat) {
      const p = await vscode.window.showQuickPick(
        ALL_CATEGORIES.map(x => ({ label: CATEGORY_LABELS[x], cat: x })),
        { title: `Category for *.${it.key}`, placeHolder: 'Skip with Esc' });
      cat = p?.cat;
    }
    if (!cat) continue;
    (it.kind2 === 'ext' ? acc.extensions : acc.folders)[it.key] = cat;
  }
  const n = Object.keys(acc.extensions).length + Object.keys(acc.folders).length;
  if (n) {
    const c = cfg();
    const merged = mergeRules({
      extensions: c.get<Record<string, string>>('categoryRules.extensions') ?? {},
      folders: c.get<Record<string, string>>('categoryRules.folders') ?? {},
    }, acc);
    if (Object.keys(acc.extensions).length) await c.update('categoryRules.extensions', merged.extensions, ruleTarget('categoryRules.extensions'));
    if (Object.keys(acc.folders).length) await c.update('categoryRules.folders', merged.folders, ruleTarget('categoryRules.folders'));
  }
  void vscode.window.showInformationMessage(n ? `Added ${n} category rule${n === 1 ? '' : 's'}.` : 'No rules added.');
  return true;
}

export async function stepProject(d: SetupDeps): Promise<boolean> {
  const repoId = await d.getRepoId().catch(() => undefined);
  const projects = d.db.getAllProjects();
  type ProjItem = vscode.QuickPickItem & { id?: string };
  const items: ProjItem[] = [{ label: '$(add) Create a new project' }];
  for (const p of projects) {
    const linked = !!repoId && p.repos.includes(repoId);
    items.push({ label: (linked ? '$(check) ' : '') + p.name, description: p.repos.join(', ') || 'no repos', detail: linked ? 'already linked to this repository' : undefined, id: p.id });
  }
  const picked = projects.length ? await vscode.window.showQuickPick(items, {
    title: 'Setup \u2014 Project',
    placeHolder: repoId ? `Link this repository (${repoId}) to a project, or create one` : 'No repository open \u2014 create a project to link one later',
  }) : items[0];
  if (!picked) return false;

  let projectId = picked.id;
  if (!projectId) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const name = await vscode.window.showInputBox({
      title: 'Setup \u2014 New project', prompt: 'Project name (e.g. the customer or product)',
      value: folder ? path.basename(folder) : '',
      validateInput: v => v.trim() ? null : 'Enter a project name',
    });
    if (!name) return false;
    projectId = d.db.upsertProject({ name: name.trim() }).id;
  }
  const name = d.db.getProject(projectId)?.name ?? projectId;
  if (repoId) {
    d.db.linkRepoToProject(projectId, repoId);
    void vscode.window.showInformationMessage(`"${name}" is linked to this repository. Its effort now rolls up under the project.`);
  } else {
    void vscode.window.showInformationMessage(`Project "${name}" is ready. Open a repository and run "Link Current Repo to Project".`);
  }
  return true;
}

export async function stepGitHubToken(d: SetupDeps): Promise<boolean> {
  const src = await d.gh.tokenSource();
  const token = await vscode.window.showInputBox({
    title: 'Setup \u2014 GitHub token (optional)',
    prompt: (src === 'none' ? '' : `A token is already set (${src === 'secure' ? 'secure storage' : 'plain setting'}). `) +
      'Paste a personal access token for Copilot billing and metrics. It is kept in VS Code secure storage. Leave blank to skip.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token?.trim()) return false;
  await d.gh.setSecretToken(token.trim());
  void vscode.window.showInformationMessage('GitHub token saved in secure storage.');
  return true;
}
