import * as fs from 'fs';
import * as readline from 'readline';
import type { UsageData } from '../store/database';
import { readStore } from '../store/persistence';
import {
  listSessions, optimizationFindings, sessionDetail, usageOverview, workItemUsage, type InsightFilter
} from '../analysis/usageInsights';
import { promptExcerpts, SessionTitleResolver, storageRoots } from '../util/sessionTitles';
import { BUDGET_SNAPSHOT_FILE } from '../analysis/budget';
import { HEALTH_SNAPSHOT_FILE } from '../analysis/dataHealth';
import { CATEGORY_RULES_SNAPSHOT_FILE, defaultClassifier, modelEfficiency, toolProfile } from '../analysis/efficiency';
import { categorizeWith, sanitizeRules } from '../util/categoryRules';
import { ESTIMATION_SNAPSHOT_FILE, estimateAccuracy, suggestEstimate, type EstimationItem } from '../analysis/estimation';
import { decodeReviewStore, emptyReviewStore, REVIEW_FILE, reviewIssues, reviewStatus, type ReviewIssuesIo } from '../analysis/review';
import { reviewMark, reviewResolveIssue, type ResolveAction, type ReviewMarkArgs, type ReviewMarkIo } from '../analysis/reviewMark';
import { ReviewStore } from '../review/reviewStore';
import { CORRECTIONS_FILE, decodeCorrectionStore, emptyCorrectionStore, listCorrections, type CorrectionKind } from '../analysis/corrections';
import { changedFilesSync, contentAtSync, resolveReviewBaseSync } from '../review/reviewGit';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

export { promptExcerpts };

function loadReviewStore() {
  const file = process.env.AET_STORE_PATH ? path.join(path.dirname(process.env.AET_STORE_PATH), REVIEW_FILE) : '';
  if (!file || !fs.existsSync(file)) return emptyReviewStore();
  return readStore(file, decodeReviewStore, emptyReviewStore).value;
}

function loadCorrectionStore() {
  const file = process.env.AET_STORE_PATH ? path.join(path.dirname(process.env.AET_STORE_PATH), CORRECTIONS_FILE) : '';
  if (!file || !fs.existsSync(file)) return emptyCorrectionStore();
  return readStore(file, decodeCorrectionStore, emptyCorrectionStore).value;
}

/** Read-only access to the working tree for `review_issues`. */
const reviewFileIo: ReviewIssuesIo = {
  exists: dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } },
  readFile: abs => {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 1_500_000) return null;
      const buf = fs.readFileSync(abs);
      return buf.includes(0) ? null : buf.toString('utf8');
    } catch { return null; }
  },
  currentBranch: root => {
    try {
      const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return b && b !== 'HEAD' ? b : null;
    } catch { return null; }
  }
};

/** Git and store access for `review_mark` / `review_resolve_issue`, the only tools that write (review marks, never the effort store). */
const reviewMarkIo: ReviewMarkIo = {
  ...reviewFileIo,
  resolveBase: resolveReviewBaseSync,
  changedFiles: changedFilesSync,
  contentAt: contentAtSync,
  update: (repoId, change) => {
    if (!process.env.AET_STORE_PATH) throw new Error('AET_STORE_PATH is not set.');
    new ReviewStore(path.dirname(process.env.AET_STORE_PATH)).updateRepo(repoId, change);
  },
  now: () => Date.now(),
  newId: () => randomUUID()
};

/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing usage
 * insights to AI assistants. Started by VS Code through the extension's MCP
 * server definition provider. Never writes the effort store; only `review_mark`
 * and `review_resolve_issue` write review marks. Prompt text is read on
 * demand from Copilot's own local debug logs and only returned, never stored.
 */

