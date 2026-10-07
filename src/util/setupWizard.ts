/**
 * Pure model for the setup wizard (#144): steps, step status, Copilot plan
 * presets and category-rule proposals from the files in a workspace. No vscode
 * import, so it can be unit tested directly.
 */
import { categorizeWith, getFileExt, type CategoryRules, type FileCategory } from './categoryRules';

export type SetupStepId = 'restore' | 'profile' | 'rates' | 'credits' | 'categories' | 'project' | 'token';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  detail: string;
  /** Command that runs the step on its own (also used by the walkthrough). */
  command: string;
  optional?: boolean;
}

export const SETUP_STEPS: SetupStep[] = [
  { id: 'restore', title: 'Restore from a backup', detail: 'New machine? Bring back projects, work items, credits and settings from a backup file.', command: 'aiEffortTracker.restoreBackup', optional: true },
  { id: 'profile', title: 'Developer profile', detail: 'Seniority presets your hand-coding baseline (lines/min). You can adjust it.', command: 'aiEffortTracker.setDeveloperProfile' },
  { id: 'rates', title: 'Currency and hourly rates', detail: 'What an hour costs and what it is sold for. Projects can override these.', command: 'aiEffortTracker.setup.rates' },
  { id: 'credits', title: 'Copilot plan and credit budget', detail: 'Your plan pre-fills the monthly credit budget, renewal day and cost per credit.', command: 'aiEffortTracker.setup.credits' },
  { id: 'categories', title: 'Category rules', detail: 'Detect file types and folders in this workspace and map them to programming, docs, specs, deployment\u2026', command: 'aiEffortTracker.setup.categoryRules' },
  { id: 'project', title: 'Project and repository', detail: 'Create a project and link this repository so its effort rolls up.', command: 'aiEffortTracker.setup.project' },
  { id: 'token', title: 'GitHub token', detail: 'Optional: needed for Copilot billing and metrics. Stored in VS Code secure storage.', command: 'aiEffortTracker.setup.githubToken', optional: true },
];

/** What the extension knows about the current setup; gathered by the caller. */
export interface SetupSnapshot {
  /** Setting keys (without the `aiEffortTracker.` prefix) the user has set explicitly. */
  configured: string[];
  projectCount: number;
  /** Repository id of the open workspace, or undefined when there is none. */
  repoId?: string;
  /** True when `repoId` is linked to at least one project. */
  repoLinked: boolean;
  tokenSource: 'secure' | 'settings' | 'none';
  /** Steps the user finished in the wizard (kept in globalState). */
  completed: string[];
  /** True when the store already holds tracked data. */
  hasData: boolean;
}

export type SetupStepState = 'done' | 'todo' | 'optional';

const STEP_SETTINGS: Partial<Record<SetupStepId, string[]>> = {
  profile: ['seniority', 'baselineLocPerMinute'],
  rates: ['currency', 'defaultHourlyCostRate', 'defaultHourlySellRate', 'hourlyRateUsd'],
  credits: ['credits.monthlyBudget'],
  categories: ['categoryRules.extensions', 'categoryRules.folders'],
};

export function setupStepState(id: SetupStepId, s: SetupSnapshot): SetupStepState {
  const done = (() => {
    if (s.completed.includes(id)) return true;
    switch (id) {
      case 'restore': return s.hasData;
      case 'project': return s.repoId ? s.repoLinked : s.projectCount > 0;
      case 'token': return s.tokenSource !== 'none';
      default: return (STEP_SETTINGS[id] ?? []).some(k => s.configured.includes(k));
    }
  })();
  if (done) return 'done';
  return SETUP_STEPS.find(x => x.id === id)?.optional ? 'optional' : 'todo';
}

export function setupStatus(s: SetupSnapshot): Record<SetupStepId, SetupStepState> {
  const out = {} as Record<SetupStepId, SetupStepState>;
  for (const step of SETUP_STEPS) out[step.id] = setupStepState(step.id, s);
  return out;
}

/** Required steps still open. */
export function remainingSteps(s: SetupSnapshot): SetupStepId[] {
  return SETUP_STEPS.filter(st => setupStepState(st.id, s) === 'todo').map(st => st.id);
}

/** Every setting key the status depends on, for `inspect()` by the caller. */
export const SETUP_SETTING_KEYS: string[] = Array.from(new Set(Object.values(STEP_SETTINGS).flat() as string[]));

export interface CopilotPlan {
  id: string;
  label: string;
  /** Monthly price in USD per user (0 = free). */
  priceUsd: number;
  /** Included GitHub AI Credits per user per month; undefined when not published. */
  credits?: number;
}

/** GitHub Copilot plans (docs.github.com, "Plans for GitHub Copilot"). Values only pre-fill editable inputs. */
export const COPILOT_PLANS: CopilotPlan[] = [
  { id: 'free', label: 'Copilot Free', priceUsd: 0 },
  { id: 'student', label: 'Copilot Student', priceUsd: 0 },
  { id: 'pro', label: 'Copilot Pro', priceUsd: 10, credits: 1000 },
  { id: 'pro-plus', label: 'Copilot Pro+', priceUsd: 39, credits: 3900 },
  { id: 'max', label: 'Copilot Max', priceUsd: 100, credits: 10000 },
  { id: 'business', label: 'Copilot Business', priceUsd: 19, credits: 1900 },
  { id: 'enterprise', label: 'Copilot Enterprise', priceUsd: 39, credits: 3900 },
];

/** Money per credit implied by a plan (price ÷ credits), or undefined. */
export function planCreditCost(plan: CopilotPlan): number | undefined {
  if (!plan.credits || !plan.priceUsd) return undefined;
  return Math.round((plan.priceUsd / plan.credits) * 1e6) / 1e6;
}

