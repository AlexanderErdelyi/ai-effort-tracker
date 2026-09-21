import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Database } from '../store/database';
import { GitTracker } from './gitTracker';
import { categorize } from '../util/fileTypes';
import { parseDebugLog } from '../util/debugLog';
import { parseChatAliases } from '../util/chatAliases';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 200;

export interface DebugSessionFile {
  sessionId: string;
  file: string;
  modified: number;
}

export interface DebugImportResult {
  turns: number;
  credits: number;
  unpriced: number;
  warnings: number;
}

/** Reads only this window's workspace; never scans or attributes other repos. */
export class DebugLogUsageTracker implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('AI Effort Tracker — Debug Usage', { log: true });
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private previousBranch?: string;
  private lastPoll = this.startedAt;
  private seen = new Map<string, string>();
  private bindings = new Map<string, string>();

  constructor(
    private db: Database,
    private storageUri: vscode.Uri | undefined,
    private changed: () => void
  ) {}

  static enabled(): boolean {
    return vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('captureDebugLogs') ?? true;
  }

  private root(): string | undefined {
    if (!this.storageUri || this.storageUri.scheme !== 'file') return undefined;
    return path.join(path.dirname(this.storageUri.fsPath), 'GitHub.copilot-chat', 'debug-logs');
  }

  async sessions(): Promise<DebugSessionFile[]> {
    const root = this.root();
    if (!root) return [];
    let dirs: fs.Dirent[];
    try {
      dirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files: DebugSessionFile[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(root, dir.name, 'main.jsonl');
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isFile()) files.push({ sessionId: dir.name, file, modified: stat.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.output.warn(`Cannot inspect debug session ${dir.name}: ${String(error)}`);
        }
      }
    }
    return files.sort((a, b) => b.modified - a.modified);
  }

  start(): void {
    if (!DebugLogUsageTracker.enabled()) return;
    if (!this.root()) {
      this.output.warn('No local workspace storage available. Debug-log usage is not captured in this window.');
      return;
    }
    void this.poll();
    const value = vscode.workspace.getConfiguration('aiEffortTracker').get<number>('autoCapturePollSeconds');
    const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.max(3, value) : 15;
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
  }

  private async read(file: string): Promise<string> {
    const handle = await fs.promises.open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > MAX_FILE_BYTES) {
        throw new Error('Debug log exceeds the 16 MiB read limit; use a Chat Debug export instead.');
      }

      // A bounded snapshot: concurrent appends wait until the next poll.
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private async aliases(sessionId: string): Promise<Map<string, string[]>> {
    if (!this.storageUri) return new Map();
    const file = path.join(path.dirname(this.storageUri.fsPath), 'chatSessions', `${sessionId}.jsonl`);
    try {
      return parseChatAliases(await this.read(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.output.warn(`Cannot reconcile older chat entries for ${sessionId}: ${String(error)}`);
      }
      return new Map();
    }
  }

  async poll(): Promise<void> {
    if (this.running || this.disposed || !DebugLogUsageTracker.enabled()) return;
    this.running = true;
    const pollAt = Date.now();
    try {
      const branch = await GitTracker.getCurrentBranch();
      const listed = await this.sessions();
      if (listed.length > MAX_SESSIONS) {
        this.output.warn(`Live scan limited to the newest ${MAX_SESSIONS} debug sessions; older sessions can be imported explicitly.`);
      }
      const files = listed.slice(0, MAX_SESSIONS);
      const active = new Set(files.map(f => f.file));
      for (const file of this.seen.keys()) if (!active.has(file)) this.seen.delete(file);
      let changed = false;
      for (const session of files) {
        try {
          const stat = await fs.promises.stat(session.file);
          const stamp = `${stat.mtimeMs}:${stat.size}`;
          if (this.seen.get(session.file) === stamp) continue;
          const parsed = parseDebugLog(await this.read(session.file));
          const aliases = await this.aliases(session.sessionId);
          for (const message of parsed.diagnostics) this.output.warn(`${session.sessionId}: ${message}`);
          if (this.disposed) return;
          for (const turn of parsed.turns) {
            if (turn.sessionId !== session.sessionId) {
              this.output.warn(`Session ID mismatch in ${session.sessionId}; skipped.`);
              continue;
            }
            const key = `${turn.sessionId}:${turn.turnId}`;
            const existing = this.db.hasDebugTurn(turn.sessionId, turn.turnId);
            if (!existing && turn.timestamp < this.startedAt) continue;
            if (!this.bindings.has(key)) {
              // If a branch switch happened between polls, its exact timing is
              // unknowable. Park the turn instead of silently guessing.
              const unambiguous = branch && branch !== 'HEAD' &&
                (this.previousBranch === branch || this.previousBranch === undefined) &&
                turn.timestamp >= this.lastPoll;
              this.bindings.set(key, unambiguous ? branch : 'unknown');
            }
            if (!turn.requests.length) continue;
            for (const file of turn.analysis.files) file.category = categorize(file.path);
            this.db.recordDebugUsage(this.bindings.get(key)!, {
              ...turn, logWarnings: parsed.diagnostics.length, requestAliases: [...new Set([...turn.requestAliases,
                ...turn.responseIds.flatMap(id => aliases.get(id) ?? [])])]
            });
            changed = true;
          }
          this.seen.set(session.file, stamp);
        } catch (error) {
          this.output.warn(`Cannot capture ${session.sessionId}: ${String(error)}`);
        }
      }
      // Only scalar attribution/cache metadata survives polls; payloads are discarded.
      while (this.bindings.size > 5000) this.bindings.delete(this.bindings.keys().next().value!);
      this.previousBranch = branch;
      this.lastPoll = pollAt;
      if (changed) this.changed();
    } catch (error) {
      this.output.error(`Debug-log capture failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Explicit user-selected branch; existing row attribution is never rewritten. */
  async importSession(session: DebugSessionFile, branch: string): Promise<DebugImportResult> {
    const parsed = parseDebugLog(await this.read(session.file));
    for (const diagnostic of parsed.diagnostics) this.output.warn(diagnostic);
    const aliases = await this.aliases(session.sessionId);
    if (parsed.turns.some(turn => turn.sessionId !== session.sessionId)) throw new Error('Debug-log session ID mismatch');
    const summary: DebugImportResult = {
      turns: 0, credits: 0, unpriced: 0,
      warnings: parsed.diagnostics.length + (parsed.ignoredPartialLine ? 1 : 0)
    };
    for (const turn of parsed.turns) {
      if (!turn.requests.length) continue;
      for (const file of turn.analysis.files) file.category = categorize(file.path);
      const { entry } = this.db.recordDebugUsage(branch, {
        ...turn, logWarnings: parsed.diagnostics.length, requestAliases: [...new Set([...turn.requestAliases,
          ...turn.responseIds.flatMap(id => aliases.get(id) ?? [])])]
      });
      summary.turns++;
      summary.credits += entry.credits;
      summary.unpriced += entry.debugUsage?.unpricedRequests ?? 0;
    }
    this.changed();
    return summary;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.seen.clear();
    this.bindings.clear();
    this.output.dispose();
  }
}
