import * as fs from 'fs';
import * as path from 'path';
import { groupEpisodes, type Correction } from './corrections';
import { NON_LESSON_CATEGORIES, normalizeCategory, suggestScope } from './correctionLabels';
import { globToRegExp } from './review';

/**
 * Coding rules learned from labelled corrections (#133) and handed back to
 * Copilot as instructions files and MCP tools (#134). A rule is proposed (by
 * you, Copilot or a repeated lesson), then approved; only approved rules are
 * exported.
 */
export const LESSONS_FILE = 'lessons.json';
export const GENERATED_MARKER = 'aet-lessons:generated';
export const DEFAULT_MIN_OCCURRENCES = 3;
export const DEFAULT_MIN_WORK_ITEMS = 2;

export type RuleStatus = 'proposed' | 'approved' | 'rejected' | 'retired';
export type RuleSource = 'user' | 'copilot' | 'rule';
export const RULE_STATUSES: readonly RuleStatus[] = ['proposed', 'approved', 'rejected', 'retired'];

export interface LessonRule {
  id: string;
  category: string;
  /** Files the rule applies to, as a glob such as `**\/*.Codeunit.al`. */
  scope: string;
  /** The rule in one or two sentences, written for Copilot. */
  text: string;
  status: RuleStatus;
  /** Workspace folder name; without it the rule applies to every repository. */
  repo?: string;
  /** Ids of the corrections the rule was learned from. */
  examples: string[];
  createdBy: RuleSource;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
}

export interface LessonStoreData { version: 1; rules: LessonRule[] }

/** Changes from one VS Code window or the MCP server, merged into the latest file under the store lock. */
export interface LessonDelta { upsert: LessonRule[]; remove: string[] }

export const emptyLessonStore = (): LessonStoreData => ({ version: 1, rules: [] });
export const emptyLessonDelta = (): LessonDelta => ({ upsert: [], remove: [] });
export const lessonDeltaIsEmpty = (d: LessonDelta) => !d.upsert.length && !d.remove.length;

const str = (v: unknown) => typeof v === 'string' ? v : '';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

function decodeRule(v: unknown): LessonRule | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const id = str(r.id), category = normalizeCategory(str(r.category));
  if (!id || !category) return undefined;
  const status = RULE_STATUSES.includes(r.status as RuleStatus) ? r.status as RuleStatus : 'proposed';
  const createdBy = r.createdBy === 'copilot' || r.createdBy === 'rule' ? r.createdBy : 'user';
  return {
    id, category, scope: str(r.scope).trim() || '**', text: str(r.text).trim(), status,
    ...(str(r.repo) ? { repo: str(r.repo) } : {}),
    examples: Array.isArray(r.examples) ? r.examples.filter((x): x is string => typeof x === 'string') : [],
    createdBy, createdAt: num(r.createdAt), updatedAt: num(r.updatedAt),
    ...(num(r.approvedAt) ? { approvedAt: num(r.approvedAt) } : {})
  };
}

export function decodeLessonStore(raw: string): LessonStoreData {
  const s = JSON.parse(raw) as Record<string, unknown>;
  if (!s || typeof s !== 'object' || !Array.isArray(s.rules)) throw new Error('Invalid lessons store');
  return { version: 1, rules: s.rules.map(decodeRule).filter((r): r is LessonRule => !!r) };
}

/** Upserts replace a rule unless the stored one was changed later; removes delete by id. */
export function mergeLessonDelta(data: LessonStoreData, delta: LessonDelta): LessonStoreData {
  const gone = new Set(delta.remove);
  const byId = new Map(data.rules.filter(r => !gone.has(r.id)).map(r => [r.id, r]));
  for (const r of delta.upsert) {
    if (gone.has(r.id)) continue;
    const cur = byId.get(r.id);
    if (!cur || cur.updatedAt <= r.updatedAt) byId.set(r.id, r);
  }
  return { version: 1, rules: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) };
}

export const ruleKey = (category: string, scope: string) => `${normalizeCategory(category)}|${scope.trim().replace(/\\/g, '/').toLowerCase()}`;

