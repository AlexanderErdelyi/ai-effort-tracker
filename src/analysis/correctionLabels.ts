import {
  emptyCorrectionDelta, groupEpisodes,
  type Correction, type CorrectionDelta, type CorrectionEpisode, type CorrectionStoreData, type LabelSource,
  type SuggestedLabel, type SuggestionSource
} from './corrections';
import { globToRegExp } from './review';

/**
 * Labels for captured corrections (#132): a category says what was wrong, a
 * scope (file glob) says where the lesson applies. Lesson categories feed rule
 * suggestions (#133); the others mark corrections that teach nothing.
 */
export const DEFAULT_LESSON_CATEGORIES = [
  'wrong fact', 'logic bug', 'style', 'naming', 'documentation', 'ordering/structure', 'error handling', 'tests', 'performance'
];
/** Copilot did what was asked; the request changed or was a status update. */
export const NON_LESSON_CATEGORIES = ['requirement change', 'progress update', 'not a lesson'];

export interface KeywordRule { pattern: string; category: string }

/** Checked in order against the prompt that asked for AI rework; the first match wins. */
export const DEFAULT_KEYWORD_RULES: KeywordRule[] = [
  { pattern: '\\b(status|progress)\\b|what you (did|have done|changed)', category: 'progress update' },
  { pattern: '\\b(wrong|mistake|incorrect|bug|not correct|does ?n.t work|does not work)\\b', category: 'logic bug' },
  { pattern: '\\b(document|documentation|comments?|xml ?doc)\\b', category: 'documentation' },
  { pattern: '\\b(sort|sorting|order|reorder|structure|restructure)\\b', category: 'ordering/structure' },
  { pattern: '\\b(rename|naming)\\b', category: 'naming' },
  { pattern: '\\b(error handling|exception|validation|testfield)\\b', category: 'error handling' },
  { pattern: '\\b(unit tests?|tests)\\b', category: 'tests' },
  { pattern: '\\b(slow|performance|faster|optimi[sz]e)\\b', category: 'performance' }
];

export interface LabelSuggestion {
  category: string;
  reason: string;
  /** Your earlier labels (`history`), a prompt keyword rule, a check of the diff (`heuristic`) or the AI fallback (`default`). */
  source: SuggestionSource;
  /** Keyword rule pattern that matched. */
  rule?: string;
  /** History suggestions: glob and note of the similar labelled corrections. */
  scope?: string;
  note?: string;
  /** History suggestions: how many similar labelled corrections agree. */
  matches?: number;
}

export const normalizeCategory = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();

/** Valid rules only; bad regular expressions and empty categories are dropped. */
export function compileKeywordRules(rules: unknown): Array<{ re: RegExp; category: string; pattern: string }> {
  if (!Array.isArray(rules)) return [];
  const out: Array<{ re: RegExp; category: string; pattern: string }> = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const { pattern, category } = r as Record<string, unknown>;
    if (typeof pattern !== 'string' || !pattern || typeof category !== 'string' || !normalizeCategory(category)) continue;
    try { out.push({ re: new RegExp(pattern, 'i'), category: normalizeCategory(category), pattern }); } catch { /* skip invalid pattern */ }
  }
  return out;
}

const COMMENT = /^\s*(\/\/|\/\*|\*|--|#(?!\w)|')/;
const DIGITS = /\d+/g;
const squash = (lines: string[]) => lines.join('\n').replace(/\s+/g, '');
const DOC_EXTS = new Set(['md', 'mdx', 'markdown', 'rst', 'adoc', 'txt']);
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$|tests?\.codeunit\.al$|_tests?\.[^/]+$|(^|\/)test_[^/]+$/i;
const ERROR_HANDLING = /\b(Error|FieldError|TestField)\s*\(|\b(throw|raise|try|catch|except|finally)\b|\bif\b.*\b(then\s+exit|return|throw|raise)\b/i;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\S/g;
const IDENT = /^[A-Za-z_]/;
/** Words whose swap changes meaning, not a name. */
const KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'none', 'nil', 'and', 'or', 'not', 'xor', 'in', 'is', 'if', 'then', 'else', 'begin', 'end',
  'var', 'let', 'const', 'local', 'internal', 'public', 'private', 'protected', 'procedure', 'trigger', 'function', 'exit', 'return'
]);

