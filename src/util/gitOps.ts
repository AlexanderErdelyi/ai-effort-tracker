import * as fs from 'fs';
import * as path from 'path';

/** Non-dirty reloads this soon after a git operation are git's work, not yours (#160). */
export const GIT_OP_WINDOW_MS = 30_000;

const gitDirs = new Map<string, string | null>();

/** The git directory of the repository containing `dir` (linked worktrees resolve their `gitdir:` file). */
export function gitDirFor(dir: string): string | undefined {
  const seen: string[] = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const cached = gitDirs.get(cur);
    if (cached !== undefined) { for (const s of seen) gitDirs.set(s, cached); return cached ?? undefined; }
    seen.push(cur);
    const dotGit = path.join(cur, '.git');
    let found: string | null | undefined;
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) found = dotGit;
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        found = m ? path.resolve(cur, m[1].trim()) : null;
      }
    } catch { /* not here */ }
    if (found !== undefined) { for (const s of seen) gitDirs.set(s, found); return found ?? undefined; }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const s of seen) gitDirs.set(s, null);
  return undefined;
}

/** True for HEAD reflog messages of operations that rewrite the working tree (checkout, pull, merge, reset, rebase …). */
export function rewritesWorkingTree(reflogMessage: string): boolean {
  const m = reflogMessage.trim();
  if (!m) return false;
  return !/^commit\b/.test(m) && !/^branch:/.test(m);
}

/** Message of the last HEAD reflog line (`<old> <new> <who> <ts> <tz>\t<message>`). */
export function lastReflogMessage(text: string): string {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const last = lines[lines.length - 1] ?? '';
  const tab = last.indexOf('\t');
  return tab >= 0 ? last.slice(tab + 1) : '';
}

/**
 * Whether git rewrote the working tree of the repository containing `filePath`
 * within `windowMs` (or is doing so right now: `index.lock` exists). Commits do
 * not count, they leave files untouched. Best-effort: false when unsure.
 */
export function recentWorkingTreeOp(filePath: string, now = Date.now(), windowMs = GIT_OP_WINDOW_MS): boolean {
  const gitDir = gitDirFor(path.dirname(filePath));
  if (!gitDir) return false;
  try {
    if (fs.existsSync(path.join(gitDir, 'index.lock'))) return true;
    const log = path.join(gitDir, 'logs', 'HEAD');
    const st = fs.statSync(log);
    if (now - st.mtimeMs > windowMs) return false;
    const size = st.size, len = Math.min(size, 8192);
    const fd = fs.openSync(log, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return rewritesWorkingTree(lastReflogMessage(buf.toString('utf8')));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
