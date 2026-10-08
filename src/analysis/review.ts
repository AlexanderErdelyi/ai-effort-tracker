import { createHash } from 'crypto';
import { branchKey, refsInclude } from '../util/branchKey';

/**
 * Code review tracking (#106-#109). Pure logic: no VS Code, no file I/O.
 *
 * A review mark never stores code or line numbers. It stores two short hashes
 * per reviewed line: `c` = the line together with its nearest non-blank
 * neighbours, `p` = the line alone (normalized). A line stays reviewed while
 * its context hash still matches, so marks survive commits, rebases, branch
 * switches and inserted blank lines; editing a line (or a neighbour) makes it
 * unreviewed again. Long lines moved together as a block keep their review
 * through the plain hash.
 */

export const REVIEW_FILE = 'review-marks.json';
export type ReviewVerdict = 'ok' | 'issue';
export type MarkStatus = ReviewVerdict | 'clear';
export type LineStatus = ReviewVerdict | 'todo';

export interface LineKey { c: string; p: string }

/** Who said a flagged issue is fixed: Copilot via MCP (`review_resolve_issue`) or the developer. */
export type FixedBy = 'ai' | 'user';
export interface IssueFix {
  at: number;
  by: FixedBy;
  note?: string;
  /** Keys of the code changed for the fix (shown purple until the developer accepts or reopens it). */
  lines?: string[];
}

export interface ReviewMark {
  id: string;
  status: MarkStatus;
  note?: string;
  at: number;
  /** Issues: branch it was flagged on and its 1-based first line, to find it again once its lines are gone. */
  branch?: string;
  line?: number;
  /** Issues: reported fixed, waiting for the developer to verify (lines may be empty then). */
  fixed?: IssueFix;
  /** `c` + `p` hashes, 12 hex chars each. */
  lines: string[];
}

export interface FileCoverage {
  path: string;
  total: number;
  reviewed: number;
  issueLines: number;
}

export interface OpenIssue {
  path: string;
  /** 1-based line of the first flagged line. */
  line: number;
  lines: number;
  note: string;
  at: number;
  markId?: string;
}

/**
 * A flagged issue that needs a second look: reported fixed (by Copilot or the
 * developer), or `changed` = all its flagged lines were edited away. `lines`
 * counts the flagged lines still in the file (0 when they are gone).
 */
export interface ResolvedIssue extends OpenIssue {
  markId: string;
  by: FixedBy | 'changed';
  fixedAt?: number;
  fixNote?: string;
  /** Lines changed for the fix that are still in the file (highlighted purple). */
  changedLines?: number;
}

export interface BranchCoverage {
  at: number;
  base: string;
  total: number;
  reviewed: number;
  issueLines: number;
  files: FileCoverage[];
  issues: OpenIssue[];
  /** Fixed / changed issues waiting for verification. */
  resolved?: ResolvedIssue[];
}

export interface RepoReview {
  files: Record<string, ReviewMark[]>;
  coverage: Record<string, BranchCoverage>;
  /** Local folders of this repository seen on this machine, most recent first (for MCP). */
  roots?: string[];
}

export interface ReviewStoreData {
  version: 1;
  repos: Record<string, RepoReview>;
}

const HASH_LEN = 12;
/** Only lines at least this long can keep their review when moved. */
export const MOVE_MIN_LENGTH = 20;
/** Changed lines remembered per fix. */
const MAX_FIX_LINES = 2000;
const MARK_TTL_MS = 400 * 86_400_000;
const MAX_KEYS_PER_FILE = 40_000;
const MAX_COVERAGE_FILES = 2000;
const MAX_COVERAGE_ISSUES = 200;
const MAX_BRANCHES_PER_REPO = 300;
const MAX_ROOTS = 5;

export const normalizeLine = (line: string) => line.replace(/\s+/g, ' ').trim();
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, HASH_LEN);
export const encodeKey = (k: LineKey) => k.c + k.p;
export const decodeKey = (s: string): LineKey => ({ c: s.slice(0, HASH_LEN), p: s.slice(HASH_LEN) });

/** Hash keys per line; `null` for blank lines (they never need review). */
export function lineKeys(lines: readonly string[]): (LineKey | null)[] {
  const norm = lines.map(normalizeLine);
  const prev: string[] = new Array(norm.length);
  let last = '';
  for (let i = 0; i < norm.length; i++) { prev[i] = last; if (norm[i]) last = norm[i]; }
  const out: (LineKey | null)[] = new Array(norm.length);
  let next = '';
  for (let i = norm.length - 1; i >= 0; i--) {
    out[i] = norm[i] ? { c: hash(prev[i] + '\n' + norm[i] + '\n' + next), p: hash(norm[i]) } : null;
    if (norm[i]) next = norm[i];
  }
  return out;
}

/** Lines of a text; a BOM is dropped (VS Code hides it, `git show` keeps it). */
export const splitLines = (text: string) => text.replace(/^\uFEFF/, '').split(/\r?\n/);

/**
 * 0-based indices of `current` lines that were added or modified compared with
 * `base` (null = new file: every line). Blank lines are excluded. Exact after
 * trimming line ends; an LCS diff on the differing middle, with a multiset
 * approximation when the middle is too large for an exact diff.
 */
export function changedLines(base: readonly string[] | null, current: readonly string[], maxCells = 4_000_000): Set<number> {
  const out = new Set<number>();
  const blank = (i: number) => !current[i].trim();
  if (!base) {
    for (let i = 0; i < current.length; i++) if (!blank(i)) out.add(i);
    return out;
  }
  const ids = new Map<string, number>();
  const intern = (s: string) => { const k = s.trimEnd(); let v = ids.get(k); if (v === undefined) ids.set(k, v = ids.size); return v; };
  const a = base.map(intern), b = current.map(intern);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  const add = (j: number) => { if (!blank(j)) out.add(j); };
  if (m === 0) return out;
  if (n === 0) { for (let j = start; j < endB; j++) add(j); return out; }
  if ((n + 1) * (m + 1) <= maxCells) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else { add(start + j); j++; }
    }
    for (; j < m; j++) add(start + j);
    return out;
  }
  const pool = new Map<number, number>();
  for (let i = start; i < endA; i++) pool.set(a[i], (pool.get(a[i]) ?? 0) + 1);
  for (let j = start; j < endB; j++) {
    const left = pool.get(b[j]) ?? 0;
    if (left > 0) pool.set(b[j], left - 1); else add(j);
  }
  return out;
}

