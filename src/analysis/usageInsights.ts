import type { LedgerEntry, UsageData } from '../store/database';
import { listCost, serverOf, type ModelPrice } from '../util/modelCatalog';
import { branchMatches, repoMatches } from '../util/branchKey';

/**
 * Pure, deterministic usage analysis over the effort store. No I/O, no vscode
 * dependency: shared by the dashboard and the stdio MCP server. Savings are
 * list-price ESTIMATES calibrated against recorded charges; they never modify
 * recorded credits.
 */

export interface InsightFilter {
  /** Look-back window in days (default 30). Ignored when `from` is set. */
  days?: number;
  from?: number;
  to?: number;
  branch?: string;
  workItemId?: string;
  projectId?: string;
  /** Repository id or '__legacy__' (#155). */
  repoId?: string;
  sessionId?: string;
}

export interface Call {
  sessionId: string;
  turnId: string;
  /** Context stream: main chat, a utility purpose, or one subagent. Cache is per stream. */
  stream: string;
  spanId: string;
  ts: number;
  timed: boolean;
  durationMs: number;
  model: string;
  agent: string;
  effort?: string;
  input: number;
  cached: number;
  output: number;
  credits: number | null;
  toolset?: string;
  subagent: boolean;
  branch?: string;
  workItemId?: string | null;
  projectId?: string | null;
}

export type CacheCause = 'new-context' | 'model-switch' | 'idle-expiry' | 'toolset-change' | 'other';

export interface CacheBreak {
  sessionId: string;
  turnId: string;
  ts: number;
  model: string;
  previousModel?: string;
  subagent: boolean;
  cause: CacheCause;
  gapMinutes?: number;
  inputTokens: number;
  cacheHit: number;
  credits: number;
  /** Estimated extra credits vs. a warm cache; undefined when not estimable. */
  wasted?: number;
}

export interface Finding {
  id: string;
  category: 'cache' | 'model' | 'tools' | 'context' | 'effort' | 'reliability';
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  recommendation: string;
  /** Credits that could plausibly be saved; always an estimate. */
  creditsAtStake?: number;
  evidence: Record<string, unknown>;
}

export const CACHE_TTL_MS = 5 * 60_000;
const MIN_BREAK_INPUT = 8000;
const LOW_CACHE = 0.5;
const DAY = 86_400_000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => Math.round(n * 1000) / 10;
const iso = (ts: number) => new Date(ts).toISOString();
const creditsOf = (list: Call[]) => list.reduce((n, c) => n + (c.credits ?? 0), 0);

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item); else map.set(k, [item]);
  }
  return map;
}

function range(f: InsightFilter, now: number): { from: number; to: number } {
  const to = f.to ?? now;
  return { from: f.from ?? to - (f.days ?? 30) * DAY, to };
}

function streamOf(sessionId: string, spanId: string, agent: string, subagent: boolean): string {
  if (subagent) {
    try {
      const [scope] = JSON.parse(spanId);
      const [sid] = JSON.parse(scope);
      if (typeof sid === 'string') return `${sid}|sub`;
    } catch { /* not a namespaced child span */ }
    return `${sessionId}|sub`;
  }
  return `${sessionId}|${agent || 'chat'}`;
}

function matches(e: LedgerEntry, f: InsightFilter, from: number, to: number): boolean {
  if (!e.debugUsage) return false;
  if (e.ts < from - DAY || e.ts > to) return false;
  if (f.branch && !branchMatches(e.branch, f.branch)) return false;
  if (f.repoId && !repoMatches(e.branch, f.repoId)) return false;
  if (f.workItemId && e.workItemId !== f.workItemId) return false;
  if (f.projectId === '__none__' ? !!e.projectId : f.projectId && e.projectId !== f.projectId) return false;
  if (f.sessionId && e.debugUsage.sessionId !== f.sessionId) return false;
  return true;
}

/** Flatten recorded debug-log calls, sorted chronologically. */
export function collectCalls(data: UsageData, filter: InsightFilter = {}, now = Date.now()): Call[] {
  const { from, to } = range(filter, now);
  const calls: Call[] = [];
  for (const e of data.creditLedger) {
    if (!matches(e, filter, from, to)) continue;
    const u = e.debugUsage!;
    u.requests.forEach((r, i) => {
      const timed = typeof r.ts === 'number' && Number.isFinite(r.ts);
      const ts = timed ? r.ts! : e.ts + i;
      if (ts < from || ts > to) return;
      const agent = r.agent ?? '';
      calls.push({
        sessionId: u.sessionId, turnId: u.turnId, stream: streamOf(u.sessionId, r.spanId, agent, !!r.subagent),
        spanId: r.spanId, ts, timed, durationMs: r.durationMs ?? 0, model: r.model, agent, effort: r.effort,
        input: r.inputTokens, cached: Math.min(r.inputTokens, r.cachedTokens ?? 0), output: r.outputTokens,
        credits: r.credits, toolset: r.toolset, subagent: !!r.subagent,
        branch: e.branch, workItemId: e.workItemId, projectId: e.projectId
      });
    });
  }
  return calls.sort((a, b) => a.ts - b.ts);
}

