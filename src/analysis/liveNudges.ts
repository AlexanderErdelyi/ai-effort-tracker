import type { LedgerEntry, UsageData } from '../store/database';
import { collectCalls, detectCacheBreaks, priceOf, READ_ONLY_TOOL, scaled, type Call } from './usageInsights';

/**
 * Live nudges while chatting (issue #93). Pure and deterministic: evaluates the
 * newly recorded calls of one chat session against the rest of that session.
 * Uses only recorded token/credit metadata, never prompt content.
 */

export type NudgeType = 'model-switch' | 'idle-cache' | 'context-growth' | 'light-premium' | 'tool-bloat';
export const NUDGE_TYPES: NudgeType[] = ['model-switch', 'idle-cache', 'context-growth', 'light-premium', 'tool-bloat'];

export interface NudgeSettings {
  enabled: boolean;
  types: Record<NudgeType, boolean>;
  /** Main-chat context size (input tokens) that triggers context-growth. */
  contextTokens: number;
  /** Minimum context re-sent after a pause or model switch to be worth a nudge. */
  cacheMinTokens: number;
  /** Tools offered per request that triggers tool-bloat. */
  toolCount: number;
  /** Consecutive light turns on a pricier model that trigger light-premium. */
  lightTurns: number;
  /** Minimum minutes before the model-switch nudge repeats for the same chat. */
  cooldownMinutes: number;
  /** Minimum minutes between any two nudges. */
  minGapMinutes: number;
}

export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = {
  enabled: true,
  types: { 'model-switch': true, 'idle-cache': true, 'context-growth': true, 'light-premium': true, 'tool-bloat': true },
  contextTokens: 150_000,
  cacheMinTokens: 30_000,
  toolCount: 100,
  lightTurns: 3,
  cooldownMinutes: 30,
  minGapMinutes: 10
};

export interface NudgeState {
  mutedTypes: NudgeType[];
  mutedSessions: string[];
  /** `${sessionId}|${type}` → when it was last shown. */
  lastShown: Record<string, number>;
  /** When any nudge was last shown. */
  lastAny: number;
  /** sessionId → timestamp of the newest call already evaluated. */
  seen: Record<string, number>;
}

export interface Nudge {
  type: NudgeType;
  sessionId: string;
  title: string;
  message: string;
  creditsAtStake?: number;
  /** Rate-limit key in NudgeState.lastShown; defaults to `${sessionId}|${type}`. */
  key?: string;
  evidence: Record<string, unknown>;
}

export interface LiveChat {
  sessionId: string;
  credits: number;
  turns: number;
  calls: number;
  /** Average credits of the last three main-chat calls. */
  creditsPerCall: number;
  contextTokens: number;
  cacheHitPct: number;
  model: string;
  startedAt: number;
  lastAt: number;
}

const MIN = 60_000;
/** On first sight of a session only calls this recent are considered new. */
export const FRESH_WINDOW_MS = 10 * MIN;
const STATE_TTL_MS = 7 * 86_400_000;
const LIGHT_OUTPUT_TOKENS = 4000;
const CHEAPER_RATIO = 0.5;
/** Cache breaks that wasted less than this are not worth interrupting for. */
const MIN_WASTED_CREDITS = 2;

/**
 * How soon the same nudge may repeat: model-switch per chat after the cooldown,
 * context-growth whenever the context reaches a new size level, tool-bloat once
 * a day across chats (the tool set rarely changes), the rest once per chat.
 */
function repeatAfterMs(type: NudgeType, settings: NudgeSettings): number {
  switch (type) {
    case 'model-switch': return settings.cooldownMinutes * MIN;
    case 'context-growth': return 0;
    case 'tool-bloat': return 86_400_000;
    default: return Infinity;
  }
}