/** Each correction whose removed lines show up again in another correction of the same file (a move done in two steps). */
export interface CrossMove { line: number; removedHere: boolean }
const MOVE_WINDOW_MS = 30 * 60_000;

const meaningful = (l: string) => l.trim().length >= 6;
function changedLines(c: Correction): { removed: string[]; added: string[] } {
  const before = (c.before ?? []).map(l => l.trim()), after = (c.after ?? []).map(l => l.trim());
  const a = new Set(after), b = new Set(before);
  return { removed: before.filter(l => meaningful(l) && !a.has(l)), added: after.filter(l => meaningful(l) && !b.has(l)) };
}

/** Pairs corrections in one file, close in time, where one removed what the other added. */
export function crossMoves(corrections: readonly Correction[]): Map<string, CrossMove> {
  const out = new Map<string, CrossMove>();
  const byFile = new Map<string, Correction[]>();
  for (const c of corrections) {
    if (c.kind === 'move') continue;
    const key = `${c.repo}|${c.path.replace(/\\/g, '/')}`.toLowerCase();
    byFile.set(key, [...(byFile.get(key) ?? []), c]);
  }
  for (const list of byFile.values()) {
    if (list.length < 2) continue;
    const lines = list.map(changedLines);
    for (let i = 0; i < list.length; i++) {
      const removed = lines[i].removed;
      if (removed.length < 2) continue;
      for (let j = 0; j < list.length; j++) {
        if (i === j || Math.abs(list[i].t - list[j].t) > MOVE_WINDOW_MS) continue;
        // Rewriting the same spot twice is not a move.
        if (Math.abs(list[i].line - list[j].line) <= Math.max(removed.length, 3)) continue;
        const added = new Set(lines[j].added);
        if (removed.filter(l => added.has(l)).length / removed.length < 0.6) continue;
        out.set(list[i].id, { line: list[j].line, removedHere: true });
        if (!out.has(list[j].id)) out.set(list[j].id, { line: list[i].line, removedHere: false });
      }
    }
  }
  return out;
}

/** Old and new name when every difference is the same identifier renamed. */
function renamedIdentifier(before: string[], after: string[]): [string, string] | undefined {
  if (before.length !== after.length) return undefined;
  const map = new Map<string, string>(), back = new Map<string, string>();
  for (let i = 0; i < before.length; i++) {
    const a = before[i].match(TOKEN) ?? [], b = after[i].match(TOKEN) ?? [];
    if (a.length !== b.length) return undefined;
    for (let j = 0; j < a.length; j++) {
      if (a[j] === b[j]) continue;
      if (!IDENT.test(a[j]) || !IDENT.test(b[j]) || a[j].toLowerCase() === b[j].toLowerCase()) return undefined;
      if (KEYWORDS.has(a[j].toLowerCase()) || KEYWORDS.has(b[j].toLowerCase())) return undefined;
      if ((map.get(a[j]) ?? b[j]) !== b[j] || (back.get(b[j]) ?? a[j]) !== a[j]) return undefined;
      map.set(a[j], b[j]);
      back.set(b[j], a[j]);
    }
  }
  return map.size === 1 ? [...map.entries()][0] : undefined;
}

const sorted = (lines: string[]) => lines.map(l => l.trim()).filter(Boolean).sort().join('\n');

/** Inputs that make suggestions better than one correction alone: your earlier labels and moves across corrections. */
export interface SuggestContext { history?: readonly HistoryEntry[]; moves?: ReadonlyMap<string, CrossMove> }

/**
 * A category guess for one correction, for you to confirm. Your own earlier
 * labels win (#149), then prompt keyword rules (AI rework only), then what the
 * diff shows (#151); AI rework without any of these is a requirement change.
 */
export function suggestLabel(c: Correction, rules: ReturnType<typeof compileKeywordRules>, ctx: SuggestContext = {}): LabelSuggestion | undefined {
  const fromHistory = ctx.history?.length ? historySuggestion(c, ctx.history) : undefined;
  if (fromHistory) return fromHistory;
  if (c.source === 'ai') {
    const text = c.trigger?.text ?? '';
    for (const r of rules) if (r.re.test(text)) return { category: r.category, reason: `The prompt matches "${r.pattern}"`, source: 'keyword', rule: r.pattern };
    return changeSuggestion(c, ctx.moves) ?? { category: 'requirement change', reason: 'Copilot reworked its own code after a new prompt', source: 'default' };
  }
  return changeSuggestion(c, ctx.moves);
}

