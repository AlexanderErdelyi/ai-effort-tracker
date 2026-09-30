import type { LedgerEntry, UsageData } from '../store/database';
import { BUILTIN_SERVER, serverOf } from '../util/modelCatalog';
import { categorizeWith, type CategoryRules } from '../util/categoryRules';
import { collectCalls, priceOf, scaled, type Call, type InsightFilter } from './usageInsights';

/**
 * Model efficiency per task type (#99) and tool-set profiles (#102). Pure and
 * deterministic; shared by the dashboard and the MCP server. Savings are
 * list-price ESTIMATES scaled from recorded charges.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => Math.round(n * 1000) / 10;
const DAY = 86_400_000;

/** Task type of a turn: the file category with most changed lines, or `qa` when nothing was edited. */
export const QA_TASK = 'qa';
export const TASK_LABELS: Record<string, string> = {
  qa: 'Q&A / read-only', programming: 'Programming', specification: 'Specification', documentation: 'Documentation',
  translation: 'Translations', deployment: 'Deployment', config: 'Config', other: 'Other'
};
/** Turns a model needs for a task type before it is compared or recommended. */
export const MIN_SAMPLES = 5;

export type Classifier = (path: string) => string;
export const defaultClassifier = (rules: CategoryRules = { extensions: {}, folders: {} }): Classifier =>
  p => categorizeWith(p, rules);
/** Per-machine file (next to the store) with the user's category rules, for the MCP server. */
export const CATEGORY_RULES_SNAPSHOT_FILE = 'category-rules.json';

interface Turn {
  entry: LedgerEntry;
  calls: Call[];
  model: string;
  task: string;
  lines: number;
}

function key(c: { sessionId: string; turnId: string }) { return `${c.sessionId}|${c.turnId}`; }