/** Context size level: -1 below the threshold, then 0, 1, 2… for each doubling (100K, 200K, 400K…). */
function contextLevel(tokens: number, threshold: number): number {
  return tokens < threshold ? -1 : Math.floor(Math.log2(tokens / threshold));
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const credits = (list: Call[]) => list.reduce((n, c) => n + (c.credits ?? 0), 0);
const k = (n: number) => `${Math.round(n / 1000)}K`;

export function emptyNudgeState(): NudgeState {
  return { mutedTypes: [], mutedSessions: [], lastShown: {}, lastAny: 0, seen: {} };
}

/** Sanitise persisted state (it may come from an older version or be damaged). */
export function normalizeNudgeState(value: unknown): NudgeState {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<NudgeState>;
  const nums = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {})
    .filter(([, t]) => typeof t === 'number' && Number.isFinite(t))) as Record<string, number>;
  return {
    mutedTypes: Array.isArray(v.mutedTypes) ? v.mutedTypes.filter(t => NUDGE_TYPES.includes(t)) : [],
    mutedSessions: Array.isArray(v.mutedSessions) ? v.mutedSessions.filter(s => typeof s === 'string').slice(-200) : [],
    lastShown: nums(v.lastShown),
    lastAny: typeof v.lastAny === 'number' && Number.isFinite(v.lastAny) ? v.lastAny : 0,
    seen: nums(v.seen)
  };
}

/** Drop rate-limit and cursor entries older than a week so state stays small. */
export function pruneNudgeState(state: NudgeState, now: number): NudgeState {
  const keep = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, t]) => now - t < STATE_TTL_MS));
  return { ...state, lastShown: keep(state.lastShown), seen: keep(state.seen) };
}

/** The chat's main conversation: the non-subagent stream with the most calls (utility calls such as titles are separate streams). */
function mainCalls(calls: Call[]): Call[] {
  const counts = new Map<string, number>();
  for (const c of calls) if (!c.subagent) counts.set(c.stream, (counts.get(c.stream) ?? 0) + 1);
  let main = '', most = 0;
  for (const [stream, n] of counts) if (n > most) { main = stream; most = n; }
  return calls.filter(c => c.stream === main);
}

function sessionTurns(data: UsageData, sessionId: string): LedgerEntry[] {
  return data.creditLedger.filter(e => e.debugUsage?.sessionId === sessionId);
}

/** The session's running totals for the status bar; null when it has no recorded calls. */
export function liveChatStatus(data: UsageData, sessionId: string, now = Date.now()): LiveChat | null {
  const calls = collectCalls(data, { sessionId, from: 0 }, now);
  if (!calls.length) return null;
  const main = mainCalls(calls);
  const recent = (main.length ? main : calls).slice(-3);
  const last = recent[recent.length - 1];
  return {
    sessionId,
    credits: r1(credits(calls)),
    turns: new Set(calls.map(c => c.turnId)).size,
    calls: calls.length,
    creditsPerCall: r1(credits(recent) / recent.length),
    contextTokens: last.input,
    cacheHitPct: last.input ? Math.round(last.cached / last.input * 100) : 0,
    model: last.model,
    startedAt: calls[0].ts,
    lastAt: calls[calls.length - 1].ts
  };
}

/** The session with the most recent recorded call within `withinMs`, if any. */
export function latestSession(data: UsageData, now = Date.now(), withinMs = 30 * MIN): string | null {
  let best: { id: string; ts: number } | null = null;
  for (const e of data.creditLedger) {
    const u = e.debugUsage;
    if (!u || now - e.ts > withinMs + 86_400_000) continue;
    for (const r of u.requests) {
      const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : e.ts;
      if (ts <= now && now - ts <= withinMs && (!best || ts > best.ts)) best = { id: u.sessionId, ts };
    }
  }
  return best?.id ?? null;
}

function isLight(e: LedgerEntry, turnCalls: Call[]): boolean {
  if ((e.analysis?.files.length ?? 0) > 0) return false;
  if ((e.analysis?.tools ?? []).some(t => !READ_ONLY_TOOL.test(t.name))) return false;
  return turnCalls.reduce((n, c) => n + c.output, 0) <= LIGHT_OUTPUT_TOKENS;
}

