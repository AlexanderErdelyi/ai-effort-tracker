import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UsageData } from '../store/database';
import { readStore } from '../store/persistence';
import {
  listSessions, optimizationFindings, sessionDetail, usageOverview, workItemUsage, type InsightFilter
} from '../analysis/usageInsights';

/**
 * Read-only MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing usage
 * insights to AI assistants. Started by VS Code through the extension's MCP
 * server definition provider. Never writes the store. Prompt text is read on
 * demand from Copilot's own local debug logs and only returned, never stored.
 */

const SERVER = { name: 'ai-effort-tracker', version: process.env.AET_VERSION || '0.0.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LOG_BYTES = 256 * 1024 * 1024;

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
    title: 'Credits per work item',
    description: 'Work items with credits, sessions, branches and models in the period. Use to choose a workItemId scope.',
    inputSchema: { type: 'object', properties: filterProps, additionalProperties: false }
  },
  {
    name: 'list_sessions',
    title: 'Recent chat sessions',
    description: 'Copilot chat sessions (newest first) with turns, credits, models, max context size and avoidable cache breaks.',
    inputSchema: {
      type: 'object',
      properties: { ...filterProps, limit: { type: 'number', description: 'Max sessions (1-100, default 20).' } },
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

function sessionLog(sessionId: string): string | undefined {
  if (!/^[\w.-]{1,128}$/.test(sessionId)) return undefined;
  const roots = (process.env.AET_WORKSPACE_STORAGE ?? '').split(path.delimiter).filter(Boolean);
  let best: { file: string; mtime: number } | undefined;
  for (const root of roots) {
    let workspaces: string[];
    try { workspaces = fs.readdirSync(root); } catch { continue; }
    for (const ws of workspaces) {
      const file = path.join(root, ws, 'GitHub.copilot-chat', 'debug-logs', sessionId, 'main.jsonl');
      try {
        const st = fs.statSync(file);
        if (st.size <= MAX_LOG_BYTES && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
      } catch { /* not in this workspace */ }
    }
  }
  return best?.file;
}

/** User-prompt excerpts keyed by span id (= turn id). Returned only, never persisted. */
export function promptExcerpts(file: string, maxChars: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('"user_message"')) continue;
    try {
      const row = JSON.parse(line);
      const text = row?.type === 'user_message' && typeof row.attrs?.content === 'string' ? row.attrs.content : '';
      if (!text || typeof row.spanId !== 'string' || out.has(row.spanId)) continue;
      const flat = text.replace(/\s+/g, ' ').trim();
      out.set(row.spanId, flat.length > maxChars ? flat.slice(0, maxChars) + '…' : flat);
    } catch { /* partial line */ }
  }
  return out;
}

export function callTool(name: string, args: Json, data = loadData()): unknown {
  switch (name) {
    case 'usage_overview': return usageOverview(data, parseFilter(args));
    case 'optimization_findings': {
      const findings = optimizationFindings(data, parseFilter(args));
      return findings.length ? { findings } : { findings, note: 'No optimization opportunities detected in this period, or no debug-log usage was captured yet.' };
    }
    case 'list_work_items': return { workItems: workItemUsage(data, parseFilter(args)).slice(0, 100) };
    case 'list_sessions': return {
      sessions: listSessions(data, parseFilter(args), typeof args.limit === 'number' ? args.limit : 20)
    };
    case 'session_detail': {
      const id = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!id) throw new Error('"sessionId" is required.');
      const detail = sessionDetail(data, id);
      if (!detail) throw new Error(`No captured usage for session "${id}". Use list_sessions to find ids.`);
      if (args.includePrompts !== true) return detail;
      const chars = Math.max(50, Math.min(1000, typeof args.promptChars === 'number' ? args.promptChars : 300));
      const file = sessionLog(id);
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
