import {
  applyMark, blockContext, changedLines, DEFAULT_REVIEW_EXCLUDE, dropMark, evaluateFile, excludeMatcher, globToRegExp, keysForLines, keysForRange, setIssueFix, splitLines, withRoot,
  type MarkStatus, type RepoReview, type ReviewIssuesIo, type ReviewMark, type ReviewStoreData
} from './review';
import { ALL_CATEGORIES, type FileCategory } from '../util/categoryRules';
import { refsInclude } from '../util/branchKey';

export type ReviewMarkStatus = 'reviewed' | 'issue' | 'clear';

export interface ReviewMarkArgs {
  status?: ReviewMarkStatus;
  /** Repository-relative paths, path fragments ("NOBJQMSyncMgt") or globs ("app/specs/**"). */
  paths?: string[];
  /** Effort category of the files (programming, specification, documentation, …). */
  category?: string;
  all?: boolean;
  /** 1-based, inclusive; only with exactly one matching file. */
  startLine?: number;
  endLine?: number;
  note?: string;
  repo?: string;
  branch?: string;
  workItemId?: string;
  dryRun?: boolean;
}

/** Git, file and store access for {@link reviewMark}; injected so the logic stays testable. */
export interface ReviewMarkIo extends ReviewIssuesIo {
  /** The commit changes are reviewed against: `saved` when it still exists, else the merge-base. */
  resolveBase(root: string, saved?: string): string | null;
  changedFiles(root: string, base: string | null): Map<string, string | null>;
  contentAt(root: string, base: string, rel: string): string | null;
  /** Apply `change` to the latest stored entry of the repository and save it. */
  update(repoId: string, change: (repo: RepoReview) => RepoReview): void;
  now(): number;
  newId(): string;
}