const SERVER = { name: 'ai-effort-tracker', version: process.env.AET_VERSION || '0.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
let resolver: SessionTitleResolver | undefined;
const titles = () => resolver ??= new SessionTitleResolver(storageRoots(process.env.AET_WORKSPACE_STORAGE));

type Json = Record<string, unknown>;

const filterProps: Json = {
  days: { type: 'number', description: 'Look-back window in days (default 30). Ignored when "from" is set.' },
  from: { type: 'string', description: 'ISO date/time start (optional).' },
  to: { type: 'string', description: 'ISO date/time end (optional, default now).' },
  branch: { type: 'string', description: 'Only this git branch.' },
  workItemId: { type: 'string', description: 'Only this work item (see list_work_items).' },
  projectId: { type: 'string', description: 'Only this project.' },
  sessionId: { type: 'string', description: 'Only this Copilot chat session.' }
};

export const TOOLS = [
  {
    name: 'usage_overview',
    title: 'Copilot usage overview',
    description: 'Credits, calls, tokens and cache-hit rate by model, agent, reasoning effort and subagents; cache breaks by cause with estimated waste; enabled vs. used tools/MCP servers. Start here.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'optimization_findings',
    title: 'Copilot optimization findings',
    description: 'Ranked, evidence-backed recommendations to reduce credit usage: model switches, prompt-cache expiry, unused/duplicate MCP tools, tool_search rounds, failing tools, expensive models on light turns, long chats, reasoning effort, subagents. Credits at stake are estimates.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'list_work_items',
    title: 'Credits and budgets per work item',
    description: 'Work items with credits, sessions, branches and models in the period, plus budget status where known (state ok/warning/over/unestimated, worst dimension and percent, time/credit/money budget vs used, 7-day burn rate and projected run-out). Budget status is all-time and as of budgetAsOf. Use to choose a workItemId scope.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'list_sessions',
    title: 'Recent chat sessions',
    description: 'Copilot chat sessions (newest first) with turns, credits, duration, models, max context, cache-hit rate, lines changed, avoidable cache breaks and an expensiveLowOutput flag (top-quartile credits but < 10 lines changed). With includeTitles, adds the chat title VS Code shows (or the first prompt), read on demand from local files and never stored.',
    inputSchema: {
      type: 'object',
      properties: {
        ...filterProps,
        limit: { type: 'number', description: 'Max sessions (1-100, default 20).' },
        includeTitles: { type: 'boolean', description: 'Add each chat\'s title (default false).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'session_detail',
    title: 'Chat session detail',
    description: 'Per-turn breakdown of one chat session: credits, models, effort, tools, files edited and cache breaks. With includePrompts, adds short excerpts of the user prompts read from Copilot\'s local debug log (if it still exists) to judge topic changes and whether a cheaper model would do.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Chat session id (see list_sessions).' },
        includePrompts: { type: 'boolean', description: 'Add user-prompt excerpts (default false).' },
        promptChars: { type: 'number', description: 'Excerpt length, 50-1000 (default 300).' }
      },
      required: ['sessionId'],
      additionalProperties: false
    }
  },
  {
    name: 'model_efficiency',
    title: 'Model efficiency per task type',
    description: 'Per model × task type (file category with the most changed lines in the turn, or "qa" for Q&A / read-only turns): turns, credits, credits per turn, credits per 100 added lines, cache hit and output tokens; plus the cheapest model with enough samples per task type and estimated savings. Use to decide which model to pick for which kind of work.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'tool_profile',
    title: 'Tool-set profile',
    description: 'For a project, work item or period: every MCP server / built-in tool group offered to Copilot vs actually called (calls, turns, tools used, last used, definition size), with a recommended minimal set (keep / disable / review), tokens saved per request and estimated credits saved.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'suggest_estimate',
    title: 'Suggest an estimate from history',
    description: 'Suggests hours and credits for new work from finished work items (marked done, or untouched for 14 days) with similar titles, the same project or the same main category. Returns the P25/median/P75 range, the comparables used and the historical bias (actual ÷ estimate). Pass workItemId to estimate an existing item, or title/projectId for new work.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string', description: 'Existing work item to estimate (its title and project are used).' },
        title: { type: 'string', description: 'Title or short description of the new work.' },
        projectId: { type: 'string', description: 'Project of the new work.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Expected main categories, e.g. ["programming"].' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'estimate_accuracy',
    title: 'Estimation accuracy',
    description: 'How accurate hour estimates of finished work items were: median actual ÷ estimate, share within ±20 %, over/under shares, mean absolute error, grouped by project, size and month, per-category factors and the biggest misses. A factor of 1.4 means work took 40 % longer than estimated.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Only this project.' } },
      additionalProperties: false
    }
  },
  {
    name: 'data_health',
    title: 'Data health check',
    description: 'Whether the tracked data is complete and consistent: save errors, backups, schema, invalid numbers, duplicate credit rows, references to deleted items, time and credits without a work item, work items without project or estimate, projects without rates, unpriced model calls, missing token prices, future timestamps and days with more than 16 h. Each problem has a severity, count, examples and the extension command that fixes it. Check this before trusting totals or ROI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'review_status',
    title: 'Code review coverage',
    description: 'How much of the changed code (since the merge-base with the default branch) the developer has marked as reviewed in VS Code, per work item and branch: reviewed vs changed lines, files left to review and open review issues with their notes. Without arguments: overview of all work items, plus finished work items that are not fully reviewed. Use it to check whether AI-generated code was reviewed before a work item is closed.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string', description: 'Detail for this work item (all its branches).' },
        branch: { type: 'string', description: 'Detail for this git branch.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'review_issues',
    title: 'Open code review issues to fix',
    description: 'Code the developer flagged as a review issue in VS Code ("⚑ Flag issue"), read live from the files on disk: file, absolute path, current start/end line, the developer\'s note and a numbered code excerpt (flagged lines marked ">"). Call this when asked to fix review issues or review findings, then fix each one at its location. Issues only present on another branch are listed under onOtherBranches.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string', description: 'Only issues in files changed on the branches of this work item.' },
        branch: { type: 'string', description: 'Only issues in files changed on this git branch.' },
        path: { type: 'string', description: 'Only files whose repository-relative path contains this text.' },
        contextLines: { type: 'number', description: 'Unflagged lines of code shown before and after each issue (0–10, default 3).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_corrections',
    title: 'Corrections of AI-written code',
    description: 'Changes made later to code that an AI edit wrote, captured in VS Code: the developer\'s own edits (source "human") and Copilot rework requested with a new prompt (source "ai"). Each correction has its kind (modify, insert, delete, move), file and line, the enclosing declaration, a short before/after snippet and, when known, the prompt that asked for the change (trigger) and the prompt that produced the original code (origin). Newest first, with counts by source, kind and file type, plus "episodes": the returned corrections grouped by the prompt that caused them (AI rework) or by one sitting of the developer\'s edits (human). One prompt that changes a requirement can rework dozens of lines, so judge AI rework per episode; the developer\'s own (human) corrections are the strongest signal of real mistakes. Use it to learn what the developer usually changes after AI programming (ordering, documentation, naming, checks, wrong facts) and to suggest coding rules.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string', description: 'Only corrections on branches of this work item.' },
        branch: { type: 'string', description: 'Only corrections on this git branch.' },
        path: { type: 'string', description: 'Only files whose relative path contains this text.' },
        repo: { type: 'string', description: 'Only this workspace folder (name contains this text).' },
        source: { type: 'string', enum: ['human', 'ai'], description: 'Only the developer\'s edits (human) or prompted Copilot rework (ai).' },
        kind: { type: 'string', enum: ['modify', 'insert', 'delete', 'move'], description: 'Only this kind of change.' },
        days: { type: 'number', description: 'Only the last N days.' },
        limit: { type: 'number', description: 'Maximum corrections returned (1–500, default 50).' }
      },
      additionalProperties: false
    }
  }
].map(t => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } as Json })).concat([{
  name: 'review_mark',
  title: 'Mark code as reviewed',
  description: 'Mark changed code as reviewed in the developer\'s VS Code review tracking, or remove review marks, or flag lines as a review issue. '
    + 'ONLY call this when the developer explicitly asks you to (e.g. "mark the specs as reviewed", "mark NOBJQMSyncMgt as reviewed", "unmark the page files"); never mark code you wrote or reviewed yourself on your own initiative. '
    + 'Select files with "paths" (repository-relative paths, folders, name fragments or globs like "app/specs/**" or "*.Table.al") and/or "category"; "all": true selects every changed file. '
    + 'Without a line range, status "reviewed" marks only the changed lines still to review and "clear" removes only reviewed marks (flagged issues stay). '
    + 'With startLine/endLine (one file) every non-blank line in the range is marked; "issue" needs a range and a "note". Use "dryRun": true to preview when the selection is unclear. '
    + 'Works on the files checked out now; returns the files and line ranges that were marked.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['reviewed', 'clear', 'issue'], description: 'reviewed (default), clear (remove marks) or issue (flag lines, needs startLine and note).' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files to mark: repository-relative paths, folders, name fragments or globs.' },
      category: { type: 'string', description: 'Only files of this effort category: programming, specification, documentation, translation, deployment, config or other.' },
      all: { type: 'boolean', description: 'Every changed file on the branch (combine with category to narrow).' },
      startLine: { type: 'number', description: '1-based first line (exactly one file must match).' },
      endLine: { type: 'number', description: '1-based last line (default startLine).' },
      note: { type: 'string', description: 'What is wrong (status issue).' },
      repo: { type: 'string', description: 'Repository (part of its remote URL or folder) when several are open.' },
      branch: { type: 'string', description: 'Use the folder that has this branch checked out.' },
      workItemId: { type: 'string', description: 'Use the folder that has a branch of this work item checked out.' },
      dryRun: { type: 'boolean', description: 'Only report what would be marked.' }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as Json
}, {
  name: 'review_resolve_issue',
  title: 'Report a review issue as fixed',
  description: 'Update a review issue the developer flagged in VS Code. After you fixed an issue from review_issues, call this with its issueId, action "fixed" (default), a one-line note of what you changed '
    + 'and startLine/endLine of the code you changed (line numbers in the file now): the issue then waits under "Fixed — to verify" in the developer\'s Review view with your change highlighted, so they can check your fix. '
    + 'Use action "reopen" to undo that. Use action "remove" (deletes the flag) ONLY when the developer explicitly asks to remove or dismiss the issue. '
    + 'Do not report an issue as fixed when you did not change the code for it.',
  inputSchema: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'issueId from review_issues.' },
      file: { type: 'string', description: 'Instead of issueId: path or name of a file with exactly one matching issue.' },
      action: { type: 'string', enum: ['fixed', 'reopen', 'remove'], description: 'fixed (default): fixed, waits for verification; reopen: open again; remove: delete the flag (only when asked).' },
      note: { type: 'string', description: 'What you changed to fix it (shown to the developer).' },
      startLine: { type: 'number', description: 'action fixed: 1-based first line of the code you changed for the fix, in the file now. Highlighted for the developer to verify.' },
      endLine: { type: 'number', description: 'action fixed: 1-based last line of the changed code (default startLine).' },
      repo: { type: 'string', description: 'Repository (part of its remote URL or folder) to narrow the search.' }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as Json
}]);