interface MarkIndex {
  byC: Map<string, ReviewMark>;
  /** Line text hash -> non-clear marks holding it, newest first. */
  byP: Map<string, ReviewMark[]>;
  /** Per mark id: how many of its lines have each text hash. */
  pCount: Map<string, Map<string, number>>;
}

function indexMarks(marks: readonly ReviewMark[]): MarkIndex {
  const byC = new Map<string, ReviewMark>(), byP = new Map<string, ReviewMark[]>(), pCount = new Map<string, Map<string, number>>();
  for (const m of marks) {
    for (const s of m.lines) {
      const k = decodeKey(s);
      const hc = byC.get(k.c);
      if (!hc || hc.at <= m.at) byC.set(k.c, m);
      if (m.status === 'clear') continue;
      let counts = pCount.get(m.id);
      if (!counts) pCount.set(m.id, counts = new Map());
      const n = counts.get(k.p) ?? 0;
      counts.set(k.p, n + 1);
      if (!n) { const list = byP.get(k.p); if (list) list.push(m); else byP.set(k.p, [m]); }
    }
  }
  for (const list of byP.values()) list.sort((x, y) => y.at - x.at);
  return { byC, byP, pCount };
}

/**
 * The mark of each line. A line matches by its context hash (text + neighbours);
 * when that changed, a long line can still keep the mark it had before it was
 * moved, but only if (1) the mark still has that text unaccounted for, i.e. the
 * line is no longer where it was (a copy does not inherit it), and (2) a
 * neighbour belongs to the same mark: matched by context, or another long moved
 * line of it. So a duplicate line elsewhere next to e.g. `var` stays unmarked.
 */
function matchLines(lines: readonly string[], keys: readonly (LineKey | null)[], index: MarkIndex): (ReviewMark | undefined)[] {
  const { byC, byP, pCount } = index;
  const n = lines.length;
  const match: (ReviewMark | undefined)[] = new Array(n);
  const left = new Map<string, Map<string, number>>();
  const leftOf = (m: ReviewMark) => {
    let l = left.get(m.id);
    if (!l) left.set(m.id, l = new Map(pCount.get(m.id) ?? []));
    return l;
  };
  const take = (m: ReviewMark, p: string) => { const l = leftOf(m); const v = l.get(p) ?? 0; if (v > 0) l.set(p, v - 1); };
  const has = (m: ReviewMark, p: string) => (leftOf(m).get(p) ?? 0) > 0;
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    if (!k) continue;
    const m = byC.get(k.c);
    if (m) { match[i] = m; if (m.status !== 'clear') take(m, k.p); }
  }
  const long = (i: number) => normalizeLine(lines[i]).length >= MOVE_MIN_LENGTH;
  const prev: number[] = new Array(n), next: number[] = new Array(n);
  for (let i = 0, last = -1; i < n; i++) { prev[i] = last; if (keys[i]) last = i; }
  for (let i = n - 1, last = -1; i >= 0; i--) { next[i] = last; if (keys[i]) last = i; }
  const candidates = (i: number) => (keys[i] && !match[i] && long(i) ? (byP.get(keys[i]!.p) ?? []).filter(m => has(m, keys[i]!.p)) : []);
  for (let i = 0; i < n; i++) {
    const cands = candidates(i);
    if (!cands.length) continue;
    const supports = (m: ReviewMark, j: number) => j >= 0
      && (match[j] ? match[j]!.id === m.id : long(j) && has(m, keys[j]!.p) && keys[j]!.p !== keys[i]!.p);
    const m = cands.find(c => supports(c, prev[i]) || supports(c, next[i]));
    if (m) { match[i] = m; take(m, keys[i]!.p); }
  }
  return match;
}

export interface FileReview {
  /** Per line: review state of changed lines and of flagged lines; undefined otherwise. */
  status: (LineStatus | undefined)[];
  total: number;
  reviewed: number;
  issueLines: number;
  /** Flagged issues matched in this file (one per mark, first matching line). */
  issues: { line: number; lines: number; note: string; at: number; markId: string; indices: number[]; flagged: number }[];
  /** Issues reported fixed whose flagged lines (`indices`) or changed lines (`changed`) are in the file; `line` = first of both. */
  fixed: { markId: string; line: number; indices: number[]; changed: number[] }[];
  /** Runs of unreviewed changed lines (0-based, inclusive), blank lines bridge a run. */
  todoBlocks: { start: number; end: number; lines: number }[];
  /** Runs of reviewed changed lines (0-based, inclusive), `at` = newest mark in the run. */
  reviewedBlocks: { start: number; end: number; lines: number; at: number }[];
}

/**
 * Review state of every line of a file. `changed` null means every non-blank
 * line counts as changed (e.g. no git baseline). Issues are reported even on
 * unchanged lines so a flagged problem never disappears from view.
 */
