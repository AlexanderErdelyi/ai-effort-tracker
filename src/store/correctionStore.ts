import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, readStore, retainPrevious, withStoreLock } from './persistence';
import {
  CORRECTIONS_FILE, decodeCorrectionStore, deltaIsEmpty, emptyCorrectionStore, mergeCorrectionDelta,
  type CorrectionDelta, type CorrectionStoreData
} from '../analysis/corrections';

/**
 * Durable store of captured corrections (#131), separate from the effort store.
 * Each window's changes are merged into the LATEST file under the interprocess
 * lock (read → merge → atomic write), keeping .bak and history copies, so two
 * VS Code windows never overwrite each other's corrections.
 */
export class CorrectionStore {
  readonly file: string;
  private cache: { stamp: string; data: CorrectionStoreData } | undefined;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.file = path.join(storageDir, CORRECTIONS_FILE);
  }

  private stamp(): string {
    try { const st = fs.statSync(this.file); return `${st.mtimeMs}|${st.size}`; } catch { return 'missing'; }
  }

  load(): CorrectionStoreData {
    const stamp = this.stamp();
    if (this.cache && this.cache.stamp === stamp) return this.cache.data;
    const data = readStore(this.file, decodeCorrectionStore, emptyCorrectionStore).value;
    this.cache = { stamp, data };
    return data;
  }

  apply(delta: CorrectionDelta, now = Date.now()): CorrectionStoreData {
    if (deltaIsEmpty(delta)) return this.load();
    return withStoreLock(this.file, 5000, () => {
      const loaded = readStore(this.file, decodeCorrectionStore, emptyCorrectionStore);
      const data = mergeCorrectionDelta(loaded.value, delta, now);
      const serialized = JSON.stringify(data);
      if (serialized === loaded.raw) return data;
      if (loaded.raw !== undefined && !loaded.recoveredFrom) retainPrevious(this.file, loaded.raw);
      atomicWrite(this.file, serialized);
      this.cache = { stamp: this.stamp(), data };
      return data;
    });
  }
}
