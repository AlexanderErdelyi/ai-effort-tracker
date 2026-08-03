import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../store/database';
import { TimeTracker } from './timeTracker';
import { parseDebugExport, ImportedTurn } from '../util/debugExport';

/** Aggregate outcome of importing one or more export files. */
export interface ImportSummary {
  files: number;
  turns: number;
  requests: number;
  credits: number;
  inserted: number;
  updated: number;
  purgedAuto: number;
}

/**
 * Imports EXACT chat credits from Copilot Chat Debug exports (issue #70).
 *
 * The user exports the Chat Debug log ("all prompts") into a configured folder
 * (`aiEffortTracker.creditImportFolder`); this tracker watches that folder,
 * parses each export via {@link parseDebugExport}, and upserts one EXACT
 * `source:'import'` ledger row per turn (deduped/idempotent by `promptId`, so a
 * periodic "export all" never double-counts and a later, more complete export
 * upgrades the value). It is the authoritative alternative to the live
 * token-rate estimator, whose numbers undercount agent turns ~5×.
 *
 * EXACT-ONLY reconciliation: whenever an import runs it purges the estimated
 * `source:'auto'` rows ({@link Database.purgeAutoLedger}); the live estimators are
 * disabled while a folder is configured (see extension activation). So credit
 * totals come purely from exact imports + manual entries and always match GitHub.
 *
 * Everything is best-effort/defensive: a malformed export, a vanished file, or a
 * permission error is swallowed and never disturbs the extension host.
 */
export class CreditImportTracker implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private output: vscode.LogOutputChannel;
  /** path → {mtime,size} already imported, to skip unchanged files on re-poll. */
  private seen = new Map<string, { mtime: number; size: number }>();

  constructor(
    private db: Database,
    private timeTracker: TimeTracker,
    /** Called after an import mutates the ledger, so the dashboard can refresh. */
    private onImported?: (summary: ImportSummary) => void
  ) {
    this.output = vscode.window.createOutputChannel('AI Effort Tracker — Credit Import', { log: true });
  }

  /** True when a credit-import folder is configured and exists on disk. */
  static isConfigured(): boolean {
    const dir = CreditImportTracker.folder();
    return !!dir && CreditImportTracker.isDir(dir);
  }

  static folder(): string {
    return (vscode.workspace.getConfiguration('aiEffortTracker').get<string>('creditImportFolder') ?? '').trim();
  }

  /** List `*.json` files in the configured import folder (empty when unset). */
  static listConfiguredFolderFiles(): string[] {
    const dir = CreditImportTracker.folder();
    if (!dir || !CreditImportTracker.isDir(dir)) return [];
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
        .map(d => path.join(dir, d.name));
    } catch {
      return [];
    }
  }

  private static isDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  start(_context: vscode.ExtensionContext): void {
    if (!CreditImportTracker.isConfigured()) {
      this.output.info('Credit import disabled (aiEffortTracker.creditImportFolder not set / missing).');
      return;
    }
    this.output.info(`Watching credit-import folder: ${CreditImportTracker.folder()}`);
    void this.scanAndImport();
    // Poll the folder; a debounced watcher is unnecessary and fs.watch is flaky
    // across platforms/network drives, so a simple interval is the robust choice.
    this.timer = setInterval(() => void this.scanAndImport(), 10_000);
  }

  /** Scan the configured folder and import any new/changed `*.json` exports. */
  private async scanAndImport(): Promise<void> {
    try {
      const dir = CreditImportTracker.folder();
      if (!dir || !CreditImportTracker.isDir(dir)) return;
      const files = this.jsonFilesIn(dir).filter(f => this.isNew(f));
      if (files.length === 0) return;
      const summary = this.importFiles(files);
      if (summary.turns > 0 || summary.purgedAuto > 0) this.onImported?.(summary);
    } catch {
      /* best-effort: never disturb the extension host */
    }
  }

  /**
   * Import an explicit list of export files (used by the manual command too).
   * Purges estimated `auto` rows afterwards (exact-only), and returns an
   * aggregate summary suitable for a status toast.
   */
  importFiles(files: string[]): ImportSummary {
    const branch = this.timeTracker.getBranch();
    const summary: ImportSummary = {
      files: 0,
      turns: 0,
      requests: 0,
      credits: 0,
      inserted: 0,
      updated: 0,
      purgedAuto: 0
    };

    for (const file of files) {
      let turns: ImportedTurn[];
      try {
        const raw = fs.readFileSync(file, 'utf8');
        turns = parseDebugExport(JSON.parse(raw));
      } catch (err) {
        this.output.warn(`Skipped ${path.basename(file)}: ${String(err)}`);
        continue;
      }
      summary.files += 1;
      for (const t of turns) {
        const { inserted } = this.db.recordImportedUsage(branch, t.model, t.credits, {
          promptId: t.promptId,
          promptTokens: t.promptTokens,
          completionTokens: t.completionTokens,
          requests: t.requests
        });
        summary.turns += 1;
        summary.requests += t.requests;
        summary.credits += t.credits;
        if (inserted) summary.inserted += 1;
        else summary.updated += 1;
      }
      this.markSeen(file);
      this.output.info(
        `Imported ${turns.length} turn(s) from ${path.basename(file)} — ${turns
          .reduce((s, t) => s + t.credits, 0)
          .toFixed(2)} AIU`
      );
    }

    // Exact-only: drop estimated auto rows so they can never double-count.
    summary.purgedAuto = this.db.purgeAutoLedger();
    return summary;
  }

  private jsonFilesIn(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.json'))
        .map(d => path.join(dir, d.name));
    } catch {
      return [];
    }
  }

  private isNew(file: string): boolean {
    try {
      const st = fs.statSync(file);
      const prev = this.seen.get(file);
      return !prev || prev.mtime !== st.mtimeMs || prev.size !== st.size;
    } catch {
      return false;
    }
  }

  private markSeen(file: string): void {
    try {
      const st = fs.statSync(file);
      this.seen.set(file, { mtime: st.mtimeMs, size: st.size });
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.output.dispose();
  }
}