export function evaluateFile(lines: readonly string[], changed: ReadonlySet<number> | null, marks: readonly ReviewMark[]): FileReview {
  const keys = lineKeys(lines);
  const matched = matchLines(lines, keys, indexMarks(marks));
  const status: (LineStatus | undefined)[] = new Array(lines.length);
  const okAt: number[] = new Array(lines.length);
  const issueMap = new Map<string, FileReview['issues'][number]>();
  const fixedMap = new Map<string, FileReview['fixed'][number]>();
  let total = 0, reviewed = 0, issueLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const k = keys[i];
    if (!k) continue;
    const mark = matched[i];
    if (mark?.fixed) {
      const hit = fixedMap.get(mark.id);
      if (hit) hit.indices.push(i); else fixedMap.set(mark.id, { markId: mark.id, line: i, indices: [i], changed: [] });
    }
    const verdict = mark && mark.status !== 'clear' && !mark.fixed ? mark.status : undefined;
    const isChanged = changed ? changed.has(i) : true;
    if (verdict === 'issue') {
      status[i] = 'issue';
      issueLines++;
      const hit = issueMap.get(mark!.id);
      if (hit) { hit.lines++; hit.indices.push(i); } else issueMap.set(mark!.id, { line: i, lines: 1, note: mark!.note ?? '', at: mark!.at, markId: mark!.id, indices: [i], flagged: mark!.lines.length });
    }
    if (!isChanged) continue;
    total++;
    if (verdict === 'ok') { status[i] = 'ok'; okAt[i] = mark!.at; reviewed++; }
    else if (verdict !== 'issue') status[i] = 'todo';
  }
  const fixC = new Map<string, ReviewMark>();
  for (const m of marks) {
    if (m.status !== 'issue' || !m.fixed?.lines) continue;
    for (const s of m.fixed.lines) { const c = decodeKey(s).c; const h = fixC.get(c); if (!h || h.fixed!.at <= m.fixed.at) fixC.set(c, m); }
  }
  if (fixC.size) {
    for (let i = 0; i < lines.length; i++) {
      const m = keys[i] && fixC.get(keys[i]!.c);
      if (!m) continue;
      const hit = fixedMap.get(m.id);
      if (!hit) fixedMap.set(m.id, { markId: m.id, line: i, indices: [], changed: [i] });
      else if (!hit.indices.includes(i)) { hit.changed.push(i); hit.line = Math.min(hit.line, i); }
    }
  }
  const todoBlocks: FileReview['todoBlocks'] = [];
  const reviewedBlocks: FileReview['reviewedBlocks'] = [];
  let cur: FileReview['todoBlocks'][number] | undefined;
  let ok: FileReview['reviewedBlocks'][number] | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!keys[i]) continue;
    if (status[i] === 'todo') {
      if (cur) { cur.end = i; cur.lines++; } else todoBlocks.push(cur = { start: i, end: i, lines: 1 });
    } else cur = undefined;
    if (status[i] === 'ok') {
      if (ok) { ok.end = i; ok.lines++; ok.at = Math.max(ok.at, okAt[i]); } else reviewedBlocks.push(ok = { start: i, end: i, lines: 1, at: okAt[i] });
    } else ok = undefined;
  }
  const issues = [...issueMap.values()].sort((x, y) => x.line - y.line);
  return { status, total, reviewed, issueLines, issues, todoBlocks, reviewedBlocks, fixed: [...fixedMap.values()].sort((x, y) => x.line - y.line) };
}

/**
 * Issues of one file that need verification: marks reported fixed, and open
 * issues none of whose lines are left (edited away, e.g. by Copilot). `review`
 * is null when the file is gone. An issue only counts on the branch it was
 * flagged on (older marks without a branch: when the file changed on this branch),
 * so switching to a branch without that code does not report it as fixed.
 */