const MAX_FILES = 500;
const STATUS: Record<ReviewMarkStatus, MarkStatus> = { reviewed: 'ok', issue: 'issue', clear: 'clear' };
const joinPath = (root: string, rel: string) => root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' + rel.replace(/\//g, '\\') : '/' + rel);
const isGlob = (s: string) => /[*?{]/.test(s);

const CATEGORY_ALIASES: Record<string, FileCategory> = {
  code: 'programming', program: 'programming', source: 'programming', spec: 'specification', specs: 'specification',
  doc: 'documentation', docs: 'documentation', translations: 'translation', xlf: 'translation', deploy: 'deployment', configuration: 'config'
};

/** "specs" → specification, "Docs" → documentation, …; throws on unknown names. */
export function normalizeCategory(input: string): FileCategory {
  const v = input.trim().toLowerCase().replace(/^[^a-z]+/, '');
  if ((ALL_CATEGORIES as string[]).includes(v)) return v as FileCategory;
  const hit = CATEGORY_ALIASES[v] ?? ALL_CATEGORIES.find(c => v.length >= 4 && c.startsWith(v));
  if (hit) return hit;
  throw new Error(`Unknown category "${input}". Use one of: ${ALL_CATEGORIES.join(', ')}.`);
}

/** 1-based line ranges of sorted 0-based indices; blank lines between two indices do not split a range. */
function toRanges(lines: readonly string[], idx: readonly number[], file: string) {
  const out: { startLine: number; endLine: number; lines: number; context: string }[] = [];
  let cur: { s: number; e: number; n: number } | undefined;
  const flush = () => { if (cur) out.push({ startLine: cur.s + 1, endLine: cur.e + 1, lines: cur.n, context: blockContext(lines, cur.s, cur.e, file) }); };
  for (const i of idx) {
    let bridged = !!cur;
    if (cur) for (let k = cur.e + 1; k < i; k++) if (lines[k].trim()) { bridged = false; break; }
    if (cur && bridged) { cur.e = i; cur.n++; } else { flush(); cur = { s: i, e: i, n: 1 }; }
  }
  flush();
  return out;
}

/**
 * MCP `review_mark`: mark code as reviewed (or flag / clear it) on behalf of
 * the developer, e.g. "mark the specs as reviewed". Works on the files checked
 * out now in a folder VS Code has seen; without a line range only lines still
 * to review are marked (status reviewed) or only reviewed lines are cleared
 * (status clear, flagged issues stay).
 */
export function reviewMark(
  store: ReviewStoreData,
  branches: Record<string, { workItemId?: string | null }>,
  args: ReviewMarkArgs,
  categoryOf: (rel: string) => string,
  io: ReviewMarkIo
): unknown {
  const status: ReviewMarkStatus = args.status ?? 'reviewed';
  if (!STATUS[status]) throw new Error('"status" must be reviewed, issue or clear.');
  const paths = (args.paths ?? []).map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  const category = args.category?.trim() ? normalizeCategory(args.category) : undefined;
  const ranged = args.startLine !== undefined || args.endLine !== undefined;
  if (!paths.length && !category && !args.all) throw new Error('Say what to mark: "paths" (files, folders, name fragments or globs), "category" (e.g. specification), or "all": true.');
  if (status === 'issue' && !ranged) throw new Error('Flagging an issue needs "startLine" (and "endLine") in one file, plus a "note".');
  let startLine = 0, endLine = 0;
  if (ranged) {
    startLine = Math.round(Number(args.startLine ?? args.endLine));
    endLine = Math.round(Number(args.endLine ?? args.startLine));
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) throw new Error('"startLine"/"endLine" must be 1-based with startLine ≤ endLine.');
  }

  // Which checked-out folder: the requested branch / work item, else the one used in VS Code most recently.
  const wanted = args.workItemId ? Object.keys(branches).filter(b => branches[b]?.workItemId === args.workItemId) : args.branch ? [args.branch] : null;
  const repoFilter = args.repo?.trim().toLowerCase();
  const candidates: { repoId: string; repo: RepoReview; root: string; branch: string | null; seen: number }[] = [];
  const checkedOut: { repo: string; root: string; branch: string | null }[] = [];
  for (const [repoId, repo] of Object.entries(store.repos)) {
    for (const root of repo.roots ?? []) {
      if (!io.exists(root)) continue;
      const branch = io.currentBranch(root);
      checkedOut.push({ repo: repoId, root, branch });
      if (repoFilter && !repoId.toLowerCase().includes(repoFilter) && !root.toLowerCase().includes(repoFilter)) continue;
      if (wanted && !(branch && refsInclude(wanted, repoId, branch))) continue;
      candidates.push({ repoId, repo, root, branch, seen: branch ? repo.coverage[branch]?.at ?? 0 : 0 });
    }
  }
  if (!candidates.length) {
    const what = args.workItemId ? `a branch of work item ${args.workItemId}${wanted?.length ? ` (${wanted.join(', ')})` : ''}` : args.branch ? `branch ${args.branch}` : 'a repository';
    throw new Error(`No folder known to AI Effort Tracker has ${what} checked out${repoFilter ? ` for repo "${args.repo}"` : ''}. Checked out now: `
      + (checkedOut.length ? checkedOut.map(c => `${c.root} (${c.branch ?? 'detached'})`).join('; ') : 'none — open the repository in VS Code with the extension once') + '.');
  }
  candidates.sort((a, b) => b.seen - a.seen);
  const target = candidates[0];
  const { repoId, repo, root } = target;

  const base = io.resolveBase(root, target.branch ? repo.coverage[target.branch]?.base || undefined : undefined);
  const changed = io.changedFiles(root, base);
  const excluded = excludeMatcher(DEFAULT_REVIEW_EXCLUDE);
  const matchers = paths.map(p => {
    if (isGlob(p)) { const re = globToRegExp(p); return (rel: string) => re.test(rel); }
    const needle = p.toLowerCase().replace(/\/+$/, '');
    return (rel: string) => rel.toLowerCase().includes(needle);
  });
  const catOk = (rel: string) => !category || categoryOf(rel) === category;
  const matches = (rel: string) => (!matchers.length || matchers.some(m => m(rel))) && catOk(rel);

  const pool = new Set<string>();
  for (const rel of changed.keys()) if (!excluded(rel)) pool.add(rel);
  if (status === 'clear' || ranged) for (const [rel, marks] of Object.entries(repo.files)) if (marks.length) pool.add(rel);
  if (ranged) for (const p of paths) if (!isGlob(p) && io.readFile(joinPath(root, p)) !== null) pool.add(p);
  let files = [...pool].filter(matches).sort();
  if (ranged && files.length !== 1) {
    const exact = files.filter(f => paths.some(p => f.toLowerCase() === p.toLowerCase()));
    if (exact.length === 1) files = exact;
    else throw new Error(files.length ? `A line range needs exactly one file, but ${files.length} match: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}.`
      : 'No file matches "paths". Use the repository-relative path of the file.');
  }
  if (!files.length) {
    const byCategory: Record<string, number> = {};
    for (const rel of pool) { const c = categoryOf(rel); byCategory[c] = (byCategory[c] ?? 0) + 1; }
    return {
      dryRun: !!args.dryRun, result: 'No changed file matches. Nothing was marked.', repo: repoId, root, branch: target.branch,
      changedFilesByCategory: byCategory, sampleChangedFiles: [...pool].sort().slice(0, 30),
      hint: 'Categories come from the developer\'s category rules (e.g. Markdown specs may count as documentation). Match by "paths" instead, e.g. ["app/specs/"] or ["*.Table.al"].'
    };
  }

  const planned: { rel: string; keys: string[]; ranges: ReturnType<typeof toRanges> }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let unchanged = 0;
  for (const rel of files.slice(0, MAX_FILES)) {
    const text = io.readFile(joinPath(root, rel));
    if (text === null) { skipped.push({ file: rel, reason: 'missing, binary or larger than 1.5 MB' }); continue; }
    const lines = splitLines(text);
    const marks = repo.files[rel] ?? [];
    let idx: number[];
    if (ranged) {
      if (startLine > lines.length) { skipped.push({ file: rel, reason: `the file has only ${lines.length} lines` }); continue; }
      idx = [];
      for (let i = startLine - 1; i <= Math.min(endLine, lines.length) - 1; i++) if (lines[i].trim()) idx.push(i);
    } else if (status === 'clear') {
      idx = evaluateFile(lines, null, marks).status.flatMap((s, i) => s === 'ok' ? [i] : []);
    } else {
      let set = new Set<number>();
      if (changed.has(rel)) {
        const from = changed.get(rel);
        const baseText = from && base ? io.contentAt(root, base, from) : null;
        set = changedLines(baseText === null ? null : splitLines(baseText), lines);
      }
      idx = evaluateFile(lines, set, marks).status.flatMap((s, i) => s === 'todo' ? [i] : []);
    }
    const keys = keysForLines(lines, idx);
    if (!keys.length) { unchanged++; continue; }
    planned.push({ rel, keys, ranges: toRanges(lines, idx, rel) });
  }

  const note = args.note?.trim();
  if (!args.dryRun && planned.length) {
    const now = io.now();
    io.update(repoId, latest => {
      const next = { ...latest.files };
      for (const p of planned) {
        const marks = applyMark(next[p.rel] ?? [], p.keys, STATUS[status], now, io.newId(), note, { branch: target.branch ?? undefined, line: p.ranges[0]?.startLine });
        if (marks.length) next[p.rel] = marks; else delete next[p.rel];
      }
      return withRoot({ ...latest, files: next }, root);
    });
  }
  const lines = planned.reduce((s, p) => s + p.keys.length, 0);
  const what = `${lines} line${lines === 1 ? '' : 's'} in ${planned.length} file${planned.length === 1 ? '' : 's'}`;
  const sentence = status === 'reviewed' ? `mark ${what} as reviewed` : status === 'issue' ? `flag ${what} as a review issue` : `remove the review marks from ${what}`;
  const done = status === 'reviewed' ? `Marked ${what} as reviewed` : status === 'issue' ? `Flagged ${what} as a review issue` : `Removed the review marks from ${what}`;
  return {
    dryRun: !!args.dryRun,
    result: planned.length ? (args.dryRun ? `Would ${sentence}.` : `${done}.`)
      : status === 'clear' ? 'Nothing to clear: no reviewed lines in the matching files.' : 'Nothing to mark: the matching files have no lines left to review.',
    repo: repoId, root, branch: target.branch, baseline: base ? base.slice(0, 7) : null,
    ...(candidates.length > 1 ? { otherFolders: candidates.slice(1).map(c => `${c.root} (${c.branch ?? 'detached'})`), hint: 'Pass "repo" or "branch" to use another folder.' } : {}),
    files: planned.slice(0, 100).map(p => ({ file: p.rel, lines: p.keys.length, ranges: p.ranges.slice(0, 20) })),
    ...(planned.length > 100 ? { moreFiles: planned.length - 100 } : {}),
    ...(files.length > MAX_FILES ? { notProcessed: files.length - MAX_FILES } : {}),
    ...(unchanged ? { filesWithNothingToDo: unchanged } : {}),
    ...(skipped.length ? { skipped: skipped.slice(0, 20) } : {}),
    ...(!args.dryRun && planned.length ? {
      note: 'VS Code shows the new marks within a few seconds. Marks follow the line content, so they survive branch switches and are cleared by edits to the marked lines.',
      undo: status === 'clear' ? 'Mark the lines reviewed again to undo.'
        : status === 'issue' ? 'Call review_mark with status "clear" and the same file and lines to remove the flag.'
          : 'Call review_mark with status "clear" and the same arguments to remove review marks from these files again (this also clears lines reviewed earlier).'
    } : {})
  };
}

