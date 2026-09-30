import { createHash } from 'crypto';

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

export interface ReviewMark {
  id: string;
  status: MarkStatus;
  note?: string;
  at: number;
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
}

export interface BranchCoverage {
  at: number;
  base: string;
  total: number;
  reviewed: number;
  issueLines: number;
  files: FileCoverage[];
  issues: OpenIssue[];
}

export interface RepoReview {
  files: Record<string, ReviewMark[]>;
  coverage: Record<string, BranchCoverage>;
}

export interface ReviewStoreData {
  version: 1;
  repos: Record<string, RepoReview>;
}

const HASH_LEN = 12;
/** Only lines at least this long can keep their review when moved. */
export const MOVE_MIN_LENGTH = 20;
const MARK_TTL_MS = 400 * 86_400_000;
const MAX_KEYS_PER_FILE = 40_000;
const MAX_COVERAGE_FILES = 2000;
const MAX_COVERAGE_ISSUES = 200;
const MAX_BRANCHES_PER_REPO = 300;

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

interface MarkIndex { byC: Map<string, ReviewMark>; byP: Map<string, ReviewMark> }

function indexMarks(marks: readonly ReviewMark[]): MarkIndex {
  const byC = new Map<string, ReviewMark>(), byP = new Map<string, ReviewMark>();
  for (const m of marks) {
    for (const s of m.lines) {
      const k = decodeKey(s);
      const hc = byC.get(k.c);
      if (!hc || hc.at <= m.at) byC.set(k.c, m);
      if (m.status === 'clear') continue;
      const hp = byP.get(k.p);
      if (!hp || hp.at <= m.at) byP.set(k.p, m);
    }
  }
  return { byC, byP };
}

export interface FileReview {
  /** Per line: review state of changed lines and of flagged lines; undefined otherwise. */
  status: (LineStatus | undefined)[];
  total: number;
  reviewed: number;
  issueLines: number;
  /** Flagged issues matched in this file (one per mark, first matching line). */
  issues: { line: number; lines: number; note: string; at: number; markId: string; indices: number[] }[];
  /** Runs of unreviewed changed lines (0-based, inclusive), blank lines bridge a run. */
  todoBlocks: { start: number; end: number; lines: number }[];
}

/**
 * Review state of every line of a file. `changed` null means every non-blank
 * line counts as changed (e.g. no git baseline). Issues are reported even on
 * unchanged lines so a flagged problem never disappears from view.
 */
