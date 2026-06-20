import * as vscode from 'vscode';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';
import { getFileExt } from '../util/fileTypes';

export class CopilotTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  start(_context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => this.onDocChange(event)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.checkCopilotChatState())
    );
  }

  private onDocChange(event: vscode.TextDocumentChangeEvent) {
    if (!event.contentChanges.length) return;
    // Ignore output channels, git, extension internals
    const scheme = event.document.uri.scheme;
    if (scheme !== 'file' && scheme !== 'untitled') return;

    const ext = getFileExt(event.document.fileName);
    const branch = this.timeTracker.getBranch();
    const mode = this.timeTracker.getMode();

    for (const change of event.contentChanges) {
      const linesAdded = (change.text.match(/\n/g) ?? []).length;
      const linesDeleted = change.range.end.line - change.range.start.line;

      if (linesAdded === 0 && linesDeleted === 0) continue; // single-line char edit, skip

      // Attribution heuristic:
      // AI if: currently in aiGenerating mode, OR multi-line insert at a single cursor point (Copilot inline)
      const isAiInline =
        linesAdded >= 2 &&
        linesDeleted === 0 &&
        change.range.start.line === change.range.end.line &&
        mode !== 'humanCoding';

      const source: 'human' | 'ai' =
        mode === 'aiGenerating' || isAiInline ? 'ai' : 'human';

      this.db.recordLineChange(branch, ext, source, linesAdded, linesDeleted);
    }
  }

  private checkCopilotChatState() {
    const isCopilotActive = vscode.window.visibleTextEditors.some(e =>
      e.document.uri.scheme === 'vscode-chat' ||
      e.document.languageId === 'github-copilot'
    );
    this.timeTracker.setAiGenerating(isCopilotActive);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
