import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';

/**
 * Auto-captures the AI model used per chat / agent request by tailing the
 * GitHub Copilot Chat extension's own log file.
 *
 * Research (see PR / issue #17): there is no public VS Code API to observe
 * another extension's chat turns, model selection, output channel, or credit
 * counts. However, VS Code writes every extension's OutputChannel /
 * LogOutputChannel to a plain text file under the window's exthost log
 * directory, and sibling extensions share that directory — so we can READ the
 * Copilot Chat log even though we cannot subscribe to it. Each model request is
 * logged as one line:
 *
 *   ccreq:<id>.copilotmd | success | <model> | <ms>ms | [copilotLanguageModelWrapper]
 *
 * That gives us the MODEL per request automatically. Exact credit /
 * premium-request COUNTS are NOT present locally — they are computed
 * server-side and are only authoritative through the GitHub billing API (see
 * GitHubService.getBillingUsage and the "Import Copilot Premium-Request Usage"
 * command). So this tracker records the model plus an ESTIMATED premium-request
 * weight (a configurable multiplier per model; included / background models
 * weigh 0 and are skipped). Treat auto-captured credits as an estimate; the
 * billing import remains the source of truth.
 */
export class ChatUsageTracker implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private output: vscode.LogOutputChannel;
  /** Absolute path to the Copilot Chat log we are tailing (once found). */
  private logPath: string | undefined;
  /** Byte offset we have already consumed in logPath. */
  private offset = 0;
  /** Bounded set of ccreq ids already recorded (guards against re-reads). */
  private seen = new Set<string>();

  private static readonly LINE_RE =
    /ccreq:([0-9a-f]+)\.[\w.-]+ \| success \| ([^|]+?) \| \d+ms/g;

  constructor(
    private db: Database,
    private timeTracker: TimeTracker,
    private logUri: vscode.Uri
  ) {
    this.output = vscode.window.createOutputChannel('AI Effort Tracker', { log: true });
  }

  start(_context: vscode.ExtensionContext) {
    if (!this.enabled()) {
      this.output.info('Auto-capture disabled (aiEffortTracker.autoCaptureCredits = false).');
      return;
    }
    const seconds = Math.max(
      5,
      vscode.workspace.getConfiguration('aiEffortTracker').get<number>('autoCapturePollSeconds') ?? 15
    );
    // Prime immediately (seeks to end of the current log), then poll.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('autoCaptureCredits') ?? true;
  }

  private async poll(): Promise<void> {
    try {
      if (!this.enabled()) return;
      if (!this.logPath || !fs.existsSync(this.logPath)) {
        this.logPath = this.findCopilotChatLog();
        if (!this.logPath) return;
        // Only capture usage from now on: seek to the current end of file so we
        // never re-import historical requests or double count across restarts.
        this.offset = fs.statSync(this.logPath).size;
        this.output.info(`Watching Copilot Chat log: ${this.logPath}`);
        return;
      }

      const size = fs.statSync(this.logPath).size;
      if (size < this.offset) {
        // File was truncated / rotated — restart from the beginning.
        this.offset = 0;
      }
      if (size === this.offset) return;

      const chunk = await this.readRange(this.logPath, this.offset, size);
      this.offset = size;
      this.consume(chunk);
    } catch {
      /* best-effort: never disturb the extension host */
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

  private consume(text: string): void {
    const branch = this.timeTracker.getBranch();
    ChatUsageTracker.LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ChatUsageTracker.LINE_RE.exec(text)) !== null) {
      const id = m[1];
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > 5000) {
        // Keep the guard set bounded.
        this.seen = new Set([...this.seen].slice(-2500));
      }

      const model = this.normalizeModel(m[2].trim());
      const weight = this.creditWeight(model);
      if (weight <= 0) continue; // background / included model — skip.

      this.db.recordAutoModelUsage(branch, model, weight, `auto:ccreq:${id}`);
      this.output.info(`Captured request: ${model} (+${weight} est. credit) on ${branch}`);
    }
  }

  /** Strip a trailing date/version stamp: `gpt-4o-mini-2024-07-18` -> `gpt-4o-mini`. */
  private normalizeModel(model: string): string {
    return model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-preview$/, '');
  }

  /**
   * Estimated premium-request weight for a model. Matched by substring against
   * the configurable `premiumRequestMultipliers` map; unmatched models fall
   * back to `autoCreditDefaultMultiplier`.
   */
  private creditWeight(model: string): number {
    const cfg = vscode.workspace.getConfiguration('aiEffortTracker');
    const map = cfg.get<Record<string, number>>('premiumRequestMultipliers') ?? {};
    const lower = model.toLowerCase();
    let best: { key: string; val: number } | undefined;
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key.toLowerCase())) {
        if (!best || key.length > best.key.length) best = { key, val };
      }
    }
    if (best) return best.val;
    return cfg.get<number>('autoCreditDefaultMultiplier') ?? 1;
  }

  /**
   * Locate the Copilot Chat log for this window. Our own log dir is a sibling of
   * `GitHub.copilot-chat` inside the window's exthost log directory, so try that
   * first; otherwise fall back to scanning the logs root for the newest one.
   */
  private findCopilotChatLog(): string | undefined {
    const LOG_FILE = 'GitHub Copilot Chat.log';
    const CHAT_DIR = 'GitHub.copilot-chat';

    // 1) Sibling of our extension's log directory (same window / exthost).
    const exthostDir = path.dirname(this.logUri.fsPath);
    const sibling = path.join(exthostDir, CHAT_DIR, LOG_FILE);
    if (fs.existsSync(sibling)) return sibling;

    // 2) Walk up to the `logs` root and pick the newest matching log.
    let logsRoot: string | undefined;
    let cur = exthostDir;
    for (let i = 0; i < 6; i++) {
      if (path.basename(cur).toLowerCase() === 'logs') { logsRoot = cur; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!logsRoot || !fs.existsSync(logsRoot)) return undefined;

    let newest: { file: string; mtime: number } | undefined;
    for (const session of this.safeDirs(logsRoot)) {
      for (const win of this.safeDirs(path.join(logsRoot, session))) {
        const candidate = path.join(logsRoot, session, win, 'exthost', CHAT_DIR, LOG_FILE);
        try {
          const mtime = fs.statSync(candidate).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { file: candidate, mtime };
        } catch { /* not present in this window */ }
      }
    }
    return newest?.file;
  }

  private safeDirs(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.output.dispose();
  }
}