export function resolvedIssuesOf(rel: string, marks: readonly ReviewMark[], review: FileReview | null, branch: string | null, fileChanged: boolean): ResolvedIssue[] {
  const open = new Set(review?.issues.map(i => i.markId) ?? []);
  const hits = new Map((review?.fixed ?? []).map(f => [f.markId, f]));
  const out: ResolvedIssue[] = [];
  for (const m of marks) {
    if (m.status !== 'issue' || open.has(m.id)) continue;
    const hit = hits.get(m.id);
    const mine = m.branch ? m.branch === branch : fileChanged;
    if (!hit && !mine) continue;
    const base = { path: rel, line: hit ? hit.line + 1 : m.line ?? 1, lines: hit?.indices.length ?? 0, note: m.note ?? '', at: m.at, markId: m.id };
    if (m.fixed) out.push({ ...base, by: m.fixed.by, fixedAt: m.fixed.at, ...(m.fixed.note ? { fixNote: m.fixed.note } : {}), ...(hit?.changed.length ? { changedLines: hit.changed.length } : {}) });
    else out.push({ ...base, by: 'changed' });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Report an issue fixed (`fix`) or open it again (`null`); null when the mark is not there. */
export function setIssueFix(marks: readonly ReviewMark[], markId: string, fix: IssueFix | null): ReviewMark[] | null {
  const i = marks.findIndex(m => m.id === markId && m.status === 'issue');
  if (i < 0) return null;
  const m: ReviewMark = { ...marks[i] };
  if (fix) {
    m.fixed = { at: fix.at, by: fix.by };
    const text = fix.note?.trim();
    if (text) m.fixed.note = text.slice(0, 2000);
    if (fix.lines?.length) m.fixed.lines = fix.lines.slice(0, MAX_FIX_LINES);
  } else delete m.fixed;
  const next = [...marks];
  if (m.lines.length || m.fixed) next[i] = m; else next.splice(i, 1);
  return next;
}

/** Remove one mark (e.g. a verified fix); null when it is not there. */
export function dropMark(marks: readonly ReviewMark[], markId: string): ReviewMark[] | null {
  const next = marks.filter(m => m.id !== markId);
  return next.length === marks.length ? null : next;
}

const DECLARATION = [
  /^\s*(?:(?:local|internal|protected|public|private|static|async|export|override|abstract|virtual|default)\s+)*(procedure|trigger|function|def|class|interface|enum|struct|record)\s+("[^"]+"|[\w$.]+)/i,
  /^\s*(field|action|group|part|area|layout|dataitem|column|key|value)\s*\(\s*(?:\d+\s*;\s*)?("[^"]+"|[\w$.]+)/i,
  /^\s*(codeunit|table|page|report|query|xmlport|enumextension|tableextension|pageextension|reportextension|permissionset|profile|controladdin)\s+\d*\s*("[^"]+"|[\w$.]+)/i,
  /^\s*(?:(?:public|private|protected|internal|static|async|readonly|override|virtual|abstract|export)\s+)+[\w<>[\],.? ]+?\s+([A-Za-z_$][\w$]*)\s*\(/
];

const CONTEXT_WINDOW = 400;
const clipContext = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 69) + '…' : t; };

/** A Markdown heading or code declaration on this line, e.g. "## Setup" or "procedure SyncJob". */
function declarationAt(line: string, markdown: boolean, code: boolean): string | undefined {
  if (markdown) {
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) return clipContext(`${h[1]} ${h[2]}`);
  }
  if (!code || line.length > 400) return undefined;
  for (const re of DECLARATION) {
    const m = re.exec(line);
    if (m) return clipContext(m.length > 2 ? `${m[1].toLowerCase()} ${m[2]}` : `${m[1]}()`);
  }
  return undefined;
}

/**
 * Where each block of lines sits, for lists: the nearest heading or declaration
 * at or above its start ("procedure SyncJob", "## Acceptance criteria"), else
 * its first non-blank line. One pass over the file; at most 70 characters each.
 * Headings count in Markdown files (or when `file` is unknown), declarations
 * in every other file.
 */
export function blockContexts(lines: readonly string[], blocks: readonly { start: number; end: number }[], file?: string): string[] {
  if (!blocks.length) return [];
  const markdown = !file || /\.(md|markdown|mdx)$/i.test(file);
  const code = !file || !markdown;
  const last = Math.min(lines.length - 1, Math.max(...blocks.map(b => b.start)));
  const nearest: (number | undefined)[] = new Array(last + 1);
  const found = new Map<number, string>();
  let cur: number | undefined;
  for (let i = 0; i <= last; i++) {
    const d = declarationAt(lines[i], markdown, code);
    if (d) { cur = i; found.set(i, d); }
    nearest[i] = cur;
  }
  return blocks.map(({ start, end }) => {
    const at = start >= 0 && start <= last ? nearest[start] : undefined;
    if (at !== undefined && start - at <= CONTEXT_WINDOW) return found.get(at)!;
    for (let i = Math.max(0, start); i <= Math.min(end, lines.length - 1); i++) if (lines[i].trim()) return clipContext(lines[i]);
    return '';
  });
}

export const blockContext = (lines: readonly string[], start: number, end = start, file?: string): string => blockContexts(lines, [{ start, end }], file)[0];

/** Keys of the non-blank lines in [start, end] (0-based, inclusive). */
export function keysForRange(lines: readonly string[], start: number, end: number): string[] {
  const idx: number[] = [];
  for (let i = Math.max(0, start); i <= Math.min(end, lines.length - 1); i++) idx.push(i);
  return keysForLines(lines, idx);
}

/** Keys of the given non-blank line indices (0-based). */
export function keysForLines(lines: readonly string[], indices: Iterable<number>): string[] {
  const keys = lineKeys(lines);
  const out: string[] = [];
  for (const i of indices) if (keys[i]) out.push(encodeKey(keys[i]!));
  return out;
}

/**
 * Record a verdict (or 'clear') for the given line keys. The same lines are
 * removed from older marks so the newest decision wins; marks older than
 * ~13 months and the oldest marks beyond a per-file cap are pruned.
 */
export function applyMark(marks: readonly ReviewMark[], keys: readonly string[], status: MarkStatus, now: number, id: string, note?: string, where?: { branch?: string; line?: number }): ReviewMark[] {
  const unique = [...new Set(keys)];
  const contexts = new Set(unique.map(k => decodeKey(k).c));
  const kept: ReviewMark[] = [];
  for (const m of marks) {
    if (m.at < now - MARK_TTL_MS) continue;
    const lines = m.lines.filter(s => !contexts.has(decodeKey(s).c));
    if (lines.length || m.fixed) kept.push(lines.length === m.lines.length ? m : { ...m, lines });
  }
  if (unique.length) {
    const mark: ReviewMark = { id, status, at: now, lines: unique };
    const text = note?.trim();
    if (text && status === 'issue') mark.note = text.slice(0, 2000);
    if (status === 'issue' && where?.branch && where.branch !== 'HEAD') mark.branch = where.branch.slice(0, 300);
    if (status === 'issue' && where?.line && where.line > 0) mark.line = Math.floor(where.line);
    kept.push(mark);
  }
  kept.sort((x, y) => x.at - y.at);
  let count = kept.reduce((s, m) => s + m.lines.length, 0);
  while (count > MAX_KEYS_PER_FILE && kept.length > 1) count -= kept.shift()!.lines.length;
  return kept;
}

export const emptyReviewStore = (): ReviewStoreData => ({ version: 1, repos: {} });
export const emptyRepoReview = (): RepoReview => ({ files: {}, coverage: {} });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

function decodeMark(v: unknown): ReviewMark | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !Array.isArray(v.lines)) return undefined;
  const status = v.status === 'ok' || v.status === 'issue' || v.status === 'clear' ? v.status : undefined;
  if (!status) return undefined;
  const lines = v.lines.filter((s): s is string => typeof s === 'string' && s.length === HASH_LEN * 2);
  const f = status === 'issue' && isObj(v.fixed) && (v.fixed.by === 'ai' || v.fixed.by === 'user') ? v.fixed : undefined;
  if (!lines.length && !f) return undefined;
  const m: ReviewMark = { id: v.id, status, at: num(v.at), lines };
  if (typeof v.note === 'string' && v.note) m.note = v.note;
  if (typeof v.branch === 'string' && v.branch && v.branch.length <= 300) m.branch = v.branch;
  if (typeof v.line === 'number' && Number.isInteger(v.line) && v.line > 0) m.line = v.line;
  if (f) {
    m.fixed = { at: num(f.at), by: f.by as FixedBy };
    if (typeof f.note === 'string' && f.note) m.fixed.note = f.note;
    const fl = Array.isArray(f.lines) ? f.lines.filter((s): s is string => typeof s === 'string' && s.length === HASH_LEN * 2).slice(0, MAX_FIX_LINES) : [];
    if (fl.length) m.fixed.lines = fl;
  }
  return m;
}

