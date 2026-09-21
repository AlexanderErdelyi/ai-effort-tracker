import type { TurnAnalysis } from './debugExport';
import { toolEditImpact, toolResultFailed } from './editImpact';

export interface DebugLogRequest {
  responseId?: string;
  spanId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  credits: number | null;
}

export interface DebugLogTurn {
  sessionId: string;
  /** The user-message root span, NOT the restarting tool-round index. */
  turnId: string;
  timestamp: number;
  requests: DebugLogRequest[];
  /** Sum of known charges only. See unknownRequestCount for completeness. */
  credits: number;
  unknownRequestCount: number;
  /** Turn/export linkage only; never used to deduplicate distinct physical spans. */
  responseIds: string[];
  requestAliases: string[];
  analysis: TurnAnalysis;
}

export interface DebugLogResult {
  turns: DebugLogTurn[];
  /** Code-free diagnostics with one-based line numbers. */
  diagnostics: string[];
  ignoredPartialLine: boolean;
}

interface Row {
  line: number;
  sid: string;
  scope: string;
  ts: number;
  dur: number;
  type: string;
  name: string;
  spanId: string;
  parentSpanId: string;
  status: string;
  attrs: Record<string, unknown>;
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const validNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const num = (v: unknown): number => validNumber(v) ? v : 0;
const key = (sid: string, span: string): string => JSON.stringify([sid, span]);
const tiers = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

function analysis(): TurnAnalysis {
  return { files: [], totalAdded: 0, totalRemoved: 0, tools: [], toolCalls: 0,
    requestsDetail: [], tiers: tiers(), tierCredits: tiers(), durationMs: 0 };
}

function successful(row: Row): boolean {
  return row.status === 'ok' || row.status === 'success';
}

/**
 * Parse a persisted Copilot debug log without I/O or retaining prompt/code text.
 * Span IDs identify physical calls: responseId can be reused by every tool round.
 * Repeated snapshots of a span replace its usage, never add to it. A responseId
 * alone cannot identify physical calls, so spanless records are diagnosed.
 */
export function parseDebugLog(mainText: string, relatedLogs: string[] = []): DebugLogResult {
  const diagnostics: string[] = [], rows: Row[] = [];
  const parentSessions = new Map<string, string>();
  let ignoredPartialLine = false;
  for (const text of [mainText, ...relatedLogs]) {
    const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let session = '';
    const scopes = new Map<string, string>();
    for (let i = 0; i < raw.length; i++) {
      if (!raw[i].trim()) continue;
      let value: unknown;
      try { value = JSON.parse(raw[i]); } catch {
        if (i === raw.length - 1 && !text.endsWith('\n')) ignoredPartialLine = true;
        else diagnostics.push(`Line ${i + 1}: malformed JSON record ignored.`);
        continue;
      }
      if (!object(value) || !str(value.type)) {
        diagnostics.push(`Line ${i + 1}: invalid debug record ignored.`);
        continue;
      }
      const sid = str(value.sid) || session;
      if (value.type === 'session_start') session = sid;
      if (!sid) {
        diagnostics.push(`Line ${i + 1}: missing session identity; record ignored.`);
        continue;
      }
      const ts = validNumber(value.ts) ? value.ts
        : typeof value.ts === 'string' ? Date.parse(value.ts) : NaN;
      if (value.type === 'session_start' && Number.isFinite(ts)) {
        scopes.set(sid, key(sid, String(ts)));
        if (object(value.attrs) && str(value.attrs.parentSessionId)) {
          parentSessions.set(scopes.get(sid)!, str(value.attrs.parentSessionId));
        }
      }
      rows.push({ line: i + 1, sid, scope: scopes.get(sid) ?? sid, ts, dur: num(value.dur), type: str(value.type),
        name: str(value.name), spanId: str(value.spanId), parentSpanId: str(value.parentSpanId),
        status: str(value.status).toLowerCase(), attrs: object(value.attrs) ? value.attrs : {} });
    }
  }

  const nodes = new Map<string, Row>();
  const roots = new Map<string, DebugLogTurn>();
  const identities = new Map<string, string>();
  function persistedId(row: Row): string {
    if (parentSessions.has(row.scope)) return key(row.scope, row.spanId);
    const id = key(row.sid, row.spanId);
    const firstScope = identities.get(id);
    if (!firstScope) identities.set(id, row.scope);
    return !firstScope || firstScope === row.scope ? row.spanId : key(row.scope, row.spanId);
  }
  for (const row of rows) {
    if (row.spanId) {
      persistedId(row);
      const id = key(row.scope, row.spanId), previous = nodes.get(id);
      const attrs = { ...previous?.attrs, ...row.attrs };
      if (!validNumber(attrs.copilotUsageNanoAiu) && validNumber(previous?.attrs.copilotUsageNanoAiu)) {
        attrs.copilotUsageNanoAiu = previous.attrs.copilotUsageNanoAiu;
      }
      nodes.set(id, previous ? { ...row, parentSpanId: row.parentSpanId || previous.parentSpanId, attrs } : row);
    }
    if (row.type !== 'user_message' || !row.spanId || parentSessions.has(row.scope)) continue;
    const id = key(row.scope, row.spanId);
    if (!roots.has(id) && Number.isFinite(row.ts)) roots.set(id, {
      sessionId: row.sid, turnId: persistedId(row), timestamp: row.ts, requests: [],
      credits: 0, unknownRequestCount: 0, responseIds: [], requestAliases: [], analysis: analysis()
    });
  }

  // Round markers have no parent in current Copilot logs, but encode their root
  // span in "turn_start-<root>-<round>". Other records use the real parent graph.
  const markerRoots = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== 'turn_start' && row.type !== 'turn_end') continue;
    const encoded = /^(?:turn_start|turn_end)-(.+)-[^-]+$/.exec(row.spanId)?.[1];
    if (encoded && nodes.has(key(row.scope, encoded))) {
      markerRoots.set(key(row.scope, row.spanId), key(row.scope, encoded));
    }
  }
  const linkedInvocations = new Set<string>();
  function rootOf(row: Row): DebugLogTurn | undefined {
    let id = key(row.scope, row.spanId);
    const visited = new Set<string>();
    while (!visited.has(id)) {
      visited.add(id);
      const root = roots.get(id);
      if (root) return root;
      const marker = markerRoots.get(id);
      if (marker) { id = marker; continue; }
      const node = nodes.get(id);
      if (!node?.parentSpanId) return undefined;
      const localParent = key(node.scope, node.parentSpanId);
      if (nodes.has(localParent)) { id = localParent; continue; }
      const parentSid = parentSessions.get(node.scope);
      if (!parentSid) return undefined;
      // Child roots point at a tool span in their declared parent session.
      // The latest preceding span selects the correct extension-host lifetime.
      const candidates = [...nodes.values()].filter(p => p.sid === parentSid &&
        p.type === 'tool_call' && p.spanId === node.parentSpanId && p.ts <= node.ts)
        .sort((a, b) => b.ts - a.ts);
      if (!candidates.length) return undefined;
      id = key(candidates[0].scope, candidates[0].spanId);
      linkedInvocations.add(id);
    }
    return undefined;
  }

  const requests = new Map<string, Row>(), tools = new Map<string, Row>();
  for (const original of rows) {
    if (original.type !== 'llm_request' && original.type !== 'tool_call') continue;
    const row = original.spanId ? nodes.get(key(original.scope, original.spanId))! : original;
    const identity = row.spanId;
    if (!identity) {
      diagnostics.push(`Line ${row.line}: missing call identity; record ignored.`);
      continue;
    }
    (row.type === 'llm_request' ? requests : tools).set(key(row.scope, identity), row);
  }

  for (const row of requests.values()) {
    if (!successful(row) && !validNumber(row.attrs.copilotUsageNanoAiu)) continue;
    const turn = rootOf(row);
    if (!turn) {
      diagnostics.push(`Line ${row.line}: request has no user-message root; ignored.`);
      continue;
    }
    const a = row.attrs, responseId = str(a.responseId);
    const request: DebugLogRequest = {
      spanId: persistedId(row),
      ...(responseId ? { responseId } : {}),
      model: str(a.model) || row.name.replace(/^chat:/, '') || 'unknown',
      inputTokens: num(a.inputTokens), outputTokens: num(a.outputTokens),
      ...(validNumber(a.cachedTokens) ? { cachedTokens: a.cachedTokens } : {}),
      credits: validNumber(a.copilotUsageNanoAiu) ? a.copilotUsageNanoAiu / 1e9 : null
    };
    turn.requests.push(request);
    if (responseId && !turn.responseIds.includes(responseId)) turn.responseIds.push(responseId);
    for (const alias of [a.requestId, a.ourRequestId, a.userRequestId]) {
      const id = str(alias);
      if (id && !turn.requestAliases.includes(id)) turn.requestAliases.push(id);
    }
    if (request.credits === null) turn.unknownRequestCount++;
    else turn.credits += request.credits;
    const cacheRead = Math.min(request.inputTokens, request.cachedTokens ?? 0);
    const tokenTiers = { input: request.inputTokens - cacheRead, cacheRead, cacheWrite: 0, output: request.outputTokens };
    for (const tier of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      turn.analysis.tiers[tier] += tokenTiers[tier];
    }
    turn.analysis.durationMs += row.dur;
    // Legacy RequestStat requires an exact number. Unknown requests remain in
    // turn.requests, not fabricated as free requests in this exact-cost list.
    if (request.credits !== null) turn.analysis.requestsDetail.push({
      model: request.model, promptTokens: request.inputTokens, completionTokens: request.outputTokens,
      credits: request.credits, durationMs: row.dur, tiers: tokenTiers
    });
    // Persisted logs do not expose per-tier charges; never invent an allocation.
  }
  for (const row of tools.values()) {
    if (!successful(row) || toolResultFailed(row.attrs.result)) continue;
    const turn = rootOf(row);
    if (!turn) {
      diagnostics.push(`Line ${row.line}: tool has no user-message root; ignored.`);
      continue;
    }
    const name = row.name || 'unknown';
    turn.analysis.toolCalls++;
    const tool = turn.analysis.tools.find(t => t.name === name);
    if (tool) tool.count++; else turn.analysis.tools.push({ name, count: 1 });
    const impact = toolEditImpact(name, row.attrs.args);
    diagnostics.push(...impact.diagnostics.map(d => `Line ${row.line}: ${d}`));
    for (const file of impact.files) {
      const prior = turn.analysis.files.find(f => f.path === file.path);
      if (prior) {
        prior.added += file.added; prior.removed += file.removed; prior.edits += file.edits;
        if (file.created) prior.created = true;
      } else turn.analysis.files.push(file);
      turn.analysis.totalAdded += file.added;
      turn.analysis.totalRemoved += file.removed;
    }
  }
  for (const row of tools.values()) {
    if (row.name === 'runSubagent' && successful(row) && !toolResultFailed(row.attrs.result) &&
        !linkedInvocations.has(key(row.scope, row.spanId))) {
      diagnostics.push(`Line ${row.line}: subagent usage is not linked yet; turn total may be incomplete.`);
    }
  }
  return { turns: [...roots.values()].sort((a, b) => a.timestamp - b.timestamp), diagnostics, ignoredPartialLine };
}
