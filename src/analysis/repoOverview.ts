/**
 * Repository overview (#155): tracked branches grouped by repository, with
 * per-repo totals that are exactly the sum of their branches. Pure: no vscode
 * import, so it is shared by the extension, the MCP server and the tests.
 */
import { LEGACY_REPO, repoLabel } from '../util/branchKey';

/** The BranchSummary fields the overview reads. */
export interface RepoBranchInput {
  branch: string;
  repoId: string | null;
  name: string;
  workItemId: string | null;
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  estimatedCostUsd: number;
  creditsTotal: number;
}

export interface RepoProjectRef {
  id: string;
  name: string;
  repos: string[];
}

export interface RepoTotals {
  humanMs: number;
  aiMs: number;
  reviewMs: number;
  activeMs: number;
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  costUsd: number;
  credits: number;
}

export interface RepoBranchRow extends RepoTotals {
  branch: string;
  name: string;
  workItemId: string | null;
}

export interface RepoRow extends RepoTotals {
  /** Repository id, or {@link LEGACY_REPO} for branches tracked before #154. */
  repoId: string;
  label: string;
  legacy: boolean;
  /** Projects that list this repository. */
  projects: { id: string; name: string }[];
  branches: RepoBranchRow[];
}

export const LEGACY_REPO_LABEL = 'Unknown repository (older branches)';

function zero(): RepoTotals {
  return { humanMs: 0, aiMs: 0, reviewMs: 0, activeMs: 0, linesHumanAdded: 0, linesHumanDeleted: 0, linesAiAdded: 0, linesAiDeleted: 0, costUsd: 0, credits: 0 };
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function branchRow(b: RepoBranchInput): RepoBranchRow {
  const humanMs = n(b.humanCodingMs), aiMs = n(b.aiGeneratingMs), reviewMs = n(b.reviewingMs);
  return {
    branch: b.branch, name: b.name, workItemId: b.workItemId,
    humanMs, aiMs, reviewMs, activeMs: humanMs + aiMs + reviewMs,
    linesHumanAdded: n(b.linesHumanAdded), linesHumanDeleted: n(b.linesHumanDeleted),
    linesAiAdded: n(b.linesAiAdded), linesAiDeleted: n(b.linesAiDeleted),
    costUsd: n(b.estimatedCostUsd), credits: n(b.creditsTotal),
  };
}

const TOTAL_KEYS = Object.keys(zero()) as (keyof RepoTotals)[];

function add(t: RepoTotals, r: RepoTotals): void {
  for (const k of TOTAL_KEYS) t[k] += r[k];
}

/**
 * Group branches by repository. Every repo a project links is listed even
 * without tracked branches; branches without a repository land in one legacy
 * row. Rows sort by active time (legacy last), branches likewise.
 */
export function buildRepoOverview(
  branches: readonly RepoBranchInput[],
  projects: readonly RepoProjectRef[] = [],
  opts: { includeRepos?: readonly string[] } = {},
): RepoRow[] {
  const rows = new Map<string, RepoRow>();
  const row = (repoId: string): RepoRow => {
    let r = rows.get(repoId);
    if (!r) {
      const legacy = repoId === LEGACY_REPO;
      r = {
        repoId, legacy, label: legacy ? LEGACY_REPO_LABEL : repoLabel(repoId),
        projects: legacy ? [] : projects.filter(p => p.repos.includes(repoId)).map(p => ({ id: p.id, name: p.name })),
        branches: [], ...zero(),
      };
      rows.set(repoId, r);
    }
    return r;
  };
  for (const p of projects) for (const repo of p.repos) if (repo) row(repo);
  for (const repo of opts.includeRepos ?? []) if (repo) row(repo);
  for (const b of branches) {
    const r = row(b.repoId || LEGACY_REPO);
    const br = branchRow(b);
    r.branches.push(br);
    add(r, br);
  }
  const byActive = (a: RepoTotals & { label?: string; name?: string }, b: RepoTotals & { label?: string; name?: string }) =>
    b.activeMs - a.activeMs || b.credits - a.credits || String(a.label ?? a.name).localeCompare(String(b.label ?? b.name));
  const out = [...rows.values()];
  for (const r of out) r.branches.sort(byActive);
  return out.sort((a, b) => Number(a.legacy) - Number(b.legacy) || byActive(a, b));
}
