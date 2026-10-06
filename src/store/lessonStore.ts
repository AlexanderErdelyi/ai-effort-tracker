import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, readStore, retainPrevious, withStoreLock } from './persistence';
import {
  decodeLessonStore, emptyLessonStore, lessonDeltaIsEmpty, LESSONS_FILE, mergeLessonDelta,
  type LessonDelta, type LessonStoreData
} from '../analysis/lessons';

/**
 * Durable store of coding rules (#133). Like the correction store, every
 * change is merged into the LATEST file under the interprocess lock with
 * .bak and history copies, so VS Code windows and the MCP server never
 * overwrite each other's rules.
 */
export class LessonStore {
  readonly file: string;
  private cache: { stamp: string; data: LessonStoreData } | undefined;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.file = path.join(storageDir, LESSONS_FILE);
  }

  private stamp(): string {
    try { const st = fs.statSync(this.file); return `${st.mtimeMs}|${st.size}`; } catch { return 'missing'; }
  }

  load(): LessonStoreData {
    const stamp = this.stamp();
    if (this.cache && this.cache.stamp === stamp) return this.cache.data;
    const data = readStore(this.file, decodeLessonStore, emptyLessonStore).value;
    this.cache = { stamp, data };
    return data;
  }

  apply(delta: LessonDelta): LessonStoreData {
    if (lessonDeltaIsEmpty(delta)) return this.load();
    return withStoreLock(this.file, 5000, () => {
      const loaded = readStore(this.file, decodeLessonStore, emptyLessonStore);
      const data = mergeLessonDelta(loaded.value, delta);
      const serialized = JSON.stringify(data);
      if (serialized === loaded.raw) return data;
      if (loaded.raw !== undefined && !loaded.recoveredFrom) retainPrevious(this.file, loaded.raw);
      atomicWrite(this.file, serialized);
      this.cache = { stamp: this.stamp(), data };
      return data;
    });
  }
}