function decodeCoverage(v: unknown): BranchCoverage | undefined {
  if (!isObj(v)) return undefined;
  const files = Array.isArray(v.files) ? v.files.filter(isObj).map(f => ({
    path: String(f.path ?? ''), total: num(f.total), reviewed: num(f.reviewed), issueLines: num(f.issueLines)
  })).filter(f => f.path) : [];
  const issues = Array.isArray(v.issues) ? v.issues.filter(isObj).map(i => ({
    path: String(i.path ?? ''), line: num(i.line), lines: num(i.lines), note: typeof i.note === 'string' ? i.note : '', at: num(i.at),
    ...(typeof i.markId === 'string' && i.markId ? { markId: i.markId } : {})
  })).filter(i => i.path) : [];
  const resolved: ResolvedIssue[] = Array.isArray(v.resolved) ? v.resolved.filter(isObj).flatMap(i => {
    const by = i.by === 'ai' || i.by === 'user' || i.by === 'changed' ? i.by : undefined;
    if (!by || typeof i.path !== 'string' || !i.path || typeof i.markId !== 'string' || !i.markId) return [];
    return [{
      path: i.path, line: num(i.line), lines: num(i.lines), note: typeof i.note === 'string' ? i.note : '', at: num(i.at), markId: i.markId, by,
      ...(typeof i.fixedAt === 'number' ? { fixedAt: i.fixedAt } : {}), ...(typeof i.fixNote === 'string' && i.fixNote ? { fixNote: i.fixNote } : {})
    }];
  }) : [];
  return { at: num(v.at), base: typeof v.base === 'string' ? v.base : '', total: num(v.total), reviewed: num(v.reviewed), issueLines: num(v.issueLines), files, issues, ...(resolved.length ? { resolved } : {}) };
}

/** Strict enough to reject a foreign/corrupt file (recovery then tries .bak), lenient per entry. */
export function decodeReviewStore(raw: string): ReviewStoreData {
  const s = JSON.parse(raw) as unknown;
  if (!isObj(s) || s.version !== 1 || !isObj(s.repos)) throw new Error('Not a review store');
  const out = emptyReviewStore();
  for (const [repo, r] of Object.entries(s.repos)) {
    if (!isObj(r)) continue;
    const rr = emptyRepoReview();
    if (isObj(r.files)) {
      for (const [file, marks] of Object.entries(r.files)) {
        if (!Array.isArray(marks)) continue;
        const list = marks.map(decodeMark).filter((m): m is ReviewMark => !!m);
        if (list.length) rr.files[file] = list;
      }
    }
    if (isObj(r.coverage)) {
      for (const [branch, c] of Object.entries(r.coverage)) {
        const cov = decodeCoverage(c);
        if (cov) rr.coverage[branch] = cov;
      }
    }
    if (Array.isArray(r.roots)) {
      const roots = r.roots.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 1000).slice(0, MAX_ROOTS);
      if (roots.length) rr.roots = roots;
    }
    out.repos[repo] = rr;
  }
  return out;
}

/** Store the latest coverage of a branch (bounded lists, oldest branches pruned). */
export function withCoverage(repo: RepoReview, branch: string, cov: BranchCoverage): RepoReview {
  const files = [...cov.files].sort((x, y) => (y.total - y.reviewed) - (x.total - x.reviewed) || x.path.localeCompare(y.path)).slice(0, MAX_COVERAGE_FILES);
  const next: BranchCoverage = { ...cov, files, issues: cov.issues.slice(0, MAX_COVERAGE_ISSUES) };
  if (cov.resolved?.length) next.resolved = cov.resolved.slice(0, MAX_COVERAGE_ISSUES); else delete next.resolved;
  const coverage = { ...repo.coverage, [branch]: next };
  const names = Object.keys(coverage);
  if (names.length > MAX_BRANCHES_PER_REPO) {
    names.sort((x, y) => coverage[x].at - coverage[y].at);
    for (const n of names.slice(0, names.length - MAX_BRANCHES_PER_REPO)) delete coverage[n];
  }
  return { ...repo, coverage };
}

export interface ReviewStatusArgs { workItemId?: string; branch?: string }

