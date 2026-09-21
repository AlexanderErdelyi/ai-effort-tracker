/**
 * Pure parser for Copilot Chat Debug exports (issue #70).
 *
 * The Chat Debug view can export the captured request logs as JSON. That export
 * contains per-request AIU costs (`metadata.usage.copilot_usage.total_nano_aiu`).
 * Persisted Copilot debug logs expose recorded charges through a separate parser.
 * These charges describe recorded usage, not final invoice adjustments.
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
import { toolEditImpact, toolResultFailed } from './editImpact';

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
  /** Model-response linkage shared with persisted debug logs; not request identities. */
  responseIds?: string[];
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
      if (log.status === 'error' || log.status === 'failed' || log.success === false || toolResultFailed(log.result)) continue;
      toolCalls += 1;
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      const edits = toolEditImpact(tool, log.args).files;
      for (const e of edits) {
        const key = e.path;
        const cur = fileMap.get(key) ?? { path: key, ext: e.ext, added: 0, removed: 0, edits: 0 };
        cur.added += e.added;
        cur.removed += e.removed;
        cur.edits += e.edits;
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
    const responseIds = new Set<string>();
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
      const meta = isObj(log.metadata) ? log.metadata : undefined;
      const usage = meta && isObj(meta.usage) ? meta.usage : undefined;
      for (const candidate of [meta?.responseId, usage?.responseId]) {
        const id = str(candidate);
        if (id) responseIds.add(id);
      }
      if (exact > bestModelCredits) {
        bestModelCredits = exact;
        bestModel = modelOf(log);
      }
    }

    if (requests === 0 || !(credits > 0)) continue;
    out.push({
      promptId,
      ...(responseIds.size ? { responseIds: [...responseIds] } : {}),
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
