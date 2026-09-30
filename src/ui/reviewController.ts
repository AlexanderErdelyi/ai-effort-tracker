import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { normalizeRepoId } from '../store/database';
import * as R from '../analysis/review';
import * as T from '../analysis/reviewTree';
import { ALL_CATEGORIES, CATEGORY_LABELS, categorizeWith, readUserRules, type FileCategory } from '../util/fileTypes';
import { ReviewStore } from '../review/reviewStore';
import * as G from '../review/reviewGit';

/**
 * Code review tracking in the editor (#107, #108): gutter marks, CodeLens,
 * commands, the "AI Effort: Review" view and a status bar item. Changed lines
 * are computed against the branch's merge-base (or a chosen baseline), marks
 * live in the durable {@link ReviewStore}, and the latest coverage of the
 * current branch is saved for work items, the health check and MCP (#109).
 */

interface RepoCtx {
  root: string;
  repoId: string;
  branch: string;
  head: string;
  base: string | null;
  baseLabel: string;
  changed: Map<string, string | null>;
  at: number;
}

interface DocEval {
  version: number;
  ctx: RepoCtx;
  rel: string;
  review: R.FileReview;
}

interface Block { start: number; end: number; lines: number; at?: number; context: string }

interface FileRow extends R.FileCoverage { root: string; firstTodo?: number; todo: Block[]; ok: Block[] }

interface Snapshot { ctx: RepoCtx; cov: R.BranchCoverage; rows: FileRow[] }

type Section = 'open' | 'done';

type Node =
  | { kind: 'summary' }
  | { kind: 'issues' }
  | { kind: 'issue'; issue: R.OpenIssue }
  | { kind: 'resolvedGroup' }
  | { kind: 'resolved'; issue: R.ResolvedIssue }
  | { kind: 'section'; section: Section }
  | { kind: 'file'; row: FileRow; section: Section; showDir?: boolean }
  | { kind: 'block'; row: FileRow; block: Block; section: Section }
  | { kind: 'group'; group: T.ReviewTreeGroup<FileRow>; section: Section };

const CTX_TTL_MS = 20_000;
const MAX_DOC_LINES = 60_000;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_BLOCKS = 200;
const BASE_KEY = 'aet.review.baseOverrides';