export function priceOf(prices: Record<string, ModelPrice>, model: string): ModelPrice | undefined {
  return prices[model] ?? prices[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

/**
 * Recorded credits × (list cost of alternative ÷ list cost of actual tokens).
 * Scaling the real charge keeps any discount or multiplier that applied.
 */
export function scaled(call: Call, price: ModelPrice | undefined, tokens: { input: number; cached: number; output: number },
  target: ModelPrice | undefined = price): number | undefined {
  if (!price || !target || call.credits === null) return undefined;
  const actual = listCost(price, { inputTokens: call.input, cachedTokens: call.cached, outputTokens: call.output });
  if (actual <= 0) return undefined;
  return call.credits * listCost(target, { inputTokens: tokens.input, cachedTokens: tokens.cached, outputTokens: tokens.output }) / actual;
}

export function detectCacheBreaks(calls: Call[], prices: Record<string, ModelPrice>): CacheBreak[] {
  const breaks: CacheBreak[] = [];
  const last = new Map<string, Call>();
  for (const c of calls) {
    const prev = last.get(c.stream);
    last.set(c.stream, c);
    if (c.input < MIN_BREAK_INPUT || c.cached / c.input >= LOW_CACHE) continue;
    const gap = prev && c.timed && prev.timed ? c.ts - (prev.ts + prev.durationMs) : undefined;
    const cause: CacheCause = !prev ? 'new-context'
      : prev.model !== c.model ? 'model-switch'
        : gap !== undefined && gap > CACHE_TTL_MS ? 'idle-expiry'
          : prev.toolset && c.toolset && prev.toolset !== c.toolset ? 'toolset-change' : 'other';
    let wasted: number | undefined;
    if (prev) {
      const warm = scaled(c, priceOf(prices, c.model), { input: c.input, cached: Math.min(c.input, prev.input), output: c.output });
      if (warm !== undefined) wasted = Math.max(0, c.credits! - warm);
    }
    breaks.push({ sessionId: c.sessionId, turnId: c.turnId, ts: c.ts, model: c.model,
      ...(prev && prev.model !== c.model ? { previousModel: prev.model } : {}), subagent: c.subagent, cause,
      ...(gap !== undefined ? { gapMinutes: Math.round(gap / 6000) / 10 } : {}),
      inputTokens: c.input, cacheHit: r2(c.cached / c.input), credits: c.credits ?? 0,
      ...(wasted !== undefined ? { wasted } : {}) });
  }
  return breaks;
}

interface Bucket { calls: number; credits: number; input: number; cached: number; output: number }
const bucket = (): Bucket => ({ calls: 0, credits: 0, input: 0, cached: 0, output: 0 });
function add(b: Bucket, c: Call) {
  b.calls++; b.credits += c.credits ?? 0; b.input += c.input; b.cached += c.cached; b.output += c.output;
}
function show(b: Bucket) {
  return { calls: b.calls, credits: r2(b.credits), inputTokens: b.input, outputTokens: b.output,
    cacheHitPct: b.input ? pct(b.cached / b.input) : 0, creditsPerCall: b.calls ? r2(b.credits / b.calls) : 0 };
}

function turnsOf(data: UsageData, calls: Call[]): LedgerEntry[] {
  const ids = new Set(calls.map(c => `${c.sessionId}|${c.turnId}`));
  return data.creditLedger.filter(e => e.debugUsage && ids.has(`${e.debugUsage.sessionId}|${e.debugUsage.turnId}`));
}

export interface ToolUsage {
  /** Tools offered in the most recent tool set of the period. */
  toolsOffered: number;
  maxToolsOffered: number;
  toolsetsSeen: number;
  servers: { server: string; toolsOffered: number; definitionChars: number; offeredInPct: number; calls: number; failed: number; usedTools: number }[];
  topTools: { name: string; calls: number; failed: number; server: string }[];
  toolSearchCalls: number;
  duplicateServers: { servers: [string, string]; overlapPct: number }[];
}

export function toolUsage(data: UsageData, calls: Call[]): ToolUsage {
  const toolsets = [...new Set(calls.map(c => c.toolset))]
    .filter((id): id is string => !!id && !!data.toolsets[id]).map(id => data.toolsets[id])
    .sort((a, b) => b.lastSeen - a.lastSeen);
  // Tool sets differ per workspace/window; newest wins when a tool appears in several.
  const serverByTool = new Map<string, string>();
  const offered = new Map<string, { count: number; chars: number; tools: Set<string>; calls: number }>();
  for (const ts of toolsets) {
    for (const [key, s] of Object.entries(ts.servers)) {
      for (const t of s.tools) if (!serverByTool.has(t)) serverByTool.set(t, key);
      const o = offered.get(key) ?? { count: 0, chars: 0, tools: new Set<string>(), calls: 0 };
      o.count = Math.max(o.count, s.count); o.chars = Math.max(o.chars, s.chars);
      s.tools.forEach(t => o.tools.add(t));
      offered.set(key, o);
    }
  }
  const withToolset = calls.filter(c => c.toolset && data.toolsets[c.toolset]);
  for (const c of withToolset) {
    for (const key of Object.keys(data.toolsets[c.toolset!].servers)) offered.get(key)!.calls++;
  }
  const server = (name: string) => serverByTool.get(name) ?? serverOf(name);
  const tools = new Map<string, { calls: number; failed: number }>();
  for (const e of turnsOf(data, calls)) {
    for (const t of e.analysis?.tools ?? []) {
      const s = tools.get(t.name) ?? { calls: 0, failed: 0 };
      s.calls += t.count; s.failed += t.failed ?? 0;
      tools.set(t.name, s);
    }
  }
  const servers = new Map<string, ToolUsage['servers'][number]>();
  for (const [key, o] of offered) {
    servers.set(key, { server: key, toolsOffered: o.count, definitionChars: o.chars,
      offeredInPct: withToolset.length ? pct(o.calls / withToolset.length) : 0, calls: 0, failed: 0, usedTools: 0 });
  }
  for (const [name, s] of tools) {
    const key = server(name);
    const entry = servers.get(key) ?? { server: key, toolsOffered: 0, definitionChars: 0, offeredInPct: 0, calls: 0, failed: 0, usedTools: 0 };
    entry.calls += s.calls; entry.failed += s.failed; entry.usedTools++;
    servers.set(key, entry);
  }
  const duplicates = new Map<string, ToolUsage['duplicateServers'][number]>();
  const suffixes = (key: string, names: string[]) => {
    const prefix = 'mcp_' + key.slice(4);
    return new Set(names.map(n => n.slice(prefix.length).replace(/^_+/, '')));
  };
  // Only servers offered together in the same request are duplicates.
  for (const ts of toolsets) {
    const mcp = Object.entries(ts.servers).filter(([k]) => k.startsWith('mcp:'));
    for (let i = 0; i < mcp.length; i++) {
      for (let j = i + 1; j < mcp.length; j++) {
        const pair = [mcp[i][0], mcp[j][0]].sort() as [string, string];
        if (duplicates.has(pair.join('|'))) continue;
        const a = suffixes(mcp[i][0], mcp[i][1].tools), b = suffixes(mcp[j][0], mcp[j][1].tools);
        const smaller = Math.min(a.size, b.size);
        const overlap = [...a].filter(x => b.has(x)).length / smaller;
        if (smaller >= 3 && overlap >= 0.6) duplicates.set(pair.join('|'), { servers: pair, overlapPct: pct(overlap) });
      }
    }
  }
  return {
    toolsOffered: toolsets[0]?.toolCount ?? 0,
    maxToolsOffered: Math.max(0, ...toolsets.map(t => t.toolCount)),
    toolsetsSeen: toolsets.length,
    servers: [...servers.values()].sort((a, b) => b.toolsOffered - a.toolsOffered || b.calls - a.calls),
    topTools: [...tools.entries()].map(([name, s]) => ({ name, ...s, server: server(name) }))
      .sort((a, b) => b.calls - a.calls).slice(0, 20),
    toolSearchCalls: tools.get('tool_search')?.calls ?? 0,
    duplicateServers: [...duplicates.values()]
  };
}

export function usageOverview(data: UsageData, filter: InsightFilter = {}, now = Date.now()) {
  const { from, to } = range(filter, now);
  const calls = collectCalls(data, filter, now);
  const total = bucket(), sub = bucket();
  const byModel: Record<string, Bucket> = {}, byAgent: Record<string, Bucket> = {}, byEffort: Record<string, Bucket> = {};
  let unknown = 0, timed = 0;
  for (const c of calls) {
    add(total, c);
    add(byModel[c.model] ??= bucket(), c);
    add(byAgent[c.subagent ? 'subagent' : c.agent || 'unknown'] ??= bucket(), c);
    add(byEffort[c.effort ?? 'unspecified'] ??= bucket(), c);
    if (c.subagent) add(sub, c);
    if (c.credits === null) unknown++;
    if (c.timed) timed++;
  }
  const byCause: Record<string, { count: number; credits: number; wasted: number }> = {};
  for (const b of detectCacheBreaks(calls, data.modelPrices)) {
    const s = byCause[b.cause] ??= { count: 0, credits: 0, wasted: 0 };
    s.count++; s.credits += b.credits; s.wasted += b.wasted ?? 0;
  }
  const map = (m: Record<string, Bucket>) => Object.fromEntries(Object.entries(m)
    .sort((a, b) => b[1].credits - a[1].credits).map(([k, v]) => [k, show(v)]));
  const turns = new Set(calls.map(c => `${c.sessionId}|${c.turnId}`)).size;
  return {
    period: { from: iso(from), to: iso(to) },
    filter,
    totals: { ...show(total), sessions: new Set(calls.map(c => c.sessionId)).size, turns,
      creditsPerTurn: turns ? r2(total.credits / turns) : 0, unpricedCalls: unknown },
    byModel: map(byModel),
    byAgent: map(byAgent),
    byEffort: map(byEffort),
    subagents: show(sub),
    cacheBreaks: Object.fromEntries(Object.entries(byCause).map(([k, v]) =>
      [k, { count: v.count, credits: r2(v.credits), estimatedWaste: r2(v.wasted) }])),
    tools: toolUsage(data, calls),
    dataCoverage: {
      calls: calls.length,
      withTimingPct: calls.length ? pct(timed / calls.length) : 0,
      modelPricesKnown: Object.keys(data.modelPrices).length,
      note: 'Only calls captured from Copilot debug logs are analysed. Calls captured before 0.22 lack timing, effort and tool-set details until their log is re-read.'
    }
  };
}

function severity(credits: number, total: number): Finding['severity'] {
  const share = total ? credits / total : 0;
  return share >= 0.1 ? 'high' : share >= 0.03 ? 'medium' : 'low';
}

export const READ_ONLY_TOOL = /^(read_file|list_dir|file_search|grep_search|semantic_search|fetch_webpage|get_errors|view_image|tool_search|memory|manage_todo_list|get_terminal_output|github_repo)$|search|find|list|read|query|fetch|_get/i;

function cacheFinding(id: string, category: Finding['category'], list: CacheBreak[], total: number,
  title: string, detail: (credits: number, wasted: number) => string, recommendation: string): Finding {
  const credits = list.reduce((n, b) => n + b.credits, 0), wasted = list.reduce((n, b) => n + (b.wasted ?? 0), 0);
  return {
    id, category, severity: severity(wasted, total), title, detail: detail(r2(credits), r2(wasted)), recommendation,
    creditsAtStake: r2(wasted),
    evidence: { examples: list.slice(-5).map(b => ({ session: b.sessionId, at: iso(b.ts), cause: b.cause,
      ...(b.previousModel ? { from: b.previousModel } : {}), model: b.model,
      ...(b.gapMinutes !== undefined ? { gapMinutes: b.gapMinutes } : {}),
      inputTokens: b.inputTokens, credits: r2(b.credits) })) }
  };
}

export function optimizationFindings(data: UsageData, filter: InsightFilter = {}, now = Date.now()): Finding[] {
  const calls = collectCalls(data, filter, now);
  const total = creditsOf(calls);
  const findings: Finding[] = [];
  if (!calls.length) return findings;
  const breaks = detectCacheBreaks(calls, data.modelPrices);

  const switches = breaks.filter(b => b.cause === 'model-switch');
  if (switches.length) findings.push(cacheFinding('model-switch-cache', 'model', switches, total,
    `Switching models mid-chat re-sent the full context ${switches.length}×`,
    (c, w) => `A different model cannot reuse the previous model's prompt cache, so the whole conversation is billed again at the uncached rate. These calls cost ${c} credits, about ${w} more than with a warm cache.`,
    'Pick the model at the start of a chat and keep it. For a sub-task on another model, start a new chat with a short summary, or delegate to a subagent with a small, focused context.'));

  const idle = breaks.filter(b => b.cause === 'idle-expiry');
  if (idle.length) findings.push(cacheFinding('idle-cache-expiry', 'cache', idle, total,
    `Pauses over 5 minutes expired the prompt cache ${idle.length}×`,
    (c, w) => `After ~5 minutes without a request the cached conversation expires, and the next message re-sends everything at the uncached rate. Cost: ${c} credits, about ${w} above a warm-cache call. The larger the chat, the more each expiry costs.`,
    'Send follow-ups before long breaks or batch several questions into one message. After a long break on a large chat, start a new chat with a short summary if the next step is a different topic.'));

  const other = breaks.filter(b => b.cause === 'toolset-change' || b.cause === 'other');
  if (other.some(b => (b.wasted ?? 0) > 0)) findings.push(cacheFinding('unexplained-cache-miss', 'cache', other, total,
    `${other.length} cache misses without a model switch or pause`,
    (c, w) => `Causes include changing enabled tools/MCP servers mid-chat (${other.filter(b => b.cause === 'toolset-change').length}×), context summarization, or edited instructions. These calls cost ${c} credits, about ${w} above a warm cache.`,
    'Avoid toggling tools, MCP servers or instruction files during an active chat; configure them before starting.'));

  const tools = toolUsage(data, calls);
  const unused = tools.servers.filter(s => s.server.startsWith('mcp:') && s.calls === 0 && s.toolsOffered > 0);
  if (unused.length || tools.duplicateServers.length) {
    const unusedTools = unused.reduce((n, s) => n + s.toolsOffered, 0);
    findings.push({
      id: 'tool-bloat', category: 'tools',
      severity: unusedTools >= 50 || tools.duplicateServers.length ? 'medium' : 'low',
      title: `Up to ${tools.maxToolsOffered} tools offered; ${unused.length} MCP servers (${unusedTools} tools) were never used`,
      detail: 'Enabled tool definitions are part of every request. Large tool lists enlarge the prompt, make tool choice harder, and beyond ~128 tools Copilot hides tools behind `tool_search`, which adds model rounds.' +
        (tools.duplicateServers.length ? ` Duplicate servers: ${tools.duplicateServers.map(d => d.servers.join(' ≈ ')).join('; ')}.` : ''),
      recommendation: 'Disable unused MCP servers in the chat tool picker (or per workspace), remove duplicate server registrations, and create tool sets per task type.',
      evidence: { unusedServers: unused.map(s => ({ server: s.server, tools: s.toolsOffered })),
        duplicateServers: tools.duplicateServers, toolSearchCalls: tools.toolSearchCalls }
    });
  }

  if (tools.toolSearchCalls >= 3) {
    const avg = total / calls.length, stake = tools.toolSearchCalls * avg;
    findings.push({
      id: 'tool-search-rounds', category: 'tools', severity: severity(stake, total),
      title: `The model searched for tools ${tools.toolSearchCalls}× before using them`,
      detail: `Each tool_search is an extra model round (≈${r2(avg)} credits per call on average in this period). It happens when too many tools are enabled to offer them all directly.`,
      recommendation: 'Reduce enabled tools (see tool-bloat) so frequently used tools are offered directly.',
      creditsAtStake: r2(stake), evidence: { toolSearchCalls: tools.toolSearchCalls, avgCreditsPerCall: r2(avg) }
    });
  }

  const failed = tools.topTools.filter(t => t.failed >= 2);
  if (failed.length) findings.push({
    id: 'failed-tools', category: 'reliability', severity: 'low',
    title: `${failed.reduce((n, t) => n + t.failed, 0)} failed tool calls`,
    detail: 'Each failed tool call costs a model round to notice and retry.',
    recommendation: 'Fix recurring causes (missing MCP authentication, wrong paths, unavailable build tools) or disable tools that fail consistently.',
    evidence: { tools: failed.map(t => ({ name: t.name, failed: t.failed, succeeded: t.calls })) }
  });

  // Model choice on light turns: no edits, little output, read-only tools.
  const models = [...new Set(calls.map(c => c.model))];
  const byTurn = group(calls.filter(c => !c.subagent), c => `${c.sessionId}|${c.turnId}`);
  const light = new Map<string, { turns: number; credits: number; alt: Record<string, number> }>();
  for (const e of turnsOf(data, calls)) {
    const tc = byTurn.get(`${e.debugUsage!.sessionId}|${e.debugUsage!.turnId}`);
    if (!tc?.length || (e.analysis?.files.length ?? 0) > 0) continue;
    if (tc.reduce((n, c) => n + c.output, 0) > 4000) continue;
    if ((e.analysis?.tools ?? []).some(t => !READ_ONLY_TOOL.test(t.name))) continue;
    for (const c of tc) {
      const s = light.get(c.model) ?? { turns: 0, credits: 0, alt: {} };
      s.credits += c.credits ?? 0;
      for (const m of models) {
        if (m === c.model) continue;
        const v = scaled(c, priceOf(data.modelPrices, c.model), c, priceOf(data.modelPrices, m));
        if (v !== undefined) s.alt[m] = (s.alt[m] ?? 0) + v;
      }
      light.set(c.model, s);
    }
    light.get(tc[tc.length - 1].model)!.turns++;
  }
  const perModel: { model: string; turns: number; credits: number; stake: number; alternatives: Record<string, number> }[] = [];
  for (const [model, s] of light) {
    const cheaper = Object.entries(s.alt).filter(([, v]) => v < s.credits * 0.7).sort((a, b) => b[1] - a[1]);
    if (!s.turns || !cheaper.length || s.credits < 1) continue;
    // Conservative: savings vs. the most expensive of the cheaper models you already use.
    perModel.push({ model, turns: s.turns, credits: r2(s.credits), stake: r2(s.credits - cheaper[0][1]),
      alternatives: Object.fromEntries(cheaper.slice(0, 3).map(([m, v]) => [m, r2(v)])) });
  }
  if (perModel.length) {
    perModel.sort((a, b) => b.stake - a.stake);
    const stake = perModel.reduce((n, m) => n + m.stake, 0);
    const top = perModel[0];
    findings.push({
      id: 'light-turns', category: 'model', severity: severity(stake, total),
      title: `${perModel.reduce((n, m) => n + m.turns, 0)} read-only/question turns ran on pricier models (${r2(perModel.reduce((n, m) => n + m.credits, 0))} credits)`,
      detail: `These turns edited no files, produced little output and only read or searched. Biggest: ${top.turns} turns on ${top.model} (${top.credits} credits); with the same tokens, ${Object.entries(top.alternatives).map(([m, v]) => `${m} ≈ ${v}`).join(', ')} credits. Token counts differ between models, so this is an estimate, not a quality judgement.`,
      recommendation: 'Use a cheaper model you trust for explanations, lookups and planning questions; reserve premium models for complex edits and hard reasoning. Check prompt excerpts with session_detail to judge which turns really needed them.',
      creditsAtStake: r2(stake),
      evidence: { byModel: perModel }
    });
  }

  // Long chats: context grows every round and every round re-reads it.
  const long = [...group(calls.filter(c => !c.subagent), c => c.stream).values()].map(list => {
    const q = Math.max(1, Math.floor(list.length / 4));
    return { session: list[0].sessionId, calls: list.length, turns: new Set(list.map(c => c.turnId)).size,
      credits: creditsOf(list), maxInputTokens: Math.max(...list.map(c => c.input)),
      earlyPerCall: creditsOf(list.slice(0, q)) / q, latePerCall: creditsOf(list.slice(-q)) / q };
  }).filter(s => s.maxInputTokens >= 100_000 && s.turns >= 3 && s.latePerCall > s.earlyPerCall * 1.5)
    .sort((a, b) => b.credits - a.credits);
  if (long.length) {
    // Rough: half of the late-call premium over the second half of each chat.
    const stake = long.reduce((n, s) => n + (s.latePerCall - s.earlyPerCall) * Math.floor(s.calls / 2), 0) * 0.5;
    findings.push({
      id: 'long-chats', category: 'context', severity: severity(stake, total),
      title: `${long.length} chats grew beyond 100K tokens of context`,
      detail: 'Every model round re-reads the whole conversation, so late calls in these chats cost much more than early ones. Unrelated follow-up topics in the same chat pay for all earlier context.',
      recommendation: 'Start a new chat when the topic changes or a task is done, carrying over a short summary. Use session_detail with prompt excerpts to check whether a chat stayed on one topic.',
      creditsAtStake: r2(stake),
      evidence: { sessions: long.slice(0, 5).map(s => ({ ...s, credits: r2(s.credits), earlyPerCall: r2(s.earlyPerCall), latePerCall: r2(s.latePerCall) })) }
    });
  }

  const highCredits = creditsOf(calls.filter(c => c.effort && /^(high|xhigh|max)$/i.test(c.effort)));
  if (total && highCredits / total >= 0.5) findings.push({
    id: 'reasoning-effort', category: 'effort', severity: 'low',
    title: `${pct(highCredits / total)}% of credits used high reasoning effort`,
    detail: 'Higher reasoning effort produces more billed thinking tokens and slower answers. It pays off for hard problems, not for lookups or routine edits.',
    recommendation: 'Lower the reasoning effort for routine work in the model picker and raise it only for complex tasks.',
    evidence: { byEffort: Object.fromEntries([...group(calls, c => c.effort ?? 'unspecified')].map(([k, v]) => [k, r2(creditsOf(v))])) }
  });

  const subCredits = creditsOf(calls.filter(c => c.subagent));
  if (total && subCredits / total >= 0.25) findings.push({
    id: 'subagents', category: 'context', severity: 'low',
    title: `Subagents used ${pct(subCredits / total)}% of credits`,
    detail: `Each subagent starts with a fresh context (${breaks.filter(b => b.cause === 'new-context' && b.subagent).length} cold starts in this period). That is efficient for broad, isolated research, but costly for small lookups the main chat could answer from existing context.`,
    recommendation: 'Delegate only broad, independent research to subagents; ask the main chat directly for small lookups.',
    evidence: { subagentCredits: r2(subCredits) }
  });

  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || (b.creditsAtStake ?? 0) - (a.creditsAtStake ?? 0));
}

export interface SessionRow {
  sessionId: string;
  start: string;
  end: string;
  /** Wall-clock span from first call to end of last call. */
  durationMin: number;
  turns: number;
  calls: number;
  credits: number;
  creditsPerTurn: number;
  models: string[];
  maxInputTokens: number;
  cacheHitPct: number;
  outputTokens: number;
  subagentCredits: number;
  linesAdded: number;
  linesRemoved: number;
  filesEdited: number;
  avoidableCacheBreaks: number;
  branches: string[];
  workItems: string[];
  /** Expensive relative to the other sessions in the period, yet changed almost no lines. */
  expensiveLowOutput: boolean;
}

/** Sessions below this many changed lines count as "low output". */
export const LOW_OUTPUT_LINES = 10;
const LOW_OUTPUT_MIN_CREDITS = 10;

/** Every session in the period with its aggregates, newest first. */
export function sessionRows(data: UsageData, filter: InsightFilter = {}, now = Date.now()): SessionRow[] {
  const calls = collectCalls(data, filter, now);
  const breaks = detectCacheBreaks(calls, data.modelPrices);
  const avoidable = new Map<string, number>();
  for (const b of breaks) if (b.cause !== 'new-context') avoidable.set(b.sessionId, (avoidable.get(b.sessionId) ?? 0) + 1);
  const entries = group(turnsOf(data, calls), e => e.debugUsage!.sessionId);
  const rows = [...group(calls, c => c.sessionId).entries()].map(([id, list]): SessionRow => {
    const b = bucket();
    list.forEach(c => add(b, c));
    const turns = new Set(list.map(c => c.turnId)).size;
    const last = list[list.length - 1];
    let linesAdded = 0, linesRemoved = 0;
    const files = new Set<string>();
    for (const e of entries.get(id) ?? []) {
      for (const f of e.analysis?.files ?? []) {
        linesAdded += f.added ?? 0; linesRemoved += f.removed ?? 0; files.add(f.path);
      }
    }
    return {
      sessionId: id,
      start: iso(list[0].ts),
      end: iso(last.ts),
      durationMin: Math.round((last.ts + last.durationMs - list[0].ts) / 6000) / 10,
      turns,
      calls: list.length,
      credits: r2(b.credits),
      creditsPerTurn: turns ? r2(b.credits / turns) : 0,
      models: [...new Set(list.map(c => c.model))],
      maxInputTokens: Math.max(...list.map(c => c.input)),
      cacheHitPct: b.input ? pct(b.cached / b.input) : 0,
      outputTokens: b.output,
      subagentCredits: r2(creditsOf(list.filter(c => c.subagent))),
      linesAdded, linesRemoved, filesEdited: files.size,
      avoidableCacheBreaks: avoidable.get(id) ?? 0,
      branches: [...new Set(list.map(c => c.branch).filter((x): x is string => !!x))],
      workItems: [...new Set(list.map(c => c.workItemId).filter((x): x is string => !!x))],
      expensiveLowOutput: false
    };
  });
  // "Expensive" = top quartile of the period (and at least a few credits).
  const sorted = rows.map(r => r.credits).sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.ceil((sorted.length - 1) * 0.75)] : 0;
  const threshold = Math.max(p75, LOW_OUTPUT_MIN_CREDITS);
  for (const r of rows) r.expensiveLowOutput = r.credits >= threshold && r.linesAdded + r.linesRemoved < LOW_OUTPUT_LINES;
  return rows.sort((a, b) => b.end.localeCompare(a.end));
}

