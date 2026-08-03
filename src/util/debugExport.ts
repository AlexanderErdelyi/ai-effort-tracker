/**
 * Pure parser for Copilot Chat Debug exports (issue #70).
 *
 * The Chat Debug view can export the captured request logs as JSON. That export
 * is the ONLY place the EXACT per-request AIU cost
 * (`metadata.usage.copilot_usage.total_nano_aiu`) is available — VS Code strips
 * it from the on-disk `chatSessions/*.jsonl` within seconds, so tailing that file
 * only ever yields a token-rate estimate (which undercounts multi-request agent
 * turns ~5×). Importing this export lets credit totals match GitHub exactly.
 *
 * Two shapes are accepted, both defensively:
 *   1. "all prompts" wrapper: `{ prompts: [ { prompt, promptId, logs:[…] }, … ] }`
 *   2. a single turn:         `{ prompt, promptId, logs:[…] }`
 *   3. a bare array of turns: `[ { promptId, logs:[…] }, … ]`
 *
 * Each turn's `logs[]` holds one entry per internal model request; a request's
 * exact cost lives at `log.metadata.usage.copilot_usage`. We sum the exact AIU
 * across the turn (via {@link exactCreditsFromCopilotUsage}) plus the durable
 * prompt/completion token counts, and resolve the turn's dominant model. This
 * module is FRAMEWORK-FREE and PURE (no fs / vscode / store), mirroring
 * {@link ./aiuRates}, so it is trivially unit-testable.
 */

import { exactCreditsFromCopilotUsage, tokenTiersFromCopilotUsage } from './aiuRates';

/** Line-count impact of the edits a turn made to one file (no code stored). */
export interface FileEditStat {
  /** Absolute file path as reported by the edit tool. */
  path: string;
  /** Lowercased file extension (e.g. `al`, `ts`, `md`), or `unknown`. */
  ext: string;
  /** Effort category (filled in by the importer via the user's category rules). */
  category?: string;
  /** Lines added across all edits to this file in the turn. */
  added: number;
  /** Lines removed across all edits to this file in the turn. */
  removed: number;
  /** Number of edit operations applied to this file. */
  edits: number;
  /** True when the file was newly created (no prior content). */
  created?: boolean;
}

/** How many times a given tool was invoked in the turn. */
export interface ToolStat {
  name: string;
  count: number;
}