let seq = 0;
export function newRuleId(now = Date.now()): string {
  seq = (seq + 1) % 1296;
  return `r${now.toString(36)}${seq.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export interface NewRuleInput { category: string; scope: string; text?: string; examples?: string[]; repo?: string; status?: RuleStatus }

export function createRule(input: NewRuleInput, by: RuleSource, now = Date.now()): LessonRule {
  const category = normalizeCategory(input.category);
  if (!category) throw new Error('A rule needs a category.');
  if (NON_LESSON_CATEGORIES.includes(category)) throw new Error(`"${category}" teaches nothing; pick a lesson category.`);
  const text = (input.text ?? '').trim();
  const status = input.status ?? 'proposed';
  if (status === 'approved' && !text) throw new Error('Write the rule text before approving it.');
  return {
    id: newRuleId(now), category, scope: input.scope.trim() || '**', text, status,
    ...(input.repo?.trim() ? { repo: input.repo.trim() } : {}),
    examples: [...new Set(input.examples ?? [])], createdBy: by, createdAt: now, updatedAt: now,
    ...(status === 'approved' ? { approvedAt: now } : {})
  };
}

export interface RulePatch { category?: string; scope?: string; text?: string; status?: RuleStatus; repo?: string; addExamples?: string[] }

export function updateRule(rule: LessonRule, patch: RulePatch, now = Date.now()): LessonRule {
  const next: LessonRule = { ...rule, examples: [...rule.examples], updatedAt: now };
  if (patch.category !== undefined) {
    const c = normalizeCategory(patch.category);
    if (!c || NON_LESSON_CATEGORIES.includes(c)) throw new Error('Pick a lesson category.');
    next.category = c;
  }
  if (patch.scope !== undefined) next.scope = patch.scope.trim() || '**';
  if (patch.text !== undefined) next.text = patch.text.trim();
  if (patch.repo !== undefined) { if (patch.repo.trim()) next.repo = patch.repo.trim(); else delete next.repo; }
  if (patch.addExamples) next.examples = [...new Set([...next.examples, ...patch.addExamples])];
  if (patch.status !== undefined) {
    if (!RULE_STATUSES.includes(patch.status)) throw new Error(`Unknown status "${patch.status}".`);
    next.status = patch.status;
    if (patch.status === 'approved' && rule.status !== 'approved') next.approvedAt = now;
  }
  if (next.status === 'approved' && !next.text) throw new Error('Write the rule text before approving it.');
  return next;
}

/** Repeated lessons: lesson-labelled corrections grouped by category and scope. */
export interface LessonGroup {
  key: string;
  category: string;
  scope: string;
  /** Corrections in the group. */
  count: number;
  /** Your own edits among them (the strongest signal). */
  human: number;
  /** Prompts or editing sittings; one prompt that reworks 30 lines counts once. */
  episodes: number;
  /** Work items, or branches without a work item. */
  workItems: string[];
  repos: string[];
  /** Distinct notes, most frequent first; each is a draft rule text. */
  notes: string[];
  /** Newest corrections first (at most 20). */
  examples: string[];
  lastAt: number;
  /** Repeated often enough to become a rule. */
  suggested: boolean;
  /** Rules with the same category and scope. */
  ruleIds: string[];
}

export interface LessonThresholds { minOccurrences?: number; minWorkItems?: number }

export function lessonGroups(corrections: readonly Correction[], rules: readonly LessonRule[], t: LessonThresholds = {}): LessonGroup[] {
  const minOcc = Math.max(1, Math.floor(t.minOccurrences ?? DEFAULT_MIN_OCCURRENCES));
  const minWi = Math.max(1, Math.floor(t.minWorkItems ?? DEFAULT_MIN_WORK_ITEMS));
  const lessons = corrections.filter(c => c.category && !NON_LESSON_CATEGORIES.includes(c.category));
  const episodeOf = new Map<string, string>();
  for (const e of groupEpisodes(lessons)) for (const id of e.correctionIds) episodeOf.set(id, e.id);
  const groups = new Map<string, {
    category: string; scope: string; items: Correction[]; episodes: Set<string>; work: Set<string>; repos: Set<string>; notes: Map<string, number>;
  }>();
  for (const c of lessons) {
    const scope = c.scope || suggestScope(c.path);
    const key = ruleKey(c.category!, scope);
    const g = groups.get(key) ?? { category: c.category!, scope, items: [] as Correction[], episodes: new Set<string>(), work: new Set<string>(), repos: new Set<string>(), notes: new Map<string, number>() };
    g.items.push(c);
    g.episodes.add(episodeOf.get(c.id) ?? c.id);
    g.work.add(c.workItemId ? `#${c.workItemId}` : c.branch || 'unknown');
    if (c.repo) g.repos.add(c.repo);
    const note = c.note?.trim();
    if (note) g.notes.set(note, (g.notes.get(note) ?? 0) + 1);
    groups.set(key, g);
  }
  const rulesByKey = new Map<string, string[]>();
  for (const r of rules) {
    const k = ruleKey(r.category, r.scope);
    rulesByKey.set(k, [...(rulesByKey.get(k) ?? []), r.id]);
  }
  return [...groups.entries()].map(([key, g]) => {
    const items = g.items.slice().sort((a, b) => b.t - a.t);
    return {
      key, category: g.category, scope: g.scope, count: items.length,
      human: items.filter(c => c.source === 'human').length,
      episodes: g.episodes.size, workItems: [...g.work].sort(), repos: [...g.repos].sort(),
      notes: [...g.notes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
      examples: items.slice(0, 20).map(c => c.id), lastAt: items[0]?.t ?? 0,
      suggested: g.episodes.size >= minOcc && g.work.size >= minWi,
      ruleIds: rulesByKey.get(key) ?? []
    };
  }).sort((a, b) =>
    Number(b.suggested && !b.ruleIds.length) - Number(a.suggested && !a.ruleIds.length)
    || Number(b.suggested) - Number(a.suggested)
    || b.episodes - a.episodes || b.count - a.count || a.key.localeCompare(b.key));
}