export type ResolveAction = 'fixed' | 'reopen' | 'remove';

export interface ResolveIssueArgs {
  /** `issueId` from review_issues (a unique prefix of at least 6 characters is enough). */
  issueId?: string;
  /** Without issueId: the file (path or name fragment) that has exactly one matching issue. */
  file?: string;
  action?: ResolveAction;
  /** What was changed (fixed) or why (remove / reopen). */
  note?: string;
  /** action fixed: 1-based range of the code changed for the fix, in the file on disk now (highlighted for the developer). */
  startLine?: number;
  endLine?: number;
  repo?: string;
}

/**
 * MCP `review_resolve_issue`: report a flagged issue as fixed by Copilot (it then
 * waits in "Fixed — to verify" in VS Code), open it again, or remove the flag.
 */
export function reviewResolveIssue(store: ReviewStoreData, args: ResolveIssueArgs, io: Pick<ReviewMarkIo, 'update' | 'now' | 'exists' | 'currentBranch' | 'readFile'>): unknown {
  const action: ResolveAction = args.action ?? 'fixed';
  if (action !== 'fixed' && action !== 'reopen' && action !== 'remove') throw new Error('"action" must be fixed, reopen or remove.');
  const id = args.issueId?.trim();
  const file = args.file?.trim().replace(/\\/g, '/').toLowerCase();
  if (!id && !file) throw new Error('Pass "issueId" (from review_issues) or "file".');
  if (id && id.length < 6) throw new Error('"issueId" is too short; pass the full id from review_issues.');
  const repoFilter = args.repo?.trim().toLowerCase();
  const found: { repoId: string; rel: string; mark: ReviewMark }[] = [];
  for (const [repoId, repo] of Object.entries(store.repos)) {
    if (repoFilter && !repoId.toLowerCase().includes(repoFilter) && !(repo.roots ?? []).some(r => r.toLowerCase().includes(repoFilter))) continue;
    for (const [rel, marks] of Object.entries(repo.files)) {
      if (!id && !rel.toLowerCase().includes(file!)) continue;
      for (const mark of marks) {
        if (mark.status !== 'issue') continue;
        if (id ? mark.id === id || mark.id.startsWith(id) : action === 'fixed' ? !mark.fixed : action === 'reopen' ? !!mark.fixed : true) found.push({ repoId, rel, mark });
      }
    }
  }
  const list = (xs: typeof found) => xs.slice(0, 15).map(x => ({ issueId: x.mark.id, file: x.rel, note: x.mark.note || '(no note)', fixed: !!x.mark.fixed }));
  if (!found.length) throw new Error(id ? `No review issue with id "${id}". Call review_issues for the current ids.` : `No ${action === 'reopen' ? 'fixed ' : action === 'fixed' ? 'open ' : ''}review issue in a file matching "${args.file}".`);
  if (found.length > 1) return { result: 'Several issues match; nothing was changed. Call again with one "issueId".', candidates: list(found) };
  const { repoId, rel, mark } = found[0];
  if (action === 'fixed' && mark.fixed) return { result: 'This issue is already reported fixed; nothing was changed.', issueId: mark.id, file: rel, fixNote: mark.fixed.note ?? null };
  if (action === 'reopen' && !mark.fixed) return { result: 'This issue is open already; nothing was changed.', issueId: mark.id, file: rel };
  const ranged = action === 'fixed' && (args.startLine !== undefined || args.endLine !== undefined);
  let fixLines: string[] | undefined, changedRange: { startLine: number; endLine: number; lines: number } | undefined;
  if (ranged) {
    const s = Math.round(Number(args.startLine ?? args.endLine)), e = Math.round(Number(args.endLine ?? args.startLine));
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < s) throw new Error('"startLine"/"endLine" must be 1-based with startLine ≤ endLine.');
    const roots = (store.repos[repoId].roots ?? []).filter(r => io.exists(r));
    roots.sort((a, b) => Number(io.currentBranch(b) === mark.branch) - Number(io.currentBranch(a) === mark.branch));
    const text = roots.map(r => io.readFile(joinPath(r, rel))).find((x): x is string => x !== null);
    if (text === undefined) throw new Error(`Cannot read ${rel} to highlight the changed lines; call again without startLine/endLine.`);
    const lines = splitLines(text);
    if (s > lines.length) throw new Error(`${rel} has only ${lines.length} lines.`);
    fixLines = keysForRange(lines, s - 1, Math.min(e, lines.length) - 1);
    changedRange = { startLine: s, endLine: Math.min(e, lines.length), lines: fixLines.length };
  }
  const now = io.now();
  io.update(repoId, latest => {
    const marks = latest.files[rel] ?? [];
    const next = action === 'remove' ? dropMark(marks, mark.id) : setIssueFix(marks, mark.id, action === 'fixed' ? { at: now, by: 'ai', note: args.note, lines: fixLines } : null);
    if (!next) throw new Error('The issue was changed in the meantime. Call review_issues and try again.');
    const files = { ...latest.files };
    if (next.length) files[rel] = next; else delete files[rel];
    return { ...latest, files };
  });
  return {
    result: action === 'fixed' ? 'Reported as fixed by Copilot. The developer verifies it in VS Code (Review view → "Fixed — to verify").'
      : action === 'reopen' ? 'The issue is open again.' : 'The review flag was removed.',
    issueId: mark.id, repo: repoId, file: rel, note: mark.note || '(no note)',
    ...(changedRange ? { highlighted: changedRange } : action === 'fixed' ? { hint: 'Pass startLine/endLine of the code you changed next time so the developer sees it highlighted.' } : {}),
    ...(action === 'remove' ? {} : { undo: `Call review_resolve_issue with issueId "${mark.id}" and action "${action === 'fixed' ? 'reopen' : 'fixed'}".` })
  };
}
