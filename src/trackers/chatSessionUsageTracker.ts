import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';
import { estimateCreditsAiu, exactCreditsFromCopilotUsage } from '../util/aiuRates';

/**
 * Auto-captures REAL per-request chat usage (tokens → AIU credits) by tailing VS
 * Code's own chat session storage (issue #59). This complements — and does NOT
 * replace — {@link ChatUsageTracker} (issue #17), which tails the Copilot Chat
 * *extension log* and only sees `model + latency` (no tokens). The two use
 * distinct ledger note namespaces (`auto:jsonl:` here vs `auto:ccreq:` there) so
 * they never collide or double-count.
 *
 * Storage (verified — see issue #59 + comments):
 * `%APPDATA%\Code\User\workspaceStorage\<wsHash>\chatSessions\<sessionId>.jsonl`
 * is an event-sourced patch log, one JSON object per line:
 *   - `kind:0` → base snapshot `{ v: { requests:[...], inputState:{selectedModel}, ... } }`
 *   - `kind:1` → set value at json-pointer path `{ k:[...path], v:... }`
 *   - `kind:2` → array splice/set at path `{ k:[...path], v:... }`
 * Reconstruct = base + patches; dedup requests by `requestId`. Each request
 * carries DURABLE `promptTokens`/`completionTokens` + resolved model, and a
 * TRANSIENT `result.metadata.usage.copilot_usage.total_nano_aiu` (the EXACT AIU
 * cost) that is live-compacted away within seconds.
 *
 * Strategy (owner-approved):
 *  1. PRIMARY (always works): estimate credits from the durable model + tokens
 *     via the per-model AIU rate table ({@link estimateCreditsAiu}).
 *  2. UPGRADE (exact): when a fast poll catches `total_nano_aiu` before
 *     compaction, record the EXACT credits, overriding the estimate for that
 *     requestId in place (never a second ledger row).
 * The GitHub billing import stays the authoritative reconciliation source.
 *
 * Everything is best-effort/defensive: a malformed/partial line, a compacted-away
 * payload, a missing dir, or a permission error is swallowed and never disturbs
 * the extension host. Gated behind `aiEffortTracker.autoCaptureRealCredits`.
 */