export function evaluateFile(lines: readonly string[], changed: ReadonlySet<number> | null, marks: readonly ReviewMark[]): FileReview {
  const keys = lineKeys(lines);
  const { byC, byP } = indexMarks(marks);
  const status: (LineStatus | undefined)[] = new Array(lines.length);
  const issueMap = new Map<string, FileReview['issues'][number]>();
  let total = 0, reviewed = 0, issueLines = 0;
  let prevP: string | undefined;
  const nextP: (string | undefined)[] = new Array(lines.length);
  let np: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) { nextP[i] = np; if (keys[i]) np = keys[i]!.p; }
  for (let i = 0; i < lines.length; i++) {
    const k = keys[i];
    if (!k) continue;
    let mark = byC.get(k.c);
    if (!mark) {
      const moved = byP.get(k.p);
      if (moved && normalizeLine(lines[i]).length >= MOVE_MIN_LENGTH
        && ((prevP !== undefined && byP.has(prevP)) || (nextP[i] !== undefined && byP.has(nextP[i]!)))) mark = moved;
    }
    prevP = k.p;
    const verdict = mark && mark.status !== 'clear' ? mark.status : undefined;
    const isChanged = changed ? changed.has(i) : true;
    if (verdict === 'issue') {
      status[i] = 'issue';
      issueLines++;
      const hit = issueMap.get(mark!.id);
      if (hit) { hit.lines++; hit.indices.push(i); } else issueMap.set(mark!.id, { line: i, lines: 1, note: mark!.note ?? '', at: mark!.at, markId: mark!.id, indices: [i] });
    }
    if (!isChanged) continue;
    total++;
    if (verdict === 'ok') { status[i] = 'ok'; reviewed++; }
    else if (verdict !== 'issue') status[i] = 'todo';
  }
  const todoBlocks: FileReview['todoBlocks'] = [];
  let cur: FileReview['todoBlocks'][number] | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (status[i] === 'todo') {
      if (cur) { cur.end = i; cur.lines++; } else todoBlocks.push(cur = { start: i, end: i, lines: 1 });
    } else if (keys[i]) cur = undefined;
  }
  const issues = [...issueMap.values()].sort((x, y) => x.line - y.line);
  return { status, total, reviewed, issueLines, issues, todoBlocks };
}

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
export function applyMark(marks: readonly ReviewMark[], keys: readonly string[], status: MarkStatus, now: number, id: string, note?: string): ReviewMark[] {
  const unique = [...new Set(keys)];
  const contexts = new Set(unique.map(k => decodeKey(k).c));
  const kept: ReviewMark[] = [];
  for (const m of marks) {
    if (m.at < now - MARK_TTL_MS) continue;
    const lines = m.lines.filter(s => !contexts.has(decodeKey(s).c));
    if (lines.length) kept.push(lines.length === m.lines.length ? m : { ...m, lines });
  }
  if (unique.length) {
    const mark: ReviewMark = { id, status, at: now, lines: unique };
    const text = note?.trim();
    if (text && status === 'issue') mark.note = text.slice(0, 2000);
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
  if (!lines.length) return undefined;
  const m: ReviewMark = { id: v.id, status, at: num(v.at), lines };
  if (typeof v.note === 'string' && v.note) m.note = v.note;
  return m;
}

function decodeCoverage(v: unknown): BranchCoverage | undefined {
  if (!isObj(v)) return undefined;
  const files = Array.isArray(v.files) ? v.files.filter(isObj).map(f => ({
    path: String(f.path ?? ''), total: num(f.total), reviewed: num(f.reviewed), issueLines: num(f.issueLines)
  })).filter(f => f.path) : [];
  const issues = Array.isArray(v.issues) ? v.issues.filter(isObj).map(i => ({
    path: String(i.path ?? ''), line: num(i.line), lines: num(i.lines), note: typeof i.note === 'string' ? i.note : '', at: num(i.at)
  })).filter(i => i.path) : [];
  return { at: num(v.at), base: typeof v.base === 'string' ? v.base : '', total: num(v.total), reviewed: num(v.reviewed), issueLines: num(v.issueLines), files, issues };
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
    out.repos[repo] = rr;
  }
  return out;
}

/** Store the latest coverage of a branch (bounded lists, oldest branches pruned). */
export function withCoverage(repo: RepoReview, branch: string, cov: BranchCoverage): RepoReview {
  const files = [...cov.files].sort((x, y) => (y.total - y.reviewed) - (x.total - x.reviewed) || x.path.localeCompare(y.path)).slice(0, MAX_COVERAGE_FILES);
  const coverage = { ...repo.coverage, [branch]: { ...cov, files, issues: cov.issues.slice(0, MAX_COVERAGE_ISSUES) } };
  const names = Object.keys(coverage);
  if (names.length > MAX_BRANCHES_PER_REPO) {
    names.sort((x, y) => coverage[x].at - coverage[y].at);
    for (const n of names.slice(0, names.length - MAX_BRANCHES_PER_REPO)) delete coverage[n];
  }
  return { ...repo, coverage };
}

export interface ReviewStatusArgs { workItemId?: string; branch?: string }

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
    issues: roll.issues.slice(0, 50).map(i => ({ ...i, at: new Date(i.at).toISOString() }))
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
  for (const r of Object.values(store.repos)) {
    for (const b of Object.keys(r.coverage)) {
      const wi = branches[b]?.workItemId;
      if (wi && wi !== '__unassigned__') { if (!byWi.get(wi)?.includes(b)) byWi.set(wi, [...(byWi.get(wi) ?? []), b]); }
      else if (!loose.includes(b)) loose.push(b);
    }
  }
  const row = (roll: ReviewRollup) => ({ total: roll.total, reviewed: roll.reviewed, pct: roll.pct, unreviewed: roll.unreviewed, openIssues: roll.openIssues, complete: roll.complete, asOf: roll.asOf ? new Date(roll.asOf).toISOString() : null });
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
  const rows: ReviewRollup['branches'] = [];
  let asOf: number | null = null;
  for (const [repo, r] of Object.entries(store.repos)) {
    for (const [branch, cov] of Object.entries(r.coverage)) {
      if (!wanted.has(branch)) continue;
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
    asOf, branches: rows, filesLeft, issues
  };
}