export function listSessions(data: UsageData, filter: InsightFilter = {}, limit = 20, now = Date.now()): SessionRow[] {
  return sessionRows(data, filter, now).slice(0, Math.max(1, Math.min(limit, 100)));
}

export type SessionSortKey = 'end' | 'start' | 'durationMin' | 'turns' | 'calls' | 'credits' | 'creditsPerTurn'
  | 'cacheHitPct' | 'maxInputTokens' | 'linesChanged' | 'avoidableCacheBreaks';

export interface SessionQuery {
  filter?: InsightFilter;
  model?: string;
  minCredits?: number;
  lowOutputOnly?: boolean;
  sort?: SessionSortKey;
  descending?: boolean;
  offset?: number;
  /** Page size (1-500, default 50). */
  limit?: number;
}

/** Filtered, sorted, paged session list for the dashboard's Sessions tab. */
export function querySessions(data: UsageData, q: SessionQuery = {}, now = Date.now()) {
  const all = sessionRows(data, q.filter ?? {}, now);
  const rows = all.filter(r => (!q.model || r.models.includes(q.model))
    && (!q.minCredits || r.credits >= q.minCredits)
    && (!q.lowOutputOnly || r.expensiveLowOutput));
  const key = q.sort ?? 'end';
  const val = (r: SessionRow): number | string => key === 'linesChanged' ? r.linesAdded + r.linesRemoved : r[key];
  const dir = q.descending === false ? 1 : -1;
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * dir || b.end.localeCompare(a.end);
  });
  const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
  const offset = Math.max(0, Math.min(q.offset ?? 0, Math.max(0, rows.length - 1)));
  return {
    total: rows.length,
    offset,
    totals: { credits: r2(rows.reduce((n, r) => n + r.credits, 0)), turns: rows.reduce((n, r) => n + r.turns, 0),
      lowOutput: rows.filter(r => r.expensiveLowOutput).length },
    models: [...new Set(all.flatMap(r => r.models))].sort(),
    branches: [...new Set(all.flatMap(r => r.branches))].sort(),
    rows: rows.slice(offset, offset + limit)
  };
}