/** Does `scope` match this path? Also tries every sub-path, so absolute paths and paths from the repository's parent folder match too. */
export function scopeMatches(scope: string, filePath: string): boolean {
  const re = globToRegExp(scope || '**');
  const p = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (re.test(p)) return true;
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (re.test(p.slice(i + 1))) return true;
  return false;
}

/** Rules for one repository: those without a repo plus those of this repo. */
export const rulesForRepo = (rules: readonly LessonRule[], repo?: string) =>
  rules.filter(r => !r.repo || !repo || r.repo.toLowerCase() === repo.toLowerCase());

export interface LessonQuery { path?: string; repo?: string; includeProposed?: boolean }

export function findRules(rules: readonly LessonRule[], q: LessonQuery = {}): LessonRule[] {
  return rulesForRepo(rules, q.repo)
    .filter(r => r.status === 'approved' || (q.includeProposed && r.status === 'proposed'))
    .filter(r => !q.path || scopeMatches(r.scope, q.path))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.category.localeCompare(b.category) || a.createdAt - b.createdAt);
}

/** Copilot proposes a rule: refreshes its own open proposal with the same category, scope and text or adds a new one. */
export function proposeRuleDelta(data: LessonStoreData, input: NewRuleInput, now = Date.now()): { delta: LessonDelta; rule: LessonRule; created: boolean } {
  const key = ruleKey(input.category, input.scope);
  const text = (input.text ?? '').trim();
  if (!text) throw new Error('"text" is required: the rule in one or two sentences.');
  const same = data.rules.find(r => ruleKey(r.category, r.scope) === key && r.text.toLowerCase() === text.toLowerCase());
  if (same) {
    if (same.status !== 'proposed') return { delta: emptyLessonDelta(), rule: same, created: false };
    const rule = updateRule(same, { addExamples: input.examples ?? [], ...(input.repo !== undefined ? { repo: input.repo } : {}) }, now);
    return { delta: { upsert: [rule], remove: [] }, rule, created: false };
  }
  const rule = createRule({ ...input, text, status: 'proposed' }, 'copilot', now);
  return { delta: { upsert: [rule], remove: [] }, rule, created: true };
}

// ---------------------------------------------------------------- export (#134)

export interface ExportFile { name: string; content: string }

const yamlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function scopeSlug(scope: string): string {
  const s = scope.replace(/\\/g, '/').replace(/^(\*\*\/)+/, '').replace(/\*\*/g, 'all').replace(/\*/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'all';
}

/** One instructions file per scope with the approved rules, grouped by category. */
export function lessonInstructionFiles(rules: readonly LessonRule[]): ExportFile[] {
  const byScope = new Map<string, LessonRule[]>();
  for (const r of rules) {
    if (r.status !== 'approved' || !r.text) continue;
    byScope.set(r.scope, [...(byScope.get(r.scope) ?? []), r]);
  }
  const used = new Set<string>();
  return [...byScope.keys()].sort().map(scope => {
    let slug = scopeSlug(scope), n = 2;
    while (used.has(slug)) slug = `${scopeSlug(scope)}-${n++}`;
    used.add(slug);
    const list = byScope.get(scope)!;
    const cats = [...new Set(list.map(r => r.category))].sort();
    const body = cats.map(cat => {
      const items = list.filter(r => r.category === cat).sort((a, b) => a.createdAt - b.createdAt)
        .map(r => '- ' + r.text.replace(/\r?\n+/g, '\n  '));
      return `## ${title(cat)}\n\n${items.join('\n')}`;
    }).join('\n\n');
    return {
      name: `aet-lessons-${slug}.instructions.md`,
      content: `---\napplyTo: ${yamlString(scope)}\ndescription: ${yamlString(`Lessons from corrections of AI-written code (${scope})`)}\n---\n`
        + `<!-- ${GENERATED_MARKER}: written by AI Effort Tracker from the approved rules in the dashboard's Corrections tab. Edit the rules there; this file is replaced on every export. -->\n\n`
        + `# Lessons for \`${scope}\`\n\nThe developer corrected AI-written code in these files for the reasons below. Follow these rules when you write or change such files.\n\n${body}\n`
    };
  });
}

export const REVIEW_SKILL_NAME = 'lessons-review';

/** Agent skill: check changed code against the approved rules and flag violations in the review view. */
export function reviewSkillMarkdown(): string {
  return `---\nname: ${REVIEW_SKILL_NAME}\ndescription: ${yamlString('Review changed code against the lessons learned from earlier corrections of AI-written code (AI Effort Tracker rules). Use it when asked to check code against the lessons or rules, or before marking work as done.')}\n---\n`
    + `<!-- ${GENERATED_MARKER}: written by AI Effort Tracker. Remove this line to keep your own edits; the file is then no longer replaced. -->\n\n`
    + '# Review against the lessons\n\n'
    + 'The developer keeps coding rules learned from corrections of AI-written code in AI Effort Tracker. Check the changed code against them:\n\n'
    + '1. Find the changed files (for example with `git diff --name-only` against the base branch, or the files the developer names).\n'
    + '2. For each file call the `get_lessons` tool of the "AI Effort Tracker usage insights" MCP server with `path` set to the repository-relative path. It returns the approved rules whose scope matches that file.\n'
    + '3. Read the changed parts of the file and check every rule. Only report real violations; a rule that does not apply to the change is not a finding.\n'
    + '4. Report each violation with the file, line range, the rule and what to change.\n'
    + '5. Only when the developer asks you to flag them: call `review_mark` with `status: "issue"`, `paths: [file]`, `startLine`, `endLine` and a `note` that quotes the rule. The lines then show as review issues in VS Code.\n\n'
    + 'Do not fix the code unless the developer asks you to. If `get_lessons` returns no rules for any file, say so.\n';
}

export interface ExportResult { dir: string; written: string[]; removed: string[]; skipped: string[]; skill?: string; rules: number }

const isGenerated = (file: string) => {
  try { return fs.readFileSync(file, 'utf8').includes(GENERATED_MARKER); } catch { return false; }
};

const writeIfChanged = (file: string, content: string) => {
  try { if (fs.readFileSync(file, 'utf8') === content) return; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

/**
 * Writes the instructions files into `dir`, removes generated files of scopes
 * that no longer have rules, and writes the review skill into `skillsDir`
 * unless you edited it (marker removed).
 */
export function writeLessonExport(rules: readonly LessonRule[], dir: string, skillsDir?: string): ExportResult {
  const files = lessonInstructionFiles(rules);
  const keep = new Set(files.map(f => f.name));
  const removed: string[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^aet-lessons-.*\.instructions\.md$/i.test(name) || keep.has(name)) continue;
      const file = path.join(dir, name);
      if (isGenerated(file)) { fs.unlinkSync(file); removed.push(name); }
    }
  }
  const skipped: string[] = [];
  for (const f of files) {
    const file = path.join(dir, f.name);
    if (fs.existsSync(file) && !isGenerated(file)) skipped.push(f.name); else writeIfChanged(file, f.content);
  }
  let skill: string | undefined;
  if (skillsDir) {
    const file = path.join(skillsDir, REVIEW_SKILL_NAME, 'SKILL.md');
    if (!fs.existsSync(file) || isGenerated(file)) { writeIfChanged(file, reviewSkillMarkdown()); skill = file; }
  }
  return { dir, written: files.map(f => f.name).filter(n => !skipped.includes(n)), removed, skipped, ...(skill ? { skill } : {}), rules: rules.filter(r => r.status === 'approved' && r.text).length };
}
