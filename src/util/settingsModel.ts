/**
 * Settings tab model (#148): groups the extension's contributed settings, picks
 * an editor for each one and validates values before they are written. Pure —
 * no vscode import — so it is unit-tested directly.
 */

export const SETTINGS_PREFIX = 'aiEffortTracker.';

export const SENIORITY_PRESETS: Record<'junior' | 'mid' | 'senior', number> = {
  junior: 3,
  mid: 5,
  senior: 8,
};

export const SETTING_GROUPS = [
  'Profile & baselines',
  'Rates & ROI',
  'Credits & budget',
  'Categories',
  'Tracking',
  'Nudges',
  'Review',
  'Corrections & rules',
  'Integrations',
  'Other',
] as const;
export type SettingGroup = typeof SETTING_GROUPS[number];

/** Keys (without prefix) or key prefixes ending in '.' mapped to a group. First match wins. */
const GROUP_RULES: [string, SettingGroup][] = [
  ['seniority', 'Profile & baselines'],
  ['baselineLocPerMinute', 'Profile & baselines'],
  ['baselineLocPerMinuteByCategory', 'Profile & baselines'],
  ['dailyActiveGoalMinutes', 'Profile & baselines'],
  ['hourlyRateUsd', 'Rates & ROI'],
  ['defaultHourlyCostRate', 'Rates & ROI'],
  ['defaultHourlySellRate', 'Rates & ROI'],
  ['currency', 'Rates & ROI'],
  ['creditCostPerUnit', 'Rates & ROI'],
  ['usdPerCredit', 'Rates & ROI'],
  ['credits.', 'Credits & budget'],
  ['budget.', 'Credits & budget'],
  ['captureDebugLogs', 'Credits & budget'],
  ['autoCapturePollSeconds', 'Credits & budget'],
  ['autoCaptureCredits', 'Credits & budget'],
  ['autoCaptureRealCredits', 'Credits & budget'],
  ['creditImportFolder', 'Credits & budget'],
  ['aiuRatesOverride', 'Credits & budget'],
  ['autoCreditDefaultMultiplier', 'Credits & budget'],
  ['premiumRequestMultipliers', 'Credits & budget'],
  ['categoryRules.', 'Categories'],
  ['idleThresholdSeconds', 'Tracking'],
  ['codingActiveSeconds', 'Tracking'],
  ['aiActiveSeconds', 'Tracking'],
  ['away.', 'Tracking'],
  ['branches.', 'Tracking'],
  ['timesheet.', 'Tracking'],
  ['sessions.', 'Tracking'],
  ['handoff.', 'Tracking'],
  ['nudges.', 'Nudges'],
  ['review.', 'Review'],
  ['corrections.', 'Corrections & rules'],
  ['lessons.', 'Corrections & rules'],
  ['azureDevOpsOrg', 'Integrations'],
  ['githubToken', 'Integrations'],
  ['githubOrg', 'Integrations'],
  ['githubRepo', 'Integrations'],
  ['mcpServer.', 'Integrations'],
];

/** Legacy estimators and raw tables: shown under "Advanced" in their group. */
const ADVANCED = new Set([
  'autoCaptureCredits', 'autoCaptureRealCredits', 'creditImportFolder', 'aiuRatesOverride',
  'autoCreditDefaultMultiplier', 'premiumRequestMultipliers', 'hourlyRateUsd', 'usdPerCredit',
]);

const UNITS: Record<string, string> = {
  baselineLocPerMinute: 'lines/min',
  baselineLocPerMinuteByCategory: 'lines/min',
  dailyActiveGoalMinutes: 'min',
  idleThresholdSeconds: 's',
  codingActiveSeconds: 's',
  aiActiveSeconds: 's',
  autoCapturePollSeconds: 's',
  'away.minMinutes': 'min',
  'away.maxMinutes': 'min',
  'nudges.cooldownMinutes': 'min',
  'nudges.contextTokens': 'tokens',
  'nudges.cacheMinTokens': 'tokens',
  'nudges.toolCount': 'tools',
  'nudges.lightTurnCount': 'turns',
  'budget.thresholds': '%',
  'budget.creditsPerEstimatedHour': 'credits/h',
  'credits.monthlyBudget': 'credits',
  'credits.renewalDay': 'day',
  'lessons.minOccurrences': 'times',
  'lessons.minWorkItems': 'items',
  autoCreditDefaultMultiplier: 'credits',
  premiumRequestMultipliers: 'credits',
  hourlyRateUsd: 'USD/h',
  usdPerCredit: 'USD',
  defaultHourlyCostRate: '{currency}/h',
  defaultHourlySellRate: '{currency}/h',
  creditCostPerUnit: '{currency}',
};

