import * as vscode from 'vscode';

/**
 * Effort categories. The set was expanded (M3, issue #14) from the original
 * `code | spec | config | other` to reflect real work types. Older category
 * keys are still tolerated by the dashboard (it falls back to the raw key), and
 * stored line data is keyed by file extension — not by category — so no data
 * migration is required.
 */
export type FileCategory =
  | 'programming'
  | 'specification'
  | 'documentation'
  | 'deployment'
  | 'config'
  | 'other';

export const ALL_CATEGORIES: FileCategory[] = [
  'programming',
  'specification',
  'documentation',
  'deployment',
  'config',
  'other'
];

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  programming: '💻 Programming',
  specification: '📋 Specification',
  documentation: '📄 Documentation',
  deployment: '🚀 Deployment',
  config: '⚙️ Config',
  other: '📦 Other'
};

/** Built-in extension → category defaults. User settings override these. */
const DEFAULT_EXT_RULES: Record<string, FileCategory> = {
  // programming
  al: 'programming', ts: 'programming', tsx: 'programming', js: 'programming',
  jsx: 'programming', cs: 'programming', py: 'programming', java: 'programming',
  go: 'programming', rs: 'programming', cpp: 'programming', c: 'programming',
  h: 'programming', hpp: 'programming', rb: 'programming', php: 'programming',
  swift: 'programming', kt: 'programming', dart: 'programming', lua: 'programming',
  r: 'programming', sql: 'programming', sh: 'programming', ps1: 'programming',
  psm1: 'programming', vb: 'programming', fs: 'programming', fsx: 'programming',
  scala: 'programming', ex: 'programming', exs: 'programming', elm: 'programming',
  clj: 'programming',

  // specification (acceptance / behaviour specs)
  feature: 'specification', story: 'specification', spec: 'specification',

  // documentation
  md: 'documentation', txt: 'documentation', rst: 'documentation',
  adoc: 'documentation', doc: 'documentation', docx: 'documentation',
  pdf: 'documentation',

  // deployment / infrastructure
  dockerfile: 'deployment', tf: 'deployment', tfvars: 'deployment',
  bicep: 'deployment', helm: 'deployment', nomad: 'deployment',

  // config
  json: 'config', jsonc: 'config', yaml: 'config', yml: 'config',
  toml: 'config', xml: 'config', ini: 'config', env: 'config',
  config: 'config', csproj: 'config', sln: 'config', props: 'config',
  targets: 'config', editorconfig: 'config', gitignore: 'config', lock: 'config'
};

interface CategoryRules {
  extensions: Record<string, FileCategory>;
  folders: Record<string, FileCategory>;
}

function normalizeExtKey(key: string): string {
  // Accept "al", ".al" and "*.al" forms.
  return key.replace(/^\*?\.?/, '').toLowerCase();
}

function isValidCategory(value: unknown): value is FileCategory {
  return typeof value === 'string' && (ALL_CATEGORIES as string[]).includes(value);
}

/** Read user-configured rules from settings (best effort). */
function readUserRules(): CategoryRules {
  const extensions: Record<string, FileCategory> = {};
  const folders: Record<string, FileCategory> = {};
  try {
    const cfg = vscode.workspace.getConfiguration('aiEffortTracker');
    const extRules = cfg.get<Record<string, string>>('categoryRules.extensions') ?? {};
    for (const [k, v] of Object.entries(extRules)) {
      if (isValidCategory(v)) extensions[normalizeExtKey(k)] = v;
    }
    const folderRules = cfg.get<Record<string, string>>('categoryRules.folders') ?? {};
    for (const [k, v] of Object.entries(folderRules)) {
      if (isValidCategory(v)) folders[k] = v;
    }
  } catch { /* vscode config unavailable — fall back to defaults */ }
  return { extensions, folders };
}

/** Convert a folder glob (`*`, `**`, `?`) to a RegExp anchored to the full path. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else { re += '[^/]*'; }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

/** True if a folder rule pattern matches the (normalized, slash-separated) path. */
function folderMatches(pattern: string, normPath: string): boolean {
  const pat = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!pat) return false;
  if (/[*?]/.test(pat)) {
    return globToRegExp(pat).test(normPath);
  }
  // Plain folder name / sub-path: match it as a path segment anywhere.
  return ('/' + normPath + '/').includes('/' + pat + '/');
}

export function getFileExt(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const parts = base.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'unknown';
}

/** Categorize by extension only (built-in defaults + user extension rules). */
export function categorizeExt(ext: string): FileCategory {
  const key = ext.toLowerCase();
  const { extensions } = readUserRules();
  if (extensions[key]) return extensions[key];
  if (DEFAULT_EXT_RULES[key]) return DEFAULT_EXT_RULES[key];
  return 'other';
}

/**
 * Path-aware categorization. Folder rules take precedence over extension rules,
 * and user rules take precedence over built-in defaults.
 */
export function categorize(filePath: string): FileCategory {
  const normPath = filePath.replace(/\\/g, '/').toLowerCase();
  const { extensions, folders } = readUserRules();

  for (const [pattern, cat] of Object.entries(folders)) {
    if (folderMatches(pattern, normPath)) return cat;
  }

  const ext = getFileExt(filePath);
  if (extensions[ext]) return extensions[ext];
  if (DEFAULT_EXT_RULES[ext]) return DEFAULT_EXT_RULES[ext];
  return 'other';
}
