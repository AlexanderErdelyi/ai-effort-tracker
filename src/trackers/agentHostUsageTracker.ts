import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Database } from '../store/database';
import { GitTracker } from './gitTracker';
import { categorize } from '../util/fileTypes';
import { branchAt, type BranchSwitch } from '../util/reflog';
import { branchKey } from '../util/branchKey';
import type { DebugUserMessage } from '../util/debugLog';
import {
  agentSessionRoot, agentTurns, parseAgentEvents, readAgentEvents, readAgentSession,
  sqlite, sqliteUnavailableReason, type AgentHostSession
} from '../util/agentHost';

const MAX_SESSIONS = 200;
/** Missing turns from before this window started are recovered (same window as debug logs). */
const RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

interface Owner {
  /** Folder to run git in (the session's working directory when it exists). */
  cwd: string;
  /** Folder whose repository identity keys the branch (matches the window's keys). */
  repoFolder: string;
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Captures VS Code Agent Host chats (VS Code 1.141+, #172). These run as Copilot
 * CLI sessions and write neither debug logs nor chatSessions files, so the
 * existing sources never see them. Sessions are global; each window records only
 * sessions whose working folder belongs to one of its workspace folders (or the
 * same repository, e.g. an agent worktree). Rows share the debug-usage identity,
 * so windows that both own a session still merge into one ledger row.
 */
export class AgentHostUsageTracker implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('AI Effort Tracker — Agent Host Usage', { log: true });
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  /** Sessions that received turns in the latest poll, for live nudges (#93). */
  lastChangedSessions: string[] = [];
  /** Receives the clipped prompts of re-read sessions (correction capture, #131). */
  onUserMessages?: (messages: DebugUserMessage[]) => void;
  private seen = new Map<string, string>();
  private fingerprints = new Map<string, string>();
  private bindings = new Map<string, string>();
  private warned = new Map<string, string>();

  constructor(
    private db: Database,
    private globalStorageUri: vscode.Uri | undefined,
    private changed: () => void
  ) {}

  static enabled(): boolean {
    return vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('captureAgentHost') ?? true;
  }

  private root(): string | undefined {
    if (!this.globalStorageUri || this.globalStorageUri.scheme !== 'file') return undefined;
    // <Code>/User/globalStorage/<extension> → <Code>/agentSessionData
    return agentSessionRoot(path.dirname(path.dirname(this.globalStorageUri.fsPath)));
  }

  start(): void {
    if (!AgentHostUsageTracker.enabled() || !this.root()) return;
    if (!sqlite()) {
      this.output.warn(`Agent Host chats cannot be captured: ${sqliteUnavailableReason()}`);
      return;
    }
    void this.poll();
    const value = vscode.workspace.getConfiguration('aiEffortTracker').get<number>('autoCapturePollSeconds');
    const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.max(3, value) : 15;
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
  }

  private windowFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter(f => f.uri.scheme === 'file').map(f => path.normalize(f.uri.fsPath));
  }

  private async owner(session: AgentHostSession): Promise<Owner | undefined> {
    const folders = this.windowFolders();
    if (!folders.length) return undefined;
    for (const wd of session.folders) {
      const f = folders.find(folder => inside(wd, folder));
      if (f) return { cwd: fs.existsSync(wd) ? wd : f, repoFolder: f };
    }
    // Agent worktrees (or a repo root above a window subfolder) share the window's repository.
    for (const wd of session.folders) {
      if (!fs.existsSync(wd)) continue;
      const id = await GitTracker.repoIdFor(wd);
      for (const f of folders) {
        if (await GitTracker.repoIdFor(f) === id) return { cwd: wd, repoFolder: wd };
      }
    }
    return undefined;
  }

  private async branchFor(owner: Owner, session: AgentHostSession, ts: number,
    cache: Map<string, { switches: BranchSwitch[]; current?: string }>): Promise<string> {
    let git = cache.get(owner.cwd);
    if (!git) {
      git = { switches: await GitTracker.branchSwitchesIn(owner.cwd), current: await GitTracker.branchNameIn(owner.cwd) };
      cache.set(owner.cwd, git);
    }
    let name = branchAt(git.switches, ts);
    // No switch since the turn: the checkout is still on the same branch.
    if (!name && git.current && !git.switches.some(s => s.ts >= ts - 2000)) name = git.current;
    // The folder is gone (e.g. removed worktree): trust the session's last branch.
    if (!name && git.current === undefined) name = session.branch;
    if (!name || name === 'HEAD') return 'unknown';
    return branchKey(await GitTracker.repoIdFor(owner.repoFolder), name);
  }