const cfg = () => vscode.workspace.getConfiguration('aiEffortTracker.review');
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class ReviewController implements vscode.Disposable, vscode.CodeLensProvider, vscode.TreeDataProvider<Node> {
  readonly store: ReviewStore;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly rootOfDir = new Map<string, string | null>();
  private readonly ctxs = new Map<string, RepoCtx>();
  private readonly ctxPending = new Map<string, Promise<RepoCtx | undefined>>();
  private readonly evals = new Map<string, DocEval>();
  private readonly evalSeq = new Map<string, number>();
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly treeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  readonly onDidChangeTreeData = this.treeEmitter.event;
  private readonly okType: vscode.TextEditorDecorationType;
  private readonly okBgType: vscode.TextEditorDecorationType;
  private readonly issueType: vscode.TextEditorDecorationType;
  private readonly todoType: vscode.TextEditorDecorationType;
  private readonly statusItem: vscode.StatusBarItem;
  private snapshot: Snapshot | undefined;
  private currentRoot: string | undefined;
  private coverageTimer: NodeJS.Timeout | undefined;
  private coverageRunning = false;
  private coverageAgain = false;
  private lastPersisted = '';
  private storeStamp = '';
  private storeErrorShown = false;
  private exclude: (rel: string) => boolean = () => false;
  private tick: NodeJS.Timeout | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, storageDir: string) {
    this.store = new ReviewStore(storageDir);
    const icon = (n: string) => vscode.Uri.joinPath(context.extensionUri, 'media', n);
    this.okType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('review-ok.svg'), gutterIconSize: '70%',
      overviewRulerColor: 'rgba(46,160,67,0.7)', overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.okBgType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true, backgroundColor: new vscode.ThemeColor('aiEffortTracker.review.reviewedLineBackground')
    });
    this.issueType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('review-issue.svg'), gutterIconSize: '80%', isWholeLine: true,
      backgroundColor: 'rgba(248,81,73,0.08)',
      overviewRulerColor: 'rgba(248,81,73,0.9)', overviewRulerLane: vscode.OverviewRulerLane.Full
    });
    this.todoType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon('review-todo.svg'), gutterIconSize: '70%',
      overviewRulerColor: 'rgba(210,153,34,0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.statusItem = vscode.window.createStatusBarItem('aiEffortTracker.review', vscode.StatusBarAlignment.Left, 40);
    this.statusItem.name = 'AI Effort Tracker: Review';
    this.statusItem.command = 'aiEffortTracker.review.showProgress';
    this.readConfig();

    const view = vscode.window.createTreeView('aiEffortTracker.reviewView', { treeDataProvider: this, showCollapseAll: true, manageCheckboxStateManually: true });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(this.store.file)), path.basename(this.store.file)));
    const external = () => { clearTimeout(this.watchTimer); this.watchTimer = setTimeout(() => void this.poll(), 400); };
    this.disposables.push(
      view, watcher, watcher.onDidChange(external), watcher.onDidCreate(external),
      view.onDidChangeCheckboxState(e => void this.onCheckbox(e)),
      this.okType, this.okBgType, this.issueType, this.todoType, this.statusItem, this.lensEmitter, this.treeEmitter,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) this.queueDoc(e.document, 50, true); }),
      vscode.window.onDidChangeVisibleTextEditors(eds => { for (const e of eds) this.queueDoc(e.document, 50); }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length && vscode.window.visibleTextEditors.some(v => v.document === e.document)) this.queueDoc(e.document, 400);
      }),
      vscode.workspace.onDidSaveTextDocument(doc => { this.invalidateCtx(); this.queueDoc(doc, 50); this.scheduleCoverage(1500); }),
      vscode.workspace.onDidCreateFiles(() => { this.invalidateCtx(); this.scheduleCoverage(1500); }),
      vscode.workspace.onDidDeleteFiles(() => { this.invalidateCtx(); this.scheduleCoverage(1500); }),
      vscode.workspace.onDidRenameFiles(() => { this.invalidateCtx(); this.scheduleCoverage(1500); }),
      vscode.window.onDidChangeWindowState(s => { if (s.focused) void this.poll(); }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiEffortTracker.review.groupBy') || e.affectsConfiguration('aiEffortTracker.categoryRules')) this.treeEmitter.fire();
        const keys = ['enabled', 'showDecorations', 'highlightReviewedLines', 'codeLens', 'showStatusBar', 'exclude', 'baseRef'];
        if (!keys.some(k => e.affectsConfiguration('aiEffortTracker.review.' + k))) return;
        this.readConfig();
        this.invalidateCtx();
        this.refreshAll();
      }),
      ...this.registerCommands()
    );
    this.tick = setInterval(() => void this.poll(), 15_000);
    this.refreshAll();
  }

  private enabled() { return cfg().get<boolean>('enabled') ?? true; }

  private readConfig() {
    const globs = cfg().get<string[]>('exclude');
    this.exclude = R.excludeMatcher(Array.isArray(globs) ? globs : R.DEFAULT_REVIEW_EXCLUDE);
    void vscode.commands.executeCommand('setContext', 'aiEffortTracker.reviewEnabled', this.enabled());
  }

  // ---------------------------------------------------------------- git context

  private async rootFor(fsPath: string): Promise<string | undefined> {
    const dir = path.dirname(fsPath);
    if (!this.rootOfDir.has(dir)) {
      if (this.rootOfDir.size > 2000) this.rootOfDir.clear();
      this.rootOfDir.set(dir, (await G.gitRoot(dir)) ?? null);
    }
    return this.rootOfDir.get(dir) ?? undefined;
  }

  private baseOverride(root: string, branch: string): string | undefined {
    const map = this.context.workspaceState.get<Record<string, string>>(BASE_KEY) ?? {};
    return map[`${root}|${branch}`] || cfg().get<string>('baseRef')?.trim() || undefined;
  }

  private ctx(root: string, fresh = false): Promise<RepoCtx | undefined> {
    const hit = this.ctxs.get(root);
    if (hit && !fresh && Date.now() - hit.at < CTX_TTL_MS) return Promise.resolve(hit);
    const pending = this.ctxPending.get(root);
    if (pending) return pending;
    const p = (async () => {
      try {
        const head = (await G.git(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], root))?.trim().split(/\r?\n/) ?? [];
        const branch = head[1] || (await G.gitBranch(root)) || 'HEAD';
        const repoId = normalizeRepoId((await G.gitRemote(root)) ?? path.normalize(root));
        const override = this.baseOverride(root, branch);
        const base = await G.resolveReviewBase(root, override);
        const changed = await G.changedFiles(root, base);
        const baseLabel = override && base ? `${override} (${base.slice(0, 7)})` : base ? `merge-base ${base.slice(0, 7)}` : 'no commits yet';
        const ctx: RepoCtx = { root, repoId, branch, head: head[0] ?? '', base, baseLabel, changed, at: Date.now() };
        this.ctxs.set(root, ctx);
        return ctx;
      } catch {
        return hit;
      } finally {
        this.ctxPending.delete(root);
      }
    })();
    this.ctxPending.set(root, p);
    return p;
  }

  private invalidateCtx() { for (const c of this.ctxs.values()) c.at = 0; }

  private relOf(ctx: RepoCtx, fsPath: string): string | undefined {
    const rel = path.relative(ctx.root, fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  /** Changed line indices of a text vs the review base; empty for untracked-and-ignored files. */
  private async changedFor(ctx: RepoCtx, rel: string, lines: string[], dirty: boolean): Promise<Set<number>> {
    const inSet = ctx.changed.has(rel);
    if (!inSet && !dirty) return new Set();
    const from = inSet ? ctx.changed.get(rel) : rel;
    const baseText = from && ctx.base ? await G.contentAt(ctx.root, ctx.base, from) : null;
    if (baseText === null && !inSet) return new Set();
    return R.changedLines(baseText === null ? null : R.splitLines(baseText), lines);
  }

  private marksFor(repoId: string, rel: string): R.ReviewMark[] {
    try {
      return this.store.repo(repoId).files[rel] ?? [];
    } catch (error) {
      if (!this.storeErrorShown) {
        this.storeErrorShown = true;
        void vscode.window.showErrorMessage(`AI Effort Tracker: review marks could not be read (${(error as Error).message}). Nothing was changed on disk.`);
      }
      return [];
    }
  }

  // ---------------------------------------------------------------- per document

  private queueDoc(doc: vscode.TextDocument, delay: number, activeChanged = false) {
    if (doc.uri.scheme !== 'file') return;
    const key = doc.uri.toString();
    clearTimeout(this.docTimers.get(key));
    this.docTimers.set(key, setTimeout(() => {
      this.docTimers.delete(key);
      void this.evaluate(doc).then(ev => {
        if (activeChanged && ev && !same(ev.ctx.root, this.currentRoot ?? '')) {
          this.currentRoot = ev.ctx.root;
          this.scheduleCoverage(200);
        }
      });
    }, delay));
  }

  private async evaluate(doc: vscode.TextDocument): Promise<DocEval | undefined> {
    const key = doc.uri.toString();
    const seq = (this.evalSeq.get(key) ?? 0) + 1;
    this.evalSeq.set(key, seq);
    let ev: DocEval | undefined;
    if (this.enabled() && doc.uri.scheme === 'file' && !doc.isClosed && doc.lineCount <= MAX_DOC_LINES) {
      const root = await this.rootFor(doc.uri.fsPath);
      const ctx = root ? await this.ctx(root) : undefined;
      const rel = ctx ? this.relOf(ctx, doc.uri.fsPath) : undefined;
      if (ctx && rel && !this.exclude(rel)) {
        const version = doc.version;
        const lines = R.splitLines(doc.getText());
        const changed = await this.changedFor(ctx, rel, lines, doc.isDirty);
        const review = R.evaluateFile(lines, changed, this.marksFor(ctx.repoId, rel));
        ev = { version, ctx, rel, review };
      }
    }
    if (this.evalSeq.get(key) !== seq) return this.evals.get(key);
    if (ev) this.evals.set(key, ev); else this.evals.delete(key);
    this.decorate(doc);
    this.lensEmitter.fire();
    return ev;
  }

  private decorate(doc: vscode.TextDocument) {
    const ev = this.evals.get(doc.uri.toString());
    const show = this.enabled() && (cfg().get<boolean>('showDecorations') ?? true);
    const background = show && (cfg().get<boolean>('highlightReviewedLines') ?? true);
    const ok: vscode.DecorationOptions[] = [], todo: vscode.Range[] = [];
    const issues: vscode.DecorationOptions[] = [];
    if (ev && show) {
      const s = ev.review.status;
      for (let i = 0; i < s.length && i < doc.lineCount; i++) if (s[i] === 'todo') todo.push(doc.lineAt(i).range);
      const file = JSON.stringify(doc.uri.fsPath);
      for (const b of ev.review.reviewedBlocks) {
        const args = encodeURIComponent(`[${file},${b.start},${b.end}]`);
        const md = new vscode.MarkdownString(`$(pass-filled) **Reviewed** · ${plural(b.lines, 'line')} · ${new Date(b.at).toLocaleString()}\n\n`
          + `[$(close) Remove mark](command:aiEffortTracker.review.clearMark?${args} "Back to unreviewed") · [$(warning) Flag issue](command:aiEffortTracker.review.flagIssue?${args})`, true);
        md.isTrusted = { enabledCommands: ['aiEffortTracker.review.clearMark', 'aiEffortTracker.review.flagIssue'] };
        let first = true;
        for (let i = b.start; i <= b.end && i < doc.lineCount; i++) {
          if (s[i] !== 'ok') continue;
          ok.push(first ? { range: doc.lineAt(i).range, hoverMessage: md } : { range: doc.lineAt(i).range });
          first = false;
        }
      }
      for (const issue of ev.review.issues) {
        const md = new vscode.MarkdownString(`**⚑ Review issue** · ${new Date(issue.at).toLocaleString()}\n\n${issue.note ? escapeMd(issue.note) : '_no note_'}`);
        for (const i of issue.indices) if (i < doc.lineCount) issues.push({ range: doc.lineAt(i).range, hoverMessage: md });
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== doc) continue;
      editor.setDecorations(this.okType, ok);
      editor.setDecorations(this.okBgType, background ? ok.map(o => o.range) : []);
      editor.setDecorations(this.todoType, todo);
      editor.setDecorations(this.issueType, issues);
    }
  }

  private refreshAll() {
    for (const e of vscode.window.visibleTextEditors) this.queueDoc(e.document, 10, e === vscode.window.activeTextEditor);
    if (!vscode.window.activeTextEditor) this.scheduleCoverage(500);
    else this.scheduleCoverage(800);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled() || !(cfg().get<boolean>('codeLens') ?? true)) return [];
    const ev = this.evals.get(doc.uri.toString());
    if (!ev || ev.version !== doc.version) return [];
    const r = ev.review;
    if (!r.total && !r.issues.length && !r.fixed.length) return [];
    const uri = doc.uri;
    const at = (line: number) => new vscode.Range(line, 0, line, 0);
    const lenses: vscode.CodeLens[] = [];
    const todo = r.todoBlocks.reduce((s, b) => s + b.lines, 0);
    lenses.push(new vscode.CodeLens(at(0), {
      title: `$(checklist) Review ${r.reviewed}/${r.total} lines (${Math.floor(R.coveragePct(r.reviewed, r.total))}%)${r.issues.length ? ` · ${plural(r.issues.length, 'issue')}` : ''}`,
      command: 'aiEffortTracker.review.nextUnreviewed', tooltip: 'Changed lines on this branch reviewed so far. Click: next unreviewed change.'
    }));
    if (todo) {
      lenses.push(new vscode.CodeLens(at(0), {
        title: `✓ Mark file reviewed (${todo})`, command: 'aiEffortTracker.review.markFileReviewed', arguments: [uri],
        tooltip: 'Mark every unreviewed changed line in this file as reviewed OK'
      }));
    }
    for (const b of r.todoBlocks.slice(0, 300)) {
      lenses.push(new vscode.CodeLens(at(b.start), {
        title: `✓ Mark ${b.lines === 1 ? 'line' : `${b.lines} lines`} reviewed`, command: 'aiEffortTracker.review.markReviewed', arguments: [uri, b.start, b.end]
      }));
      lenses.push(new vscode.CodeLens(at(b.start), {
        title: '⚑ Flag issue', command: 'aiEffortTracker.review.flagIssue', arguments: [uri, b.start, b.end]
      }));
    }
    for (const issue of r.issues.slice(0, 100)) {
      const note = issue.note ? issue.note.replace(/\s+/g, ' ') : 'Issue';
      lenses.push(new vscode.CodeLens(at(issue.line), {
        title: `⚑ ${note.length > 70 ? note.slice(0, 69) + '…' : note}`, command: 'aiEffortTracker.review.issueActions', arguments: [uri, issue.line],
        tooltip: 'Resolve, edit or remove this review issue'
      }));
      lenses.push(new vscode.CodeLens(at(issue.line), {
        title: '✨ Fix with Copilot', command: 'aiEffortTracker.review.fixWithCopilot', arguments: [uri, issue.line],
        tooltip: 'Open a new chat with a prompt to fix this issue'
      }));
    }
    if (r.fixed.length) {
      const byId = new Map(this.marksFor(ev.ctx.repoId, ev.rel).map(m => [m.id, m]));
      for (const f of r.fixed.slice(0, 100)) {
        const m = byId.get(f.markId);
        if (!m?.fixed) continue;
        const note = (m.note || 'Issue').replace(/\s+/g, ' ');
        lenses.push(new vscode.CodeLens(at(f.line), {
          title: `$(verified) ${m.fixed.by === 'ai' ? 'Fixed by Copilot' : 'Fixed'}: ${note.length > 60 ? note.slice(0, 59) + '…' : note}`,
          command: 'aiEffortTracker.review.acceptFix', arguments: [uri, f.markId],
          tooltip: `${m.fixed.note ? m.fixed.note + '\n\n' : ''}Click to accept the fix and remove the flag.`
        }));
        lenses.push(new vscode.CodeLens(at(f.line), { title: '↺ Reopen', command: 'aiEffortTracker.review.reopenIssue', arguments: [uri, f.markId] }));
      }
    }
    return lenses;
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): vscode.Disposable[] {
    const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand('aiEffortTracker.review.' + id, async (...args: any[]) => {
      try { await fn(...args); } catch (error) {
        void vscode.window.showErrorMessage(`AI Effort Tracker: ${(error as Error).message}`);
      }
    });
    return [
      reg('markReviewed', (uri?: vscode.Uri | string, s?: number, e?: number) => this.markCommand('ok', uri, s, e)),
      reg('flagIssue', (uri?: vscode.Uri | string, s?: number, e?: number) => this.markCommand('issue', uri, s, e)),
      reg('clearMark', (uri?: vscode.Uri | string, s?: number, e?: number) => this.markCommand('clear', uri, s, e)),
      reg('markFileReviewed', (uri?: vscode.Uri) => this.markFile(uri)),
      reg('nextUnreviewed', () => this.nextUnreviewed()),
      reg('issueActions', (uri: vscode.Uri, line: number) => this.issueActions(uri, line)),
      reg('toggleHighlights', async () => {
        const cur = cfg().get<boolean>('showDecorations') ?? true;
        await cfg().update('showDecorations', !cur, vscode.ConfigurationTarget.Global);
        void vscode.window.setStatusBarMessage(`AI Effort Tracker: review highlights ${cur ? 'hidden' : 'shown'}`, 2500);
      }),
      reg('toggleReviewedBackground', async () => {
        const cur = cfg().get<boolean>('highlightReviewedLines') ?? true;
        await cfg().update('highlightReviewedLines', !cur, vscode.ConfigurationTarget.Global);
        void vscode.window.setStatusBarMessage(`AI Effort Tracker: reviewed lines ${cur ? 'show only the ✓ in the gutter' : 'are highlighted green'}`, 2500);
      }),
      reg('treeMarkReviewed', (node?: Node) => this.treeAction(node, 'ok')),
      reg('treeRemoveMarks', (node?: Node) => this.treeAction(node, 'clear')),
      reg('acceptFix', (target?: Node | vscode.Uri, markId?: string) => this.resolvedAction(target, 'accept', markId)),
      reg('reopenIssue', (target?: Node | vscode.Uri, markId?: string) => this.resolvedAction(target, 'reopen', markId)),
      reg('markIssueFixed', (target?: Node | vscode.Uri, markId?: string) => this.resolvedAction(target, 'fixed', markId)),
      reg('openRange', (root: string, rel: string, start: number, end: number) => this.openAt(path.join(root, rel), start, end)),
      reg('setBaseline', () => this.setBaseline()),
      reg('refresh', () => { this.invalidateCtx(); this.refreshAll(); this.scheduleCoverage(50); }),
      reg('openFile', (root: string, rel: string, line?: number) => this.openAt(path.join(root, rel), line)),
      reg('changeGrouping', () => this.chooseGrouping()),
      reg('showProgress', () => vscode.commands.executeCommand('aiEffortTracker.reviewView.focus')),
      reg('fixWithCopilot', async (target?: Node | vscode.Uri, line?: number) => {
        if (target instanceof vscode.Uri) {
          const ev = await this.ensureEval(await vscode.workspace.openTextDocument(target));
          const i = ev.review.issues.find(x => typeof line === 'number' && (x.indices.includes(line) || x.line === line));
          if (!i) throw new Error('This issue no longer exists (the lines were changed).');
          return this.fixWithCopilot({ path: ev.rel, line: i.line + 1, lines: i.lines, note: i.note, at: i.at, markId: i.markId }, ev.ctx.branch);
        }
        return this.fixWithCopilot(target && typeof target === 'object' && target.kind === 'issue' ? target.issue : undefined);
      })
    ];
  }

  private async docFor(uri?: vscode.Uri | string): Promise<vscode.TextDocument | undefined> {
    if (uri instanceof vscode.Uri) return vscode.workspace.openTextDocument(uri);
    if (typeof uri === 'string' && uri) return vscode.workspace.openTextDocument(vscode.Uri.file(uri));
    return vscode.window.activeTextEditor?.document;
  }

  private async ensureEval(doc: vscode.TextDocument): Promise<DocEval> {
    let ev = this.evals.get(doc.uri.toString());
    if (!ev || ev.version !== doc.version) ev = await this.evaluate(doc);
    if (!ev) {
      if (!this.enabled()) throw new Error('Review tracking is turned off (setting aiEffortTracker.review.enabled).');
      throw new Error('This file is not reviewable: it is outside a git repository or excluded by aiEffortTracker.review.exclude.');
    }
    return ev;
  }

  /** Selected line ranges; an empty selection means the change block (or issue) under the cursor. */
  private rangesFromEditor(editor: vscode.TextEditor, ev: DocEval): [number, number][] {
    return editor.selections.map(sel => {
      if (sel.isEmpty) {
        const l = sel.active.line;
        const block = ev.review.todoBlocks.find(b => b.start <= l && l <= b.end);
        if (block) return [block.start, block.end] as [number, number];
        const issue = ev.review.issues.find(i => i.indices.includes(l));
        if (issue) return [Math.min(...issue.indices), Math.max(...issue.indices)] as [number, number];
        return [l, l] as [number, number];
      }
      const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
      return [sel.start.line, end] as [number, number];
    });
  }

  private async markCommand(status: R.MarkStatus, uri?: vscode.Uri | string, start?: number, end?: number) {
    const doc = await this.docFor(uri);
    if (!doc) throw new Error('Open a file first.');
    const ev = await this.ensureEval(doc);
    let ranges: [number, number][];
    if (typeof start === 'number') ranges = [[start, typeof end === 'number' ? end : start]];
    else {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== doc) throw new Error('Select the lines to mark.');
      ranges = this.rangesFromEditor(editor, ev);
    }
    const lines = R.splitLines(doc.getText());
    const idx = new Set<number>();
    for (const [s, e] of ranges) for (let i = Math.max(0, s); i <= Math.min(e, lines.length - 1); i++) idx.add(i);
    let note: string | undefined;
    if (status === 'issue') {
      note = await vscode.window.showInputBox({
        title: `Flag ${plural(idx.size, 'line')} as a review issue`,
        prompt: 'What needs to be fixed? (optional, shown on hover, in the Review view and to AI via MCP)',
        placeHolder: 'e.g. missing permission check, rounding looks wrong'
      });
      if (note === undefined) return;
    }
    const keys = R.keysForLines(lines, idx);
    if (!keys.length) { void vscode.window.setStatusBarMessage('AI Effort Tracker: only blank lines selected', 2500); return; }
    const where = status === 'issue' ? { branch: ev.ctx.branch, line: Math.min(...idx) + 1 } : undefined;
    this.writeMarks(ev.ctx, ev.rel, marks => R.applyMark(marks, keys, status, Date.now(), randomUUID(), note, where));
    await this.afterMark(doc);
    const verb = status === 'ok' ? 'reviewed' : status === 'issue' ? 'flagged' : 'cleared';
    void vscode.window.setStatusBarMessage(`AI Effort Tracker: ${plural(keys.length, 'line')} ${verb}`, 2500);
  }

  private writeMarks(ctx: RepoCtx, rel: string, change: (marks: R.ReviewMark[]) => R.ReviewMark[]): R.ReviewMark[] {
    let before: R.ReviewMark[] = [];
    this.store.updateRepo(ctx.repoId, repo => {
      before = repo.files[rel] ?? [];
      const next = change(before);
      const files = { ...repo.files };
      if (next.length) files[rel] = next; else delete files[rel];
      return R.withRoot({ ...repo, files }, ctx.root);
    });
    return before;
  }

  private async afterMark(doc?: vscode.TextDocument) {
    this.storeStamp = this.stamp();
    if (doc) await this.evaluate(doc);
    for (const e of vscode.window.visibleTextEditors) if (e.document !== doc) this.queueDoc(e.document, 10);
    this.scheduleCoverage(300);
  }

  private async markFile(uri?: vscode.Uri) {
    const doc = await this.docFor(uri);
    if (!doc) throw new Error('Open a file first.');
    const ev = await this.ensureEval(doc);
    const idx = ev.review.status.flatMap((s, i) => s === 'todo' ? [i] : []);
    if (!idx.length) { void vscode.window.showInformationMessage('Nothing left to review in this file.'); return; }
    const keys = R.keysForLines(R.splitLines(doc.getText()), idx);
    const before = this.writeMarks(ev.ctx, ev.rel, marks => R.applyMark(marks, keys, 'ok', Date.now(), randomUUID()));
    await this.afterMark(doc);
    const pick = await vscode.window.showInformationMessage(`Marked ${plural(keys.length, 'line')} in ${path.basename(ev.rel)} as reviewed.`, 'Undo');
    if (pick === 'Undo') {
      this.writeMarks(ev.ctx, ev.rel, () => before);
      await this.afterMark(doc);
    }
  }

  private async issueActions(uri: vscode.Uri, line: number) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ev = await this.ensureEval(doc);
    const issue = ev.review.issues.find(i => i.indices.includes(line)) ?? ev.review.issues.find(i => i.line === line);
    if (!issue) throw new Error('This issue no longer exists (the lines were changed).');
    const items = [
      { label: '$(sparkle) Ask Copilot to fix it', id: 'fix' },
      { label: '$(check) Resolved — mark reviewed', id: 'ok' },
      { label: '$(verified) Fixed — verify later', id: 'fixed', description: 'moves it to "Fixed — to verify"' },
      { label: '$(edit) Edit note', id: 'edit' },
      { label: '$(close) Remove flag (back to unreviewed)', id: 'clear' },
      { label: '$(copy) Copy note', id: 'copy' }
    ];
    const pick = await vscode.window.showQuickPick(items, { title: issue.note || 'Review issue', placeHolder: `${plural(issue.lines, 'line')} flagged ${new Date(issue.at).toLocaleString()}` });
    if (!pick) return;
    if (pick.id === 'copy') { await vscode.env.clipboard.writeText(`${ev.rel}:${issue.line + 1} ${issue.note}`); return; }
    if (pick.id === 'fix') {
      await this.fixWithCopilot({ path: ev.rel, line: issue.line + 1, lines: issue.lines, note: issue.note, at: issue.at, markId: issue.markId }, ev.ctx.branch);
      return;
    }
    if (pick.id === 'fixed') {
      this.writeMarks(ev.ctx, ev.rel, marks => R.setIssueFix(marks, issue.markId, { at: Date.now(), by: 'user' }) ?? marks);
      await this.afterMark(doc);
      return;
    }
    const keys = R.keysForLines(R.splitLines(doc.getText()), issue.indices);
    let note: string | undefined;
    if (pick.id === 'edit') {
      note = await vscode.window.showInputBox({ title: 'Edit review issue', value: issue.note });
      if (note === undefined) return;
    }
    const status: R.MarkStatus = pick.id === 'edit' ? 'issue' : pick.id as R.MarkStatus;
    this.writeMarks(ev.ctx, ev.rel, marks => R.applyMark(marks, keys, status, Date.now(), randomUUID(), note,
      status === 'issue' ? { branch: ev.ctx.branch, line: issue.line + 1 } : undefined));
    await this.afterMark(doc);
  }

  /** Open a new chat with a prompt to fix one issue or all open issues of the current branch. */
  private async fixWithCopilot(issue?: R.OpenIssue, branch?: string) {
    const snap = issue ? this.snapshot : this.snapshot ?? await this.computeCoverage();
    const all = issue ? [issue] : snap?.cov.issues ?? [];
    if (!all.length) { void vscode.window.showInformationMessage('No open review issues on this branch.'); return; }
    const root = snap?.ctx.root ?? this.currentRoot;
    const withCode = await Promise.all(all.slice(0, 25).map(async (i, n) => {
      if (n >= 10 || !root) return i;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, i.path)));
        const ev = await this.evaluate(doc);
        const hit = ev?.review.issues.find(x => (i.markId && x.markId === i.markId) || (x.at === i.at && x.note === i.note));
        if (!hit) return i;
        return { ...i, line: hit.line + 1, code: R.issueExcerpt(R.splitLines(doc.getText()), hit.indices, 2, 40) };
      } catch { return i; }
    }));
    const prompt = R.fixIssuesPrompt(branch ?? snap?.ctx.branch ?? null, withCode, all.length);
    await vscode.env.clipboard.writeText(prompt);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true });
      void vscode.window.setStatusBarMessage('AI Effort Tracker: fix prompt is ready in a new chat (also on the clipboard). Pick Agent mode and send it.', 6000);
    } catch {
      void vscode.window.showInformationMessage('AI Effort Tracker: fix prompt copied to the clipboard – paste it into a chat.');
    }
  }

  private async openAt(file: string, line?: number, end?: number) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    let target = line;
    if (target === undefined) {
      const ev = await this.evaluate(doc);
      target = ev?.review.todoBlocks[0]?.start ?? ev?.review.issues[0]?.line ?? 0;
    }
    const first = Math.min(target, doc.lineCount - 1);
    const pos = new vscode.Position(first, 0);
    if (typeof end === 'number' && end > first) {
      const last = doc.lineAt(Math.min(end, doc.lineCount - 1));
      editor.selection = new vscode.Selection(last.range.end, pos);
      editor.revealRange(new vscode.Range(pos, last.range.end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Current review state of a file (open editor text or disk), for bulk actions from the view. */
  private async evalFile(ctx: RepoCtx, rel: string): Promise<{ lines: string[]; review: R.FileReview } | undefined> {
    const abs = path.join(ctx.root, rel);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && same(d.uri.fsPath, abs));
    let text = doc?.getText();
    if (text === undefined) {
      try { const buf = fs.readFileSync(abs); if (buf.includes(0)) return undefined; text = buf.toString('utf8'); } catch { return undefined; }
    }
    const lines = R.splitLines(text);
    const changed = await this.changedFor(ctx, rel, lines, !!doc?.isDirty);
    return { lines, review: R.evaluateFile(lines, changed, this.marksFor(ctx.repoId, rel)) };
  }

  /** Inline actions of the Review view: mark a range / file / group reviewed, or remove its review marks. */
  private async treeAction(node: Node | undefined, status: 'ok' | 'clear'): Promise<boolean> {
    if (!node || (node.kind !== 'block' && node.kind !== 'file' && node.kind !== 'group')) return false;
    const snap = this.snapshot;
    if (!snap) return false;
    const rows = node.kind === 'group' ? collectRows(node.group) : [node.row];
    const ctx = await this.ctx(rows[0]?.root ?? snap.ctx.root);
    if (!ctx) throw new Error('Could not read the git repository.');
    const want: R.LineStatus = status === 'ok' ? 'todo' : 'ok';
    const lineCount = node.kind === 'block' ? node.block.lines : rows.reduce((s, r) => s + (status === 'ok' ? r.total - r.reviewed : r.reviewed), 0);
    if (node.kind !== 'block' && (rows.length > 1 || status === 'clear')) {
      const what = rows.length === 1 ? path.posix.basename(rows[0].path) : plural(rows.length, 'file');
      const verb = status === 'ok' ? `Mark ${plural(lineCount, 'line')} in ${what} as reviewed?` : `Remove the review marks from ${plural(lineCount, 'line')} in ${what}?`;
      const go = await vscode.window.showWarningMessage(verb, { modal: true, detail: status === 'clear' ? 'The lines go back to "to review". Flagged issues stay.' : undefined }, status === 'ok' ? 'Mark Reviewed' : 'Remove Marks');
      if (!go) return false;
    }
    const plan: { rel: string; keys: string[] }[] = [];
    for (const row of rows) {
      const ev = await this.evalFile(ctx, row.path);
      if (!ev) continue;
      let idx = ev.review.status.flatMap((s, i) => s === want ? [i] : []);
      if (node.kind === 'block') idx = idx.filter(i => i >= node.block.start && i <= node.block.end);
      const keys = R.keysForLines(ev.lines, idx);
      if (keys.length) plan.push({ rel: row.path, keys });
    }
    if (!plan.length) { this.scheduleCoverage(50); throw new Error('Those lines changed in the meantime. The view is refreshed; try again.'); }
    const before = new Map<string, R.ReviewMark[] | undefined>();
    const now = Date.now();
    this.store.updateRepo(ctx.repoId, repo => {
      const files = { ...repo.files };
      for (const p of plan) {
        before.set(p.rel, files[p.rel]);
        const next = R.applyMark(files[p.rel] ?? [], p.keys, status, now, randomUUID());
        if (next.length) files[p.rel] = next; else delete files[p.rel];
      }
      return R.withRoot({ ...repo, files }, ctx.root);
    });
    await this.afterMark();
    const n = plan.reduce((s, p) => s + p.keys.length, 0);
    const msg = `${status === 'ok' ? 'Marked' : 'Removed review marks from'} ${plural(n, 'line')}${plan.length > 1 ? ` in ${plural(plan.length, 'file')}` : ` in ${path.posix.basename(plan[0].rel)}`}${status === 'ok' ? ' as reviewed' : ''}.`;
    if (node.kind === 'block') { void vscode.window.setStatusBarMessage(`AI Effort Tracker: ${msg}`, 3000); return true; }
    void vscode.window.showInformationMessage(msg, 'Undo').then(async pick => {
      if (pick !== 'Undo') return;
      this.store.updateRepo(ctx.repoId, repo => {
        const files = { ...repo.files };
        for (const [rel, marks] of before) if (marks?.length) files[rel] = marks; else delete files[rel];
        return { ...repo, files };
      });
      await this.afterMark();
    });
    return true;
  }

  /** Checkbox in the Review view: check = mark reviewed, uncheck = remove the review marks. */
  private async onCheckbox(e: vscode.TreeCheckboxChangeEvent<Node>) {
    const [node, state] = e.items[0] ?? [];
    if (!node || (node.kind !== 'block' && node.kind !== 'file' && node.kind !== 'group')) return;
    const want = state === vscode.TreeItemCheckboxState.Checked ? 'ok' : 'clear';
    if ((want === 'ok') !== (node.section === 'open')) return;
    let done = false;
    try { done = await this.treeAction(node, want); } catch (error) {
      void vscode.window.showErrorMessage(`AI Effort Tracker: ${(error as Error).message}`);
    }
    if (!done) this.treeEmitter.fire();
  }

  /** Fixed / changed issues: accept the fix (drop the flag), open it again, or report an open issue fixed. */
  private async resolvedAction(target: Node | vscode.Uri | undefined, action: 'accept' | 'reopen' | 'fixed', id?: string) {
    let repoId: string, rel: string, markId: string | undefined;
    if (target instanceof vscode.Uri) {
      const ev = await this.ensureEval(await vscode.workspace.openTextDocument(target));
      repoId = ev.ctx.repoId; rel = ev.rel; markId = id;
    } else {
      const snap = this.snapshot;
      if (!snap || !target || (target.kind !== 'resolved' && target.kind !== 'issue')) return;
      repoId = snap.ctx.repoId; rel = target.issue.path; markId = target.issue.markId;
    }
    if (!markId) throw new Error('This issue was flagged by an older version; use its CodeLens in the editor instead.');
    const mid = markId;
    const change = (marks: R.ReviewMark[]) => action === 'accept' ? R.dropMark(marks, mid)
      : R.setIssueFix(marks, mid, action === 'fixed' ? { at: Date.now(), by: 'user' } : null);
    let before: R.ReviewMark[] | undefined;
    let missing = false;
    this.store.updateRepo(repoId, repo => {
      before = repo.files[rel];
      const next = change(before ?? []);
      if (!next) { missing = true; return repo; }
      const files = { ...repo.files };
      if (next.length) files[rel] = next; else delete files[rel];
      return { ...repo, files };
    });
    await this.afterMark();
    if (missing) throw new Error('This issue no longer exists. The view is refreshed.');
    const msg = action === 'accept' ? 'Fix accepted, the flag is removed.' : action === 'reopen' ? 'The issue is open again.' : 'Moved to "Fixed — to verify".';
    if (action !== 'accept') { void vscode.window.setStatusBarMessage(`AI Effort Tracker: ${msg}`, 3000); return; }
    void vscode.window.showInformationMessage(msg, 'Undo').then(async pick => {
      if (pick !== 'Undo') return;
      this.store.updateRepo(repoId, repo => {
        const files = { ...repo.files };
        if (before?.length) files[rel] = before; else delete files[rel];
        return { ...repo, files };
      });
      await this.afterMark();
    });
  }

  private async nextUnreviewed() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const ev = await this.evaluate(editor.document);
      const cur = editor.selection.active.line;
      const next = ev?.review.todoBlocks.find(b => b.start > cur) ?? undefined;
      if (next) return this.openAt(editor.document.uri.fsPath, next.start);
    }
    const snap = this.snapshot ?? await this.computeCoverage();
    const rows = (snap?.rows ?? []).filter(r => r.total > r.reviewed && r.firstTodo !== undefined);
    if (!rows.length) {
      void vscode.window.showInformationMessage(snap && snap.cov.total ? 'Everything on this branch is reviewed. 🎉' : 'No changed lines to review on this branch.');
      return;
    }
    const currentFile = editor?.document.uri.fsPath;
    const idx = currentFile ? rows.findIndex(r => same(path.join(r.root, r.path), currentFile)) : -1;
    const row = rows[(idx + 1) % rows.length];
    const ev = editor && idx >= 0 && rows.length === 1 ? this.evals.get(editor.document.uri.toString()) : undefined;
    await this.openAt(path.join(row.root, row.path), ev?.review.todoBlocks[0]?.start);
  }

  private async setBaseline() {
    const root = this.currentRoot ?? await this.defaultRoot();
    if (!root) throw new Error('No git repository open.');
    const ctx = await this.ctx(root, true);
    if (!ctx) throw new Error('Could not read the git repository.');
    const commits = await G.recentCommits(root, 40);
    type Item = vscode.QuickPickItem & { ref?: string };
    const items: Item[] = [
      { label: '$(git-merge) Automatic', description: 'merge-base with the default branch (recommended on feature branches)', ref: '' },
      { label: '$(edit) Enter a branch, tag or commit…', ref: '?' },
      ...commits.map(([sha, text]) => ({ label: text, description: sha.slice(0, 7), ref: sha }))
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Review baseline for ${ctx.branch}`,
      placeHolder: `Current: ${ctx.baseLabel}. Lines changed after the baseline need review. Pick the last commit you already reviewed.`
    });
    if (!pick) return;
    let ref = pick.ref ?? '';
    if (ref === '?') {
      ref = (await vscode.window.showInputBox({ prompt: 'Branch, tag or commit to review against', placeHolder: 'e.g. origin/main, v1.2.0, a1b2c3d' }))?.trim() ?? '';
      if (!ref) return;
    }
    const map = { ...(this.context.workspaceState.get<Record<string, string>>(BASE_KEY) ?? {}) };
    if (ref) map[`${root}|${ctx.branch}`] = ref; else delete map[`${root}|${ctx.branch}`];
    await this.context.workspaceState.update(BASE_KEY, map);
    this.invalidateCtx();
    this.refreshAll();
  }

  // ---------------------------------------------------------------- branch coverage

  private async defaultRoot(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.uri.scheme === 'file') {
      const r = await this.rootFor(active.uri.fsPath);
      if (r) return r;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ws ? G.gitRoot(ws) : undefined;
  }

  private scheduleCoverage(delay: number) {
    if (this.disposed) return;
    clearTimeout(this.coverageTimer);
    this.coverageTimer = setTimeout(() => void this.computeCoverage(), delay);
  }

  private stamp(): string {
    try { const st = fs.statSync(this.store.file); return `${st.mtimeMs}|${st.size}`; } catch { return 'missing'; }
  }

  /** Detect branch switches, commits and marks made in other windows. */
  private async poll() {
    if (this.disposed || !this.enabled()) return;
    const stamp = this.stamp();
    const marksChanged = stamp !== this.storeStamp;
    this.storeStamp = stamp;
    const root = this.currentRoot ?? await this.defaultRoot();
    let headChanged = false;
    if (root) {
      const head = (await G.git(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], root))?.trim().split(/\r?\n/) ?? [];
      const known = this.ctxs.get(root);
      headChanged = !!known && (known.branch !== (head[1] ?? 'HEAD') || known.head !== (head[0] ?? ''));
    }
    if (headChanged) this.invalidateCtx();
    if (headChanged || marksChanged) this.refreshAll();
    else if (!this.snapshot || Date.now() - this.snapshot.cov.at > 5 * 60_000) this.scheduleCoverage(100);
  }

  private async computeCoverage(): Promise<Snapshot | undefined> {
    if (this.coverageRunning) { this.coverageAgain = true; return this.snapshot; }
    this.coverageRunning = true;
    try {
      if (!this.enabled()) { this.snapshot = undefined; this.render(); return undefined; }
      const root = this.currentRoot ?? await this.defaultRoot();
      if (!root) { this.snapshot = undefined; this.render(); return undefined; }
      this.currentRoot = root;
      const ctx = await this.ctx(root);
      if (!ctx) return this.snapshot;
      let repo: R.RepoReview;
      try { repo = this.store.repo(ctx.repoId); } catch { repo = R.emptyRepoReview(); }
      const files = new Set([...ctx.changed.keys()].filter(r => !this.exclude(r)));
      for (const [rel, marks] of Object.entries(repo.files)) if (!this.exclude(rel) && marks.some(m => m.status === 'issue')) files.add(rel);
      const open = new Map<string, vscode.TextDocument>();
      for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === 'file') open.set(process.platform === 'win32' ? d.uri.fsPath.toLowerCase() : d.uri.fsPath, d);
      const rows: FileRow[] = [];
      const issues: R.OpenIssue[] = [];
      const resolved: R.ResolvedIssue[] = [];
      const gone = (rel: string) => { const marks = repo.files[rel]; if (marks) resolved.push(...R.resolvedIssuesOf(rel, marks, null, ctx.branch, ctx.changed.has(rel))); };
      let n = 0;
      for (const rel of [...files].sort()) {
        if (this.disposed) return undefined;
        if (++n > MAX_FILES) break;
        if (n % 40 === 0) await new Promise(r => setImmediate(r));
        const abs = path.join(root, rel);
        const doc = open.get(process.platform === 'win32' ? abs.toLowerCase() : abs);
        let text: string | undefined = doc?.getText();
        if (text === undefined) {
          try {
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
            const buf = fs.readFileSync(abs);
            if (buf.includes(0)) continue;
            text = buf.toString('utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') gone(rel);
            continue;
          }
        }
        const lines = R.splitLines(text);
        if (lines.length > MAX_DOC_LINES) continue;
        const changed = await this.changedFor(ctx, rel, lines, !!doc?.isDirty);
        const ev = R.evaluateFile(lines, changed, repo.files[rel] ?? []);
        if (repo.files[rel]) resolved.push(...R.resolvedIssuesOf(rel, repo.files[rel], ev, ctx.branch, ctx.changed.has(rel)));
        if (!ev.total && !ev.issues.length) continue;
        const todoB = ev.todoBlocks.slice(0, MAX_BLOCKS), okB = ev.reviewedBlocks.slice(0, MAX_BLOCKS);
        const names = R.blockContexts(lines, [...todoB, ...okB], rel);
        rows.push({
          path: rel, total: ev.total, reviewed: ev.reviewed, issueLines: ev.issueLines, root, firstTodo: ev.todoBlocks[0]?.start,
          todo: todoB.map((b, k) => ({ ...b, context: names[k] })), ok: okB.map((b, k) => ({ ...b, context: names[todoB.length + k] }))
        });
        for (const i of ev.issues) issues.push({ path: rel, line: i.line + 1, lines: i.lines, note: i.note, at: i.at, markId: i.markId });
      }
      const sum = (k: 'total' | 'reviewed' | 'issueLines') => rows.reduce((s, r) => s + r[k], 0);
      const cov: R.BranchCoverage = {
        at: Date.now(), base: ctx.base ?? '', total: sum('total'), reviewed: sum('reviewed'), issueLines: sum('issueLines'),
        files: rows.map(({ path: p, total, reviewed, issueLines }) => ({ path: p, total, reviewed, issueLines })),
        issues: issues.sort((a, b) => b.at - a.at),
        ...(resolved.length ? { resolved: resolved.sort((a, b) => (b.fixedAt ?? b.at) - (a.fixedAt ?? a.at)) } : {})
      };
      this.snapshot = { ctx, cov, rows };
      this.persist(ctx, cov);
      this.render();
      return this.snapshot;
    } finally {
      this.coverageRunning = false;
      if (this.coverageAgain) { this.coverageAgain = false; this.scheduleCoverage(300); }
    }
  }

  private persist(ctx: RepoCtx, cov: R.BranchCoverage) {
    if (ctx.branch === 'HEAD') return;
    const rest: Partial<R.BranchCoverage> = { ...cov };
    delete rest.at;
    const sig = `${ctx.repoId}|${ctx.branch}|${JSON.stringify(rest)}`;
    const prev = (() => { try { return this.store.repo(ctx.repoId).coverage[ctx.branch]; } catch { return undefined; } })();
    const stale = !prev || Date.now() - prev.at > 6 * 3600_000;
    const rootKnown = (() => { try { return (this.store.repo(ctx.repoId).roots ?? []).includes(ctx.root); } catch { return true; } })();
    if (sig === this.lastPersisted && !stale && rootKnown) return;
    if (!cov.total && !cov.issues.length && !cov.resolved?.length && !prev) { this.lastPersisted = sig; return; }
    try {
      this.store.updateRepo(ctx.repoId, repo => R.withRoot(R.withCoverage(repo, ctx.branch, cov), ctx.root));
      this.lastPersisted = sig;
      this.storeStamp = this.stamp();
    } catch (error) {
      console.error('AI Effort Tracker: saving review coverage failed', error);
    }
  }

  /** Saved coverage of several branches combined (work item detail, health check). */
  rollup(branches: readonly string[]): R.ReviewRollup | null {
    try { return R.rollupCoverage(this.store.load(), branches); } catch { return null; }
  }

  // ---------------------------------------------------------------- view + status bar

  private render() {
    this.treeEmitter.fire();
    const snap = this.snapshot;
    const show = this.enabled() && (cfg().get<boolean>('showStatusBar') ?? true) && snap && (snap.cov.total > 0 || snap.cov.issues.length > 0);
    if (!show || !snap) { this.statusItem.hide(); return; }
    const c = snap.cov;
    const pct = Math.floor(R.coveragePct(c.reviewed, c.total));
    const done = c.reviewed >= c.total;
    this.statusItem.text = `${done ? '$(pass)' : '$(checklist)'} Review ${done ? '✓' : pct + '%'}${c.issues.length ? ` $(warning) ${c.issues.length}` : ''}`;
    this.statusItem.tooltip = new vscode.MarkdownString(
      `**Code review — ${escapeMd(snap.ctx.branch)}**\n\n${c.reviewed} of ${c.total} changed lines reviewed (${R.coveragePct(c.reviewed, c.total)} %)` +
      `${c.issues.length ? `, ${plural(c.issues.length, 'open issue')}` : ''}\n\nBaseline: ${escapeMd(snap.ctx.baseLabel)}\n\nClick to open the Review view.`);
    this.statusItem.backgroundColor = c.issues.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusItem.show();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const snap = this.snapshot!;
    switch (node.kind) {
      case 'summary': {
        const c = snap.cov;
        const item = new vscode.TreeItem(`${R.coveragePct(c.reviewed, c.total)} % reviewed`);
        item.description = `${c.reviewed}/${c.total} lines · ${snap.ctx.branch}`;
        item.tooltip = `Changed lines since ${snap.ctx.baseLabel}. ${c.total - c.reviewed} still need a look.`;
        item.iconPath = new vscode.ThemeIcon(c.reviewed >= c.total && !c.issues.length ? 'pass-filled' : 'checklist');
        item.command = { command: 'aiEffortTracker.review.nextUnreviewed', title: 'Next unreviewed change' };
        return item;
      }
      case 'issues': {
        const item = new vscode.TreeItem(`Issues (${snap.cov.issues.length})`, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        item.contextValue = 'aetReviewIssues';
        return item;
      }
      case 'issue': {
        const i = node.issue;
        const item = new vscode.TreeItem(i.note || 'Issue');
        item.description = `${i.path}:${i.line}`;
        item.tooltip = `${i.note || 'Issue'}\n${i.path}:${i.line} · ${plural(i.lines, 'line')} · ${new Date(i.at).toLocaleString()}`;
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground'));
        item.contextValue = 'aetReviewIssue';
        item.command = { command: 'aiEffortTracker.review.openFile', title: 'Open', arguments: [snap.ctx.root, i.path, i.line - 1] };
        return item;
      }
      case 'resolvedGroup': {
        const list = snap.cov.resolved ?? [];
        const item = new vscode.TreeItem(`Fixed — to verify (${list.length})`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'review:resolved';
        item.tooltip = 'Flagged issues that Copilot or you reported fixed, or whose flagged lines were all edited. '
          + 'Check each fix, then accept it (✓) to remove the flag, or reopen it.';
        item.iconPath = new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.blue'));
        item.contextValue = 'aetReviewResolvedGroup';
        return item;
      }
      case 'resolved': {
        const i = node.issue;
        const item = new vscode.TreeItem(i.note || 'Issue');
        item.id = `review:resolved:${i.markId}`;
        const who = i.by === 'ai' ? 'fixed by Copilot' : i.by === 'user' ? 'fixed by you' : 'flagged lines changed';
        item.description = `${who} · ${i.path}:${i.line}`;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**⚑ ${escapeMd(i.note || 'Issue')}**\n\n`);
        md.appendMarkdown(`${escapeMd(i.path)}:${i.line} · flagged ${new Date(i.at).toLocaleString()}\n\n`);
        if (i.by === 'changed') md.appendMarkdown('All flagged lines were edited or removed, so the issue is probably fixed.\n\n');
        else md.appendMarkdown(`$(verified) ${i.by === 'ai' ? 'Copilot' : 'You'} reported it fixed${i.fixedAt ? ' · ' + new Date(i.fixedAt).toLocaleString() : ''}\n\n`);
        if (i.fixNote) md.appendMarkdown(`> ${escapeMd(i.fixNote)}\n\n`);
        md.appendMarkdown(i.lines ? `${plural(i.lines, 'flagged line')} still in the file.` : 'The flagged lines are gone.');
        item.tooltip = md;
        item.iconPath = i.by === 'ai' ? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.purple'))
          : i.by === 'user' ? new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.blue'))
            : new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('charts.yellow'));
        item.contextValue = `aetReviewResolved-${i.by === 'changed' ? 'changed' : 'fixed'}`;
        item.command = { command: 'aiEffortTracker.review.openFile', title: 'Open', arguments: [snap.ctx.root, i.path, Math.max(0, i.line - 1)] };
        return item;
      }
      case 'section': {
        const open = node.section === 'open';
        const rows = open ? this.openRows(snap) : this.doneRows(snap);
        const lines = open ? snap.cov.total - snap.cov.reviewed : snap.cov.reviewed;
        const item = new vscode.TreeItem(open ? 'To review' : 'Reviewed', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `review:section:${node.section}`;
        item.description = `${plural(lines, 'line')} · ${plural(rows.length, 'file')}`;
        item.tooltip = open ? 'Changed lines nobody has marked as reviewed yet. Expand a file to see its unreviewed blocks.'
          : 'Everything marked as reviewed on this branch. Expand a file to see which lines, click to jump there.';
        item.iconPath = open ? new vscode.ThemeIcon('circle-large-outline') : new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        item.contextValue = `aetReviewSection-${node.section}`;
        return item;
      }
      case 'file': {
        const r = node.row;
        const open = node.section === 'open';
        const blocks = open ? r.todo : r.ok;
        const item = new vscode.TreeItem(path.posix.basename(r.path), blocks.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `review:file:${node.section}:${r.path}`;
        const dir = path.posix.dirname(r.path);
        const done = r.reviewed >= r.total;
        const counts = open ? `${r.reviewed}/${r.total}` : `${plural(r.reviewed, 'line')}${done ? '' : ` of ${r.total}`}`;
        item.description = `${node.showDir && dir !== '.' ? dir + ' · ' : ''}${counts}${r.issueLines ? ' · ⚑' : ''}`;
        item.tooltip = `${r.path}\n${r.reviewed} of ${r.total} changed lines reviewed (${R.coveragePct(r.reviewed, r.total)} %)${r.issueLines ? `\n${plural(r.issueLines, 'flagged line')}` : ''}`
          + `\n${open ? 'Expand for the blocks still to review.' : 'Expand for the reviewed blocks.'} Click to open.`;
        item.resourceUri = vscode.Uri.file(path.join(r.root, r.path));
        // Expandable rows with a resourceUri get the folder icon unless told they are files.
        item.iconPath = vscode.ThemeIcon.File;
        item.checkboxState = checkbox(open, open ? `Mark the ${plural(r.total - r.reviewed, 'line')} left as reviewed` : 'Remove the review marks of this file');
        item.contextValue = `aetReviewFile-${node.section}`;
        const first = blocks[0];
        item.command = open || !first
          ? { command: 'aiEffortTracker.review.openFile', title: 'Open', arguments: [r.root, r.path, done ? undefined : r.firstTodo] }
          : { command: 'aiEffortTracker.review.openRange', title: 'Open', arguments: [r.root, r.path, first.start, first.end] };
        return item;
      }
      case 'block': {
        const { row, block: b } = node;
        const open = node.section === 'open';
        const range = b.start === b.end ? `line ${b.start + 1}` : `lines ${b.start + 1}–${b.end + 1}`;
        const item = new vscode.TreeItem(b.context || range);
        item.id = `review:block:${node.section}:${row.path}:${b.start}`;
        item.description = `${b.context ? range + ' · ' : ''}${plural(b.lines, 'line')}`;
        item.tooltip = `${row.path}, ${range}\n${plural(b.lines, 'line')} ${open ? 'to review' : `reviewed${b.at ? ' · ' + new Date(b.at).toLocaleString() : ''}`}\nClick to select the lines in the editor.`;
        item.checkboxState = checkbox(open, open ? 'Mark these lines as reviewed' : 'Remove the review marks of these lines');
        item.contextValue = `aetReviewBlock-${node.section}`;
        item.command = { command: 'aiEffortTracker.review.openRange', title: 'Open', arguments: [row.root, row.path, b.start, b.end] };
        return item;
      }
      case 'group': {
        const g = node.group;
        const done = g.reviewed >= g.total && !g.issueLines;
        const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `review:${g.id}`;
        const counts = node.section === 'open' ? `${g.reviewed}/${g.total}${g.issueLines ? ' · ⚑' : ''}` : plural(g.reviewed, 'line');
        item.description = g.type === 'category' && g.commonPath ? `${counts} · ${g.commonPath}` : counts;
        item.tooltip = `${g.type === 'folder' ? g.key : g.label.replace(/^\P{L}+/u, '')}${g.commonPath ? `\n${g.commonPath}` : ''}\n${plural(g.files, 'file')}, ${g.reviewed} of ${g.total} changed lines reviewed (${R.coveragePct(g.reviewed, g.total)} %)${g.issueLines ? `\n${plural(g.issueLines, 'flagged line')}` : ''}`;
        if (g.type === 'folder') {
          item.resourceUri = vscode.Uri.file(path.join(snap.ctx.root, g.key));
          item.iconPath = vscode.ThemeIcon.Folder;
        } else item.iconPath = new vscode.ThemeIcon(done ? 'pass' : 'symbol-folder', done ? new vscode.ThemeColor('testing.iconPassed') : undefined);
        const open = node.section === 'open';
        item.checkboxState = checkbox(open, open ? `Mark everything in ${plural(g.files, 'file')} as reviewed` : `Remove the review marks of ${plural(g.files, 'file')}`);
        item.contextValue = `aetReviewGroup-${node.section}`;
        return item;
      }
    }
  }

  private openRows(snap: Snapshot): FileRow[] {
    return snap.rows.filter(r => r.total > r.reviewed || (r.issueLines && !r.total))
      .sort((a, b) => (b.total - b.reviewed) - (a.total - a.reviewed) || a.path.localeCompare(b.path));
  }

  private doneRows(snap: Snapshot): FileRow[] {
    return snap.rows.filter(r => r.reviewed > 0).sort((a, b) => a.path.localeCompare(b.path));
  }

  getChildren(node?: Node): Node[] {
    const snap = this.snapshot;
    if (!snap || (!snap.cov.total && !snap.cov.issues.length && !snap.cov.resolved?.length)) return [];
    if (!node) {
      const out: Node[] = [{ kind: 'summary' }];
      if (snap.cov.issues.length) out.push({ kind: 'issues' });
      if (snap.cov.resolved?.length) out.push({ kind: 'resolvedGroup' });
      if (this.openRows(snap).length) out.push({ kind: 'section', section: 'open' });
      if (this.doneRows(snap).length) out.push({ kind: 'section', section: 'done' });
      return out;
    }
    if (node.kind === 'issues') return [...snap.cov.issues].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).map(issue => ({ kind: 'issue', issue }));
    if (node.kind === 'resolvedGroup') return (snap.cov.resolved ?? []).map(issue => ({ kind: 'resolved', issue }));
    if (node.kind === 'section') return this.fileNodes(node.section === 'open' ? this.openRows(snap) : this.doneRows(snap), node.section);
    if (node.kind === 'group') return node.group.children.map(n => this.toNode(n, node.section));
    if (node.kind === 'file') return (node.section === 'open' ? node.row.todo : node.row.ok).map(block => ({ kind: 'block', row: node.row, block, section: node.section }));
    return [];
  }

  private groupBy(): T.ReviewGroupBy {
    const v = cfg().get<string>('groupBy');
    return v === 'folder' || v === 'none' ? v : 'category';
  }

  /** Files of one section (open / fully reviewed), grouped as configured. */
  private fileNodes(rows: FileRow[], section: Section): Node[] {
    const groupBy = this.groupBy();
    if (groupBy === 'none') return rows.map(row => ({ kind: 'file', row, section, showDir: true }));
    const rules = readUserRules();
    const tree = T.buildReviewTree(rows, groupBy, p => categorizeWith(p, rules), c => CATEGORY_LABELS[c as FileCategory] ?? c, ALL_CATEGORIES, section);
    return tree.map(n => this.toNode(n, section));
  }

  private toNode(n: T.ReviewTreeNode<FileRow>, section: Section): Node {
    return n.kind === 'file' ? { kind: 'file', row: n.row, section } : { kind: 'group', group: n, section };
  }

  private async chooseGrouping() {
    const cur = this.groupBy();
    const items: (vscode.QuickPickItem & { value: T.ReviewGroupBy })[] = [
      { label: '$(symbol-folder) Category, then folder', description: 'Programming, Specification, Documentation, …', value: 'category' },
      { label: '$(list-tree) Folder', description: 'like the Explorer', value: 'folder' },
      { label: '$(list-flat) Flat list', description: 'most lines left first', value: 'none' }
    ];
    for (const i of items) if (i.value === cur) i.description = `${i.description} · current`;
    const pick = await vscode.window.showQuickPick(items, { title: 'Group review files by' });
    if (pick && pick.value !== cur) await cfg().update('groupBy', pick.value, vscode.ConfigurationTarget.Global);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.tick);
    clearTimeout(this.coverageTimer);
    clearTimeout(this.watchTimer);
    for (const t of this.docTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

/** Checkbox of a Review view row: open rows are unchecked (check = mark reviewed), reviewed rows checked (uncheck = remove marks). */
function checkbox(open: boolean, tooltip: string): vscode.TreeItemCheckboxState | { state: vscode.TreeItemCheckboxState; tooltip: string } {
  return { state: open ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked, tooltip };
}

function collectRows(g: T.ReviewTreeGroup<FileRow>): FileRow[] {
  return g.children.flatMap(c => c.kind === 'file' ? [c.row] : collectRows(c));
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
