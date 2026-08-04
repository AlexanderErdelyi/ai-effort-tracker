import * as vscode from 'vscode';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';
import { getFileExt } from '../util/fileTypes';

export class CopilotTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private documentLines = new Map<string, string[]>();

  constructor(private db: Database, private timeTracker: TimeTracker) {}

  start(_context: vscode.ExtensionContext) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
        this.documentLines.set(doc.uri.toString(), doc.getText().split(/\r?\n/));
      }
    }
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
          this.documentLines.set(doc.uri.toString(), doc.getText().split(/\r?\n/));
        }
      }),
      vscode.workspace.onDidCloseTextDocument(doc => this.documentLines.delete(doc.uri.toString())),
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
    const insertedText = changeCount === 1 ? event.contentChanges[0].text : '';

    // Hand typing = exactly one small edit into a single region. This covers the
    // everyday keystrokes that ALSO change the line count, which must count as
    // human:
    //   - a single typed char or a backspace           (tiny edit)
    //   - pressing Enter / Tab / auto-indent            (single-region insert of
    //     newline + whitespace only — AI never suggests pure whitespace)
    //   - Backspace that merges two lines               (tiny deletion, ≤1 char)
    // Anything multi-region, larger, or containing real (non-whitespace) code
    // text is an AI/agent apply, an inline-completion accept, or a paste → AI.
    const tinyEdit = insertedChars <= 1 && deletedChars <= 1;
    const whitespaceInsert =
      insertedText.length > 0 && /^\s+$/.test(insertedText) && deletedChars <= 1;
    const looksHandTyped = changeCount === 1 && (tinyEdit || whitespaceInsert);

    // The `aiGenerating` gate keeps AI-context edits as AI: while chat / an agent
    // is writing (mode stays aiGenerating for a few seconds after any AI edit),
    // even a small edit is attributed to AI, so AI-inserted lines stay AI.
    const source: 'human' | 'ai' =
      looksHandTyped && mode !== 'aiGenerating' ? 'human' : 'ai';
    const key = event.document.uri.toString();
    const before = this.documentLines.get(key);
    const after = event.document.getText().split(/\r?\n/);
    this.documentLines.set(key, after);

    const relPath = vscode.workspace.asRelativePath(event.document.uri, false);
    if (insertedLines > 0 || deletedLines > 0) {
      this.db.recordLineChange(branch, ext, source, insertedLines, deletedLines, relPath);
    }
    if (before) {
      this.db.recordEffectiveLines(branch, relPath, source, meaningfulLineVersions(before, after));
    }

    if (insertedChars > 0) {
      this.db.recordChars(branch, source, insertedChars);
    }
    if (source === 'ai' && insertedChars > 0) {
      // Inline completion = one contiguous insert, no deletion, into the editor
      // you're actively looking at, modest size. Everything else (multi-region,
      // replacements, background file writes) is a chat/agent apply.
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      const isActiveDoc = activeUri === event.document.uri.toString();
      const looksInline =
        changeCount === 1 && deletedChars === 0 && isActiveDoc && insertedLines <= 8;
      this.db.recordAiSplit(branch, looksInline ? 'inline' : 'chat', insertedLines, insertedChars);
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

/**
 * Count meaningful line versions between two document states. Common prefix and
 * suffix lines are ignored, so a whole-file rewrite that preserves 100 lines and
 * adds one counts as one. A later delete or replacement counts as another version.
 */
export function meaningfulLineVersions(before: string[], after: string[]): number {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let bi = before.length - 1, ai = after.length - 1;
  while (bi >= start && ai >= start && before[bi] === after[ai]) { bi--; ai--; }
  const removed = Math.max(0, bi - start + 1);
  const added = Math.max(0, ai - start + 1);
  return removed + added;
}