/** Exact cost + token profile of a single internal model request. */
export interface RequestStat {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Exact AIU credits for this request. */
  credits: number;
  /** Wall-clock duration of the request in ms (0 when not reported). */
  durationMs: number;
  /** Per-tier token counts (input / cache-read / cache-write / output). */
  tiers: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

/**
 * Compact, code-free deep-analysis of one chat turn (issue #74). Everything here
 * is derived at import time from the debug export so the drill-down survives even
 * if the export file is later deleted. It stores COUNTS and PATHS only — never the
 * actual `oldString`/`newString` code — to stay small and privacy-safe.
 */
export interface TurnAnalysis {
  /** Per-file line-count impact (added/removed), for code-impact insight. */
  files: FileEditStat[];
  totalAdded: number;
  totalRemoved: number;
  /** Tool-usage histogram (reads, searches, builds, edits…). */
  tools: ToolStat[];
  /** Total tool invocations in the turn. */
  toolCalls: number;
  /** Per-request cost/token profile (for token-efficiency insight). */
  requestsDetail: RequestStat[];
  /** Turn-summed token counts per tier. */
  tiers: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Turn-summed exact AIU credits per tier (sums to the turn's credits). */
  tierCredits: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Total model wall-clock time across the turn's requests, in ms. */
  durationMs: number;
}

/** One imported chat turn, summed to its exact AIU credit cost. */
export interface ImportedTurn {
  /** Stable per-turn id used for idempotent upsert dedup (`import:debug:<id>`). */
  promptId: string;
  /** Dominant model of the turn (the request contributing the most credits). */
  model: string;
  /** EXACT AIU credits summed across the turn's internal model requests. */
  credits: number;
  /** Real prompt (input) tokens summed across the turn. */
  promptTokens: number;
  /** Real completion (output) tokens summed across the turn. */
  completionTokens: number;
  /** Number of internal model requests that carried an exact cost. */
  requests: number;
  /** Compact, code-free deep breakdown of the turn (issue #74). */
  analysis?: TurnAnalysis;
}

/** Coerce an unknown to a finite, non-negative number, else `0`. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Best-effort string, else `''`. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Extract the array of turn objects from any accepted export shape. */
function turnsOf(root: unknown): Record<string, unknown>[] {
  if (Array.isArray(root)) return root.filter(isObj);
  if (isObj(root)) {
    if (Array.isArray(root.prompts)) return root.prompts.filter(isObj);
    // A single-turn export is itself a turn (has its own logs[]).
    if (Array.isArray(root.logs)) return [root];
  }
  return [];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/** Resolve the model id for one request log (best-effort across shapes). */
function modelOf(log: Record<string, unknown>): string {
  const meta = isObj(log.metadata) ? log.metadata : undefined;
  return str(meta?.model) || str(meta?.modelId) || str(log.name) || 'unknown';
}

/** Pull the `copilot_usage` block + token counts from one request log. */
function usageOf(log: Record<string, unknown>): {
  copilotUsage: unknown;
  promptTokens: number;
  completionTokens: number;
} {
  const meta = isObj(log.metadata) ? log.metadata : undefined;
  const usage = meta && isObj(meta.usage) ? meta.usage : undefined;
  return {
    copilotUsage: usage?.copilot_usage,
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens)
  };
}

/** Stable id for a turn, or `''` when none can be derived (turn is skipped). */
function promptIdOf(turn: Record<string, unknown>): string {
  const direct = str(turn.promptId) || str(turn.id);
  if (direct) return direct;
  // Fall back to the first request's ourRequestId so a turn without an explicit
  // promptId still gets a stable, dedupable key.
  const logs = Array.isArray(turn.logs) ? turn.logs.filter(isObj) : [];
  for (const log of logs) {
    const meta = isObj(log.metadata) ? log.metadata : undefined;
    const id = str(meta?.ourRequestId) || str(meta?.requestId) || str(meta?.serverRequestId);
    if (id) return id;
  }
  return '';
}

/** Extension of a path (lowercased, no dot), or `unknown`. */
function extOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : 'unknown';
}

/** Split into lines for diffing (handles CRLF/CR/LF). */
function splitLines(s: string): string[] {
  if (!s) return [];
  return s.split(/\r\n|\r|\n/);
}

/**
 * Count lines added/removed between two strings via an LCS line-diff (the same
 * added = new-not-in-common, removed = old-not-in-common measure Git uses). Turns
 * carry small edits, but a guard falls back to a multiset diff for pathologically
 * large blobs so the DP can never blow up. Pure.
 */
function lineDiff(oldStr: string, newStr: string): { added: number; removed: number } {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  if (a.length > 4000 || b.length > 4000) {
    // Fallback: multiset difference (order-insensitive but bounded + never throws).
    const count = new Map<string, number>();
    for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of b) {
      const c = count.get(l) ?? 0;
      if (c > 0) { common++; count.set(l, c - 1); }
    }
    return { added: b.length - common, removed: a.length - common };
  }
  const m = a.length;
  const n = b.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[n];
  return { added: n - lcs, removed: m - lcs };
}

/**
 * Coerce a tool-call `args` value to a plain object. The debug export sometimes
 * serializes args as a JSON string, and sometimes as a char-indexed object (the
 * result of spreading a string), so we reconstruct both. Returns `{}` on failure.
 */
function coerceArgs(args: unknown): Record<string, unknown> {
  if (isObj(args)) {
    const keys = Object.keys(args);
    if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
      const joined = keys.sort((x, y) => Number(x) - Number(y)).map(k => (args as Record<string, unknown>)[k]).join('');
      try { const o = JSON.parse(joined); return isObj(o) ? o : {}; } catch { return {}; }
    }
    return args;
  }
  if (typeof args === 'string') {
    try { const o = JSON.parse(args); return isObj(o) ? o : {}; } catch { return {}; }
  }
  return {};
}

/** One file edit extracted from a tool call (path + old/new code strings). */
interface RawEdit { filePath: string; oldString: string; newString: string; created: boolean }

/** Extract file edits from a single tool call's args, across known edit tools. */
function editsFromArgs(tool: string, args: Record<string, unknown>): RawEdit[] {
  const t = tool.toLowerCase();
  const out: RawEdit[] = [];
  // multi-edit tools: an array of {filePath, oldString, newString}
  const arr = Array.isArray(args.replacements) ? args.replacements
    : Array.isArray(args.edits) ? args.edits
    : undefined;
  if (arr) {
    for (const r of arr) {
      if (!isObj(r)) continue;
      const fp = str(r.filePath) || str(r.file) || str(r.path);
      if (!fp) continue;
      out.push({ filePath: fp, oldString: str(r.oldString), newString: str(r.newString), created: false });
    }
    return out;
  }
  const fp = str(args.filePath) || str(args.file) || str(args.path);
  if (!fp) return out;
  // create / insert tools: full content, no prior text.
  if (/create|new_file|insert/.test(t)) {
    const content = str(args.content) || str(args.code) || str(args.newString);
    out.push({ filePath: fp, oldString: '', newString: content, created: /create|new_file/.test(t) });
    return out;
  }
  // single replace edit.
  out.push({ filePath: fp, oldString: str(args.oldString), newString: str(args.newString), created: false });
  return out;
}