/** Guesses for extensions the built-in defaults leave as `other`. */
const EXT_HINTS: Record<string, FileCategory> = {
  html: 'programming', htm: 'programming', css: 'programming', scss: 'programming', sass: 'programming',
  less: 'programming', vue: 'programming', svelte: 'programming', mjs: 'programming', cjs: 'programming',
  mts: 'programming', cts: 'programming', razor: 'programming', cshtml: 'programming', xaml: 'programming',
  groovy: 'programming', pl: 'programming', pm: 'programming', m: 'programming', mm: 'programming',
  zig: 'programming', nim: 'programming', erl: 'programming', hrl: 'programming', hs: 'programming',
  ml: 'programming', psd1: 'config', bat: 'programming', cmd: 'programming', graphql: 'programming',
  gql: 'programming', proto: 'specification', rdl: 'programming', rdlc: 'programming',
  ipynb: 'programming', kql: 'programming', bicepparam: 'deployment', hcl: 'deployment',
  dockerignore: 'deployment', nuspec: 'config', gradle: 'config', properties: 'config', cfg: 'config',
  conf: 'config', plist: 'config', csv: 'other', mdx: 'documentation', markdown: 'documentation',
  wiki: 'documentation', tex: 'documentation', puml: 'specification', plantuml: 'specification',
  mmd: 'specification', drawio: 'specification', openapi: 'specification', gherkin: 'specification',
  json5: 'config', arb: 'translation', strings: 'translation', resjson: 'translation',
};

/** Folder names that usually mean one category. Matched as a whole path segment. */
const FOLDER_HINTS: Array<{ names: string[]; category: FileCategory }> = [
  { names: ['docs', 'doc', 'documentation', 'wiki'], category: 'documentation' },
  { names: ['specs', 'specifications', 'requirements'], category: 'specification' },
  { names: ['deploy', 'deployment', 'deployments', 'infra', 'infrastructure', 'terraform', 'helm', 'k8s', 'kubernetes', 'pipelines', 'workflows', '.azure', '.pipelines'], category: 'deployment' },
  { names: ['translations', 'translation', 'locales', 'locale', 'i18n', 'l10n'], category: 'translation' },
];

/** Binary/asset extensions with no meaningful line counts; never proposed. */
const IGNORED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp', 'mp4', 'mp3', 'wav', 'zip', 'gz', 'tar', '7z',
  'dll', 'exe', 'pdb', 'so', 'dylib', 'bin', 'obj', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'app', 'vsix',
  'map', 'snk', 'pfx', 'cer', 'unknown',
]);

export interface ExtProposal { ext: string; count: number; suggested?: FileCategory }
export interface FolderProposal { folder: string; count: number; total: number; suggested: FileCategory }
export interface RuleProposals { extensions: ExtProposal[]; folders: FolderProposal[]; scanned: number }

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Propose category rules from workspace-relative file paths:
 * - extensions the current rules classify as `other` (with a guess when known);
 * - well-known folders (docs, specs, infra, translations…) where some files
 *   would change category under the folder rule. Folders already covered by a
 *   folder rule are skipped. The folder key is the sub-path, which matches as
 *   a path segment anywhere (see categoryRules.folderMatches).
 */
export function proposeCategoryRules(files: string[], rules: CategoryRules, maxEach = 15): RuleProposals {
  const extCounts = new Map<string, number>();
  const folderStats = new Map<string, { count: number; total: number; suggested: FileCategory }>();
  const ruleFolders = Object.keys(rules.folders).map(k => normalize(k).toLowerCase());

  for (const raw of files) {
    const file = normalize(raw);
    if (!file) continue;
    const current = categorizeWith(file, rules);
    const ext = getFileExt(file);
    if (current === 'other' && !IGNORED_EXTS.has(ext) && !rules.extensions[ext]) {
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    const segs = file.split('/').slice(0, -1);
    // Only the first matching hint folder counts, at depth ≤ 3.
    for (let i = 0; i < Math.min(segs.length, 3); i++) {
      const name = segs[i].toLowerCase();
      const hint = FOLDER_HINTS.find(h => h.names.includes(name));
      if (!hint) continue;
      const key = segs.slice(0, i + 1).join('/');
      if (ruleFolders.some(r => r === key.toLowerCase() || r === name)) break;
      if (IGNORED_EXTS.has(ext)) break;
      const st = folderStats.get(key) ?? { count: 0, total: 0, suggested: hint.category };
      st.total++;
      if (current !== hint.category) st.count++;
      folderStats.set(key, st);
      break;
    }
  }

  const extensions = [...extCounts.entries()]
    .map(([ext, count]) => ({ ext, count, ...(EXT_HINTS[ext] ? { suggested: EXT_HINTS[ext] } : {}) }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, maxEach);

  const folders = [...folderStats.entries()]
    .filter(([, st]) => st.count > 0)
    .map(([folder, st]) => ({ folder, ...st }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
    .slice(0, maxEach);

  return { extensions, folders, scanned: files.length };
}

/** Merge accepted proposals into existing rule maps without dropping user entries. */
export function mergeRules(
  existing: { extensions?: Record<string, string>; folders?: Record<string, string> },
  accepted: { extensions?: Record<string, FileCategory>; folders?: Record<string, FileCategory> }
): { extensions: Record<string, string>; folders: Record<string, string> } {
  return {
    extensions: { ...(existing.extensions ?? {}), ...(accepted.extensions ?? {}) },
    folders: { ...(existing.folders ?? {}), ...(accepted.folders ?? {}) },
  };
}
