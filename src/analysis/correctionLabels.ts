import {
  emptyCorrectionDelta, groupEpisodes,
  type Correction, type CorrectionDelta, type CorrectionEpisode, type CorrectionStoreData, type LabelSource
} from './corrections';

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

export interface LabelSuggestion { category: string; reason: string }

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

/** A category guess for one correction, for you to confirm. */
export function suggestLabel(c: Correction, rules: ReturnType<typeof compileKeywordRules>): LabelSuggestion | undefined {
  if (c.source === 'ai') {
    const text = c.trigger?.text ?? '';
    for (const r of rules) if (r.re.test(text)) return { category: r.category, reason: `The prompt matches "${r.pattern}"` };
    return changeSuggestion(c) ?? { category: 'requirement change', reason: 'Copilot reworked its own code after a new prompt' };
  }
  return changeSuggestion(c);
}

/** What the change itself says, regardless of who made it. */
function changeSuggestion(c: Correction): LabelSuggestion | undefined {
  if (c.kind === 'move') return { category: 'ordering/structure', reason: 'AI code was moved' };
  const before = c.before ?? [], after = c.after ?? [];
  if (!before.length && !after.length) return undefined;
  if (before.length && after.length) {
    if (squash(before) === squash(after)) return { category: 'style', reason: 'Only spacing changed' };
    if (squash(before).replace(DIGITS, '#') === squash(after).replace(DIGITS, '#')) {
      return { category: 'wrong fact', reason: 'Only numbers changed (IDs, positions, values)' };
    }
  }
  if (c.ext !== 'md' && [...before, ...after].every(l => !l.trim() || COMMENT.test(l))) {
    return { category: 'documentation', reason: c.kind === 'insert' ? 'Comment lines were added' : 'Only comments changed' };
  }
  return undefined;
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
 * suggested one for its file. Unknown ids are skipped.
 */
export function labelDelta(
  data: CorrectionStoreData, ids: readonly string[], label: { category: string; scope?: string; note?: string }, by: LabelSource, now = Date.now()
): CorrectionDelta {
  const delta = emptyCorrectionDelta();
  const category = normalizeCategory(label.category);
  const byId = new Map(data.corrections.map(c => [c.id, c]));
  for (const id of new Set(ids)) {
    const c = byId.get(id);
    if (!c) continue;
    delta.patch[id] = category
      ? {
        category, labeledBy: by, labeledAt: now,
        scope: label.scope !== undefined ? label.scope.trim() : (c.scope ?? suggestScope(c.path)),
        ...(label.note !== undefined ? { note: label.note.trim() } : {})
      }
      : { category: '', scope: '', note: '' };
  }
  return delta;
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
}

/** Everything the dashboard's Corrections tab shows. */
export function correctionsView(data: CorrectionStoreData, categories: readonly string[], rules: unknown): CorrectionsView {
  const compiled = compileKeywordRules(rules);
  const lessons = [...new Set(categories.map(normalizeCategory).filter(Boolean))];
  const byId = new Map(data.corrections.map(c => [c.id, c]));
  const items = new Map<string, CorrectionItem>();
  for (const c of data.corrections) {
    const suggestion = c.category ? undefined : suggestLabel(c, compiled);
    items.set(c.id, {
      id: c.id, t: c.t, kind: c.kind, path: c.path, line: c.line, added: c.added, removed: c.removed, aiLines: c.aiLines,
      suggestedScope: suggestScope(c.path),
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
    episodes
  };
}

/** Labels every unlabeled correction that has a suggestion ("Accept all suggestions"). */
export function acceptSuggestionsDelta(view: CorrectionsView, now = Date.now()): CorrectionDelta {
  const delta = emptyCorrectionDelta();
  for (const e of view.episodes) {
    for (const i of e.items) {
      if (i.category || !i.suggestion) continue;
      delta.patch[i.id] = { category: i.suggestion.category, scope: i.suggestedScope, labeledBy: 'rule', labeledAt: now };
    }
  }
  return delta;
}
