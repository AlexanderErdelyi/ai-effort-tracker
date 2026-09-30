import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, readStore, retainPrevious, withStoreLock } from '../store/persistence';
import { decodeReviewStore, emptyRepoReview, emptyReviewStore, REVIEW_FILE, type RepoReview, type ReviewStoreData } from '../analysis/review';

/**
 * Durable review-mark store (#106), separate from the effort store so a large
 * mark set never slows effort saves. Every change is applied to the LATEST file
 * under the interprocess lock (read → change → atomic write), so two VS Code
 * windows marking at the same time never overwrite each other. The previous
 * version is kept as .bak plus hourly/daily history, and loading falls back to
 * those copies when the main file is damaged.
 */
export class ReviewStore {
  readonly file: string;
  private cache: { stamp: string; data: ReviewStoreData } | undefined;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.file = path.join(storageDir, REVIEW_FILE);
  }

  private stamp(): string {
    try { const st = fs.statSync(this.file); return `${st.mtimeMs}|${st.size}`; } catch { return 'missing'; }
  }

  /** Current data (cached until the file changes, e.g. from another window). */
  load(): ReviewStoreData {
    const stamp = this.stamp();
    if (this.cache && this.cache.stamp === stamp) return this.cache.data;
    const data = readStore(this.file, decodeReviewStore, emptyReviewStore).value;
    this.cache = { stamp, data };
    return data;
  }

  repo(repoId: string): RepoReview {
    return this.load().repos[repoId] ?? emptyRepoReview();
  }

  /** Apply `change` to the latest repo entry and persist it atomically. */
  updateRepo(repoId: string, change: (repo: RepoReview) => RepoReview): RepoReview {
    return withStoreLock(this.file, 5000, () => {
      const loaded = readStore(this.file, decodeReviewStore, emptyReviewStore);
      const data = loaded.value;
      const next = change(data.repos[repoId] ?? emptyRepoReview());
      data.repos[repoId] = next;
      const serialized = JSON.stringify(data);
      if (serialized === loaded.raw) return next;
      if (loaded.raw !== undefined && !loaded.recoveredFrom) retainPrevious(this.file, loaded.raw);
      atomicWrite(this.file, serialized);
      this.cache = { stamp: this.stamp(), data };
      return next;
    });
  }
}
