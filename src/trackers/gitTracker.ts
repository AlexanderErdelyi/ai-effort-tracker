import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Database, normalizeRepoId, extractWorkItemId } from '../store/database';
import { TimeTracker } from './timeTracker';

export class GitTracker implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  start(context: vscode.ExtensionContext) {
    // Poll git branch every 5 seconds (lightweight)
    this.pollInterval = setInterval(() => this.refreshBranch(), 5000);
    this.refreshBranch();
  }

  private async refreshBranch() {
    const branch = await GitTracker.getCurrentBranch();
    if (!branch) return;

    const prev = this.timeTracker.getBranch();
    if (branch !== prev) {
      this.timeTracker.setBranch(branch);
      // Try to resolve work item from branch name (e.g. feature/1234-auth or 1234-auth)
      const workItemId = GitTracker.extractWorkItemId(branch);
      if (workItemId) {
        this.db.setWorkItemForBranch(branch, workItemId);
      }
    }
  }

  static async getCurrentBranch(): Promise<string | undefined> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) return undefined;
    return new Promise(resolve => {
      cp.exec('git rev-parse --abbrev-ref HEAD', { cwd: wsFolder }, (err, stdout) => {
        resolve(err ? undefined : stdout.trim());
      });
    });
  }

  static extractWorkItemId(branch: string): string | undefined {
    // Single source of truth: the regex lives in the store module so migration
    // ({@link assignUnmappedBranches}) and live tracking share one implementation.
    return extractWorkItemId(branch);
  }

  /**
   * Resolve a stable identity for the current workspace repository (issue #8),
   * used to map the workspace to a {@link Project} via
   * {@link Database.getProjectForRepo}. Prefers the git `origin` remote URL
   * (normalized to `host/owner/repo`); when there is no remote (local-only repo)
   * it falls back to the workspace folder path. Returns `undefined` only when
   * there is no open workspace folder at all.
   */
  static async getRepoId(): Promise<string | undefined> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) return undefined;
    const remote = await new Promise<string | undefined>(resolve => {
      cp.exec('git config --get remote.origin.url', { cwd: wsFolder }, (err, stdout) => {
        const url = err ? '' : stdout.trim();
        resolve(url || undefined);
      });
    });
    // Fall back to the workspace folder path when the repo has no origin remote.
    return normalizeRepoId(remote ?? path.normalize(wsFolder));
  }

  dispose() {
    clearInterval(this.pollInterval);
    this.watcher?.dispose();
  }
}
