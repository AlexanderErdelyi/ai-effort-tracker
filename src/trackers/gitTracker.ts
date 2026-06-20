import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Database } from '../store/database';
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
    // Matches patterns like: feature/1234-something, bugfix/1234, 1234-something
    const match = branch.match(/(?:^|[/_-])(\d{3,6})(?:[_-]|$)/);
    return match?.[1];
  }

  dispose() {
    clearInterval(this.pollInterval);
    this.watcher?.dispose();
  }
}
