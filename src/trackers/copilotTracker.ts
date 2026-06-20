import * as vscode from 'vscode';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';

/**
 * Tracks GitHub Copilot inline completion acceptances.
 *
 * VS Code exposes `vscode.InlineCompletionItem` but not a direct "accepted" event.
 * We hook into `onDidChangeTextDocument` and compare changes with active AI state
 * to heuristically count AI-accepted lines. When the Copilot extension API becomes
 * stable we can swap to the official event.
 */
export class CopilotTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private aiActiveFiles = new Set<string>();

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  start(context: vscode.ExtensionContext) {
    // Listen for large/multi-line insertions as a proxy for Copilot acceptances.
    // A true Copilot acceptance is a single insertion of multiple lines at cursor.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;

        for (const change of event.contentChanges) {
          const addedLines = (change.text.match(/\n/g) ?? []).length;
          const removedLines = change.range.end.line - change.range.start.line;

          // Heuristic: multi-line insertion with no selection removal = likely AI completion
          if (addedLines >= 2 && removedLines === 0) {
            const branch = this.timeTracker.getBranch();
            this.db.recordCopilotAcceptance(branch, addedLines);
          }
        }
      })
    );

    // Watch for Copilot Chat panel opening (signals AI is generating)
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.checkCopilotChatState();
      })
    );
  }

  private checkCopilotChatState() {
    // When Copilot Chat is actively streaming, an editor titled "GitHub Copilot Chat" is visible
    const isCopilotVisible = vscode.window.visibleTextEditors.some(e =>
      e.document.uri.scheme === 'vscode-chat' || e.document.languageId === 'github-copilot'
    );
    this.timeTracker.setAiGenerating(isCopilotVisible);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
