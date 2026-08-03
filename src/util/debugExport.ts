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

import { exactCreditsFromCopilotUsage } from './aiuRates';

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
      requests
    });
  }
  return out;
}