const sameRoot = (a: string, b: string) => {
  const n = (s: string) => { const x = s.replace(/[\\/]+$/, ''); return process.platform === 'win32' ? x.replace(/\//g, '\\').toLowerCase() : x; };
  return n(a) === n(b);
};

/** Remember the local folder of a repository (most recent first) so MCP can read its files. */
export function withRoot(repo: RepoReview, root: string): RepoReview {
  if (repo.roots?.length && sameRoot(repo.roots[0], root)) return repo;
  return { ...repo, roots: [root, ...(repo.roots ?? []).filter(r => !sameRoot(r, root))].slice(0, MAX_ROOTS) };
}

export interface ReviewIssuesArgs { workItemId?: string; branch?: string; path?: string; contextLines?: number }

/** File access for {@link reviewIssues}; injected so the logic stays testable. */
export interface ReviewIssuesIo {
  exists(dir: string): boolean;
  /** File text, or null when missing, too large or binary. */
  readFile(abs: string): string | null;
  currentBranch(root: string): string | null;
}

const MAX_LIVE_ISSUES = 100;
const MAX_EXCERPT_LINES = 80;
const joinPath = (root: string, rel: string) => root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' + rel.replace(/\//g, '\\') : '/' + rel);

/**
 * Numbered code around flagged lines (0-based `flagged`), flagged lines marked
 * with ">", e.g. ` 12>| total := x;`. At most {@link MAX_EXCERPT_LINES} lines.
 */
export function issueExcerpt(lines: readonly string[], flagged: readonly number[], contextLines = 3, maxLines = MAX_EXCERPT_LINES): string {
  if (!flagged.length || !lines.length) return '';
  const set = new Set(flagged);
  const start = Math.min(...flagged), end = Math.max(...flagged);
  const from = Math.max(0, start - contextLines);
  const to = Math.min(lines.length - 1, end + contextLines, from + maxLines - 1);
  const width = String(to + 1).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const t = lines[n].length > 400 ? lines[n].slice(0, 400) + ' …' : lines[n];
    out.push(`${String(n + 1).padStart(width)}${set.has(n) ? '>' : ' '}| ${t}`);
  }
  return out.join('\n');
}

/** Chat prompt asking Copilot to fix flagged review issues (VS Code "Fix with Copilot"). */
export function fixIssuesPrompt(branch: string | null, issues: readonly { path: string; line: number; lines: number; note: string; code?: string; markId?: string }[], total = issues.length): string {
  const one = total === 1;
  const out = [
    `Fix the code review ${one ? 'issue' : `issues (${total})`} I flagged${branch ? ` on branch \`${branch}\`` : ''}.`,
    `The AI Effort Tracker MCP tool \`review_issues\` returns ${one ? 'it' : 'them'} with exact locations and code; use it if it is available, otherwise use the list below.`,
    ''
  ];
  issues.forEach((i, n) => {
    out.push(`${n + 1}. \`${i.path}:${i.line}\`${i.lines > 1 ? ` (${i.lines} lines)` : ''}: ${i.note || '(no note)'}${i.markId ? ` (issueId \`${i.markId}\`)` : ''}`);
    if (i.code) out.push('   ```', ...i.code.split('\n').map(l => '   ' + l), '   ```');
  });
  if (total > issues.length) out.push(`… and ${total - issues.length} more (see \`review_issues\`).`);
  out.push('', 'For each issue make the smallest fix that addresses the note and do not change unrelated code. '
    + 'After fixing an issue, call the MCP tool `review_resolve_issue` with its issueId, a one-line note of what you changed and startLine/endLine of the changed code, '
    + 'so it shows up as "fixed by Copilot" for me to verify (skip this if the tool is not available). '
    + 'When you are done, list each issue with what you changed, or why you left it unchanged.');
  return out.join('\n');
}

/**
 * MCP `review_issues`: open review issues read live from the files on disk, with
 * current line numbers and a numbered code excerpt, so an AI can fix them.
 * Issues only known from the saved coverage of another branch (not in the
 * checked-out files) are listed separately.
 */
export function reviewIssues(
  store: ReviewStoreData,
  branches: Record<string, { workItemId?: string | null }>,
  workItems: Record<string, { title?: string | null; status?: string }>,
  args: ReviewIssuesArgs,
  io: ReviewIssuesIo
): unknown {
  const ctxLines = Math.max(0, Math.min(10, Math.round(Number.isFinite(args.contextLines) ? args.contextLines! : 3)));
  const wanted = args.workItemId ? Object.keys(branches).filter(b => branches[b]?.workItemId === args.workItemId)
    : args.branch ? [args.branch] : null;
  const pathFilter = args.path?.trim().replace(/\\/g, '/').toLowerCase();
  const pathOk = (rel: string) => !pathFilter || rel.toLowerCase().includes(pathFilter);
  const live: Record<string, unknown>[] = [];
  const elsewhere: Record<string, unknown>[] = [];
  const toVerify: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const sig = (rel: string, at: number, note: string) => `${rel}\u0000${at}\u0000${note}`;
  let checkedOut: { repo: string; root: string; branch: string | null }[] = [];

  for (const [repoId, repo] of Object.entries(store.repos)) {
    const roots = (repo.roots ?? []).filter(r => io.exists(r)).map(root => ({ root, current: io.currentBranch(root) }));
    for (const { root, current } of roots) checkedOut.push({ repo: repoId, root, branch: current });
    let fromBranches: Set<string> | null = null;
    if (wanted) {
      fromBranches = new Set();
      for (const [b, cov] of Object.entries(repo.coverage)) {
        if (!refsInclude(wanted, repoId, b)) continue;
        for (const f of cov.files) fromBranches.add(f.path);
        for (const i of cov.issues) fromBranches.add(i.path);
      }
    }
    for (const { root, current } of roots) {
      // A checked-out branch of the requested scope: every flagged file in it counts.
      const relevant = wanted && !(current && refsInclude(wanted, repoId, current)) ? fromBranches : null;
      for (const [rel, marks] of Object.entries(repo.files)) {
        if (!marks.some(m => m.status === 'issue') || !pathOk(rel) || (relevant && !relevant.has(rel))) continue;
        const text = io.readFile(joinPath(root, rel));
        if (text === null) continue;
        const lines = splitLines(text);
        if (lines.length > 60_000) continue;
        const ev = evaluateFile(lines, new Set(), marks);
        for (const m of marks) {
          if (!m.fixed || seen.has(m.id)) continue;
          seen.add(m.id);
          const hit = ev.fixed.find(x => x.markId === m.id);
          toVerify.push({
            repo: repoId, file: rel, issueId: m.id, line: hit ? hit.line + 1 : m.line ?? null, note: m.note || '(no note)',
            fixedBy: m.fixed.by === 'ai' ? 'Copilot' : 'developer', fixNote: m.fixed.note ?? null, fixedAt: new Date(m.fixed.at).toISOString()
          });
        }
        for (const i of ev.issues) {
          const idx = [...i.indices].sort((a, b) => a - b);
          const start = idx[0], end = idx[idx.length - 1];
          const code = issueExcerpt(lines, idx, ctxLines);
          if (seen.has(i.markId)) continue;
          seen.add(i.markId);
          seen.add(sig(rel, i.at, i.note));
          live.push({
            issueId: i.markId, repo: repoId, root, file: rel, absolutePath: joinPath(root, rel), startLine: start + 1, endLine: end + 1,
            flaggedLines: idx.length, note: i.note || '(no note)', flaggedAt: new Date(i.at).toISOString(), branch: current, code
          });
        }
      }
    }
    const current = roots[0]?.current ?? null;
    const root = roots[0]?.root ?? null;
    const snapBranches = Object.keys(repo.coverage)
      .filter(b => (!wanted || refsInclude(wanted, repoId, b)) && !roots.some(x => x.current === b));
    for (const b of snapBranches) {
      const cov = repo.coverage[b];
      for (const i of cov.issues) {
        if (!pathOk(i.path) || seen.has(i.markId ?? '') || seen.has(sig(i.path, i.at, i.note))) continue;
        const stillFlagged = (repo.files[i.path] ?? []).some(m => m.status === 'issue' && (i.markId ? m.id === i.markId : m.at === i.at));
        if (!stillFlagged) continue;
        seen.add(i.markId ?? sig(i.path, i.at, i.note));
        elsewhere.push({
          ...(i.markId ? { issueId: i.markId } : {}), repo: repoId, branch: b, file: i.path, line: i.line, flaggedLines: i.lines, note: i.note || '(no note)',
          flaggedAt: new Date(i.at).toISOString(), asOf: new Date(cov.at).toISOString(),
          hint: root ? `Not in the files checked out now (${current ?? 'detached HEAD'}). Check out ${b} to fix it; line numbers are from ${new Date(cov.at).toISOString()}.`
            : 'The folder of this repository is not known on this machine yet; open it in VS Code with the extension once.'
        });
      }
    }
  }
  live.sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.startLine) - Number(b.startLine));
  if (wanted) checkedOut = checkedOut.filter(c => live.some(l => l.root === c.root) || (c.branch && refsInclude(wanted, c.repo, c.branch)));
  const scope = args.workItemId ? { workItemId: args.workItemId, title: workItems[args.workItemId]?.title ?? null, branches: wanted }
    : args.branch ? { branch: args.branch } : 'all repositories';
  return {
    scope, ...(pathFilter ? { path: args.path } : {}), checkedOut,
    openIssues: live.length, issues: live.slice(0, MAX_LIVE_ISSUES),
    ...(live.length > MAX_LIVE_ISSUES ? { truncated: live.length - MAX_LIVE_ISSUES } : {}),
    onOtherBranches: elsewhere.slice(0, 50),
    ...(toVerify.length ? { fixedAwaitingVerification: toVerify.slice(0, 50) } : {}),
    instructions: 'The developer flagged these lines while reviewing code in VS Code; "note" says what is wrong. Fix each issue in "file" around startLine–endLine '
      + '(lines marked ">" in "code" are the flagged ones; line numbers are for the file on disk now). Keep changes minimal and do not touch unrelated code. '
      + 'After fixing an issue, call review_resolve_issue with its issueId, a short note of what you changed and startLine/endLine of the code you changed (lines in the file now): '
      + 'it moves to "Fixed — to verify" in VS Code with your change highlighted '
      + 'and the changed code shows up as "to review". If you left an issue unchanged, say why instead of resolving it. '
      + '"fixedAwaitingVerification" lists issues already reported fixed; do not fix them again unless asked.',
    ...(live.length || elsewhere.length || toVerify.length ? {} : { note: store.repos && Object.keys(store.repos).length
      ? 'No open review issues. Flag issues in VS Code with the CodeLens "⚑ Flag issue" or the editor context menu.'
      : 'No review marks saved yet. Flag issues in VS Code with the CodeLens "⚑ Flag issue" or the editor context menu.' })
  };
}

/**
 * MCP `review_status` (#109): coverage of one work item or branch in detail,
 * otherwise an overview of every work item and branch with saved coverage.
 */
export function reviewStatus(
  store: ReviewStoreData,
  branches: Record<string, { workItemId?: string | null }>,
  workItems: Record<string, { title?: string | null; status?: string }>,
  args: ReviewStatusArgs
): unknown {
  const detail = (roll: ReviewRollup | null) => roll ? {
    ...roll, asOf: roll.asOf ? new Date(roll.asOf).toISOString() : null,
    branches: roll.branches.map(b => ({ ...b, at: new Date(b.at).toISOString() })),
    filesLeft: roll.filesLeft.slice(0, 50),
    issues: roll.issues.slice(0, 50).map(i => ({ ...i, at: new Date(i.at).toISOString() })),
    resolved: roll.resolved.slice(0, 50).map(i => ({ ...i, at: new Date(i.at).toISOString(), ...(i.fixedAt ? { fixedAt: new Date(i.fixedAt).toISOString() } : {}) }))
  } : null;
  if (args.workItemId) {
    const names = Object.keys(branches).filter(b => branches[b]?.workItemId === args.workItemId);
    const wi = workItems[args.workItemId];
    const roll = rollupCoverage(store, names);
    return { workItemId: args.workItemId, title: wi?.title ?? null, status: wi?.status ?? 'open', branches: names,
      review: detail(roll), ...(roll ? {} : { note: 'No review coverage saved for the branches of this work item yet. It is saved while a branch is checked out in VS Code.' }) };
  }
  if (args.branch) {
    const roll = rollupCoverage(store, [args.branch]);
    return { branch: args.branch, workItemId: branches[args.branch]?.workItemId ?? null, review: detail(roll),
      ...(roll ? {} : { note: 'No review coverage saved for this branch yet.' }) };
  }
  const byWi = new Map<string, string[]>();
  const loose: string[] = [];
  for (const [repoId, r] of Object.entries(store.repos)) {
    for (const name of Object.keys(r.coverage)) {
      // Branches tracked since #154 are keyed by repository; legacy ones by name.
      const b = branches[branchKey(repoId, name)] ? branchKey(repoId, name) : name;
      const wi = branches[b]?.workItemId;
      if (wi && wi !== '__unassigned__') { if (!byWi.get(wi)?.includes(b)) byWi.set(wi, [...(byWi.get(wi) ?? []), b]); }
      else if (!loose.includes(b)) loose.push(b);
    }
  }
  const row = (roll: ReviewRollup) => ({ total: roll.total, reviewed: roll.reviewed, pct: roll.pct, unreviewed: roll.unreviewed, openIssues: roll.openIssues, fixedToVerify: roll.toVerify, complete: roll.complete, asOf: roll.asOf ? new Date(roll.asOf).toISOString() : null });
  const items = [...byWi].map(([id, names]) => {
    const roll = rollupCoverage(store, names)!;
    return { workItemId: id, title: workItems[id]?.title ?? null, status: workItems[id]?.status ?? 'open', branches: names, ...row(roll) };
  }).sort((a, b) => Number(a.complete) - Number(b.complete) || b.unreviewed - a.unreviewed);
  const other = loose.map(b => ({ branch: b, ...row(rollupCoverage(store, [b])!) }))
    .sort((a, b) => Number(a.complete) - Number(b.complete) || b.unreviewed - a.unreviewed);
  return {
    workItems: items.slice(0, 100), branchesWithoutWorkItem: other.slice(0, 50),
    doneButNotReviewed: items.filter(i => i.status === 'done' && !i.complete).map(i => i.workItemId),
    ...(items.length || other.length ? {} : { note: 'No review coverage saved yet. Review marks are made in VS Code (CodeLens "Mark reviewed" / "Flag issue").' })
  };
}

export const coveragePct = (reviewed: number, total: number) => total > 0 ? Math.round(reviewed / total * 1000) / 10 : 100;

export const DEFAULT_REVIEW_EXCLUDE = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.min.js', '**/*.map',
  '**/node_modules/**', '**/out/**', '**/dist/**', '**/*.g.xlf'
];