const heuristic = (category: string, reason: string): LabelSuggestion => ({ category, reason, source: 'heuristic' });

/**
 * What the change itself says. AI rework gets only the plain checks (moved,
 * spacing, numbers, comments): its prompt says more about why it changed.
 */
function changeSuggestion(c: Correction, moves?: ReadonlyMap<string, CrossMove>): LabelSuggestion | undefined {
  if (c.kind === 'move') return heuristic('ordering/structure', 'AI code was moved');
  const human = c.source === 'human';
  const moved = human ? moves?.get(c.id) : undefined;
  if (moved) {
    return heuristic('ordering/structure', moved.removedHere
      ? `The removed lines were added again at line ${moved.line}`
      : `The added lines were removed from line ${moved.line}`);
  }
  const before = c.before ?? [], after = c.after ?? [];
  if (!before.length && !after.length) return undefined;
  const doc = DOC_EXTS.has(c.ext.toLowerCase());
  if (before.length && after.length) {
    const b = squash(before), a = squash(after);
    if (b === a) return heuristic('style', 'Only spacing changed');
    if (human && b.toLowerCase() === a.toLowerCase()) return heuristic('style', 'Only letter case changed');
    if (human && b.replace(/["';`]/g, '') === a.replace(/["';`]/g, '')) return heuristic('style', 'Only quotes or semicolons changed');
    if (b.replace(DIGITS, '#') === a.replace(DIGITS, '#')) return heuristic('wrong fact', 'Only numbers changed (IDs, positions, values)');
    if (human && before.length > 1 && sorted(before) === sorted(after)) return heuristic('ordering/structure', 'The same lines in a different order');
    const renamed = human && !doc ? renamedIdentifier(before, after) : undefined;
    if (renamed) return heuristic('naming', `Renamed ${renamed[0]} to ${renamed[1]}`);
  }
  if (!doc && [...before, ...after].every(l => !l.trim() || COMMENT.test(l))) {
    return heuristic('documentation', c.kind === 'insert' ? 'Comment lines were added' : 'Only comments changed');
  }
  if (!human) return undefined;
  if (TEST_PATH.test(c.path.replace(/\\/g, '/'))) return heuristic('tests', 'The change is in a test file');
  const { removed, added } = changedLines(c);
  const code = (l: string) => !COMMENT.test(l);
  if (added.some(l => code(l) && ERROR_HANDLING.test(l)) && !removed.some(l => code(l) && ERROR_HANDLING.test(l))) {
    return heuristic('error handling', 'An error, check or guard was added');
  }
  if (doc) return heuristic('documentation', `You edited AI-written ${c.ext} text`);
  return undefined;
}

/** A labelled correction prepared for similarity checks. */
export interface HistoryEntry {
  c: Correction; scope: string; changed: Set<string>; words: Set<string>; prompt: Set<string>; promptKey?: string;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]+/g;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'not', 'but', 'can', 'please', 'pls', 'was', 'have', 'has', 'from', 'into',
  'also', 'what', 'then', 'now', 'all', 'its', 'our', 'your', 'should', 'would', 'could', 'will', 'just', 'some', 'like', 'them',
  'they', 'there', 'here', 'make', 'does', 'did', 'get', 'let', 'use', 'yes', 'okay', 'lets', 'need', 'want', 'one', 'out', 'too'
]);
const words = (lines: readonly string[]) => new Set(lines.join('\n').toLowerCase().match(WORD) ?? []);
/** Prompt words without file paths, which repeat in every prompt of a project. */
const promptWords = (text: string) => new Set((text.replace(/\S*[\\/]\S*/g, ' ').toLowerCase().match(WORD) ?? []).filter(w => w.length > 2 && !STOP.has(w)));

function historyEntry(c: Correction): HistoryEntry {
  const b = words(c.before ?? []), a = words(c.after ?? []);
  const changed = new Set([...a].filter(w => !b.has(w)).concat([...b].filter(w => !a.has(w))));
  const text = c.source === 'ai' ? c.trigger?.text ?? '' : '';
  return {
    c, scope: suggestScope(c.path), changed, words: new Set([...a, ...b]), prompt: promptWords(text),
    ...(c.source === 'ai' && c.trigger ? { promptKey: `${c.trigger.sessionId}|${c.trigger.t}` } : {})
  };
}

/** The labelled corrections suggestions learn from. Bulk "Accept all" labels are left out so suggestions do not just confirm themselves. */
export function labelHistory(corrections: readonly Correction[]): HistoryEntry[] {
  return corrections.filter(c => c.category && c.labeledBy !== 'rule').map(historyEntry);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

const HISTORY_THRESHOLD = 0.45;

/**
 * 0..1: how alike two corrections are. AI rework is compared by its prompt,
 * because the prompt says why the code changed (the same line is often
 * rewritten for different reasons); your own changes are compared by file type
 * and the words that changed.
 */
export function similarity(x: HistoryEntry, y: HistoryEntry): number {
  if (x.c.source !== y.c.source) return 0;
  const place = x.scope === y.scope ? 1 : x.c.ext === y.c.ext ? 0.4 : 0;
  const changed = jaccard(x.changed, y.changed);
  if (x.c.source === 'ai') {
    const prompt = x.promptKey && x.promptKey === y.promptKey ? 1 : jaccard(x.prompt, y.prompt);
    return 0.6 * prompt + 0.25 * place + 0.15 * changed;
  }
  return 0.3 * place + 0.4 * changed + 0.2 * jaccard(x.words, y.words) + (x.c.kind === y.c.kind ? 0.1 : 0);
}

function historySuggestion(c: Correction, history: readonly HistoryEntry[]): LabelSuggestion | undefined {
  const me = historyEntry(c);
  const near = history
    .filter(h => h.c.id !== c.id)
    .map(h => ({ h, s: similarity(me, h) }))
    .filter(x => x.s >= HISTORY_THRESHOLD)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (!near.length) return undefined;
  const votes = new Map<string, number>();
  for (const x of near) votes.set(x.h.c.category!, (votes.get(x.h.c.category!) ?? 0) + x.s);
  const category = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const agree = near.filter(x => x.h.c.category === category);
  const scopes = new Map<string, number>();
  for (const x of agree) if (x.h.c.scope && scopeMatches(x.h.c.scope, c.path)) scopes.set(x.h.c.scope, (scopes.get(x.h.c.scope) ?? 0) + 1);
  const scope = [...scopes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const note = agree[0].s >= 0.7 ? agree[0].h.c.note : undefined;
  const n = agree.length;
  return {
    category, source: 'history', matches: n,
    reason: `Like ${n} correction${n === 1 ? '' : 's'} labelled \u201c${category}\u201d${scope ? ` in ${scope}` : ''}`,
    ...(scope ? { scope } : {}), ...(note ? { note } : {})
  };
}

/** Suggestions for any correction of this store, using its labels, moves and the keyword rules. */
/** Snapshot the extension writes so the MCP server uses the same keyword rules. */
export const CORRECTION_RULES_SNAPSHOT_FILE = 'correction-rules.json';

export function createSuggester(corrections: readonly Correction[], rules: unknown): (c: Correction) => LabelSuggestion | undefined {
  const compiled = compileKeywordRules(rules);
  const ctx: SuggestContext = { history: labelHistory(corrections), moves: crossMoves(corrections) };
  return c => suggestLabel(c, compiled, ctx);
}

const toSuggested = (s: LabelSuggestion): SuggestedLabel => ({ category: s.category, source: s.source, ...(s.rule ? { rule: s.rule } : {}) });

/** Does `scope` match this path? Also tries every sub-path, so absolute paths and paths from the repository's parent folder match too. */
export function scopeMatches(scope: string, filePath: string): boolean {
  const re = globToRegExp(scope || '**');
  const p = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (re.test(p)) return true;
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (re.test(p.slice(i + 1))) return true;
  return false;
}

/** Glob the lesson most likely applies to, e.g. `**\/*.Codeunit.al` for an AL codeunit. */
export function suggestScope(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const al = /\.([A-Za-z]+)\.al$/i.exec(base);
  if (al) return `**/*.${al[1]}.al`;
  const dot = base.lastIndexOf('.');
  if (dot > 0) return `**/*${base.slice(dot)}`;
  const slash = norm.lastIndexOf('/');
  return slash > 0 ? `${norm.slice(0, slash)}/**` : '**';
}

/**
 * Store delta that labels (or, with an empty category, unlabels) corrections.
 * Without an explicit scope each correction keeps its scope or gets the
 * suggested one for its file. Unknown ids are skipped. The first label also
 * records what the tracker suggested, so its accuracy can be measured (#150).
 */
export function labelDelta(
  data: CorrectionStoreData, ids: readonly string[], label: { category: string; scope?: string; note?: string }, by: LabelSource,
  now = Date.now(), rules: unknown = DEFAULT_KEYWORD_RULES
): CorrectionDelta {
  const delta = emptyCorrectionDelta();
  const category = normalizeCategory(label.category);
  const byId = new Map(data.corrections.map(c => [c.id, c]));
  let suggest: ((c: Correction) => LabelSuggestion | undefined) | undefined;
  for (const id of new Set(ids)) {
    const c = byId.get(id);
    if (!c) continue;
    let suggested: LabelSuggestion | undefined;
    if (category && !c.category) suggested = (suggest ??= createSuggester(data.corrections, rules))(c);
    delta.patch[id] = category
      ? {
        category, labeledBy: by, labeledAt: now,
        scope: label.scope !== undefined ? label.scope.trim() : (c.scope ?? suggestScope(c.path)),
        ...(label.note !== undefined ? { note: label.note.trim() } : {}),
        ...(suggested ? { suggested: toSuggested(suggested) } : {})
      }
      : { category: '', scope: '', note: '' };
  }
  return delta;
}

export interface SuggestionAccuracy {
  /** Labelled by you or Copilot after a suggestion was shown. */
  judged: number;
  /** Of those, labelled with the suggested category. */
  accepted: number;
  rate: number | null;
  bySource: Array<{ source: SuggestionSource; judged: number; accepted: number; rate: number }>;
  /** Labelled with "Accept all suggestions" and not reviewed since. */
  bulk: number;
  /** Keyword rules whose suggestion is usually changed (at least 3 times, half or more). */
  overriddenRules: Array<{ rule: string; category: string; judged: number; overridden: number; usually: string }>;
}

/** How often suggestions were right, per source (#150). */
export function suggestionAccuracy(corrections: readonly Correction[]): SuggestionAccuracy {
  const withSuggestion = corrections.filter(c => c.category && c.suggested);
  const judged = withSuggestion.filter(c => c.labeledBy !== 'rule');
  const ok = (c: Correction) => c.category === c.suggested!.category;
  const sources: SuggestionSource[] = ['history', 'keyword', 'heuristic', 'default'];
  const bySource = sources
    .map(source => {
      const list = judged.filter(c => c.suggested!.source === source);
      const accepted = list.filter(ok).length;
      return { source, judged: list.length, accepted, rate: list.length ? accepted / list.length : 0 };
    })
    .filter(x => x.judged);
  const rules = new Map<string, Correction[]>();
  for (const c of judged) if (c.suggested!.source === 'keyword' && c.suggested!.rule) rules.set(c.suggested!.rule, [...(rules.get(c.suggested!.rule) ?? []), c]);
  const overriddenRules = [...rules.entries()]
    .map(([rule, list]) => {
      const changed = list.filter(c => !ok(c));
      const counts = new Map<string, number>();
      for (const c of changed) counts.set(c.category!, (counts.get(c.category!) ?? 0) + 1);
      const usually = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      return { rule, category: list[0].suggested!.category, judged: list.length, overridden: changed.length, usually };
    })
    .filter(r => r.judged >= 3 && r.overridden / r.judged >= 0.5)
    .sort((a, b) => b.overridden - a.overridden);
  const accepted = judged.filter(ok).length;
  return {
    judged: judged.length, accepted, rate: judged.length ? accepted / judged.length : null,
    bySource, bulk: withSuggestion.length - judged.length, overriddenRules
  };
}

export interface CorrectionItem {
  id: string; t: number; kind: Correction['kind']; path: string; line: number; fromLine?: number;
  context?: string; toContext?: string; added: number; removed: number; aiLines: number;
  before?: string[]; after?: string[];
  category?: string; scope?: string; note?: string; labeledBy?: LabelSource;
  suggestion?: LabelSuggestion; suggestedScope: string;
}

export interface CorrectionsView {
  categories: string[];
  nonLesson: string[];
  stats: { total: number; human: number; ai: number; prompts: number; labeled: number; suggested: number; lessons: number };
  byCategory: Array<{ category: string; lesson: boolean; count: number; human: number; episodes: number; scopes: string[] }>;
  episodes: Array<CorrectionEpisode & { suggestion?: LabelSuggestion; items: CorrectionItem[] }>;
  accuracy: SuggestionAccuracy;
}

/** Everything the dashboard's Corrections tab shows. */
export function correctionsView(data: CorrectionStoreData, categories: readonly string[], rules: unknown): CorrectionsView {
  const suggest = createSuggester(data.corrections, rules);
  const lessons = [...new Set(categories.map(normalizeCategory).filter(Boolean))];
  const byId = new Map(data.corrections.map(c => [c.id, c]));
  const items = new Map<string, CorrectionItem>();
  for (const c of data.corrections) {
    const suggestion = c.category ? undefined : suggest(c);
    items.set(c.id, {
      id: c.id, t: c.t, kind: c.kind, path: c.path, line: c.line, added: c.added, removed: c.removed, aiLines: c.aiLines,
      suggestedScope: suggestion?.scope ?? suggestScope(c.path),
      ...(c.fromLine ? { fromLine: c.fromLine } : {}), ...(c.context ? { context: c.context } : {}),
      ...(c.toContext ? { toContext: c.toContext } : {}), ...(c.before ? { before: c.before } : {}), ...(c.after ? { after: c.after } : {}),
      ...(c.category ? { category: c.category } : {}), ...(c.scope ? { scope: c.scope } : {}),
      ...(c.note ? { note: c.note } : {}), ...(c.labeledBy ? { labeledBy: c.labeledBy } : {}),
      ...(suggestion ? { suggestion } : {})
    });
  }
  const episodes = groupEpisodes(data.corrections).map(e => {
    const list = e.correctionIds.map(id => items.get(id)).filter((x): x is CorrectionItem => !!x);
    const open = list.filter(i => !i.category);
    const first = open[0]?.suggestion;
    const same = first && open.every(i => i.suggestion?.category === first.category);
    return { ...e, ...(same ? { suggestion: first } : {}), items: list };
  });
  const groups = new Map<string, { count: number; human: number; episodes: Set<string>; scopes: Set<string> }>();
  for (const e of episodes) {
    for (const i of e.items) {
      if (!i.category) continue;
      const g = groups.get(i.category) ?? { count: 0, human: 0, episodes: new Set<string>(), scopes: new Set<string>() };
      g.count++;
      if (byId.get(i.id)?.source === 'human') g.human++;
      g.episodes.add(e.id);
      if (i.scope) g.scopes.add(i.scope);
      groups.set(i.category, g);
    }
  }
  const all = [...items.values()];
  return {
    categories: lessons,
    nonLesson: NON_LESSON_CATEGORIES,
    stats: {
      total: all.length,
      human: data.corrections.filter(c => c.source === 'human').length,
      ai: data.corrections.filter(c => c.source === 'ai').length,
      prompts: episodes.filter(e => e.source === 'ai').length,
      labeled: all.filter(i => i.category).length,
      suggested: all.filter(i => !i.category && i.suggestion).length,
      lessons: all.filter(i => i.category && !NON_LESSON_CATEGORIES.includes(i.category)).length
    },
    byCategory: [...groups.entries()]
      .map(([category, g]) => ({
        category, lesson: !NON_LESSON_CATEGORIES.includes(category),
        count: g.count, human: g.human, episodes: g.episodes.size, scopes: [...g.scopes].sort()
      }))
      .sort((x, y) => Number(y.lesson) - Number(x.lesson) || y.count - x.count),
    episodes,
    accuracy: suggestionAccuracy(data.corrections)
  };
}

/** Labels every unlabeled correction that has a suggestion ("Accept all suggestions"). */
export function acceptSuggestionsDelta(view: CorrectionsView, now = Date.now()): CorrectionDelta {
  const delta = emptyCorrectionDelta();
  for (const e of view.episodes) {
    for (const i of e.items) {
      if (i.category || !i.suggestion) continue;
      delta.patch[i.id] = {
        category: i.suggestion.category, scope: i.suggestedScope, labeledBy: 'rule', labeledAt: now,
        ...(i.suggestion.note ? { note: i.suggestion.note } : {}), suggested: toSuggested(i.suggestion)
      };
    }
  }
  return delta;
}
