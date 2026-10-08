import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Database, normalizeRepoId, extractWorkItemId } from '../store/database';
import { TimeTracker } from './timeTracker';
import { BranchSwitch, parseReflog } from '../util/reflog';
import { branchKey, branchNameOf, pickRepoFolder } from '../util/branchKey';

/** Real net line change of a branch vs its base (issue: churn vs net). */
export interface NetLineChange {
  branch: string;
  /** Resolved comparison base (merge-base commit sha, or 'HEAD' fallback). */
  base: string;
  totalAdded: number;
  totalRemoved: number;
  /** Number of changed files (tracked diffs + untracked). */
  fileCount: number;
  /** Net added/removed bucketed by effort category. */
  byCategory: Record<string, { added: number; removed: number }>;
}

export class GitTracker implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private pollInterval: NodeJS.Timeout | undefined;
  private refreshing = false;
  private disposed = false;

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  private switchListeners: ((prev: string | undefined, next: string, nextIsNew: boolean) => void)[] = [];

  /** #156: called after the checked-out branch changed; `nextIsNew` when nothing was tracked on it yet. */
  onBranchSwitch(listener: (prev: string | undefined, next: string, nextIsNew: boolean) => void): void {
    this.switchListeners.push(listener);
  }

  start(_context: vscode.ExtensionContext) {
    if (this.pollInterval || this.disposed) return;
    // Poll git branch every 5 seconds (lightweight)
    this.pollInterval = setInterval(() => void this.refreshBranch(), 5000);
    void this.refreshBranch();
  }

  private async refreshBranch() {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    try {
      const reported = await GitTracker.getCurrentBranch();
      if (!reported || this.disposed) return;
      // #159: a merged key resolves to its target; on case-insensitive file
      // systems git may report another casing of a branch we already track.
      const branch = this.db.canonicalBranchKey?.(reported, process.platform === 'win32' || process.platform === 'darwin') ?? reported;

      const prev = this.timeTracker.getBranch();
      if (branch !== prev) {
        const nextIsNew = !this.db.getAllBranches?.().includes(branch);
        this.timeTracker.setBranch(branch);
        // Manual mappings remain sticky in the database.
        const workItemId = GitTracker.extractWorkItemId(branchNameOf(branch));
        if (workItemId) {
          this.db.setWorkItemForBranch(branch, workItemId);
        }
        for (const l of this.switchListeners) {
          try { l(prev, branch, nextIsNew); } catch (e) { console.error('AI Effort Tracker: branch switch listener failed', e); }
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private static lastFolder: string | undefined;
  private static repoIds = new Map<string, Promise<string>>();

  /**
   * Workspace folder of the repository being worked on (#154): in a multi-root
   * workspace the folder of the active editor, so `main` of each repository is
   * tracked separately.
   */
  static activeFolder(): string | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const doc = vscode.window.activeTextEditor?.document.uri;
    const picked = pickRepoFolder(doc?.scheme === 'file' ? doc.fsPath : undefined, folders, GitTracker.lastFolder);
    if (picked) GitTracker.lastFolder = picked;
    return picked;
  }

  /**
   * Store key of the checked-out branch: `<repoId>::<branch>` (#154). Use
   * {@link getCurrentBranchName} where git or the user needs the plain name.
   */
  static async getCurrentBranch(): Promise<string | undefined> {
    const folder = GitTracker.activeFolder();
    if (!folder) return undefined;
    const name = await GitTracker.branchNameIn(folder);
    if (!name) return undefined;
    return branchKey(await GitTracker.repoIdOf(folder), name);
  }

  /** Plain git name of the checked-out branch (`HEAD` when detached). */
  static async getCurrentBranchName(): Promise<string | undefined> {
    const folder = GitTracker.activeFolder();
    return folder ? GitTracker.branchNameIn(folder) : undefined;
  }

  private static branchNameIn(folder: string): Promise<string | undefined> {
    return new Promise(resolve => {
      cp.exec('git rev-parse --abbrev-ref HEAD', { cwd: folder, timeout: 4000, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : stdout.trim() || undefined);
      });
    });
  }

  /** HEAD branch switches from the reflog (oldest first) as store keys; empty when unavailable. */
  static async getBranchSwitches(): Promise<BranchSwitch[]> {
    const wsFolder = GitTracker.activeFolder();
    if (!wsFolder) return [];
    const out = await GitTracker.exec('git reflog show --date=unix --format=%gd%x09%gs -n 5000 HEAD', wsFolder);
    if (!out) return [];
    const repoId = await GitTracker.repoIdOf(wsFolder);
    const key = (name: string | undefined) => name ? branchKey(repoId, name) : undefined;
    return parseReflog(out).map(s => ({ ts: s.ts, from: key(s.from), to: key(s.to) }));
  }

  /** Recent commits on HEAD as "abc1234 subject", newest first; empty when unavailable. */
  static async getRecentCommits(count = 5): Promise<string[]> {
    const wsFolder = GitTracker.activeFolder();
    if (!wsFolder) return [];
    const n = Math.max(1, Math.min(20, Math.round(count)));
    const out = await GitTracker.exec(`git log -n ${n} --format=%h%x20%s`, wsFolder);
    return out ? out.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
  }

  static extractWorkItemId(branch: string): string | undefined {
    // Single source of truth: the regex lives in the store module so migration
    // ({@link assignUnmappedBranches}) and live tracking share one implementation.
    return extractWorkItemId(branch);
  }

  private static exec(cmd: string, cwd: string, maxBuffer = 20 * 1024 * 1024): Promise<string | undefined> {
    return new Promise(resolve => {
      cp.exec(cmd, { cwd, maxBuffer, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : stdout);
      });
    });
  }

  /** Resolve a comparison base for "net change on this branch": the merge-base
   *  with the repo's default branch, falling back to HEAD (uncommitted-only). */
  private static async resolveNetBase(cwd: string): Promise<string> {
    const candidates: string[] = [];
    const originHead = (await GitTracker.exec('git rev-parse --abbrev-ref origin/HEAD', cwd))?.trim();
    if (originHead) candidates.push(originHead);
    candidates.push('origin/main', 'origin/master', 'main', 'master');
    for (const ref of candidates) {
      const ok = (await GitTracker.exec(`git rev-parse --verify --quiet ${ref}`, cwd))?.trim();
      if (!ok) continue;
      const mb = (await GitTracker.exec(`git merge-base HEAD ${ref}`, cwd))?.trim();
      if (mb) return mb;
    }
    return 'HEAD';
  }

  /**
   * Compute the REAL net line change of the current working branch (issue: churn
   * vs net). Unlike the event-stream churn counter, this diffs the working tree
   * (committed + uncommitted, plus untracked files) against the merge-base with
   * the default branch — i.e. exactly what SCM shows as the branch's real change.
   * Per-file added/removed are bucketed into effort categories. Best-effort:
   * returns `undefined` on any git/fs error so it never blocks the dashboard.
   */
  static async getNetLineChange(): Promise<NetLineChange | undefined> {
    const wsFolder = GitTracker.activeFolder();
    if (!wsFolder) return undefined;
    const branch = await GitTracker.getCurrentBranch();
    if (!branch) return undefined;
    try {
      // Lazy require keeps this module load-order independent and avoids a cycle.
      const { categorize } = require('../util/fileTypes') as typeof import('../util/fileTypes');
      const base = await GitTracker.resolveNetBase(wsFolder);
      const byCategory: Record<string, { added: number; removed: number }> = {};
      const bump = (p: string, a: number, r: number) => {
        const cat = categorize(p);
        (byCategory[cat] ??= { added: 0, removed: 0 });
        byCategory[cat].added += a;
        byCategory[cat].removed += r;
      };
      let totalAdded = 0, totalRemoved = 0, fileCount = 0;

      // Tracked changes (committed on branch + staged + unstaged) vs the base.
      const numstat = (await GitTracker.exec(`git diff --numstat --no-color ${base}`, wsFolder)) ?? '';
      for (const line of numstat.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        if (m[1] === '-' || m[2] === '-') continue; // binary
        const added = parseInt(m[1], 10), removed = parseInt(m[2], 10);
        // Handle rename form "old => new" / "{a => b}" by taking the new path.
        let p = m[3];
        const arrow = p.indexOf(' => ');
        if (arrow >= 0) p = p.slice(arrow + 4).replace(/[{}]/g, '');
        totalAdded += added; totalRemoved += removed; fileCount++;
        bump(p, added, removed);
      }

      // Untracked files aren't in `git diff`; count their lines as additions so
      // the net matches what the user sees in Source Control's Changes list.
      const others = (await GitTracker.exec('git ls-files --others --exclude-standard', wsFolder)) ?? '';
      const fs = require('fs') as typeof import('fs');
      const nodePath = require('path') as typeof import('path');
      let scanned = 0;
      for (const rel of others.split('\n').map(s => s.trim()).filter(Boolean)) {
        if (scanned++ > 5000) break;
        try {
          const abs = nodePath.join(wsFolder, rel);
          const st = fs.statSync(abs);
          if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
          const buf = fs.readFileSync(abs);
          if (buf.includes(0)) continue; // binary
          const text = buf.toString('utf8');
          if (!text) continue;
          const added = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          if (added <= 0) continue;
          totalAdded += added; fileCount++;
          bump(rel, added, 0);
        } catch { /* skip unreadable file */ }
      }

      return { branch, base, totalAdded, totalRemoved, fileCount, byCategory };
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a stable identity for the current workspace repository (issue #8),
   * used to map the workspace to a {@link Project} via
   * {@link Database.getProjectForRepo}. Prefers the git `origin` remote URL
   * (normalized to `host/owner/repo`); when there is no remote (local-only repo)
   * it falls back to the workspace folder path. Returns `undefined` only when
   * there is no open workspace folder at all. In a multi-root workspace this is
   * the repository of the active editor (#154).
   */
  static async getRepoId(): Promise<string | undefined> {
    const wsFolder = GitTracker.activeFolder();
    return wsFolder ? GitTracker.repoIdOf(wsFolder) : undefined;
  }

  private static repoIdOf(folder: string): Promise<string> {
    let id = GitTracker.repoIds.get(folder);
    if (!id) {
      id = new Promise<string>(resolve => {
        cp.exec('git config --get remote.origin.url', { cwd: folder, timeout: 4000, windowsHide: true }, (err, stdout) => {
          const remote = err ? '' : stdout.trim();
          // A timed-out lookup must not pin the path fallback for the session.
          if (err?.killed) GitTracker.repoIds.delete(folder);
          // Fall back to the workspace folder path when the repo has no origin remote.
          resolve(normalizeRepoId(remote || path.normalize(folder)));
        });
      });
      GitTracker.repoIds.set(folder, id);
    }
    return id;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.pollInterval);
    this.watcher?.dispose();
  }
}