/** Glob (`**`, `*`, `?`, `{a,b}`) → RegExp on '/'-separated relative paths, case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') { re += '(?:'; depth++; }
    else if (ch === '}' && depth) { re += ')'; depth--; }
    else if (ch === ',' && depth) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  while (depth-- > 0) re += ')';
  return new RegExp('^' + re + '$', 'i');
}

export function excludeMatcher(globs: readonly string[]): (rel: string) => boolean {
  const res = globs.filter(g => typeof g === 'string' && g.trim()).map(globToRegExp);
  return rel => { const p = rel.replace(/\\/g, '/'); return res.some(r => r.test(p)); };
}

export interface ReviewRollup {
  total: number;
  reviewed: number;
  unreviewed: number;
  issueLines: number;
  openIssues: number;
  pct: number;
  complete: boolean;
  asOf: number | null;
  branches: { repo: string; branch: string; total: number; reviewed: number; issueLines: number; openIssues: number; pct: number; at: number }[];
  filesLeft: { repo: string; path: string; unreviewed: number; total: number }[];
  issues: (OpenIssue & { repo: string; branch: string })[];
  /** Fixed / changed issues waiting for the developer to verify. */
  toVerify: number;
  resolved: (ResolvedIssue & { repo: string; branch: string })[];
}

