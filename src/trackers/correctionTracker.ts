import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Database } from '../store/database';
import { CorrectionStore } from '../store/correctionStore';
import { getFileExt } from '../util/fileTypes';
import { DEFAULT_REVIEW_EXCLUDE, excludeMatcher } from '../analysis/review';
import {
  addedLineHashes, addOwnership, deltaIsEmpty, detectCorrections, emptyCorrectionDelta, linkPrompts, realWorkItemId,
  type Correction, type CorrectionDelta, type CorrectionSource, type UserMessage
} from '../analysis/corrections';
import type { CodeEdit } from './copilotTracker';
import type { DebugUserMessage } from '../util/debugLog';

/** An edit burst ends after this much quiet time. */
const QUIET_MS = 10_000;
/** A burst longer than this is closed when the next edit arrives. */
const MAX_WINDOW_MS = 5 * 60_000;
/** Human corrections wait this long for their prompts before being saved. */
const HUMAN_HOLD_MS = 30_000;
/** AI rework without a prompt in between is the AI fixing itself, not a correction. */
const AI_HOLD_MS = 180_000;
const RELINK_MS = 15_000;
const SAVE_DEBOUNCE_MS = 5000;
const MESSAGE_TTL_MS = 48 * 3_600_000;
const MAX_MESSAGES = 2000;
/** Saved corrections without a known origin prompt are re-linked this long. */
const PATCH_WINDOW_MS = 10 * 60_000;

interface EditWindow {
  key: string;
  repo: string;
  path: string;
  ext: string;
  branch: string;
  snapshot: string[];
  last: string[];
  start: number;
  lastEdit: number;
  human: boolean;
  timer?: NodeJS.Timeout;
}

interface Held { c: Correction; dueAt: number }

const cfg = () => vscode.workspace.getConfiguration('aiEffortTracker');

/**
 * Captures corrections of AI-written code (#131): remembers the lines AI edits
 * add, groups later edits of a file into bursts and records each burst's
 * changes to AI-owned code with the prompts behind them.
 */
