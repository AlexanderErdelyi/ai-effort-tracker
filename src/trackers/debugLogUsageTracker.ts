import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Database } from '../store/database';
import { GitTracker } from './gitTracker';
import { categorize } from '../util/fileTypes';
import { extractUserMessages, parseDebugLog, type DebugUserMessage } from '../util/debugLog';
import { parseChatAliases } from '../util/chatAliases';
import { parseModelPrices, parseToolset } from '../util/modelCatalog';
import { BranchSwitch, branchAt } from '../util/reflog';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 200;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;
const MAX_SESSION_FILES = 200;
/** Sessions above this size are re-parsed only when idle or every few minutes. */
const LARGE_SESSION_BYTES = 16 * 1024 * 1024;
const LARGE_SESSION_IDLE_MS = 60 * 1000;
const LARGE_SESSION_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Turns from before this window started are recovered when missing from the
 * store (reload, crash, or an older window overwriting the file), attributed via
 * the git reflog or parked as `unknown`.
 */
const RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Sessions that received live (non-import) turns in the latest poll, for live nudges (#93). */
  lastChangedSessions: string[] = [];
  private disposed = false;
  private previousBranch?: string;
  private lastPoll = this.startedAt;
  private seen = new Map<string, string>();
  private bindings = new Map<string, string>();
  /** `path|mtime|size` → toolset id (or '' when unparseable); avoids rereading large tool files. */
  private toolsetCache = new Map<string, string>();
  private largeParsedAt = new Map<string, number>();
  private warned = new Map<string, string>();
  private pricesStamp = '';
  private pricesCapturedAt = 0;

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

  private async read(file: string, limit = MAX_FILE_BYTES): Promise<string> {
    const handle = await fs.promises.open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > limit) {
        throw new Error('Debug log exceeds the bounded read limit; use a Chat Debug export instead.');
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

  private async sessionFiles(session: DebugSessionFile): Promise<{ files: string[]; stamp: string; total: number; modified: number }> {
    const dir = path.dirname(session.file);
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith('.jsonl') && e.name !== 'main.jsonl')
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = [session.file, ...entries.map(e => path.join(dir, e.name))];
    if (files.length > MAX_SESSION_FILES) throw new Error('Too many debug-log files in this session; capture is incomplete.');
    let total = 0;
    let modified = 0;
    let oversized = false;
    const stamps: string[] = [];
    for (const file of files) {
      const stat = await fs.promises.stat(file);
      total += stat.size;
      modified = Math.max(modified, stat.mtimeMs);
      oversized ||= stat.size > MAX_FILE_BYTES;
      stamps.push(`${path.basename(file)}:${stat.mtimeMs}:${stat.size}`);
    }
    const stamp = stamps.join('|');
    if (oversized || total > MAX_SESSION_BYTES) {
      throw Object.assign(new Error('Debug session exceeds the read limit; capture is incomplete. Use a Chat Debug export.'), { stamp });
    }
    return { files, stamp, total, modified };
  }

  /** Receives the prompts of each re-read session (correction capture, #131). */
  onUserMessages?: (messages: DebugUserMessage[]) => void;

  private async parseSession(files: string[]): Promise<ReturnType<typeof parseDebugLog>> {
    const logs: string[] = [];
    let remaining = MAX_SESSION_BYTES;
    for (const file of files) {
      const text = await this.read(file, Math.min(MAX_FILE_BYTES, remaining));
      remaining -= Buffer.byteLength(text, 'utf8');
      logs.push(text);
    }
    if (this.onUserMessages && logs[0]) {
      try { this.onUserMessages(extractUserMessages(logs[0])); }
      catch (error) { this.output.warn(`Cannot read prompts for corrections: ${String(error)}`); }
    }
    return parseDebugLog(logs[0], logs.slice(1));
  }

  /**
   * Resolve each request's session-local tool file to a content-free toolset
   * fingerprint, and capture model prices. Descriptions/schemas are discarded.
   */
  private async catalog(sessionDir: string, requests: { toolsFile?: string; toolset?: string }[]): Promise<void> {
    const byFile = new Map<string, string>();
    for (const request of requests) {
      const name = request.toolsFile;
      delete request.toolsFile;
      if (!name) continue;
      if (!byFile.has(name)) {
        const file = path.join(sessionDir, name);
        let id = '';
        try {
          const stat = await fs.promises.stat(file);
          const cacheKey = `${file}|${stat.mtimeMs}|${stat.size}`;
          const cached = this.toolsetCache.get(cacheKey);
          if (cached !== undefined) id = cached;
          else {
            const info = stat.size <= MAX_CATALOG_BYTES ? parseToolset(await this.read(file, MAX_CATALOG_BYTES), stat.mtimeMs) : undefined;
            if (info) {
              this.db.recordToolset(info);
              id = info.id;
            }
            this.toolsetCache.set(cacheKey, id);
            while (this.toolsetCache.size > 500) this.toolsetCache.delete(this.toolsetCache.keys().next().value!);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.output.warn(`Cannot read tool definitions ${name}: ${String(error)}`);
        }
        byFile.set(name, id);
      }
      const id = byFile.get(name);
      if (id) request.toolset = id;
    }
    const models = path.join(sessionDir, 'models.json');
    try {
      const stat = await fs.promises.stat(models);
      const stamp = `${models}|${stat.mtimeMs}|${stat.size}`;
      if (stamp !== this.pricesStamp && stat.size <= MAX_CATALOG_BYTES && stat.mtimeMs >= this.pricesCapturedAt) {
        this.db.recordModelPrices(parseModelPrices(await this.read(models, MAX_CATALOG_BYTES), stat.mtimeMs));
        this.pricesStamp = stamp;
        this.pricesCapturedAt = stat.mtimeMs;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.output.warn(`Cannot read model prices: ${String(error)}`);
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
      const touched = new Set<string>();
      let switches: BranchSwitch[] | undefined;
      for (const session of files) {
        let stamp: string | undefined;
        try {
          const info = await this.sessionFiles(session);
          stamp = info.stamp;
          if (this.seen.get(session.file) === stamp) continue;
          if (info.total > LARGE_SESSION_BYTES) {
            // Re-reading a huge log on every poll would stall the extension host.
            const last = this.largeParsedAt.get(session.file) ?? 0;
            if (pollAt - info.modified < LARGE_SESSION_IDLE_MS && pollAt - last < LARGE_SESSION_INTERVAL_MS) continue;
            this.largeParsedAt.set(session.file, pollAt);
          }
          const parsed = await this.parseSession(info.files);
          const aliases = await this.aliases(session.sessionId);
          for (const message of parsed.diagnostics) this.output.warn(`${session.sessionId}: ${message}`);
          if (this.disposed) return;
          const record: typeof parsed.turns = [];
          for (const turn of parsed.turns) {
            if (turn.sessionId !== session.sessionId) {
              this.output.warn(`Session ID mismatch in ${session.sessionId}; skipped.`);
              continue;
            }
            const key = `${turn.sessionId}:${turn.turnId}`;
            const existing = this.db.hasDebugTurn(turn.sessionId, turn.turnId);
            if (!existing && turn.timestamp < this.startedAt - RECOVERY_MS) continue;
            if (!this.bindings.has(key)) {
              // If a branch switch happened between polls (or before this window
              // started), use the git reflog; park the turn when it is unknowable.
              const unambiguous = branch && branch !== 'HEAD' && turn.timestamp >= this.startedAt &&
                (this.previousBranch === branch || this.previousBranch === undefined) &&
                turn.timestamp >= this.lastPoll;
              let bound = unambiguous ? branch : undefined;
              if (!bound && !existing) {
                switches ??= await GitTracker.getBranchSwitches();
                bound = branchAt(switches, turn.timestamp);
                if (turn.timestamp < this.startedAt) {
                  this.output.info(`Recovered uncaptured turn ${key} → ${bound ?? 'unknown'}.`);
                }
              }
              this.bindings.set(key, bound ?? 'unknown');
            }
            if (turn.requests.length) record.push(turn);
          }
          await this.catalog(path.dirname(session.file), record.flatMap(t => t.requests));
          if (this.disposed) return;
          for (const turn of record) {
            const key = `${turn.sessionId}:${turn.turnId}`;
            for (const file of turn.analysis.files) file.category = categorize(file.path);
            this.db.recordDebugUsage(this.bindings.get(key)!, {
              ...turn, logWarnings: parsed.diagnostics.length, requestAliases: [...new Set([...turn.requestAliases,
                ...turn.responseIds.flatMap(id => aliases.get(id) ?? [])])]
            });
            changed = true;
            touched.add(turn.sessionId);
          }
          this.seen.set(session.file, stamp);
        } catch (error) {
          // Deterministic failures repeat every poll; report once per file state.
          const message = `Cannot capture ${session.sessionId}: ${String(error)}`;
          const failedStamp = stamp ?? (error as { stamp?: string }).stamp;
          if (this.warned.get(session.file) !== `${failedStamp}|${message}`) {
            this.warned.set(session.file, `${failedStamp}|${message}`);
            this.output.warn(message);
          }
        }
      }
      // Only scalar attribution/cache metadata survives polls; payloads are discarded.
      while (this.bindings.size > 5000) this.bindings.delete(this.bindings.keys().next().value!);
      this.previousBranch = branch;
      this.lastPoll = pollAt;
      this.lastChangedSessions = [...touched];
      if (changed) this.changed();
    } catch (error) {
      this.output.error(`Debug-log capture failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Explicit user-selected branch; existing row attribution is never rewritten. */
  async importSession(session: DebugSessionFile, branch: string): Promise<DebugImportResult> {
    const { files } = await this.sessionFiles(session);
    const parsed = await this.parseSession(files);
    for (const diagnostic of parsed.diagnostics) this.output.warn(diagnostic);
    const aliases = await this.aliases(session.sessionId);
    if (parsed.turns.some(turn => turn.sessionId !== session.sessionId)) throw new Error('Debug-log session ID mismatch');
    const summary: DebugImportResult = {
      turns: 0, credits: 0, unpriced: 0,
      warnings: parsed.diagnostics.length + (parsed.ignoredPartialLine ? 1 : 0)
    };
    await this.catalog(path.dirname(session.file), parsed.turns.flatMap(t => t.requests));
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
    this.lastChangedSessions = [];
    this.changed();
    return summary;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.seen.clear();
    this.bindings.clear();
    this.toolsetCache.clear();
    this.largeParsedAt.clear();
    this.warned.clear();
    this.output.dispose();
  }
}