/** CSV for a list of sessions; titles are optional and never stored. */
export function sessionsCsv(rows: SessionRow[], titles: Record<string, string> = {}): string {
  const cell = (v: unknown) => {
    const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
    return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const head = ['sessionId', 'title', 'start', 'end', 'durationMin', 'turns', 'calls', 'credits', 'creditsPerTurn', 'models',
    'maxInputTokens', 'cacheHitPct', 'outputTokens', 'subagentCredits', 'linesAdded', 'linesRemoved', 'filesEdited',
    'avoidableCacheBreaks', 'branches', 'workItems', 'expensiveLowOutput'];
  return [head.join(','), ...rows.map(r => [r.sessionId, titles[r.sessionId] ?? '', r.start, r.end, r.durationMin, r.turns, r.calls,
    r.credits, r.creditsPerTurn, r.models, r.maxInputTokens, r.cacheHitPct, r.outputTokens, r.subagentCredits, r.linesAdded,
    r.linesRemoved, r.filesEdited, r.avoidableCacheBreaks, r.branches, r.workItems, r.expensiveLowOutput].map(cell).join(','))].join('\r\n');
}

/** Credits per work item in the period, so an assistant can pick a scope for the other tools. */
export function workItemUsage(data: UsageData, filter: InsightFilter = {}, now = Date.now()) {
  const calls = collectCalls(data, filter, now);
  return [...group(calls, c => c.workItemId ?? '').entries()].map(([id, list]) => {
    const wi = id ? data.workItems[id] : undefined;
    const projectId = wi?.projectId ?? list.find(c => c.projectId)?.projectId ?? null;
    return {
      workItemId: id || null,
      title: wi?.title ?? (id ? null : '(no work item)'),
      project: projectId ? data.projects[projectId]?.name ?? projectId : null,
      projectId,
      branches: [...new Set(list.map(c => c.branch).filter(Boolean))],
      sessions: new Set(list.map(c => c.sessionId)).size,
      calls: list.length,
      credits: r2(creditsOf(list)),
      models: [...new Set(list.map(c => c.model))]
    };
  }).sort((a, b) => b.credits - a.credits);
}

export function sessionDetail(data: UsageData, sessionId: string) {
  const all = { sessionId, from: 0 };
  const calls = collectCalls(data, all, Number.MAX_SAFE_INTEGER);
  if (!calls.length) return undefined;
  const breaks = detectCacheBreaks(calls, data.modelPrices);
  const byTurn = group(calls, c => c.turnId);
  return {
    sessionId,
    summary: listSessions(data, all, 1, Number.MAX_SAFE_INTEGER)[0],
    turns: turnsOf(data, calls).sort((a, b) => a.ts - b.ts).map(e => {
      const turnId = e.debugUsage!.turnId, tc = byTurn.get(turnId) ?? [];
      const b = bucket();
      tc.forEach(c => add(b, c));
      return {
        turnId,
        entryId: e.id,
        at: iso(e.ts),
        branch: e.branch, workItemId: e.workItemId,
        ...show(b),
        models: [...new Set(tc.map(c => c.model))],
        effort: [...new Set(tc.map(c => c.effort).filter(Boolean))],
        subagentCredits: r2(creditsOf(tc.filter(c => c.subagent))),
        tools: (e.analysis?.tools ?? []).map(t => ({ name: t.name, calls: t.count, ...(t.failed ? { failed: t.failed } : {}) })),
        filesEdited: (e.analysis?.files ?? []).slice(0, 8).map(f => ({ path: f.path, added: f.added, removed: f.removed })),
        cacheBreaks: breaks.filter(x => x.turnId === turnId).map(x => ({
          at: iso(x.ts), cause: x.cause, model: x.model, credits: r2(x.credits),
          ...(x.wasted !== undefined ? { estimatedWaste: r2(x.wasted) } : {}),
          ...(x.gapMinutes !== undefined ? { gapMinutes: x.gapMinutes } : {})
        }))
      };
    })
  };
}