/** Every nudge the new calls trigger, most important first, ignoring mutes and rate limits. */
export function detectNudges(data: UsageData, sessionId: string, since: number, settings: NudgeSettings, now = Date.now()): Nudge[] {
  const calls = collectCalls(data, { sessionId, from: 0 }, now);
  const fresh = calls.filter(c => c.ts > since);
  if (!fresh.length) return [];
  const nudges: Nudge[] = [];
  const breaks = detectCacheBreaks(calls, data.modelPrices).filter(b => b.ts > since && !b.subagent &&
    b.inputTokens >= settings.cacheMinTokens && (b.wasted === undefined || b.wasted >= MIN_WASTED_CREDITS));

  const sw = breaks.find(b => b.cause === 'model-switch');
  if (sw) nudges.push({
    type: 'model-switch', sessionId,
    title: `Model switch re-sent ${k(sw.inputTokens)} tokens uncached`,
    message: `Switching from ${sw.previousModel ?? 'another model'} to ${sw.model} mid-chat re-sent the whole ${k(sw.inputTokens)}-token conversation without cache` +
      (sw.wasted ? ` (about ${r1(sw.wasted)} extra credits)` : '') + '. For a sub-task on another model, start a new chat with a short summary.',
    ...(sw.wasted ? { creditsAtStake: r2(sw.wasted) } : {}),
    evidence: { from: sw.previousModel, to: sw.model, inputTokens: sw.inputTokens, credits: r2(sw.credits) }
  });

  const idle = breaks.find(b => b.cause === 'idle-expiry');
  if (idle) nudges.push({
    type: 'idle-cache', sessionId,
    title: `Prompt cache expired after a ${Math.round(idle.gapMinutes ?? 5)}-minute pause`,
    message: `After ${Math.round(idle.gapMinutes ?? 5)} minutes idle the ${k(idle.inputTokens)}-token context was billed again without cache` +
      (idle.wasted ? ` (about ${r1(idle.wasted)} extra credits)` : '') + '. Send follow-ups before long breaks, or start a new chat with a summary if the next step is a new topic.',
    ...(idle.wasted ? { creditsAtStake: r2(idle.wasted) } : {}),
    evidence: { gapMinutes: idle.gapMinutes, inputTokens: idle.inputTokens, credits: r2(idle.credits) }
  });

  const main = mainCalls(calls);
  const lastMain = main.filter(c => c.ts > since).at(-1);
  const prevMax = Math.max(0, ...main.filter(c => c.ts <= since).map(c => c.input));
  if (lastMain && contextLevel(lastMain.input, settings.contextTokens) > contextLevel(prevMax, settings.contextTokens)) {
    const stream = main;
    // Skip the cold first call so "at the start" reflects a warm, small context.
    const warm = stream.length > 2 ? stream.slice(1) : stream;
    const q = Math.max(1, Math.min(3, Math.floor(warm.length / 4)));
    const early = credits(warm.slice(0, q)) / q, late = credits(warm.slice(-q)) / q;
    nudges.push({
      type: 'context-growth', sessionId,
      title: `This chat's context is ${k(lastMain.input)} tokens`,
      message: `Every call re-reads the whole conversation: now about ${r1(late)} credits per call` +
        (early > 0 && late > early * 1.2 ? ` (${r1(early)} at the start)` : '') +
        '. When the topic changes or the task is done, start a new chat with a short summary.',
      evidence: { contextTokens: lastMain.input, earlyPerCall: r2(early), latePerCall: r2(late), calls: stream.length }
    });
  }

  if (fresh.some(c => !c.subagent)) {
    const turns = sessionTurns(data, sessionId).sort((a, b) => a.ts - b.ts);
    const byTurn = new Map<string, Call[]>();
    for (const c of main) byTurn.set(c.turnId, [...(byTurn.get(c.turnId) ?? []), c]);
    const recent = turns.filter(e => byTurn.has(e.debugUsage!.turnId)).slice(-settings.lightTurns);
    const model = recent.length ? byTurn.get(recent[0].debugUsage!.turnId)!.at(-1)!.model : '';
    if (recent.length >= settings.lightTurns && recent.some(e => byTurn.get(e.debugUsage!.turnId)!.some(c => c.ts > since)) &&
      recent.every(e => isLight(e, byTurn.get(e.debugUsage!.turnId)!) && byTurn.get(e.debugUsage!.turnId)!.every(c => c.model === model))) {
      const list = recent.flatMap(e => byTurn.get(e.debugUsage!.turnId)!);
      const spent = credits(list);
      const price = priceOf(data.modelPrices, model);
      const alts = Object.entries(data.modelPrices)
        .filter(([m, p]) => p.picker && m !== model && price)
        .map(([m, p]) => ({ model: m, credits: list.reduce((n, c) => n + (scaled(c, price, c, p) ?? NaN), 0) }))
        .filter(a => Number.isFinite(a.credits) && a.credits < spent * CHEAPER_RATIO)
        .sort((a, b) => b.credits - a.credits);
      if (alts.length && spent >= 1) nudges.push({
        type: 'light-premium', sessionId,
        title: `${recent.length} light turns on ${model}`,
        message: `The last ${recent.length} turns only read, searched or answered (no edits) and cost ${r1(spent)} credits on ${model}. ` +
          `${alts[0].model} would cost about ${r1(alts[0].credits)} for the same tokens. Consider a cheaper model for questions and lookups.`,
        creditsAtStake: r2(spent - alts[0].credits),
        evidence: { model, turns: recent.length, credits: r2(spent), alternatives: alts.slice(0, 3).map(a => ({ ...a, credits: r2(a.credits) })) }
      });
    }
  }

  const toolsets = [...new Set(fresh.map(c => c.toolset).filter((t): t is string => !!t && !!data.toolsets[t]))];
  const biggest = toolsets.sort((a, b) => data.toolsets[b].toolCount - data.toolsets[a].toolCount)[0];
  const maxTools = biggest ? data.toolsets[biggest].toolCount : 0;
  const freshTurns = new Set(fresh.map(c => c.turnId));
  const searches = sessionTurns(data, sessionId).filter(e => freshTurns.has(e.debugUsage!.turnId))
    .reduce((n, e) => n + (e.analysis?.tools ?? []).filter(t => t.name === 'tool_search').reduce((m, t) => m + t.count, 0), 0);
  if (maxTools >= settings.toolCount || searches > 0) nudges.push({
    type: 'tool-bloat', sessionId,
    // The same tool set is reported at most once a day, not again in every new chat.
    key: 'tool-bloat',
    title: searches > 0 ? `The model searched for tools ${searches}\u00d7` : `${maxTools} tools are offered on every request`,
    message: (maxTools ? `${maxTools} tool definitions are sent with every request in this chat. ` : '') +
      (searches > 0 ? `Too many enabled tools made the model call tool_search ${searches}\u00d7, each an extra round. ` : '') +
      'Disable MCP servers and tools you do not need for this task in the chat tool picker.',
    evidence: { toolsOffered: maxTools, toolSearchCalls: searches }
  });

  const order = Object.fromEntries(NUDGE_TYPES.map((t, i) => [t, i])) as Record<NudgeType, number>;
  return nudges.sort((a, b) => order[a.type] - order[b.type]);
}

