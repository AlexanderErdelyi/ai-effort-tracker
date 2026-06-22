import * as vscode from 'vscode';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';
import { getFileExt } from '../util/fileTypes';

export class CopilotTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  start(_context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => this.onDocChange(event))
    );
  }

  private onDocChange(event: vscode.TextDocumentChangeEvent) {
    if (!event.contentChanges.length) return;
    const scheme = event.document.uri.scheme;
    if (scheme !== 'file' && scheme !== 'untitled') return;

    const ext = getFileExt(event.document.fileName);
    const branch = this.timeTracker.getBranch();
    const mode = this.timeTracker.getMode();

    let eventIsAi = mode === 'aiGenerating';

    for (const change of event.contentChanges) {
      const linesAdded = (change.text.match(/\n/g) ?? []).length;
      const linesDeleted = change.range.end.line - change.range.start.line;

      // A human types one character per change event. Any single change that
      // inserts a whole line (or >15 chars at once) is a Copilot inline accept,
      // an agent/WorkspaceEdit write, or a paste — i.e. not hand-typed.
      const isAiLike = linesAdded >= 1 || change.text.length > 15;
      if (isAiLike) eventIsAi = true;

      if (linesAdded === 0 && linesDeleted === 0 && change.text.length < 2) {
        continue; // ignore single-char keystrokes for line stats
      }

      const source: 'human' | 'ai' =
        mode === 'aiGenerating' || isAiLike ? 'ai' : 'human';

      this.db.recordLineChange(branch, ext, source, linesAdded, linesDeleted);
    }

    // Drive the time-mode: every edit is activity; classify the whole event.
    this.timeTracker.markEdit(eventIsAi ? 'ai' : 'human');
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
