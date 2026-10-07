import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, readStore, retainPrevious, syncDirectory, withStoreLock } from './persistence';
import { decodeEffortStore, type PersistedStore } from './database';
import { CORRECTIONS_FILE, decodeCorrectionStore, type CorrectionStoreData } from '../analysis/corrections';
import { decodeReviewStore, REVIEW_FILE, type ReviewStoreData } from '../analysis/review';
import { decodeLessonStore, LESSONS_FILE, type LessonStoreData } from '../analysis/lessons';

/**
 * #6: full backup / restore of every durable data set. A backup is one JSON
 * "bundle" holding the decoded content of each store file plus the user's
 * global extension settings (never secrets). Restores validate first, take a
 * safety copy of the current data and keep the replaced file as .bak/history.
 */
export const BACKUP_FORMAT = 'ai-effort-tracker-backup';
export const BACKUP_VERSION = 1;
export const SAFETY_DIR = 'backups';
export const SAFETY_KEEP = 10;
/** Settings that must never be written into a backup file. */
export const SECRET_SETTINGS = new Set(['aiEffortTracker.githubToken']);

export type DataSetId = 'effort' | 'corrections' | 'reviews' | 'lessons';

export interface DataSet {
  id: DataSetId;
  label: string;
  file: string;
  decode(raw: string): unknown;
  /** One-line content summary, e.g. for the restore confirmation. */
  summarize(value: unknown): string;
}

const plural = (n: number, word: string, many = word + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

function summarizeEffort(value: unknown): string {
  const s = value as PersistedStore;
  const branches = Object.values(s.branches ?? {});
  const activeMs = branches.reduce((sum, b) => sum + (b.time?.humanCoding ?? 0) + (b.time?.aiGenerating ?? 0) + (b.time?.reviewing ?? 0), 0);
  const credits = (s.creditLedger ?? []).reduce((sum, e) => sum + (Number(e.credits) || 0), 0);
  const days = branches.flatMap(b => Object.keys(b.daily ?? {})).sort();
  return [
    `${(activeMs / 3_600_000).toFixed(1)} h active`,
    plural(branches.length, 'branch', 'branches'),
    plural(Object.keys(s.workItems ?? {}).length, 'work item'),
    `${plural((s.creditLedger ?? []).length, 'credit row')} (${credits.toFixed(1)} credits)`,
    ...(days.length ? [`last activity ${days[days.length - 1]}`] : [])
  ].join(' · ');
}

export const DATA_SETS: readonly DataSet[] = [
  {
    id: 'effort', label: 'Tracking data (time, lines, credits, work items, projects)', file: 'effort-tracker.json',
    decode: decodeEffortStore, summarize: summarizeEffort
  },
  {
    id: 'corrections', label: 'Captured corrections', file: CORRECTIONS_FILE, decode: decodeCorrectionStore,
    summarize: v => plural((v as CorrectionStoreData).corrections?.length ?? 0, 'correction')
  },
  {
    id: 'reviews', label: 'Review marks', file: REVIEW_FILE, decode: decodeReviewStore,
    summarize: v => {
      const repos = Object.values((v as ReviewStoreData).repos ?? {});
      const marks = repos.reduce((sum, r) => sum + Object.values(r.files ?? {}).reduce((n, m) => n + m.length, 0), 0);
      return `${plural(marks, 'mark')} in ${plural(repos.length, 'repo')}`;
    }
  },
  {
    id: 'lessons', label: 'Rules for Copilot', file: LESSONS_FILE, decode: decodeLessonStore,
    summarize: v => plural((v as LessonStoreData).rules?.length ?? 0, 'rule')
  }
];

export const dataSet = (id: DataSetId): DataSet => DATA_SETS.find(s => s.id === id)!;

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  extensionVersion?: string;
  /** Decoded content per data set; a missing key means "not included". */
  data: Partial<Record<DataSetId, unknown>>;
  /** Global `aiEffortTracker.*` settings (secrets excluded). */
  settings?: Record<string, unknown>;
  /** Data sets that could not be read when the bundle was built. */
  skipped?: string[];
}

/**
 * Read the current content of the side stores. Missing files are skipped; an
 * unreadable store (no readable copy at all) is reported in `skipped` instead
 * of aborting the whole backup.
 */
export function readDataSets(dir: string, ids: readonly DataSetId[], skipped: string[] = []): Partial<Record<DataSetId, unknown>> {
  const result: Partial<Record<DataSetId, unknown>> = {};
  for (const id of ids) {
    const set = dataSet(id);
    try {
      const value = readStore<unknown>(path.join(dir, set.file), raw => set.decode(raw), () => undefined).value;
      if (value !== undefined) result[id] = value;
    } catch (error) {
      skipped.push(`${set.label}: ${(error as Error).message}`);
    }
  }
  return result;
}

export function buildBundle(opts: {
  dir: string;
  effort: PersistedStore;
  settings?: Record<string, unknown>;
  extensionVersion?: string;
  now?: Date;
}): BackupBundle {
  const settings = Object.fromEntries(Object.entries(opts.settings ?? {}).filter(([k]) => !SECRET_SETTINGS.has(k)));
  const skipped: string[] = [];
  const side = readDataSets(opts.dir, ['corrections', 'reviews', 'lessons'], skipped);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.extensionVersion ? { extensionVersion: opts.extensionVersion } : {}),
    data: { effort: opts.effort, ...side },
    settings,
    ...(skipped.length ? { skipped } : {})
  };
}