/**
 * Evaluate the newly recorded calls of a session: at most one nudge, honouring
 * mutes, repeat rules (model-switch after the cooldown, context-growth once per
 * size level, the rest once per chat) and a global minimum gap. Returns the
 * updated state (cursor advanced even when nothing fires).
 */
export function evaluateNudges(data: UsageData, sessionId: string, state: NudgeState, settings: NudgeSettings, now = Date.now()):
  { nudge: Nudge | null; state: NudgeState } {
  const calls = collectCalls(data, { sessionId, from: 0 }, now);
  const newest = calls.length ? calls[calls.length - 1].ts : undefined;
  const since = state.seen[sessionId] ?? now - FRESH_WINDOW_MS;
  const next: NudgeState = { ...state, lastShown: { ...state.lastShown }, seen: { ...state.seen } };
  if (newest !== undefined && (newest > since || state.seen[sessionId] === undefined)) next.seen[sessionId] = newest;
  if (!settings.enabled || state.mutedSessions.includes(sessionId) || newest === undefined || newest <= since) {
    return { nudge: null, state: next };
  }
  if (now - state.lastAny < settings.minGapMinutes * MIN) return { nudge: null, state: next };
  const nudge = detectNudges(data, sessionId, since, settings, now).find(n => {
    if (!settings.types[n.type] || state.mutedTypes.includes(n.type)) return false;
    const shown = state.lastShown[n.key ?? `${sessionId}|${n.type}`];
    return shown === undefined || now - shown >= repeatAfterMs(n.type, settings);
  }) ?? null;
  if (nudge) {
    next.lastShown[nudge.key ?? `${sessionId}|${nudge.type}`] = now;
    next.lastAny = now;
  }
  return { nudge, state: next };
}

/** Status-bar text, e.g. "chat 312 cr · 9.4/call". */
export function liveChatLabel(chat: LiveChat): string {
  return `chat ${Math.round(chat.credits)} cr \u00b7 ${chat.creditsPerCall}/call`;
}