let cache: { stamp: string; data: UsageData } | undefined;

const record = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};

export function decodeUsageData(raw: string): UsageData {
  const s = JSON.parse(raw) as Json;
  if (!s || typeof s !== 'object') throw new Error('Invalid store');
  return {
    creditLedger: Array.isArray(s.creditLedger) ? s.creditLedger as UsageData['creditLedger'] : [],
    toolsets: record(s.toolsets) as UsageData['toolsets'],
    modelPrices: record(s.modelPrices) as UsageData['modelPrices'],
    branches: record(s.branches) as UsageData['branches'],
    workItems: record(s.workItems) as UsageData['workItems'],
    projects: record(s.projects) as UsageData['projects']
  };
}

function loadData(): UsageData {
  const file = process.env.AET_STORE_PATH;
  if (!file) throw new Error('AET_STORE_PATH is not set.');
  let stamp = 'missing';
  try { const st = fs.statSync(file); stamp = `${st.mtimeMs}|${st.size}`; } catch { /* recovery copies may exist */ }
  if (cache && cache.stamp === stamp && stamp !== 'missing') return cache.data;
  const data = readStore(file, decodeUsageData, () => decodeUsageData('{}')).value;
  cache = { stamp, data };
  return data;
}

function parseFilter(args: Json): InsightFilter {
  const f: InsightFilter = {};
  const time = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (!Number.isFinite(t)) throw new Error(`"${name}" must be an ISO date.`);
    return t;
  };
  if (typeof args.days === 'number' && args.days > 0) f.days = Math.min(args.days, 3650);
  f.from = time(args.from, 'from');
  f.to = time(args.to, 'to');
  for (const k of ['branch', 'workItemId', 'projectId', 'sessionId'] as const) {
    if (typeof args[k] === 'string' && args[k]) f[k] = args[k] as string;
  }
  for (const k of Object.keys(f) as (keyof InsightFilter)[]) if (f[k] === undefined) delete f[k];
  return f;
}