export const serializeBundle = (bundle: BackupBundle) => JSON.stringify(bundle, null, 1);

/**
 * Parse an exported bundle, or a single store file copied by hand (e.g.
 * effort-tracker.json or one of its .bak/history copies from another machine).
 * Every included data set is validated with the same decoder used at startup.
 */
export function parseBackup(raw: string, fileName = ''): BackupBundle {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('The file is not valid JSON.'); }
  if (parsed && typeof parsed === 'object' && parsed.format === BACKUP_FORMAT) {
    if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
      throw new Error(`This backup was made by a newer version of AI Effort Tracker (format ${parsed.version}). Update the extension first.`);
    }
    if (!parsed.data || typeof parsed.data !== 'object') throw new Error('The backup contains no data.');
    const data: Partial<Record<DataSetId, unknown>> = {};
    for (const set of DATA_SETS) {
      if (parsed.data[set.id] === undefined) continue;
      try { data[set.id] = set.decode(JSON.stringify(parsed.data[set.id])); }
      catch (error) { throw new Error(`${set.label} in the backup is damaged: ${(error as Error).message}`); }
    }
    if (!Object.keys(data).length) throw new Error('The backup contains no data.');
    const settings = parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
      ? Object.fromEntries(Object.entries(parsed.settings as Record<string, unknown>)
        .filter(([k]) => k.startsWith('aiEffortTracker.') && !SECRET_SETTINGS.has(k)))
      : undefined;
    return {
      format: BACKUP_FORMAT, version: parsed.version, exportedAt: String(parsed.exportedAt ?? ''),
      ...(parsed.extensionVersion ? { extensionVersion: String(parsed.extensionVersion) } : {}),
      data, ...(settings && Object.keys(settings).length ? { settings } : {})
    };
  }
  const base = path.basename(fileName).toLowerCase();
  const named = DATA_SETS.find(s => s.id !== 'effort' && base.startsWith(s.file.replace(/\.json$/, '')));
  const set = named ?? dataSet('effort');
  try {
    return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '', data: { [set.id]: set.decode(raw) } };
  } catch {
    throw new Error('This is not an AI Effort Tracker backup. Use "Export Full Backup" to create one, or pick an automatic checkpoint.');
  }
}

export interface Checkpoint {
  set: DataSetId;
  file: string;
  kind: 'previous' | 'hourly' | 'daily';
  mtime: number;
  size: number;
}

/** Automatic copies kept by every store: .bak plus hourly/daily history, newest first. */
export function listCheckpoints(dir: string): Checkpoint[] {
  const result: Checkpoint[] = [];
  const add = (set: DataSetId, file: string, kind: Checkpoint['kind']) => {
    try { const st = fs.statSync(file); result.push({ set, file, kind, mtime: st.mtimeMs, size: st.size }); } catch { /* missing */ }
  };
  for (const set of DATA_SETS) {
    const main = path.join(dir, set.file);
    add(set.id, main + '.bak', 'previous');
    let names: string[] = [];
    try { names = fs.readdirSync(main + '.history'); } catch { /* none yet */ }
    for (const name of names) {
      const m = /^(hour|day)-[\dT-]+\.json$/.exec(name);
      if (m) add(set.id, path.join(main + '.history', name), m[1] === 'hour' ? 'hourly' : 'daily');
    }
  }
  return result.sort((a, b) => DATA_SETS.findIndex(s => s.id === a.set) - DATA_SETS.findIndex(s => s.id === b.set) || b.mtime - a.mtime);
}

export interface SafetyCopy { file: string; mtime: number; size: number }

/** Full bundles written automatically before each restore, newest first. */
export function listSafetyCopies(dir: string): SafetyCopy[] {
  const folder = path.join(dir, SAFETY_DIR);
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter(n => /^pre-restore-.+\.json$/.test(n)).map(n => {
    const file = path.join(folder, n);
    const st = fs.statSync(file);
    return { file, mtime: st.mtimeMs, size: st.size };
  }).sort((a, b) => b.mtime - a.mtime);
}

/** Write a safety bundle into `<dir>/backups/` and keep only the newest {@link SAFETY_KEEP}. */
export function writeSafetyCopy(dir: string, bundle: BackupBundle, now = new Date()): string {
  const folder = path.join(dir, SAFETY_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(folder, `pre-restore-${stamp}.json`);
  atomicWrite(file, JSON.stringify(bundle));
  for (const old of listSafetyCopies(dir).slice(SAFETY_KEEP)) fs.unlinkSync(old.file);
  syncDirectory(folder);
  return file;
}

/**
 * Replace a side store (corrections / review marks / rules) under its
 * interprocess lock. These stores re-read the latest file before every change,
 * so open windows continue on the restored content.
 */
export function restoreSideStore(dir: string, id: Exclude<DataSetId, 'effort'>, value: unknown): void {
  const set = dataSet(id);
  const file = path.join(dir, set.file);
  const serialized = JSON.stringify(set.decode(JSON.stringify(value)));
  withStoreLock(file, 5000, () => {
    let current: string | undefined;
    try { current = fs.readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === serialized) return;
    if (current !== undefined) retainPrevious(file, current);
    atomicWrite(file, serialized);
    syncDirectory(dir);
  });
}