export class ChatSessionUsageTracker implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private output: vscode.LogOutputChannel;

  /** Per-file reconstruction state, keyed by absolute jsonl path. */
  private files = new Map<
    string,
    {
      /** Byte offset already consumed. */
      offset: number;
      /** Trailing partial (unterminated) line carried to the next read. */
      pending: string;
      /** Reconstructed session state (base + applied patches). */
      state: SessionState;
      /** True once the file's pre-existing requests have been primed (skipped). */
      primed: boolean;
    }
  >();

  /**
   * requestId → fidelity already recorded THIS session. `'exact'` is terminal
   * (never re-recorded/downgraded); `'estimate'` may be upgraded to `'exact'`.
   * Also holds primed (pre-watch) ids as `'exact'` so they are never emitted.
   */
  private recorded = new Map<string, 'estimate' | 'exact'>();

  constructor(
    private db: Database,
    private timeTracker: TimeTracker,
    /** This workspace's storage uri; its wsHash sibling holds `chatSessions`. */
    private storageUri: vscode.Uri | undefined
  ) {
    this.output = vscode.window.createOutputChannel('AI Effort Tracker — Real Credits', { log: true });
  }

  start(_context: vscode.ExtensionContext): void {
    if (!this.enabled()) {
      this.output.info('Real-credit capture disabled (aiEffortTracker.autoCaptureRealCredits = false).');
      return;
    }
    const seconds = Math.max(3, this.pollSeconds());
    void this.poll();
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
  }

  private enabled(): boolean {
    return (
      vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('autoCaptureRealCredits') ?? true
    );
  }

  private pollSeconds(): number {
    return vscode.workspace.getConfiguration('aiEffortTracker').get<number>('autoCapturePollSeconds') ?? 15;
  }

  private rateOverrides(): Record<string, unknown> | undefined {
    const ov = vscode.workspace.getConfiguration('aiEffortTracker').get<Record<string, unknown>>('aiuRatesOverride');
    return ov && typeof ov === 'object' ? ov : undefined;
  }

  private async poll(): Promise<void> {
    try {
      if (!this.enabled()) return;
      const jsonlFiles = this.findSessionFiles();
      for (const file of jsonlFiles) {
        try {
          await this.consumeFile(file);
        } catch {
          /* one bad file must never stop the others */
        }
      }
      this.trimGuards();
    } catch {
      /* best-effort: never disturb the extension host */
    }
  }

  /** Read new bytes of one jsonl file, apply patches, and emit ready requests. */
  private async consumeFile(file: string): Promise<void> {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // vanished / unreadable
    }

    let entry = this.files.get(file);
    if (!entry) {
      entry = { offset: 0, pending: '', state: { requests: [] }, primed: false };
      this.files.set(file, entry);
    }

    if (size < entry.offset) {
      // Truncated / rotated — restart reconstruction from scratch.
      entry.offset = 0;
      entry.pending = '';
      entry.state = { requests: [] };
      entry.primed = false;
    }
    if (size === entry.offset) return;

    const chunk = await this.readRange(file, entry.offset, size);
    entry.offset = size;

    const combined = entry.pending + chunk;
    const lines = combined.split('\n');
    // The last element is an unterminated partial line — carry it forward.
    entry.pending = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.applyLine(entry.state, trimmed);
    }

    if (!entry.primed) {
      // First time we see this file: skip everything that already existed so we
      // only capture requests that COMPLETE from now on (correct branch
      // attribution), mirroring the #17 "watch from end" semantics.
      for (const req of this.safeRequests(entry.state)) {
        const id = this.requestId(req);
        if (id) this.recorded.set(id, 'exact');
      }
      entry.primed = true;
      return;
    }

    this.emitReady(entry.state);
  }

  /** Apply one reconstructed jsonl line (kind 0/1/2) to `state`. Never throws. */
  private applyLine(state: SessionState, line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // malformed / partial JSON — skip
    }
    if (!obj || typeof obj !== 'object') return;
    const patch = obj as { kind?: unknown; k?: unknown; v?: unknown };
    try {
      if (patch.kind === 0) {
        // Base snapshot: `{ kind:0, v:{ requests:[...], inputState:{...} } }`.
        const v = patch.v;
        if (v && typeof v === 'object') {
          const base = v as SessionState;
          state.requests = Array.isArray(base.requests) ? base.requests : [];
          state.inputState = base.inputState;
        }
        return;
      }
      // kind 1 (set) and kind 2 (array splice/set) both address a json-pointer
      // path; a generic set reconstructs the documented shapes for either.
      if ((patch.kind === 1 || patch.kind === 2) && Array.isArray(patch.k)) {
        setAtPath(state, patch.k as (string | number)[], patch.v);
      }
    } catch {
      /* defensive: an unexpected patch shape must never throw */
    }
  }

  /** Record every request that is now "ready" (has tokens and/or exact usage). */
  private emitReady(state: SessionState): void {
    const branch = this.timeTracker.getBranch();
    const overrides = this.rateOverrides();
    for (const req of this.safeRequests(state)) {
      const id = this.requestId(req);
      if (!id) continue;

      const prior = this.recorded.get(id);
      if (prior === 'exact') continue; // terminal — nothing better to capture

      const model = this.pickModel(req, state);
      const promptTokens = numOrUndef(req.promptTokens);
      const completionTokens = numOrUndef(req.completionTokens);
      const exactCredits = exactCreditsFromCopilotUsage(this.copilotUsage(req));

      if (exactCredits !== null) {
        this.db.recordAutoChatUsage(branch, model, exactCredits, {
          requestId: id,
          promptTokens,
          completionTokens,
          exact: true
        });
        this.recorded.set(id, 'exact');
        this.output.info(
          `Captured EXACT ${exactCredits.toFixed(4)} AIU — ${model} (${promptTokens ?? '?'}/${completionTokens ?? '?'} tok) on ${branch}`
        );
        continue;
      }

      // No exact block: record the deterministic token-rate estimate once. A
      // request with no token counts yet is simply not ready — wait for a later
      // poll (its tokens arrive as a `kind:1` patch when the turn completes).
      if (prior === 'estimate') continue;
      if (promptTokens === undefined && completionTokens === undefined) continue;

      const credits = estimateCreditsAiu(model, promptTokens, completionTokens, overrides);
      this.db.recordAutoChatUsage(branch, model, credits, {
        requestId: id,
        promptTokens,
        completionTokens,
        exact: false
      });
      this.recorded.set(id, 'estimate');
      this.output.info(
        `Captured ~est ${credits.toFixed(4)} AIU — ${model} (${promptTokens ?? '?'}/${completionTokens ?? '?'} tok) on ${branch}`
      );
    }
  }

  // ---- request field extraction (all best-effort against undocumented shape) --

  private safeRequests(state: SessionState): RequestLike[] {
    return Array.isArray(state.requests) ? (state.requests.filter(r => r && typeof r === 'object') as RequestLike[]) : [];
  }

  private requestId(req: RequestLike): string | undefined {
    const id = req.requestId ?? req.id ?? req.responseId;
    return typeof id === 'string' && id ? id : undefined;
  }

  /** Resolve the request's model, falling back to the session's selected model. */
  private pickModel(req: RequestLike, state: SessionState): string {
    const meta = (req.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const candidates: unknown[] = [
      meta?.modelId,
      meta?.model,
      req.modelId,
      (req.model as { id?: unknown; family?: unknown } | undefined)?.id,
      (req.model as { id?: unknown; family?: unknown } | undefined)?.family,
      req.modelFamily,
      (state.inputState?.selectedModel as { id?: unknown; family?: unknown } | undefined)?.family,
      (state.inputState?.selectedModel as { id?: unknown; family?: unknown } | undefined)?.id
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return 'unknown';
  }

  /** Pull the `copilot_usage` block from a request's result metadata, if present. */
  private copilotUsage(req: RequestLike): unknown {
    const meta = (req.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (!meta) return undefined;
    const usage = meta.usage as { copilot_usage?: unknown } | undefined;
    return usage?.copilot_usage ?? (meta as { copilot_usage?: unknown }).copilot_usage;
  }

  // ---- file discovery -------------------------------------------------------

  /**
   * The jsonl files to tail. Prefers THIS workspace's `chatSessions` dir (derived
   * from `storageUri`'s wsHash) for correct attribution; falls back to scanning
   * every VS Code `workspaceStorage` root and taking the most-recently-modified
   * files. Never throws; returns `[]` when nothing is found.
   */
  private findSessionFiles(): string[] {
    const derived = this.derivedChatSessionsDir();
    if (derived && this.isDir(derived)) {
      return this.jsonlIn(derived);
    }
    const files: { file: string; mtime: number }[] = [];
    for (const root of this.workspaceStorageRoots()) {
      for (const wsHash of this.safeDirs(root)) {
        const dir = path.join(root, wsHash, 'chatSessions');
        for (const file of this.jsonlIn(dir)) {
          try {
            files.push({ file, mtime: fs.statSync(file).mtimeMs });
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, 25).map(f => f.file);
  }

  private derivedChatSessionsDir(): string | undefined {
    if (!this.storageUri) return undefined;
    try {
      // storageUri = .../workspaceStorage/<wsHash>/<extensionId>; chatSessions is
      // a sibling of the extension's own storage folder.
      return path.join(path.dirname(this.storageUri.fsPath), 'chatSessions');
    } catch {
      return undefined;
    }
  }

  private workspaceStorageRoots(): string[] {
    const roots: string[] = [];
    const push = (p: string | undefined) => {
      if (p && this.isDir(p)) roots.push(p);
    };
    const appData = process.env.APPDATA;
    if (appData) {
      push(path.join(appData, 'Code', 'User', 'workspaceStorage'));
      push(path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'));
    }
    const home = os.homedir();
    if (home) {
      // macOS
      push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
      push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'));
      // Linux
      push(path.join(home, '.config', 'Code', 'User', 'workspaceStorage'));
      push(path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'));
    }
    return roots;
  }

  private jsonlIn(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.jsonl'))
        .map(d => path.join(dir, d.name));
    } catch {
      return [];
    }
  }

  private isDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private safeDirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  private readRange(file: string, start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = fs.createReadStream(file, { start, end: Math.max(start, end - 1) });
      stream.on('data', d => chunks.push(d as Buffer));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /** Keep the in-memory guard sets bounded so a long session can't grow forever. */
  private trimGuards(): void {
    if (this.recorded.size > 8000) {
      const keep = [...this.recorded.entries()].slice(-4000);
      this.recorded = new Map(keep);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.output.dispose();
  }
}

/** Minimal reconstructed session shape (only the fields we read). */
interface SessionState {
  requests: unknown[];
  inputState?: { selectedModel?: unknown } | undefined;
}

/** A best-effort view of a single reconstructed request object. */
interface RequestLike {
  requestId?: unknown;
  id?: unknown;
  responseId?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  modelId?: unknown;
  modelFamily?: unknown;
  model?: unknown;
  result?: unknown;
}

/** Coerce an unknown to a finite, non-negative number, else `undefined`. */
function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Set `value` at a json-pointer-style `path` inside `root`, creating missing
 * intermediate objects/arrays (an array when the next key is a number). Used for
 * both `kind:1` sets and `kind:2` array set/splice patches. Best-effort: an
 * unusable path is a silent no-op.
 */
function setAtPath(root: SessionState, path: (string | number)[], value: unknown): void {
  if (!Array.isArray(path) || path.length === 0) return;
  let cur: Record<string | number, unknown> = root as unknown as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    const existing = cur[key];
    if (existing === null || existing === undefined || typeof existing !== 'object') {
      cur[key] = typeof nextKey === 'number' ? [] : {};
    }
    cur = cur[key] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
}
