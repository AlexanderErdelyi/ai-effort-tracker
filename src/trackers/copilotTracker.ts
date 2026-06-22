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

    // Chat / non-file editors: count what the human types into chat, not code.
    if (scheme !== 'file' && scheme !== 'untitled') {
      this.maybeRecordChat(event);
      return;
    }

    const ext = getFileExt(event.document.fileName);
    const branch = this.timeTracker.getBranch();
    const mode = this.timeTracker.getMode();

    // Aggregate the whole event. A human types ONE small edit at a time;
    // an agent / Copilot accept / paste arrives as a big or multi-region edit.
    let insertedChars = 0, insertedLines = 0, deletedLines = 0, deletedChars = 0;
    for (const change of event.contentChanges) {
      insertedChars += change.text.length;
      insertedLines += (change.text.match(/\n/g) ?? []).length;
      deletedLines += change.range.end.line - change.range.start.line;
      deletedChars += change.rangeLength;
    }
    const changeCount = event.contentChanges.length;

    // Hand typing = exactly one edit, single line, at most one char in/out
    // (covers a keystroke and a backspace). Everything else is AI/agent/paste.
    const looksHandTyped =
      changeCount === 1 &&
      insertedLines === 0 && deletedLines === 0 &&
      insertedChars <= 1 && deletedChars <= 1;

    const source: 'human' | 'ai' =
      looksHandTyped && mode !== 'aiGenerating' ? 'human' : 'ai';

    if (insertedLines > 0 || deletedLines > 0) {
      this.db.recordLineChange(branch, ext, source, insertedLines, deletedLines);
    }
    this.timeTracker.markEdit(source);
  }

  /** Best-effort: count characters the human types into the Copilot chat input. */
  private maybeRecordChat(event: vscode.TextDocumentChangeEvent) {
    const doc = event.document;
    const looksLikeChat =
      doc.languageId === 'github-copilot' ||
      doc.languageId === 'prompt' ||
      /chat|copilot|comment|input/i.test(doc.uri.scheme);
    if (!looksLikeChat) return;

    let typed = 0;
    for (const change of event.contentChanges) {
      // Only count net human typing (ignore programmatic clears/inserts)
      if (change.text.length > 0 && change.text.length <= 4 && !change.text.includes('\n')) {
        typed += change.text.length;
      }
    }
    if (typed > 0) {
      this.db.recordChatChars(this.timeTracker.getBranch(), typed);
      this.timeTracker.markEdit('human');
    }
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