/** Group filtered calls into turns with their main model (most credits outside subagents) and task type. */
function turnsFrom(data: UsageData, calls: Call[], classify: Classifier): Turn[] {
  const byTurn = new Map<string, Call[]>();
  for (const c of calls) {
    const list = byTurn.get(key(c));
    if (list) list.push(c); else byTurn.set(key(c), [c]);
  }
  const turns: Turn[] = [];
  for (const e of data.creditLedger) {
    if (!e.debugUsage) continue;
    const list = byTurn.get(key(e.debugUsage));
    if (!list) continue;
    const credit = new Map<string, number>();
    const main = list.some(c => !c.subagent) ? list.filter(c => !c.subagent) : list;
    for (const c of main) credit.set(c.model, (credit.get(c.model) ?? 0) + (c.credits ?? 0) + 1e-9 * (c.input + c.output));
    const model = [...credit.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const byCat = new Map<string, number>();
    let lines = 0;
    for (const f of e.analysis?.files ?? []) {
      const n = (f.added ?? 0) + (f.removed ?? 0);
      if (n <= 0) continue;
      const cat = f.category || classify(f.path);
      byCat.set(cat, (byCat.get(cat) ?? 0) + n);
      lines += f.added ?? 0;
    }
    const task = byCat.size ? [...byCat.entries()].sort((a, b) => b[1] - a[1])[0][0] : QA_TASK;
    turns.push({ entry: e, calls: list, model, task, lines });
  }
  return turns;
}

export interface EfficiencyCell {
  model: string;
  task: string;
  turns: number;
  credits: number;
  creditsPerTurn: number;
  /** Lines added in the turns (0 for Q&A). */
  lines: number;
  /** Credits per 100 added lines; null for Q&A or no lines. */
  creditsPer100Lines: number | null;
  cacheHitPct: number;
  avgOutputTokens: number;
  /** Fewer than MIN_SAMPLES turns: shown, never recommended. */
  smallSample: boolean;
}

export interface TaskRecommendation {
  task: string;
  /** Model used most for this task type. */
  mostUsed: string;
  /** Cheapest model with enough samples (credits per turn; per 100 lines for edit tasks). */
  cheapest: string | null;
  metric: 'creditsPerTurn' | 'creditsPer100Lines';
  mostUsedValue: number | null;
  cheapestValue: number | null;
  /** Estimated credits saved had the most-used model's turns cost the cheapest model's rate. */
  potentialSavings: number;
  note: string;
}

export interface ModelEfficiency {
  period: { from: string; to: string };
  turns: number;
  models: string[];
  tasks: string[];
  cells: EfficiencyCell[];
  recommendations: TaskRecommendation[];
  minSamples: number;
  /** Task type used for turns without edits (compared per turn instead of per 100 lines). */
  qaTask: string;
  taskLabels: Record<string, string>;
  note: string;
}

export function modelEfficiency(data: UsageData, filter: InsightFilter = {}, classify: Classifier = defaultClassifier(), now = Date.now()): ModelEfficiency {
  const calls = collectCalls(data, filter, now);
  const turns = turnsFrom(data, calls, classify);
  const cells = new Map<string, EfficiencyCell & { input: number; cached: number; output: number }>();
  for (const t of turns) {
    const k = `${t.model}|${t.task}`;
    const c = cells.get(k) ?? { model: t.model, task: t.task, turns: 0, credits: 0, creditsPerTurn: 0, lines: 0, creditsPer100Lines: null,
      cacheHitPct: 0, avgOutputTokens: 0, smallSample: true, input: 0, cached: 0, output: 0 };
    c.turns++;
    c.lines += t.lines;
    for (const x of t.calls) { c.credits += x.credits ?? 0; c.input += x.input; c.cached += x.cached; c.output += x.output; }
    cells.set(k, c);
  }
  const out: EfficiencyCell[] = [...cells.values()].map(c => ({
    model: c.model, task: c.task, turns: c.turns, credits: r2(c.credits), creditsPerTurn: r2(c.credits / c.turns), lines: c.lines,
    creditsPer100Lines: c.task !== QA_TASK && c.lines > 0 ? r2(c.credits / c.lines * 100) : null,
    cacheHitPct: c.input ? pct(c.cached / c.input) : 0, avgOutputTokens: Math.round(c.output / c.turns), smallSample: c.turns < MIN_SAMPLES
  })).sort((a, b) => a.task.localeCompare(b.task) || b.turns - a.turns);

  const tasks = [...new Set(out.map(c => c.task))].sort((a, b) =>
    out.filter(c => c.task === b).reduce((n, c) => n + c.turns, 0) - out.filter(c => c.task === a).reduce((n, c) => n + c.turns, 0));
  const recommendations: TaskRecommendation[] = [];
  for (const task of tasks) {
    const list = out.filter(c => c.task === task);
    const metric: TaskRecommendation['metric'] = task === QA_TASK ? 'creditsPerTurn' : 'creditsPer100Lines';
    const value = (c: EfficiencyCell) => metric === 'creditsPerTurn' ? c.creditsPerTurn : c.creditsPer100Lines;
    const most = [...list].sort((a, b) => b.turns - a.turns)[0];
    const eligible = list.filter(c => !c.smallSample && value(c) !== null);
    const cheapest = eligible.sort((a, b) => value(a)! - value(b)!)[0] ?? null;
    let savings = 0;
    if (cheapest && cheapest.model !== most.model && !most.smallSample && value(most) !== null) {
      const perUnit = value(most)! - value(cheapest)!;
      savings = metric === 'creditsPerTurn' ? perUnit * most.turns : perUnit * most.lines / 100;
    }
    const label = TASK_LABELS[task] ?? task;
    const note = !cheapest
      ? `Not enough samples yet (a model needs ${MIN_SAMPLES}+ ${label} turns to be compared).`
      : cheapest.model === most.model
        ? `${most.model} is already the cheapest model with enough samples for ${label}.`
        : `${cheapest.model} did ${label} at ${value(cheapest)} credits ${metric === 'creditsPerTurn' ? 'per turn' : 'per 100 lines'} vs ${value(most) ?? '\u2014'} for ${most.model} (most used).`;
    recommendations.push({ task, mostUsed: most.model, cheapest: cheapest?.model ?? null, metric,
      mostUsedValue: value(most), cheapestValue: cheapest ? value(cheapest) : null, potentialSavings: r2(Math.max(0, savings)), note });
  }
  const to = filter.to ?? now, from = filter.from ?? to - (filter.days ?? 30) * DAY;
  return {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    turns: turns.length,
    models: [...new Set(out.map(c => c.model))].sort(),
    tasks,
    cells: out,
    recommendations,
    minSamples: MIN_SAMPLES,
    qaTask: QA_TASK,
    taskLabels: Object.fromEntries(tasks.map(t => [t, TASK_LABELS[t] ?? t])),
    note: 'Task type = category with the most changed lines in the turn (your category rules), or Q&A when nothing was edited. ' +
      'Models differ in what they are asked to do, so compare like with like and treat savings as estimates.'
  };
}

// ---------------------------------------------------------------------------
// Tool-set profile (#102)
// ---------------------------------------------------------------------------

export interface ServerProfile {
  server: string;
  builtin: boolean;
  toolsOffered: number;
  /** Tool definition size (characters) this server adds to every request. */
  definitionChars: number;
  approxTokens: number;
  /** Share (%) of model calls in the period that offered this server. */
  offeredInPct: number;
  calls: number;
  failed: number;
  turns: number;
  usedTools: string[];
  unusedTools: number;
  lastUsed: string | null;
  recommendation: 'keep' | 'disable' | 'review';
  reason: string;
}

export interface ToolProfile {
  scope: InsightFilter;
  turns: number;
  requests: number;
  servers: ServerProfile[];
  keep: string[];
  disable: string[];
  /** Approximate tokens removed per request (average over requests with a captured tool set). */
  tokensSavedPerRequest: number;
  /** Estimated credits the period would have cost less (list-price estimate). */
  estimatedCreditsSaved: number;
  note: string;
}

const CHARS_PER_TOKEN = 4;
/** Servers called fewer times than this in the period are flagged for review, not kept outright. */
const RARE_CALLS = 2;

export function toolProfile(data: UsageData, filter: InsightFilter = {}, now = Date.now()): ToolProfile {
  const calls = collectCalls(data, filter, now);
  const ids = [...new Set(calls.map(c => c.toolset))].filter((id): id is string => !!id && !!data.toolsets[id]);
  const toolsets = ids.map(id => data.toolsets[id]).sort((a, b) => b.lastSeen - a.lastSeen);
  const serverByTool = new Map<string, string>();
  const offered = new Map<string, { count: number; chars: number; tools: Set<string>; offeredCalls: number }>();
  for (const ts of toolsets) {
    for (const [k, s] of Object.entries(ts.servers)) {
      for (const t of s.tools) if (!serverByTool.has(t)) serverByTool.set(t, k);
      const o = offered.get(k) ?? { count: 0, chars: 0, tools: new Set<string>(), offeredCalls: 0 };
      o.count = Math.max(o.count, s.count); o.chars = Math.max(o.chars, s.chars);
      s.tools.forEach(t => o.tools.add(t));
      offered.set(k, o);
    }
  }
  const withToolset = calls.filter(c => c.toolset && data.toolsets[c.toolset]);
  for (const c of withToolset) for (const k of Object.keys(data.toolsets[c.toolset!].servers)) offered.get(k)!.offeredCalls++;

  const turnKeys = new Set(calls.map(key));
  const used = new Map<string, { calls: number; failed: number; turns: Set<string>; tools: Set<string>; last: number }>();
  let turns = 0;
  for (const e of data.creditLedger) {
    if (!e.debugUsage || !turnKeys.has(key(e.debugUsage))) continue;
    turns++;
    for (const t of e.analysis?.tools ?? []) {
      const srv = serverByTool.get(t.name) ?? serverOf(t.name);
      const u = used.get(srv) ?? { calls: 0, failed: 0, turns: new Set<string>(), tools: new Set<string>(), last: 0 };
      u.calls += t.count; u.failed += t.failed ?? 0; u.turns.add(key(e.debugUsage)); u.tools.add(t.name); u.last = Math.max(u.last, e.ts);
      used.set(srv, u);
    }
  }
  const servers: ServerProfile[] = [];
  for (const srv of new Set([...offered.keys(), ...used.keys()])) {
    const o = offered.get(srv), u = used.get(srv);
    const builtin = srv === BUILTIN_SERVER || !srv.startsWith('mcp:');
    const callsN = u?.calls ?? 0;
    let recommendation: ServerProfile['recommendation'], reason: string;
    if (builtin) { recommendation = 'keep'; reason = 'Built-in / extension tools (manage them in the chat tool picker).'; }
    else if (!o) { recommendation = 'keep'; reason = 'Called, but not in any captured tool set.'; }
    else if (callsN === 0) { recommendation = 'disable'; reason = `Offered in ${withToolset.length ? pct(o.offeredCalls / withToolset.length) : 0}% of requests but never called here.`; }
    else if (callsN < RARE_CALLS) { recommendation = 'review'; reason = `Called only ${callsN}× \u2013 consider enabling it only when needed.`; }
    else { recommendation = 'keep'; reason = `Used ${callsN}× in ${u!.turns.size} turns.`; }
    servers.push({
      server: srv, builtin, toolsOffered: o?.count ?? 0, definitionChars: o?.chars ?? 0, approxTokens: Math.round((o?.chars ?? 0) / CHARS_PER_TOKEN),
      offeredInPct: o && withToolset.length ? pct(o.offeredCalls / withToolset.length) : 0,
      calls: callsN, failed: u?.failed ?? 0, turns: u?.turns.size ?? 0, usedTools: [...(u?.tools ?? [])].sort(),
      unusedTools: o ? [...o.tools].filter(t => !u?.tools.has(t)).length : 0,
      lastUsed: u?.last ? new Date(u.last).toISOString() : null, recommendation, reason
    });
  }
  servers.sort((a, b) => (a.recommendation === 'disable' ? 0 : 1) - (b.recommendation === 'disable' ? 0 : 1) || b.definitionChars - a.definitionChars);
  const disable = servers.filter(s => s.recommendation === 'disable');
  let credits = 0, savedSum = 0;
  if (disable.length) {
    for (const c of withToolset) {
      const offeredHere = disable.filter(s => data.toolsets[c.toolset!].servers[s.server]).reduce((n, s) => n + s.definitionChars, 0) / CHARS_PER_TOKEN;
      if (offeredHere <= 0) continue;
      savedSum += offeredHere;
      const input = Math.max(0, c.input - offeredHere);
      const cheaper = scaled(c, priceOf(data.modelPrices, c.model), { input, cached: Math.min(input, Math.max(0, c.cached - offeredHere)), output: c.output });
      if (cheaper !== undefined) credits += Math.max(0, (c.credits ?? 0) - cheaper);
    }
  }
  const savedTokens = withToolset.length ? Math.round(savedSum / withToolset.length) : 0;
  return {
    scope: filter, turns, requests: calls.length, servers,
    keep: servers.filter(s => s.recommendation === 'keep').map(s => s.server),
    disable: disable.map(s => s.server),
    tokensSavedPerRequest: savedTokens,
    estimatedCreditsSaved: r2(credits),
    note: toolsets.length
      ? 'Disable the listed MCP servers for this project (chat tool picker or the workspace mcp.json) and re-enable them when a task needs them. Tokens are approximated as characters \u00f7 4.'
      : 'No tool sets captured in this scope yet (captured from Copilot debug logs since 0.22).'
  };
}