/**
 * Build the compact, code-free {@link TurnAnalysis} for one turn's `logs[]`.
 * Aggregates the tool histogram, per-file line-count impact, per-request token
 * profile, and per-tier credits. Pure; stores only counts/paths, never code.
 */
function analyzeTurn(logs: Record<string, unknown>[]): TurnAnalysis {
  const toolCounts = new Map<string, number>();
  const fileMap = new Map<string, FileEditStat>();
  const requestsDetail: RequestStat[] = [];
  const tiers = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const tierCredits = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let toolCalls = 0;
  let durationMs = 0;

  for (const log of logs) {
    const tool = str(log.tool);
    const isToolCall = log.kind === 'toolCall' || (!!tool && !log.metadata);
    if (isToolCall && tool) {
      toolCalls += 1;
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      const edits = editsFromArgs(tool, coerceArgs(log.args));
      for (const e of edits) {
        const { added, removed } = lineDiff(e.oldString, e.newString);
        const key = e.filePath;
        const cur = fileMap.get(key) ?? { path: key, ext: extOf(key), added: 0, removed: 0, edits: 0 };
        cur.added += added;
        cur.removed += removed;
        cur.edits += 1;
        if (e.created) cur.created = true;
        fileMap.set(key, cur);
      }
      continue;
    }
    // request log — capture the exact per-request cost + token tiers.
    const { copilotUsage, promptTokens: pt, completionTokens: ct } = usageOf(log);
    const exact = exactCreditsFromCopilotUsage(copilotUsage);
    if (exact === null || !(exact >= 0)) continue;
    const meta = isObj(log.metadata) ? log.metadata : undefined;
    const dur = num(meta?.duration);
    durationMs += dur;
    const tb = tokenTiersFromCopilotUsage(copilotUsage);
    tiers.input += tb.tokens.input;
    tiers.cacheRead += tb.tokens.cacheRead;
    tiers.cacheWrite += tb.tokens.cacheWrite;
    tiers.output += tb.tokens.output;
    tierCredits.input += tb.credits.input;
    tierCredits.cacheRead += tb.credits.cacheRead;
    tierCredits.cacheWrite += tb.credits.cacheWrite;
    tierCredits.output += tb.credits.output;
    requestsDetail.push({
      model: modelOf(log),
      promptTokens: pt,
      completionTokens: ct,
      credits: exact,
      durationMs: dur,
      tiers: { ...tb.tokens }
    });
  }

  const files = Array.from(fileMap.values()).sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  const tools = Array.from(toolCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalRemoved: files.reduce((s, f) => s + f.removed, 0),
    tools,
    toolCalls,
    requestsDetail,
    tiers,
    tierCredits,
    durationMs
  };
}

/**
 * Parse a Copilot Chat Debug export into per-turn exact credit totals. Turns with
 * no captured exact cost (e.g. a title-generation call with `total_nano_aiu` 0)
 * are omitted. Fully defensive: any malformed field is ignored, never throws.
 * Pure.
 */
export function parseDebugExport(root: unknown): ImportedTurn[] {
  const out: ImportedTurn[] = [];
  for (const turn of turnsOf(root)) {
    const promptId = promptIdOf(turn);
    if (!promptId) continue;
    const logs = Array.isArray(turn.logs) ? turn.logs.filter(isObj) : [];

    let credits = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let requests = 0;
    let bestModel = '';
    let bestModelCredits = -1;

    for (const log of logs) {
      const { copilotUsage, promptTokens: pt, completionTokens: ct } = usageOf(log);
      const exact = exactCreditsFromCopilotUsage(copilotUsage);
      if (exact === null || !(exact >= 0)) continue;
      credits += exact;
      promptTokens += pt;
      completionTokens += ct;
      requests += 1;
      if (exact > bestModelCredits) {
        bestModelCredits = exact;
        bestModel = modelOf(log);
      }
    }

    if (requests === 0 || !(credits > 0)) continue;
    out.push({
      promptId,
      model: bestModel || 'unknown',
      credits,
      promptTokens,
      completionTokens,
      requests,
      analysis: analyzeTurn(logs)
    });
  }
  return out;
}