export class CorrectionTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private owned = new Map<string, Record<string, number>>();
  private windows = new Map<string, EditWindow>();
  private held: Held[] = [];
  private recent: Correction[] = [];
  private messages = new Map<string, UserMessage>();
  private delta: CorrectionDelta = emptyCorrectionDelta();
  private saveTimer?: NodeJS.Timeout;
  private relinkTimer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private exclude = excludeMatcher(DEFAULT_REVIEW_EXCLUDE);
  private disposed = false;

  constructor(
    private db: Database,
    private store: CorrectionStore,
    private promptsAvailable: () => boolean
  ) {
    this.readConfig();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiEffortTracker.review.exclude')) this.readConfig();
      }),
      vscode.workspace.onDidSaveTextDocument(doc => this.finalize(this.keyOf(doc.uri))),
      vscode.workspace.onDidCloseTextDocument(doc => this.finalize(this.keyOf(doc.uri)))
    );
    this.relinkTimer = setInterval(() => this.relink(), RELINK_MS);
  }

  static enabled(): boolean { return cfg().get<boolean>('corrections.enabled') ?? true; }
  private captureCode(): boolean { return cfg().get<boolean>('corrections.captureCode') ?? true; }

  private readConfig() {
    const globs = cfg().get<string[]>('review.exclude');
    this.exclude = excludeMatcher(Array.isArray(globs) ? globs : DEFAULT_REVIEW_EXCLUDE);
  }

  private keyOf(uri: vscode.Uri): string {
    return process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
  }

  /** Called by CopilotTracker for every classified file edit. */
  onEdit(edit: CodeEdit): void {
    if (this.disposed || !CorrectionTracker.enabled()) return;
    const doc = edit.event.document;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    if (this.exclude(rel)) return;
    const t = Date.now();
    const meta = {
      key: this.keyOf(doc.uri), repo: folder.name, path: rel, ext: getFileExt(doc.fileName), branch: edit.branch
    };
    const reason = edit.event.reason;
    const undoRedo = reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo;
    const change = edit.event.contentChanges.length === 1 ? edit.event.contentChanges[0] : undefined;
    const clipboardCandidate = edit.source === 'ai' && !undoRedo && !!change
      && vscode.window.activeTextEditor?.document === doc;
    // Edits are applied in order; a clipboard check only delays the queue.
    this.queue = this.queue.then(async () => {
      let human = edit.source === 'human' || undoRedo;
      if (clipboardCandidate && change) {
        const clip = await vscode.env.clipboard.readText().then(s => s, () => '');
        if (clip && (sameText(clip, change.text) || sameText(clip, rangeText(edit.before, change.range)))) human = true;
      }
      this.apply(meta, edit.before, edit.after, human, t);
    }).catch(error => console.error('AI Effort Tracker: correction capture failed', error));
  }

  private apply(meta: Pick<EditWindow, 'key' | 'repo' | 'path' | 'ext' | 'branch'>, before: string[], after: string[], human: boolean, t: number) {
    let w = this.windows.get(meta.key);
    if (w && t - w.start > MAX_WINDOW_MS) { this.finalize(meta.key); w = undefined; }
    if (!w) {
      w = { ...meta, snapshot: before, last: after, start: t, lastEdit: t, human };
      this.windows.set(meta.key, w);
    } else {
      w.last = after;
      w.lastEdit = t;
      w.human = w.human || human;
      w.branch = meta.branch;
    }
    if (!human) {
      const hashes = addedLineHashes(before, after);
      if (hashes.length && addOwnership(this.ownedFor(meta.key), hashes, t)) {
        addOwnership(this.delta.owned[meta.key] ??= {}, hashes, t);
        this.scheduleSave();
      }
    }
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => this.finalize(meta.key), QUIET_MS);
  }

  private ownedFor(key: string): Record<string, number> {
    let map = this.owned.get(key);
    if (!map) {
      let stored: Record<string, number> = {};
      try { stored = this.store.load().owned[key]?.h ?? {}; } catch { /* unreadable store: start fresh */ }
      map = { ...stored };
      this.owned.set(key, map);
    }
    return map;
  }

  private finalize(key: string) {
    const w = this.windows.get(key);
    if (!w) return;
    this.windows.delete(key);
    if (w.timer) clearTimeout(w.timer);
    const owned = this.ownedFor(key);
    const source: CorrectionSource = w.human ? 'human' : 'ai';
    const now = Date.now();
    const workItemId = realWorkItemId(this.db.getWorkItemForBranch(w.branch));
    for (const d of detectCorrections(w.snapshot, w.last, owned, w.start, w.path, this.captureCode())) {
      const c: Correction = {
        id: randomUUID(), t: now, start: w.start, source,
        repo: w.repo, path: w.path, ext: w.ext, branch: w.branch,
        ...(workItemId ? { workItemId } : {}),
        ...d
      };
      this.held.push({ c, dueAt: now + (source === 'human' ? HUMAN_HOLD_MS : AI_HOLD_MS) });
    }
    if (this.held.length) this.relink();
  }

  /** Called with the prompts of re-read Copilot debug-log sessions. */
  onUserMessages(msgs: readonly DebugUserMessage[]): void {
    const now = Date.now();
    for (const m of msgs) {
      if (now - m.t > MESSAGE_TTL_MS) continue;
      this.messages.set(`${m.sessionId}|${m.t}`, { t: m.t, sessionId: m.sessionId, text: m.text });
    }
    for (const [k, m] of this.messages) if (now - m.t > MESSAGE_TTL_MS) this.messages.delete(k);
    if (this.messages.size > MAX_MESSAGES) {
      const keep = [...this.messages].sort((a, b) => b[1].t - a[1].t).slice(0, MAX_MESSAGES);
      this.messages = new Map(keep);
    }
    this.relink();
  }

  private relink(final = false) {
    const now = Date.now();
    const msgs = [...this.messages.values()];
    const captureText = this.captureCode();
    const prompts = this.promptsAvailable();
    const keep: Held[] = [];
    for (const h of this.held) {
      const link = linkPrompts(h.c, msgs, captureText);
      if (link.origin) h.c.origin = link.origin;
      if (link.trigger) h.c.trigger = link.trigger;
      if (h.c.source === 'ai') {
        if (h.c.trigger || !prompts) this.commit(h.c);
        else if (!final && now < h.dueAt) keep.push(h);
      } else if (final || now >= h.dueAt) this.commit(h.c);
      else keep.push(h);
    }
    this.held = keep;

    this.recent = this.recent.filter(c => now - c.t <= PATCH_WINDOW_MS && !c.origin);
    for (const c of this.recent) {
      const link = linkPrompts(c, msgs, captureText);
      if (!link.origin) continue;
      c.origin = link.origin;
      (this.delta.patch[c.id] ??= {}).origin = link.origin;
      this.scheduleSave();
    }
  }

  private commit(c: Correction) {
    this.delta.add.push(c);
    if (!c.origin) this.recent.push(c);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.flush(); }, SAVE_DEBOUNCE_MS);
  }

  /** Writes pending changes; keeps them for the next attempt on failure. */
  flush(): void {
    if (deltaIsEmpty(this.delta)) return;
    const pending = this.delta;
    this.delta = emptyCorrectionDelta();
    try {
      this.store.apply(pending);
    } catch (error) {
      console.error('AI Effort Tracker: saving corrections failed', error);
      this.delta = mergeDeltas(pending, this.delta);
      if (!this.disposed) this.scheduleSave();
    }
  }

  dispose(): void {
    for (const key of [...this.windows.keys()]) this.finalize(key);
    this.relink(true);
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.relinkTimer) clearInterval(this.relinkTimer);
    this.flush();
    this.disposables.forEach(d => d.dispose());
  }
}

function mergeDeltas(a: CorrectionDelta, b: CorrectionDelta): CorrectionDelta {
  const out = emptyCorrectionDelta();
  for (const d of [a, b]) {
    for (const [key, h] of Object.entries(d.owned)) {
      const target = out.owned[key] ??= {};
      for (const [hash, t] of Object.entries(h)) target[hash] = Math.min(target[hash] ?? t, t);
    }
    out.add.push(...d.add);
    for (const [id, p] of Object.entries(d.patch)) out.patch[id] = { ...out.patch[id], ...p };
  }
  return out;
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
function sameText(a: string, b: string): boolean {
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

function rangeText(lines: readonly string[], range: vscode.Range): string {
  const { start, end } = range;
  if (start.line === end.line) return (lines[start.line] ?? '').slice(start.character, end.character);
  const out = [(lines[start.line] ?? '').slice(start.character)];
  for (let i = start.line + 1; i < end.line; i++) out.push(lines[i] ?? '');
  out.push((lines[end.line] ?? '').slice(0, end.character));
  return out.join('\n');
}
