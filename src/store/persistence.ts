import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export class StoreBusyError extends Error {
  constructor() { super('Another AI Effort Tracker window is saving. Please retry.'); }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return code(error) !== 'ESRCH'; }
}

function rename(from: string, to: string): void {
  // Windows scanners and a concurrently-closing reader can transiently deny
  // replacement. Never "fix" this by unlinking the destination first.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 20 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '')) throw error;
      Atomics.wait(sleepBuffer, 0, 0, 10);
    }
  }
}

/**
 * Lamport bakery lock for a LOCAL filesystem. Every contender owns a unique
 * directory, initially "choosing", then publishes its immutable ticket. There
 * is no shared lock file to unlink: dead-process cleanup cannot accidentally
 * remove a successor's lock. PID reuse fails closed (timeout), never steals a
 * live lock. A stopped but live extension host is likewise never evicted.
 *
 * All filesystem operations inside a held lock must be synchronous. Otherwise
 * flushSync could block the very event loop needed to release another lock.
 */
export function withStoreLock<T>(file: string, waitMs: number, action: () => T): T {
  const directory = file + '.locks';
  fs.mkdirSync(directory, { recursive: true });
  const owner = `${process.pid}-${randomUUID()}`;
  const ownPath = path.join(directory, owner);
  fs.mkdirSync(ownPath);
  const deadline = performance.now() + waitMs;
  const contenders = (): { owner: string; ticket?: number }[] => {
    const result: { owner: string; ticket?: number }[] = [];
    for (const name of fs.readdirSync(directory)) {
      if (!/^\d+-[a-f0-9-]+$/.test(name)) throw new Error(`Unrecognized lock entry: ${name}`);
      const location = path.join(directory, name);
      if (!alive(Number(name.split('-')[0]))) {
        // Only the dead process could ever write to this unique directory.
        fs.rmSync(location, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
        continue;
      }
      try {
        const text = fs.readFileSync(path.join(location, 'ticket'), 'utf8');
        const ticket = Number(text);
        if (!Number.isSafeInteger(ticket) || ticket <= 0) throw new Error('Invalid persistence lock ticket');
        result.push({ owner: name, ticket });
      } catch (error) {
        if (code(error) !== 'ENOENT' && !(process.platform === 'win32' &&
            ['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? ''))) throw error;
        if (fs.existsSync(location)) result.push({ owner: name });
      }
    }
    return result;
  };
  try {
    const ticket = Math.max(0, ...contenders().map(c => c.ticket ?? 0)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Persistence lock ticket overflow');
    fs.writeFileSync(path.join(ownPath, 'choosing'), String(ticket), { flag: 'wx' });
    rename(path.join(ownPath, 'choosing'), path.join(ownPath, 'ticket'));
    for (;;) {
      const blocked = contenders().some(c => c.owner !== owner && (
        c.ticket === undefined || c.ticket < ticket || (c.ticket === ticket && c.owner < owner)
      ));
      if (!blocked) return action();
      if (performance.now() >= deadline) throw new StoreBusyError();
      Atomics.wait(sleepBuffer, 0, 0, Math.min(10, Math.max(1, deadline - performance.now())));
    }
  } finally {
    fs.rmSync(ownPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
}

/** Atomic replacement; never reuse or clean up another writer's staging file. */
export function atomicWrite(file: string, data: string): void {
  const staging = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(staging, 'wx');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    rename(staging, file);
  } finally {
    try { fs.unlinkSync(staging); }
    catch (error) { if (code(error) !== 'ENOENT') console.error('AI Effort Tracker staging cleanup failed', error); }
  }
}

/**
 * Flush directory entries where supported. Windows does not expose directory
 * fsync through Node. A failure after rename is a durability warning, NOT a
 * failed transaction: retrying its deltas would count the same effort twice.
 */
export function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(code(error) ?? ''))) {
      console.error('AI Effort Tracker directory durability warning', error);
    }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export interface LoadedJson<T> {
  value: T;
  raw?: string;
  recoveredFrom?: string;
}

function historyFiles(file: string): string[] {
  const directory = file + '.history';
  try {
    return fs.readdirSync(directory).filter(n => /^(hour|day)-[\dT-]+\.json$/.test(n))
      .sort((a, b) => b.slice(b.indexOf('-') + 1).localeCompare(a.slice(a.indexOf('-') + 1)))
      .map(n => path.join(directory, n));
  } catch (error) {
    if (code(error) === 'ENOENT') return [];
    throw error;
  }
}

/** Read-only recovery selection. Permission/I/O failures must never become an empty store. */
export function readStore<T>(file: string, decode: (raw: string) => T, empty: () => T): LoadedJson<T> {
  let mainExists = false;
  let invalid = false;
  const candidates = [file, file + '.bak', ...historyFiles(file)];
  for (const candidate of candidates) {
    let raw: string;
    try { raw = fs.readFileSync(candidate, 'utf8'); }
    catch (error) {
      if (code(error) === 'ENOENT') continue;
      throw error;
    }
    if (candidate === file) mainExists = true;
    try {
      return { value: decode(raw), raw, ...(candidate !== file ? { recoveredFrom: candidate } : {}) };
    } catch { invalid = true; }
  }
  if (mainExists || invalid) {
    throw new Error('No readable AI Effort Tracker data or recovery copy. Existing files were left untouched.');
  }
  return { value: empty() };
}

/**
 * Before committing, retain the previous main as .bak and a sampled history:
 * 24 hourly + 7 daily checkpoints. Frequent 2s saves cannot exhaust history.
 * Must be called under the lock, and before the main-file commit point.
 */
export function retainPrevious(file: string, raw: string): void {
  const directory = file + '.history';
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString();
  for (const name of [`hour-${stamp.slice(0, 13)}.json`, `day-${stamp.slice(0, 10)}.json`]) {
    const target = path.join(directory, name);
    if (!fs.existsSync(target)) atomicWrite(target, raw);
  }
  for (const [prefix, limit] of [['hour-', 24], ['day-', 7]] as const) {
    const files = fs.readdirSync(directory).filter(n => n.startsWith(prefix) && n.endsWith('.json')).sort().reverse();
    for (const name of files.slice(limit)) fs.unlinkSync(path.join(directory, name));
  }
  atomicWrite(file + '.bak', raw);
  syncDirectory(directory);
}