/** Lower bounds for numbers whose schema has none (negative or zero would break the math). */
const EXTRA_MIN: Record<string, { min: number; exclusive?: boolean }> = {
  baselineLocPerMinute: { min: 0, exclusive: true },
  dailyActiveGoalMinutes: { min: 1 },
  idleThresholdSeconds: { min: 10 },
  codingActiveSeconds: { min: 1 },
  aiActiveSeconds: { min: 1 },
  autoCapturePollSeconds: { min: 3 },
  hourlyRateUsd: { min: 0 },
  defaultHourlyCostRate: { min: 0 },
  defaultHourlySellRate: { min: 0 },
  creditCostPerUnit: { min: 0 },
  usdPerCredit: { min: 0 },
  autoCreditDefaultMultiplier: { min: 0 },
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'HUF', 'PLN', 'CZK', 'SEK', 'NOK', 'DKK', 'CAD', 'AUD', 'JPY', 'INR'];

export type SettingKind = 'boolean' | 'number' | 'enum' | 'string' | 'secret' | 'currency' | 'map' | 'list' | 'rules' | 'json';

export interface SettingDescriptor {
  /** Full key, e.g. `aiEffortTracker.nudges.enabled`. */
  key: string;
  /** Key without the `aiEffortTracker.` prefix. */
  id: string;
  label: string;
  description: string;
  group: SettingGroup;
  advanced: boolean;
  kind: SettingKind;
  defaultValue: unknown;
  integer?: boolean;
  min?: number;
  minExclusive?: boolean;
  max?: number;
  unit?: string;
  options?: string[];
  optionLabels?: string[];
  /** map: value editor kind; list: item kind. */
  valueKind?: 'number' | 'enum' | 'string';
  valueOptions?: string[];
  itemMin?: number;
  itemMax?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

export function groupOf(id: string): SettingGroup {
  for (const [rule, group] of GROUP_RULES) {
    if (rule.endsWith('.') ? id.startsWith(rule) : id === rule) return group;
  }
  return 'Other';
}

const ACRONYMS: Record<string, string> = { usd: 'USD', loc: 'LOC', aiu: 'AIU', ai: 'AI', mcp: 'MCP', csv: 'CSV' };

/** `nudges.contextTokens` → "Context tokens"; `categoryRules.folders` → "By folders". */
export function labelOf(id: string): string {
  const parts = id.split('.');
  const words = parts[parts.length - 1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ').map(w => ACRONYMS[w] ?? w);
  if (parts[0] === 'categoryRules') words.unshift('by');
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kindOf(id: string, s: Schema): Pick<SettingDescriptor, 'kind' | 'valueKind' | 'valueOptions' | 'itemMin' | 'itemMax'> {
  if (id === 'githubToken') return { kind: 'secret' };
  if (id === 'currency') return { kind: 'currency' };
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t === 'boolean') return { kind: 'boolean' };
  if (t === 'number' || t === 'integer') return { kind: 'number' };
  if (t === 'string') return Array.isArray(s.enum) ? { kind: 'enum' } : { kind: 'string' };
  if (t === 'array') {
    const it = s.items ?? {};
    if (it.type === 'object' && it.properties?.pattern && it.properties?.category) return { kind: 'rules' };
    if (it.type === 'number' || it.type === 'integer') return { kind: 'list', valueKind: 'number', itemMin: it.minimum, itemMax: it.maximum };
    if (it.type === 'string') return { kind: 'list', valueKind: 'string' };
    return { kind: 'json' };
  }
  if (t === 'object') {
    const ap = s.additionalProperties;
    if (ap && typeof ap === 'object') {
      if (ap.type === 'number') return { kind: 'map', valueKind: 'number' };
      if (ap.type === 'string' && Array.isArray(ap.enum)) return { kind: 'map', valueKind: 'enum', valueOptions: ap.enum.slice() };
      if (ap.type === 'string') return { kind: 'map', valueKind: 'string' };
    }
    return { kind: 'json' };
  }
  return { kind: 'json' };
}

function plainDescription(s: Schema): string {
  return String(s.markdownDescription ?? s.description ?? '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

/** Descriptors for every contributed setting, in group order, then manifest order. */
export function buildSettingDescriptors(properties: Record<string, Schema>): SettingDescriptor[] {
  const out: SettingDescriptor[] = [];
  for (const [key, s] of Object.entries(properties ?? {})) {
    if (!key.startsWith(SETTINGS_PREFIX) || !s || typeof s !== 'object') continue;
    const id = key.slice(SETTINGS_PREFIX.length);
    const k = kindOf(id, s);
    const extra = EXTRA_MIN[id];
    const d: SettingDescriptor = {
      key, id, label: labelOf(id), description: plainDescription(s), group: groupOf(id),
      advanced: ADVANCED.has(id) || /^legacy\b/i.test(plainDescription(s)),
      defaultValue: s.default, ...k,
    };
    if (k.kind === 'number') {
      if (s.type === 'integer') d.integer = true;
      if (typeof s.minimum === 'number') d.min = s.minimum;
      else if (extra) { d.min = extra.min; if (extra.exclusive) d.minExclusive = true; }
      if (typeof s.maximum === 'number') d.max = s.maximum;
    }
    if (k.kind === 'map' && k.valueKind === 'number') d.min = 0;
    if (k.kind === 'enum') {
      d.options = s.enum.slice();
      if (Array.isArray(s.enumDescriptions)) d.optionLabels = s.enumDescriptions.slice();
    }
    if (UNITS[id]) d.unit = UNITS[id];
    out.push(d);
  }
  const order = (g: SettingGroup) => SETTING_GROUPS.indexOf(g);
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => order(a.d.group) - order(b.d.group) || a.i - b.i)
    .map(x => x.d);
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

const fail = (error: string): ValidationResult => ({ ok: false, error });

function toNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim().replace(',', '.'));
  return undefined;
}

function checkNumber(n: number | undefined, d: { integer?: boolean; min?: number; minExclusive?: boolean; max?: number }, what = 'Value'): string | null {
  if (n === undefined || !Number.isFinite(n)) return `${what} must be a number.`;
  if (d.integer && !Number.isInteger(n)) return `${what} must be a whole number.`;
  if (d.min !== undefined && (d.minExclusive ? n <= d.min : n < d.min)) return `${what} must be ${d.minExclusive ? 'greater than' : 'at least'} ${d.min}.`;
  if (d.max !== undefined && n > d.max) return `${what} must be at most ${d.max}.`;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate and normalize a value from the Settings tab. Numbers may arrive as
 * strings (comma decimals allowed); maps, lists and rules as structured JSON.
 */
export function validateSettingValue(d: SettingDescriptor, raw: unknown): ValidationResult {
  switch (d.kind) {
    case 'secret':
      return fail('The GitHub token is stored securely; use "Set token".');
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail('Value must be on or off.');
    case 'number': {
      const n = toNumber(raw);
      const e = checkNumber(n, d);
      return e ? fail(e) : { ok: true, value: n };
    }
    case 'enum':
      return typeof raw === 'string' && d.options?.includes(raw) ? { ok: true, value: raw } : fail(`Pick one of: ${(d.options ?? []).join(', ')}.`);
    case 'currency': {
      const c = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      return /^[A-Z]{3}$/.test(c) ? { ok: true, value: c } : fail('Use a 3-letter currency code such as EUR or USD.');
    }
    case 'string': {
      if (typeof raw !== 'string') return fail('Value must be text.');
      const v = raw.trim();
      if (v && d.id === 'githubRepo' && !/^[\w.-]+\/[\w.-]+$/.test(v)) return fail('Use the owner/repo format, e.g. octocat/hello-world.');
      if (v && d.id === 'azureDevOpsOrg' && !/^https:\/\/\S+$/i.test(v)) return fail('Use the organization URL, e.g. https://dev.azure.com/myorg.');
      if (v && d.id === 'githubOrg' && !/^[A-Za-z0-9-]+$/.test(v)) return fail('Use the organization login (letters, digits and dashes).');
      return { ok: true, value: v };
    }
    case 'map': {
      // The Settings tab sends [name, value] pairs so duplicate rows can be reported.
      const pairs = Array.isArray(raw) && raw.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string')
        ? raw as [string, unknown][]
        : isPlainObject(raw) ? Object.entries(raw) : undefined;
      if (!pairs) return fail('Value must be a table of names and values.');
      const out: Record<string, unknown> = {};
      for (const [k0, v0] of pairs) {
        const k = k0.trim();
        if (!k && (v0 === '' || v0 === undefined)) continue;
        if (!k) return fail('Every row needs a name.');
        if (k in out) return fail(`"${k}" is listed twice.`);
        if (d.valueKind === 'number') {
          const n = toNumber(v0);
          const e = checkNumber(n, { min: 0 }, `"${k}"`);
          if (e) return fail(e);
          out[k] = n;
        } else if (d.valueKind === 'enum') {
          if (typeof v0 !== 'string' || !d.valueOptions?.includes(v0)) return fail(`"${k}" must be one of: ${(d.valueOptions ?? []).join(', ')}.`);
          out[k] = v0;
        } else {
          if (typeof v0 !== 'string') return fail(`"${k}" must be text.`);
          out[k] = v0.trim();
        }
      }
      return { ok: true, value: out };
    }
    case 'list': {
      if (!Array.isArray(raw)) return fail('Value must be a list.');
      const out: unknown[] = [];
      for (const item of raw) {
        if (d.valueKind === 'number') {
          if (typeof item === 'string' && !item.trim()) continue;
          const n = toNumber(item);
          const e = checkNumber(n, { min: d.itemMin, max: d.itemMax }, 'Each entry');
          if (e) return fail(e);
          out.push(n);
        } else {
          if (typeof item !== 'string') return fail('Each entry must be text.');
          const v = item.trim();
          if (v && !out.includes(v)) out.push(v);
        }
      }
      return { ok: true, value: out };
    }
    case 'rules': {
      if (!Array.isArray(raw)) return fail('Value must be a list of rules.');
      const out: { pattern: string; category: string }[] = [];
      for (const [i, r] of raw.entries()) {
        if (!isPlainObject(r)) return fail(`Rule ${i + 1} is not valid.`);
        const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
        const category = typeof r.category === 'string' ? r.category.trim() : '';
        if (!pattern && !category) continue;
        if (!pattern || !category) return fail(`Rule ${i + 1} needs both a pattern and a category.`);
        try { new RegExp(pattern, 'i'); } catch (e) { return fail(`Rule ${i + 1}: invalid pattern (${e instanceof Error ? e.message : String(e)}).`); }
        out.push({ pattern, category });
      }
      return { ok: true, value: out };
    }
    case 'json': {
      let v = raw;
      if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch (e) { return fail(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}.`); }
      }
      const expectArray = Array.isArray(d.defaultValue);
      if (expectArray ? !Array.isArray(v) : !isPlainObject(v)) return fail(expectArray ? 'Value must be a JSON array.' : 'Value must be a JSON object.');
      if (d.id === 'aiuRatesOverride') {
        for (const [model, rate] of Object.entries(v as Record<string, unknown>)) {
          if (!isPlainObject(rate)) return fail(`"${model}" must be an object with inputNanoAiuPerToken / outputNanoAiuPerToken.`);
          for (const f of ['inputNanoAiuPerToken', 'outputNanoAiuPerToken']) {
            if (rate[f] !== undefined && (typeof rate[f] !== 'number' || !Number.isFinite(rate[f] as number) || (rate[f] as number) < 0)) return fail(`"${model}.${f}" must be a number of at least 0.`);
          }
        }
      }
      return { ok: true, value: v };
    }
  }
}

/** Extra writes implied by a change: picking a seniority preset pre-fills the baseline. */
export function impliedChanges(id: string, value: unknown): { id: string; value: unknown }[] {
  if (id === 'seniority' && typeof value === 'string' && value in SENIORITY_PRESETS) {
    return [{ id: 'baselineLocPerMinute', value: SENIORITY_PRESETS[value as keyof typeof SENIORITY_PRESETS] }];
  }
  return [];
}

export interface SettingInspect {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface SettingState extends SettingDescriptor {
  value: unknown;
  userValue: unknown;
  isDefault: boolean;
  overriddenBy: 'workspace' | 'folder' | null;
  overrideValue?: unknown;
}

/** Combine descriptors with the current values. The secret value is never included. */
export function settingStates(descs: SettingDescriptor[], inspect: (id: string) => SettingInspect | undefined): SettingState[] {
  return descs.map(d => {
    const i = inspect(d.id) ?? {};
    const overriddenBy = i.workspaceFolderValue !== undefined ? 'folder' : i.workspaceValue !== undefined ? 'workspace' : null;
    const effective = i.workspaceFolderValue ?? i.workspaceValue ?? i.globalValue ?? i.defaultValue ?? d.defaultValue;
    const secret = d.kind === 'secret';
    return {
      ...d,
      value: secret ? undefined : effective,
      userValue: secret ? undefined : i.globalValue,
      isDefault: i.globalValue === undefined,
      overriddenBy,
      ...(overriddenBy && !secret ? { overrideValue: overriddenBy === 'folder' ? i.workspaceFolderValue : i.workspaceValue } : {}),
    };
  });
}