interface BudgetSnapshot { generatedAt?: string; workItems: Record<string, Json> }

let budgetCache: { stamp: string; value: BudgetSnapshot | null } | undefined;

/** Budget status written by the extension (it needs VS Code settings); null when absent. */
export function loadBudgetSnapshot(file = process.env.AET_STORE_PATH ? path.join(path.dirname(process.env.AET_STORE_PATH), BUDGET_SNAPSHOT_FILE) : ''): BudgetSnapshot | null {
  if (!file) return null;
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${file}|${st.mtimeMs}|${st.size}`; } catch { return null; }
  if (budgetCache?.stamp === stamp) return budgetCache.value;
  let value: BudgetSnapshot | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
    value = { generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined, workItems: record(raw.workItems) as Record<string, Json> };
  } catch { /* partial or corrupt snapshot: treat as absent */ }
  budgetCache = { stamp, value };
  return value;
}

const snapshotCache = new Map<string, { stamp: string; value: Json | null }>();

/** A JSON snapshot the extension writes next to the store; null when absent or unreadable. */
export function loadSnapshotFile(name: string, file = process.env.AET_STORE_PATH ? path.join(path.dirname(process.env.AET_STORE_PATH), name) : ''): Json | null {
  if (!file) return null;
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${st.mtimeMs}|${st.size}`; } catch { return null; }
  const hit = snapshotCache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value: Json | null = null;
  try { value = record(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* partial or corrupt: absent */ }
  snapshotCache.set(file, { stamp, value });
  return value;
}

