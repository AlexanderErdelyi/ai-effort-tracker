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
    const scheme = event.document.uri.scheme;
    if (scheme !== 'file' && scheme !== 'untitled') return;

    const ext = getFileExt(event.document.fileName);
    const branch = this.timeTracker.getBranch();
    const mode = this.timeTracker.getMode();

    for (const change of event.contentChanges) {
      const linesAdded = (change.text.match(/\n/g) ?? []).length;
      const linesDeleted = change.range.end.line - change.range.start.line;

      if (linesAdded === 0 && linesDeleted === 0 && change.text.length < 2) {
        continue; // ignore single-char keystrokes
      }

      // A Copilot inline completion accepted via Tab has these characteristics:
      //   1. Zero-width range (cursor position, not a selection replacement)
      //   2. Multi-line insert (linesAdded >= 1) — clear Copilot signal
      //   OR large single-line insert (> 15 chars) at cursor — likely completion
      // This can happen regardless of the current tracking mode (user was just typing).
      const isCursorInsert =
        change.range.start.line === change.range.end.line &&
        change.range.start.character === change.range.end.character;

      const isInlineCompletion =
        isCursorInsert && (linesAdded >= 1 || change.text.length > 15);

      const source: 'human' | 'ai' =
        mode === 'aiGenerating' || isInlineCompletion ? 'ai' : 'human';

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
