import * as fs from 'fs';
import * as readline from 'readline';
import type { UsageData } from '../store/database';
import { readStore } from '../store/persistence';
import {
  listSessions, optimizationFindings, sessionDetail, usageOverview, workItemUsage, type InsightFilter
} from '../analysis/usageInsights';
import { promptExcerpts, SessionTitleResolver, storageRoots } from '../util/sessionTitles';
import { BUDGET_SNAPSHOT_FILE } from '../analysis/budget';
import * as path from 'path';

export { promptExcerpts };

/**
 * Read-only MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing usage
 * insights to AI assistants. Started by VS Code through the extension's MCP
 * server definition provider. Never writes the store. Prompt text is read on
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
  }
].map(t => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

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
