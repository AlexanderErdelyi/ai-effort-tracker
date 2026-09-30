/**
 * Grouping of the Review view's file list (pure, testable): by effort category
 * then folder, by folder only, or a flat list. Folder chains with a single
 * sub-folder are compacted ("app/src/x") like VS Code's compact folders.
 */

export type ReviewGroupBy = 'category' | 'folder' | 'none';

export interface ReviewTreeRow { path: string; total: number; reviewed: number; issueLines: number }

export interface ReviewTreeGroup<R extends ReviewTreeRow> {
  kind: 'group';
  /** Stable id (keeps the expanded state across refreshes). */
  id: string;
  type: 'category' | 'folder';
  label: string;
  /** Category key, or the full folder path for folders. */
  key: string;
  /** Common folder of a category's files when it was hoisted into the category row. */
  commonPath?: string;
  files: number;
  total: number;
  reviewed: number;
  issueLines: number;
  children: ReviewTreeNode<R>[];
}

export type ReviewTreeNode<R extends ReviewTreeRow> = ReviewTreeGroup<R> | { kind: 'file'; row: R };

interface Dir<R> { name: string; path: string; dirs: Map<string, Dir<R>>; files: R[] }

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function stats<R extends ReviewTreeRow>(nodes: readonly ReviewTreeNode<R>[]) {
  let files = 0, total = 0, reviewed = 0, issueLines = 0;
  for (const n of nodes) {
    if (n.kind === 'file') { files++; total += n.row.total; reviewed += n.row.reviewed; issueLines += n.row.issueLines; }
    else { files += n.files; total += n.total; reviewed += n.reviewed; issueLines += n.issueLines; }
  }
  return { files, total, reviewed, issueLines };
}

function folderNodes<R extends ReviewTreeRow>(dir: Dir<R>, idPrefix: string): ReviewTreeNode<R>[] {
  const out: ReviewTreeNode<R>[] = [];
  for (const sub of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
    let d = sub;
    let label = d.name;
    while (!d.files.length && d.dirs.size === 1) {
      d = [...d.dirs.values()][0];
      label += '/' + d.name;
    }
    const children = folderNodes(d, idPrefix);
    out.push({ kind: 'group', id: `${idPrefix}/${d.path}`, type: 'folder', label, key: d.path, ...stats(children), children });
  }
  for (const row of [...dir.files].sort((a, b) => byName(fileName(a.path), fileName(b.path)))) out.push({ kind: 'file', row });
  return out;
}

/** Folder tree of the given rows (paths are '/'-separated, repo-relative). */
export function folderTree<R extends ReviewTreeRow>(rows: readonly R[], idPrefix = 'f'): ReviewTreeNode<R>[] {
  const root: Dir<R> = { name: '', path: '', dirs: new Map(), files: [] };
  for (const row of rows) {
    const parts = row.path.split('/').filter(Boolean);
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = d.dirs.get(parts[i]);
      if (!next) d.dirs.set(parts[i], next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      d = next;
    }
    d.files.push(row);
  }
  return folderNodes(root, idPrefix);
}

/**
 * Build the Review view's file nodes. Category groups follow `categoryOrder`
 * (unknown categories last); a category whose files share one folder shows
 * that folder's contents directly, with the folder as `commonPath`.
 */
export function buildReviewTree<R extends ReviewTreeRow>(
  rows: readonly R[],
  groupBy: ReviewGroupBy,
  categoryOf: (path: string) => string,
  categoryLabel: (category: string) => string,
  categoryOrder: readonly string[] = [],
  idPrefix = 'open'
): ReviewTreeNode<R>[] {
  if (groupBy === 'none') return [...rows].sort((a, b) => byName(a.path, b.path)).map(row => ({ kind: 'file', row }));
  if (groupBy === 'folder') return folderTree(rows, idPrefix);
  const byCat = new Map<string, R[]>();
  for (const row of rows) {
    let cat: string;
    try { cat = categoryOf(row.path) || 'other'; } catch { cat = 'other'; }
    byCat.set(cat, [...(byCat.get(cat) ?? []), row]);
  }
  const rank = (c: string) => { const i = categoryOrder.indexOf(c); return i < 0 ? categoryOrder.length : i; };
  return [...byCat.keys()].sort((a, b) => rank(a) - rank(b) || byName(a, b)).map(cat => {
    let children = folderTree(byCat.get(cat)!, `${idPrefix}:${cat}`);
    let commonPath: string | undefined;
    if (children.length === 1 && children[0].kind === 'group') {
      commonPath = children[0].key;
      children = children[0].children;
    }
    return { kind: 'group', id: `${idPrefix}:${cat}`, type: 'category', label: categoryLabel(cat), key: cat, ...(commonPath ? { commonPath } : {}), ...stats(children), children };
  });
}
