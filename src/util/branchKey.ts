/**
 * Branch identity per repository (#154).
 *
 * Tracked branches are stored under a composite key `"<repoId>::<branch>"` so
 * `main` in two repositories stays two branches. Git forbids `:` in branch
 * names, so the LAST `::` always separates the repo from the branch, even when
 * the repo id is a Windows path such as `C:\src\app`. Keys without `::` are
 * legacy entries from before #154 (repository unknown) or the reserved
 * `unknown` bucket.
 */
export const BRANCH_KEY_SEP = '::';

export function branchKey(repoId: string | null | undefined, name: string): string {
  return repoId ? `${repoId}${BRANCH_KEY_SEP}${name}` : name;
}

export function parseBranchKey(key: string): { repoId: string | null; name: string } {
  const i = key ? key.lastIndexOf(BRANCH_KEY_SEP) : -1;
  return i < 0 ? { repoId: null, name: key } : { repoId: key.slice(0, i), name: key.slice(i + BRANCH_KEY_SEP.length) };
}

/** Git branch name of a key (the key itself for legacy keys). */
export function branchNameOf(key: string): string {
  return parseBranchKey(key).name;
}

/** Repository of a key, or null for legacy keys. */
export function repoOfKey(key: string): string | null {
  return parseBranchKey(key).repoId;
}

/**
 * Groups of branch keys of the same repository whose names differ only by
 * case (#159), e.g. `UAT-Integration` / `UAT-integration`. Legacy keys (no
 * repository) form their own group; different repositories never match.
 */
export function caseVariantBranchGroups(keys: Iterable<string>): string[][] {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const { repoId, name } = parseBranchKey(key);
    const id = `${repoId ?? ''}\u0000${name.toLowerCase()}`;
    groups.set(id, [...(groups.get(id) ?? []), key]);
  }
  return [...groups.values()].filter(g => g.length > 1).map(g => g.sort());
}

/** Repo filter value for branches tracked before #154 (repository unknown). */
export const LEGACY_REPO = '__legacy__';

/**
 * Whether a stored branch key belongs to the repo filter (#155): '' matches
 * everything, {@link LEGACY_REPO} matches keys without a repository (and rows
 * without a branch), any other value matches that repository id exactly.
 */
export function repoMatches(key: string | null | undefined, repoFilter: string | null | undefined): boolean {
  if (!repoFilter) return true;
  const repo = key ? repoOfKey(key) : null;
  return repoFilter === LEGACY_REPO ? repo === null : repo === repoFilter;
}

/** Short repository name: last segment of `host/owner/repo` or of a folder path. */
export function repoLabel(repoId: string | null | undefined): string {
  if (!repoId) return '';
  const parts = repoId.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? repoId;
  try { return decodeURIComponent(last); } catch { return last; }
}

/** Readable branch: `main (my-repo)` for keys, the plain name for legacy keys. */
export function branchLabel(key: string): string {
  const { repoId, name } = parseBranchKey(key);
  return repoId ? `${name} (${repoLabel(repoId)})` : name;
}

/**
 * Whether filter `ref` selects the stored branch `key`: a full key matches
 * exactly, a plain name matches that branch in every repository.
 */
export function branchMatches(key: string | null | undefined, ref: string): boolean {
  if (!key) return false;
  return key === ref || (repoOfKey(ref) === null && branchNameOf(key) === ref);
}

/**
 * Whether branch `name` of repository `repoId` is among `refs` (store keys or
 * plain names). Used by the review store, which keys coverage by plain name.
 */
export function refsInclude(refs: Iterable<string>, repoId: string, name: string): boolean {
  const key = branchKey(repoId, name);
  for (const r of refs) if (r === name || r === key) return true;
  return false;
}

/**
 * Workspace folder whose repository is being worked on: the deepest folder that
 * contains the active file, else the last picked folder (still open), else the
 * first folder. Paths compare case-insensitively with either slash style.
 */
export function pickRepoFolder(activeFile: string | undefined, folders: readonly string[], last?: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (activeFile) {
    const file = norm(activeFile);
    const owner = folders
      .filter(f => file === norm(f) || file.startsWith(norm(f) + '/'))
      .sort((a, b) => norm(b).length - norm(a).length)[0];
    if (owner) return owner;
  }
  if (last && folders.includes(last)) return last;
  return folders[0];
}

/**
 * Resolve a branch reference (a full key or a plain git branch name) against
 * the stored keys: an exact key wins, then a key of `preferRepo`, then the only
 * key with that name, then a legacy key equal to the name.
 */
export function resolveBranchRef(ref: string, keys: Iterable<string>, preferRepo?: string | null): string | undefined {
  const all = [...keys];
  if (all.includes(ref)) return ref;
  if (repoOfKey(ref) !== null) return undefined;
  const matches = all.filter(k => repoOfKey(k) !== null && branchNameOf(k) === ref);
  if (preferRepo) {
    const own = matches.find(k => repoOfKey(k) === preferRepo);
    if (own) return own;
  }
  return matches.length === 1 ? matches[0] : undefined;
}