function localDay(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const NO_ESTIMATION = 'No estimation snapshot yet (it is written by the extension about once a minute while VS Code runs).';

export function estimationTool(name: 'suggest_estimate' | 'estimate_accuracy', args: Json, snapshot = loadSnapshotFile(ESTIMATION_SNAPSHOT_FILE), today = localDay()): unknown {
  if (!snapshot) return { note: NO_ESTIMATION };
  const items = (Array.isArray(snapshot.items) ? snapshot.items : []) as EstimationItem[];
  const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
  if (name === 'estimate_accuracy') {
    const acc = estimateAccuracy(items, today, { projectId: str(args.projectId) });
    return { ...acc, rows: acc.rows.slice(0, 50), asOf: snapshot.generatedAt ?? null,
      ...(acc.overall ? {} : { note: 'No finished work items with an hour estimate yet. Mark work items done to measure accuracy.' }) };
  }
  const wi = str(args.workItemId) ? items.find(i => i.id === args.workItemId) : undefined;
  if (str(args.workItemId) && !wi) throw new Error(`Unknown work item "${args.workItemId}".`);
  const categories = Array.isArray(args.categories) ? args.categories.filter((c): c is string => typeof c === 'string') : undefined;
  return { ...suggestEstimate(items, { title: str(args.title) ?? wi?.title, projectId: str(args.projectId) ?? wi?.projectId, categories, excludeId: wi?.id }, today),
    asOf: snapshot.generatedAt ?? null };
}

export function listWorkItems(data: UsageData, filter: InsightFilter, snapshot = loadBudgetSnapshot()) {
  const rows: Json[] = workItemUsage(data, filter).slice(0, 100);
  if (!snapshot) return { workItems: rows, budgetNote: 'No budget snapshot yet (it is written by the extension about once a minute while VS Code runs).' };
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.workItemId as string | null;
    if (!id) continue;
    seen.add(id);
    if (snapshot.workItems[id]) row.budget = snapshot.workItems[id];
  }
  // At-risk work items without usage in the period are still worth knowing about.
  if (!filter.sessionId && !filter.branch) {
    for (const [id, budget] of Object.entries(snapshot.workItems)) {
      if (seen.has(id) || rows.length >= 100) continue;
      if (budget.state !== 'warning' && budget.state !== 'over') continue;
      if (filter.workItemId && filter.workItemId !== id) continue;
      const wi = data.workItems[id];
      if (filter.projectId && wi?.projectId !== filter.projectId) continue;
      rows.push({ workItemId: id, title: wi?.title ?? null, projectId: wi?.projectId ?? null, calls: 0, credits: 0, budget });
    }
  }
  return { workItems: rows, budgetAsOf: snapshot.generatedAt ?? null };
}