  private async stamp(file: string): Promise<{ stamp: string; modified: number } | undefined> {
    try {
      const db = await fs.promises.stat(file);
      if (!db.isFile()) return undefined;
      let wal = '';
      let modified = db.mtimeMs;
      try {
        const w = await fs.promises.stat(`${file}-wal`);
        wal = `${w.mtimeMs}:${w.size}`;
        modified = Math.max(modified, w.mtimeMs);
      } catch { /* no WAL */ }
      return { stamp: `${db.mtimeMs}:${db.size}|${wal}`, modified };
    } catch {
      return undefined;
    }
  }

  async poll(): Promise<void> {
    const root = this.root();
    if (this.running || this.disposed || !root || !AgentHostUsageTracker.enabled()) return;
    this.running = true;
    try {
      let dirs: fs.Dirent[];
      try {
        dirs = await fs.promises.readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const candidates: { id: string; file: string; stamp: string; modified: number }[] = [];
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const file = path.join(root, dir.name, 'session.db');
        const s = await this.stamp(file);
        if (!s || s.modified < this.startedAt - RECOVERY_MS) continue;
        candidates.push({ id: dir.name, file, ...s });
      }
      candidates.sort((a, b) => b.modified - a.modified);
      const live = new Set(candidates.map(c => c.id));
      for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);

      let changed = false;
      const touched = new Set<string>();
      const git = new Map<string, { switches: BranchSwitch[]; current?: string }>();
      for (const c of candidates.slice(0, MAX_SESSIONS)) {
        if (this.seen.get(c.id) === c.stamp) continue;
        try {
          const session = readAgentSession(c.file, c.id);
          if (!session || !session.turns.some(t => t.usage)) { this.seen.set(c.id, c.stamp); continue; }
          const owner = await this.owner(session);
          if (!owner) { this.seen.set(c.id, c.stamp); continue; }
          const events = session.sdkSessionId ? await readAgentEvents(session.sdkSessionId) : undefined;
          const parsed = events ? parseAgentEvents(events, session.sessionId) : { timings: new Map(), messages: [] };
          if (this.onUserMessages && parsed.messages.length) {
            try { this.onUserMessages(parsed.messages); }
            catch (error) { this.output.warn(`Cannot read prompts for corrections: ${String(error)}`); }
          }
          if (this.disposed) return;
          for (const turn of agentTurns(session, parsed.timings, c.modified)) {
            const key = `${turn.sessionId}:${turn.turnId}`;
            const fingerprint = JSON.stringify([turn.timestamp, turn.requests.map(r => [r.spanId, r.credits, r.inputTokens, r.outputTokens]),
              turn.analysis.totalAdded, turn.analysis.totalRemoved, turn.analysis.toolCalls, turn.analysis.durationMs]);
            if (this.fingerprints.get(key) === fingerprint) continue;
            const existing = this.db.hasDebugTurn(turn.sessionId, turn.turnId);
            if (!existing && turn.timestamp < this.startedAt - RECOVERY_MS) continue;
            if (!this.bindings.has(key)) {
              const bound = existing ? 'unknown' : await this.branchFor(owner, session, turn.timestamp, git);
              if (!existing && turn.timestamp < this.startedAt) this.output.info(`Recovered uncaptured turn ${key} → ${bound}.`);
              this.bindings.set(key, bound);
            }
            if (this.disposed) return;
            for (const file of turn.analysis.files) file.category = categorize(file.path);
            // Attribution of an existing row stays frozen; only usage is refreshed.
            this.db.recordDebugUsage(this.bindings.get(key)!, turn);
            this.fingerprints.set(key, fingerprint);
            changed = true;
            touched.add(turn.sessionId);
          }
          this.seen.set(c.id, c.stamp);
        } catch (error) {
          const message = `Cannot capture agent session ${c.id}: ${String(error)}`;
          if (this.warned.get(c.id) !== `${c.stamp}|${message}`) {
            this.warned.set(c.id, `${c.stamp}|${message}`);
            this.output.warn(message);
          }
        }
      }
      for (const map of [this.bindings, this.fingerprints]) {
        while (map.size > 5000) map.delete(map.keys().next().value!);
      }
      this.lastChangedSessions = [...touched];
      if (changed) this.changed();
    } catch (error) {
      this.output.error(`Agent Host capture failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.seen.clear();
    this.fingerprints.clear();
    this.bindings.clear();
    this.warned.clear();
    this.output.dispose();
  }
}
