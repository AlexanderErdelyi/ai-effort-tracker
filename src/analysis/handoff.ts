import type { LedgerEntry, UsageData } from '../store/database';
import { branchNameOf } from '../util/branchKey';

/**
 * Chat handoff (issue #100). Pure builder for a "continue in a new chat" prompt
 * from what the tracker recorded about a chat session: work item, branch, files
 * edited, models and context size. Prompt excerpts and commits are passed in by
 * the caller (read on demand, never stored).
 */

export interface HandoffInput {
  sessionId: string;
  /** Chat title shown by VS Code, if known. */
  title?: string;
  /** Current branch, used when the chat's rows have none. */
  branch?: string;
  /** Recent commits on the branch ("abc1234 message"), newest first. */
  commits?: string[];
  /** First and last user prompts (only when the user allows excerpts). */
  firstPrompt?: string;
  lastPrompt?: string;
  /** Workspace root, to show file paths relative to it. */
  workspaceRoot?: string;
  maxFiles?: number;
}

export interface HandoffFile { path: string; added: number; removed: number; edits: number }

export interface HandoffFacts {
  sessionId: string;
  title: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
  externalRef: string | null;
  branch: string | null;
  turns: number;
  credits: number;
  models: string[];
  contextTokens: number;
  files: HandoffFile[];
  moreFiles: number;
  commits: string[];
}

export interface Handoff { facts: HandoffFacts; prompt: string }

const MAX_EXCERPT = 400;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n).trimEnd() + '\u2026' : s;

function relative(file: string, root?: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const f = norm(file);
  if (!root) return f;
  const r = norm(root).replace(/\/+$/, '') + '/';
  return f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f;
}

function mostCommon(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

function lastContext(rows: LedgerEntry[]): number {
  let ts = -Infinity, tokens = 0;
  for (const r of rows) {
    for (const q of r.debugUsage?.requests ?? []) {
      if (q.subagent) continue;
      const t = q.ts ?? r.ts;
      if (t >= ts && Number.isFinite(q.inputTokens)) { ts = t; tokens = q.inputTokens; }
    }
  }
  return tokens;
}

export function handoffFacts(data: UsageData, input: HandoffInput): HandoffFacts {
  const rows = (data.creditLedger ?? []).filter(r => r.chatSessionId === input.sessionId || r.debugUsage?.sessionId === input.sessionId);
  const workItemId = mostCommon(rows.map(r => r.workItemId && r.workItemId !== '__unassigned__' ? r.workItemId : null));
  const wi = workItemId ? data.workItems?.[workItemId] : undefined;
  const files = new Map<string, HandoffFile>();
  for (const r of rows) {
    for (const f of r.analysis?.files ?? []) {
      if (!f?.path) continue;
      const key = relative(f.path, input.workspaceRoot);
      const cur = files.get(key) ?? { path: key, added: 0, removed: 0, edits: 0 };
      cur.added += f.added || 0; cur.removed += f.removed || 0; cur.edits += f.edits || 0;
      files.set(key, cur);
    }
  }
  const sorted = [...files.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path));
  const max = input.maxFiles ?? 15;
  const credits = rows.reduce((a, r) => a + (Number.isFinite(r.credits) ? r.credits : 0), 0);
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))];
  return {
    sessionId: input.sessionId,
    title: input.title ? clip(flat(input.title), 120) : null,
    workItemId,
    workItemTitle: wi?.title ?? null,
    externalRef: wi?.externalRef ?? null,
    branch: mostCommon(rows.map(r => r.branch && r.branch !== 'unknown' ? r.branch : null)) ?? (input.branch && input.branch !== 'unknown' ? input.branch : null),
    turns: rows.length,
    credits: Math.round(credits * 100) / 100,
    models,
    contextTokens: lastContext(rows),
    files: sorted.slice(0, max),
    moreFiles: Math.max(0, sorted.length - max),
    commits: (input.commits ?? []).map(c => clip(flat(c), 120)).filter(Boolean).slice(0, 8)
  };
}

export function buildHandoffPrompt(f: HandoffFacts, prompts: { first?: string; last?: string } = {}): string {
  const lines: string[] = [];
  const ctx = f.contextTokens ? ` (its context had grown to about ${Math.round(f.contextTokens / 1000)}K tokens)` : '';
  lines.push(`I'm continuing work from a previous Copilot chat${f.title ? ` "${f.title}"` : ''}${ctx}. Handoff summary:`);
  lines.push('');
  if (f.workItemId) {
    lines.push(`- Work item: #${f.workItemId}${f.workItemTitle ? ` ${f.workItemTitle}` : ''}${f.externalRef ? ` (${f.externalRef})` : ''}`);
  }
  if (f.branch) lines.push(`- Branch: ${branchNameOf(f.branch)}`);
  if (f.files.length) {
    lines.push('- Files changed in that chat:');
    for (const x of f.files) lines.push(`  - ${x.path} (+${x.added}/-${x.removed})`);
    if (f.moreFiles) lines.push(`  - \u2026and ${f.moreFiles} more`);
  }
  if (f.commits.length) {
    lines.push('- Recent commits on the branch:');
    for (const c of f.commits) lines.push(`  - ${c}`);
  }
  const first = prompts.first ? clip(flat(prompts.first), MAX_EXCERPT) : '';
  const last = prompts.last ? clip(flat(prompts.last), MAX_EXCERPT) : '';
  if (first) lines.push(`- The chat started with: "${first}"`);
  if (last && last !== first) lines.push(`- My last request was: "${last}"`);
  lines.push('');
  lines.push('Read the changed files you need instead of assuming their content. Briefly confirm the current state, then continue with: ');
  return lines.join('\n');
}

export function buildHandoff(data: UsageData, input: HandoffInput): Handoff {
  const facts = handoffFacts(data, input);
  return { facts, prompt: buildHandoffPrompt(facts, { first: input.firstPrompt, last: input.lastPrompt }) };
}