/**
 * Combine the saved coverage of several branches (e.g. all branches of a work
 * item). A file changed on more than one branch counts once, from the most
 * recently evaluated branch, so overlapping branches are not double counted.
 */
export function rollupCoverage(store: ReviewStoreData, branches: readonly string[]): ReviewRollup | null {
  const wanted = new Set(branches);
  const perFile = new Map<string, { repo: string; f: FileCoverage; at: number }>();
  const issueMap = new Map<string, OpenIssue & { repo: string; branch: string }>();
  const resolvedMap = new Map<string, ResolvedIssue & { repo: string; branch: string }>();
  const rows: ReviewRollup['branches'] = [];
  let asOf: number | null = null;
  for (const [repo, r] of Object.entries(store.repos)) {
    for (const [branch, cov] of Object.entries(r.coverage)) {
      if (!refsInclude(wanted, repo, branch)) continue;
      rows.push({ repo, branch, total: cov.total, reviewed: cov.reviewed, issueLines: cov.issueLines, openIssues: cov.issues.length, pct: coveragePct(cov.reviewed, cov.total), at: cov.at });
      asOf = Math.max(asOf ?? 0, cov.at);
      for (const f of cov.files) {
        const key = repo + '\u0000' + f.path;
        const hit = perFile.get(key);
        if (!hit || hit.at < cov.at) perFile.set(key, { repo, f, at: cov.at });
      }
      for (const i of cov.issues) {
        const key = `${repo}\u0000${i.path}\u0000${i.note}\u0000${i.at}`;
        const hit = issueMap.get(key);
        if (!hit || hit.at <= i.at) issueMap.set(key, { ...i, repo, branch });
      }
      for (const i of cov.resolved ?? []) if (!resolvedMap.has(repo + '\u0000' + i.markId)) resolvedMap.set(repo + '\u0000' + i.markId, { ...i, repo, branch });
    }
  }
  if (!rows.length) return null;
  let total = 0, reviewed = 0, issueLines = 0;
  const filesLeft: ReviewRollup['filesLeft'] = [];
  for (const { repo, f } of perFile.values()) {
    total += f.total; reviewed += f.reviewed; issueLines += f.issueLines;
    const left = f.total - f.reviewed;
    if (left > 0) filesLeft.push({ repo, path: f.path, unreviewed: left, total: f.total });
  }
  filesLeft.sort((x, y) => y.unreviewed - x.unreviewed || x.path.localeCompare(y.path));
  const issues = [...issueMap.values()].sort((x, y) => y.at - x.at);
  rows.sort((x, y) => y.at - x.at);
  return {
    total, reviewed, unreviewed: total - reviewed, issueLines, openIssues: issues.length,
    pct: coveragePct(reviewed, total), complete: reviewed >= total && issues.length === 0,
    asOf, branches: rows, filesLeft, issues,
    toVerify: resolvedMap.size, resolved: [...resolvedMap.values()].sort((x, y) => (y.fixedAt ?? y.at) - (x.fixedAt ?? x.at))
  };
}
