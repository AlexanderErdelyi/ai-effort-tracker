import * as cp from 'child_process';
import * as path from 'path';

/** Git access for review tracking (#107). Arguments are passed without a shell. */
export function git(args: string[], cwd: string, maxBuffer = 32 * 1024 * 1024): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile('git', args, { cwd, maxBuffer, windowsHide: true, encoding: 'utf8', timeout: 20_000 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

export async function gitRoot(dir: string): Promise<string | undefined> {
  const out = (await git(['rev-parse', '--show-toplevel'], dir))?.trim();
  return out ? path.normalize(out) : undefined;
}

export async function gitBranch(root: string): Promise<string | undefined> {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root))?.trim() || undefined;
}

export async function gitRemote(root: string): Promise<string | undefined> {
  return (await git(['config', '--get', 'remote.origin.url'], root))?.trim() || undefined;
}

/**
 * The commit the current branch is reviewed against: an explicit ref when
 * given, otherwise the merge-base with the default branch, otherwise HEAD
 * (only uncommitted work). `null` in a repository without commits.
 */
export async function resolveReviewBase(root: string, override?: string): Promise<string | null> {
  const verify = async (ref: string) => (await git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], root))?.trim() || undefined;
  if (override) {
    const sha = await verify(override);
    if (sha) return sha;
  }
  const candidates: string[] = [];
  const originHead = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], root))?.trim();
  if (originHead && originHead !== 'origin/HEAD') candidates.push(originHead);
  candidates.push(...BASE_CANDIDATES);
  for (const ref of candidates) {
    if (!(await verify(ref))) continue;
    const mb = (await git(['merge-base', 'HEAD', ref], root))?.trim();
    if (mb) return mb;
  }
  return (await verify('HEAD')) ?? null;
}

/**
 * Files changed since `base` (committed, staged, unstaged and untracked).
 * Maps repo-relative path → path at the base (renames), or null when new.
 */
export async function changedFiles(root: string, base: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (base) {
    const raw = await git(DIFF_ARGS(base), root);
    if (raw === undefined) throw new Error('git diff failed');
    parseNameStatus(raw, out);
  } else {
    const tracked = await git(['ls-files', '-z'], root);
    for (const p of (tracked ?? '').split('\0')) if (p) out.set(p, null);
  }
  const others = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const p of (others ?? '').split('\0')) if (p) out.set(p, null);
  return out;
}

const DIFF_ARGS = (base: string) => ['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '-M', base];
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

/** `git diff --name-status -z -M` output → path → path at the base (renames) or null (added). */
export function parseNameStatus(raw: string, out = new Map<string, string | null>()): Map<string, string | null> {
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = parts[i++], to = parts[i++];
      if (to) out.set(to, status[0] === 'R' ? from : null);
    } else {
      const p = parts[i++];
      if (p && status[0] !== 'D') out.set(p, status[0] === 'A' ? null : p);
    }
  }
  return out;
}

const showCache = new Map<string, string | null>();

/** File content at `base`, or null when it did not exist there. Cached per commit. */
export async function contentAt(root: string, base: string, rel: string): Promise<string | null> {
  const key = `${root}\u0000${base}\u0000${rel}`;
  if (showCache.has(key)) return showCache.get(key)!;
  const out = await git(['show', `${base}:${rel}`], root);
  const value = out ?? null;
  if (showCache.size > 3000) showCache.clear();
  showCache.set(key, value);
  return value;
}

/** Recent commits for picking a review baseline: [sha, "abc1234 subject (2 days ago)"]. */
export async function recentCommits(root: string, count = 30): Promise<[string, string][]> {
  const out = await git(['log', '-n', String(count), '--format=%H%x09%h %s (%cr)'], root);
  return (out ?? '').split(/\r?\n/).filter(Boolean).map(l => { const t = l.indexOf('\t'); return [l.slice(0, t), l.slice(t + 1)] as [string, string]; });
}

// ------------------------------------------------ synchronous variants (MCP server process)

export function gitSync(args: string[], cwd: string, maxBuffer = 32 * 1024 * 1024): string | undefined {
  try {
    return cp.execFileSync('git', args, { cwd, maxBuffer, windowsHide: true, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return undefined; }
}

/** Same rules as {@link resolveReviewBase}; `saved` is the base the extension last used for this branch. */
export function resolveReviewBaseSync(root: string, saved?: string): string | null {
  const verify = (ref: string) => gitSync(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], root)?.trim() || undefined;
  if (saved) {
    const sha = verify(saved);
    if (sha) return sha;
  }
  const originHead = gitSync(['rev-parse', '--abbrev-ref', 'origin/HEAD'], root)?.trim();
  for (const ref of [...(originHead && originHead !== 'origin/HEAD' ? [originHead] : []), ...BASE_CANDIDATES]) {
    if (!verify(ref)) continue;
    const mb = gitSync(['merge-base', 'HEAD', ref], root)?.trim();
    if (mb) return mb;
  }
  return verify('HEAD') ?? null;
}

export function changedFilesSync(root: string, base: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (base) {
    const raw = gitSync(DIFF_ARGS(base), root);
    if (raw === undefined) throw new Error('git diff failed');
    parseNameStatus(raw, out);
  } else {
    for (const p of (gitSync(['ls-files', '-z'], root) ?? '').split('\0')) if (p) out.set(p, null);
  }
  for (const p of (gitSync(['ls-files', '--others', '--exclude-standard', '-z'], root) ?? '').split('\0')) if (p) out.set(p, null);
  return out;
}

export function contentAtSync(root: string, base: string, rel: string): string | null {
  return gitSync(['show', `${base}:${rel}`], root) ?? null;
}