export function callTool(name: string, args: Json, data = loadData()): unknown {
  switch (name) {
    case 'usage_overview': return usageOverview(data, parseFilter(args));
    case 'optimization_findings': {
      const findings = optimizationFindings(data, parseFilter(args));
      return findings.length ? { findings } : { findings, note: 'No optimization opportunities detected in this period, or no debug-log usage was captured yet.' };
    }
    case 'list_work_items': return listWorkItems(data, parseFilter(args));
    case 'list_sessions': {
      const sessions = listSessions(data, parseFilter(args), typeof args.limit === 'number' ? args.limit : 20);
      if (args.includeTitles !== true) return { sessions };
      const t = titles();
      return { sessions: sessions.map(s => ({ ...s, title: t.title(s.sessionId) ?? null })) };
    }
    case 'session_detail': {
      const id = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!id) throw new Error('"sessionId" is required.');
      const detail = sessionDetail(data, id);
      if (!detail) throw new Error(`No captured usage for session "${id}". Use list_sessions to find ids.`);
      if (args.includePrompts !== true) return detail;
      const chars = Math.max(50, Math.min(1000, typeof args.promptChars === 'number' ? args.promptChars : 300));
      const file = titles().logFile(id);
      if (!file) return { ...detail, promptsNote: 'Copilot\'s debug log for this session no longer exists; prompts are unavailable.' };
      const prompts = promptExcerpts(file, chars);
      return { ...detail, turns: detail.turns.map(t => ({ ...t, prompt: prompts.get(t.turnId) ?? null })) };
    }
    case 'model_efficiency': {
      const rules = loadSnapshotFile(CATEGORY_RULES_SNAPSHOT_FILE);
      return modelEfficiency(data, parseFilter(args), defaultClassifier(sanitizeRules(record(rules?.rules) as never)));
    }
    case 'tool_profile': return toolProfile(data, parseFilter(args));
    case 'suggest_estimate':
    case 'estimate_accuracy': return estimationTool(name, args);
    case 'data_health': {
      const snap = loadSnapshotFile(HEALTH_SNAPSHOT_FILE);
      return snap?.report ?? { note: 'No health snapshot yet. Open VS Code with the AI Effort Tracker extension (it refreshes the check every minute) and try again.' };
    }
    case 'review_status': {
      const store = loadReviewStore();
      const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
      return reviewStatus(store, data.branches as Record<string, { workItemId?: string | null }>, data.workItems as Record<string, { title?: string | null; status?: string }>,
        { workItemId: str(args.workItemId), branch: str(args.branch) });
    }
    case 'list_corrections': {
      const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
      const numArg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      const source = args.source === 'human' || args.source === 'ai' ? args.source : undefined;
      const kind = ['modify', 'insert', 'delete', 'move'].includes(args.kind as string) ? args.kind as CorrectionKind : undefined;
      const result = listCorrections(loadCorrectionStore(), {
        workItemId: str(args.workItemId), branch: str(args.branch), path: str(args.path), repo: str(args.repo),
        source, kind, days: numArg(args.days), limit: numArg(args.limit)
      });
      return result.total ? result : { ...result, note: 'No corrections captured yet. They are recorded in VS Code when code an AI edit wrote is changed later (setting aiEffortTracker.corrections.enabled).' };
    }
    case 'review_issues': {
      const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
      return reviewIssues(loadReviewStore(), data.branches as Record<string, { workItemId?: string | null }>, data.workItems as Record<string, { title?: string | null; status?: string }>,
        { workItemId: str(args.workItemId), branch: str(args.branch), path: str(args.path), contextLines: typeof args.contextLines === 'number' ? args.contextLines : undefined },
        reviewFileIo);
    }
    case 'review_mark': {
      const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
      const numArg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      const status = str(args.status);
      if (status && status !== 'reviewed' && status !== 'clear' && status !== 'issue') throw new Error('"status" must be reviewed, clear or issue.');
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : typeof args.paths === 'string' ? [args.paths] : undefined;
      const rules = sanitizeRules(record(loadSnapshotFile(CATEGORY_RULES_SNAPSHOT_FILE)?.rules) as never);
      const markArgs: ReviewMarkArgs = {
        status: status as ReviewMarkArgs['status'], paths, category: str(args.category), all: args.all === true,
        startLine: numArg(args.startLine), endLine: numArg(args.endLine), note: str(args.note),
        repo: str(args.repo), branch: str(args.branch), workItemId: str(args.workItemId), dryRun: args.dryRun === true
      };
      return reviewMark(loadReviewStore(), data.branches as Record<string, { workItemId?: string | null }>, markArgs, rel => categorizeWith(rel, rules), reviewMarkIo);
    }
    case 'review_resolve_issue': {
      const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
      const action = str(args.action);
      if (action && action !== 'fixed' && action !== 'reopen' && action !== 'remove') throw new Error('"action" must be fixed, reopen or remove.');
      return reviewResolveIssue(loadReviewStore(),
        {
          issueId: str(args.issueId), file: str(args.file), action: action as ResolveAction | undefined, note: str(args.note), repo: str(args.repo),
          startLine: typeof args.startLine === 'number' ? args.startLine : undefined, endLine: typeof args.endLine === 'number' ? args.endLine : undefined
        }, reviewMarkIo);
    }
    default: throw new Error(`Unknown tool "${name}".`);
  }
}

interface Request { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }

export function handle(msg: Request): Json | undefined {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (typeof msg.method !== 'string') return isRequest ? fail(-32600, 'Invalid request') : undefined;
  if (!isRequest) return undefined;
  const params = record(msg.params);
  switch (msg.method) {
    case 'initialize': {
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'Analyses GitHub Copilot credit usage recorded by AI Effort Tracker. Call optimization_findings for ranked recommendations, usage_overview for the numbers, and session_detail (optionally with includePrompts) to inspect a chat. Credits at stake are estimates based on Copilot list prices.'
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Unknown tool "${name}".`);
      try {
        const result = callTool(name, record(params.arguments));
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // The client closed the pipe: nothing left to answer.
  process.stdout.on('error', () => process.exit(0));
  const send = (m: Json) => process.stdout.write(JSON.stringify(m) + '\n');
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const response = handle(record(m) as Request);
      if (response) send(response);
    }
  });
  rl.on('close', () => process.exit(0));
}

if (require.main === module) main();
