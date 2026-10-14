import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TurnAnalysis } from './debugExport';
import type { DebugLogRequest, DebugLogTurn, DebugUserMessage } from './debugLog';

/**
 * VS Code 1.141+ Agent Host chats (#172). These chats run as Copilot CLI
 * sessions and no longer write Copilot debug logs or chatSessions files:
 *  - `<Code>/agentSessionData/<sessionId>/session.db` (SQLite): one row per user
 *    turn with its recorded usage (`turn_usage`), file edits and metadata;
 *  - `~/.copilot/session-state/<sdkSessionId>/events.jsonl`: timestamps, rounds
 *    and tool calls of each turn.
 * Only counts, models, paths and timestamps are stored. Prompts are clipped and
 * kept in memory for correction linking only; file contents are never read.
 */

/** Minimal surface of `node:sqlite` (not in @types/node 20). */
interface SqliteStatement { all(...params: unknown[]): Record<string, unknown>[] }
interface SqliteDatabase { prepare(sql: string): SqliteStatement; close(): void }
type SqliteCtor = new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;

let sqliteCtor: SqliteCtor | null | undefined;
let sqliteError = '';

/** `node:sqlite` DatabaseSync, or undefined when this runtime lacks it (Node < 22.5). */
export function sqlite(): SqliteCtor | undefined {
  if (sqliteCtor === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sqliteCtor = (require('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync ?? null;
    } catch (error) {
      sqliteCtor = null;
      sqliteError = String(error);
    }
  }
  return sqliteCtor ?? undefined;
}

export function sqliteUnavailableReason(): string {
  return sqliteError || 'node:sqlite is not available in this runtime';
}

/** `<Code>/agentSessionData` for the `<Code>/User` directory. */
export function agentSessionRoot(userDir: string): string {
  return path.join(path.dirname(userDir), 'agentSessionData');
}

export function copilotSessionStateRoot(): string {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

export interface AgentHostTurnRow {
  id: string;
  eventId?: string;
  /** Parsed `turn_usage.usage`, when the turn has finished. */
  usage?: Record<string, unknown>;
  edits: { toolCallId: string; path: string; type: string; added: number; removed: number }[];
}

export interface AgentHostSession {
  sessionId: string;
  title?: string;
  /** Working folders (filesystem paths), primary first. */
  folders: string[];
  /** Branch the session's checkout reported last (fallback attribution only). */
  branch?: string;
  sdkSessionId?: string;
  turns: AgentHostTurnRow[];
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const num = (v: unknown): number => valid(v) ? v : 0;

function json(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Filesystem path of a `file://` URI; undefined for other schemes. */
export function fileUriPath(uri: string): string | undefined {
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(uri.trim());
  if (!m) return undefined;
  let p: string;
  try { p = decodeURIComponent(m[2]); } catch { return undefined; }
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  if (m[1]) p = `//${m[1]}${p}`;
  return path.normalize(p);
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").all(name).length > 0;
}

/**
 * Read one Agent Host `session.db` read-only. Returns undefined when the file is
 * not an agent session (no `turns` table). Throws when SQLite is unavailable.
 */
export function readAgentSession(file: string, sessionId = path.basename(path.dirname(file))): AgentHostSession | undefined {
  const Ctor = sqlite();
  if (!Ctor) throw new Error(sqliteUnavailableReason());
  const db = new Ctor(file, { readOnly: true });
  try {
    if (!hasTable(db, 'turns')) return undefined;
    const meta = new Map<string, string>();
    if (hasTable(db, 'session_metadata')) {
      for (const r of db.prepare('SELECT key, value FROM session_metadata').all()) meta.set(String(r.key), String(r.value ?? ''));
    }
    const folders: string[] = [];
    const addFolder = (uri: unknown) => {
      const p = typeof uri === 'string' ? fileUriPath(uri) : undefined;
      if (p && !folders.includes(p)) folders.push(p);
    };
    addFolder(meta.get('copilot.workingDirectory'));
    const dirs = json(meta.get('copilot.workingDirectories'));
    if (Array.isArray(dirs)) dirs.forEach(addFolder);
    addFolder(meta.get('copilot.project.uri'));
    const git = json(meta.get('agentHost.git'));
    const provider = json(meta.get('defaultChatProviderData'));
    const usage = new Map<string, Record<string, unknown>>();
    if (hasTable(db, 'turn_usage')) {
      for (const r of db.prepare('SELECT turn_id, usage FROM turn_usage').all()) {
        const u = json(r.usage);
        if (object(u)) usage.set(String(r.turn_id), u);
      }
    }
    const edits = new Map<string, AgentHostTurnRow['edits']>();
    if (hasTable(db, 'file_edits')) {
      for (const r of db.prepare('SELECT turn_id, tool_call_id, file_path, edit_type, added_lines, removed_lines FROM file_edits').all()) {
        const list = edits.get(String(r.turn_id)) ?? [];
        list.push({ toolCallId: String(r.tool_call_id ?? ''), path: String(r.file_path ?? ''), type: String(r.edit_type ?? 'edit'),
          added: num(Number(r.added_lines)), removed: num(Number(r.removed_lines)) });
        edits.set(String(r.turn_id), list);
      }
    }
    const turns = db.prepare('SELECT id, event_id FROM turns').all().map(r => ({
      id: String(r.id),
      ...(str(r.event_id) ? { eventId: str(r.event_id) } : {}),
      ...(usage.has(String(r.id)) ? { usage: usage.get(String(r.id)) } : {}),
      edits: edits.get(String(r.id)) ?? []
    }));
    const title = str(meta.get('customTitle'));
    const branch = object(git) ? str(git.branchName) : '';
    const sdk = object(provider) ? str(provider.sdkSessionId) : '';
    return { sessionId, folders, turns,
      ...(title ? { title } : {}), ...(branch ? { branch } : {}), ...(sdk ? { sdkSessionId: sdk } : {}) };
  } finally {
    db.close();
  }
}

/** Chat title of an Agent Host session, or undefined (never throws). */
export function readAgentSessionTitle(file: string): string | undefined {
  const Ctor = sqlite();
  if (!Ctor) return undefined;
  let db: SqliteDatabase | undefined;
  try {
    db = new Ctor(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM session_metadata WHERE key='customTitle'").all()[0];
    return str(row?.value) || undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export interface AgentHostTiming {
  /** User message time (epoch ms). */
  ts: number;
  /** Summed model-round wall time of the turn (ms). */
  roundsMs: number;
  tools: Map<string, { count: number; failed: number }>;
}

/**
 * Per user message (keyed by `user.message` event id): start time, round wall
 * time and tool histogram from a Copilot CLI `events.jsonl`, plus the clipped
 * prompts for correction linking (#131). Malformed or partial lines are skipped.
 */
export function parseAgentEvents(text: string, sessionId = '', maxChars = 1000): { timings: Map<string, AgentHostTiming>; messages: DebugUserMessage[] } {
  const out = new Map<string, AgentHostTiming>();
  const messages: DebugUserMessage[] = [];
  const byInteraction = new Map<string, AgentHostTiming>();
  const toolNames = new Map<string, string>();
  let current: AgentHostTiming | undefined;
  let roundStart: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (!object(e) || !object(e.data)) continue;
    const ts = Date.parse(str(e.timestamp));
    const d = e.data;
    switch (e.type) {
      case 'user.message': {
        if (!Number.isFinite(ts) || !str(e.id)) break;
        const t: AgentHostTiming = { ts, roundsMs: 0, tools: new Map() };
        out.set(str(e.id), t);
        if (str(d.interactionId)) byInteraction.set(str(d.interactionId), t);
        current = t;
        roundStart = undefined;
        const content = typeof d.content === 'string' ? d.content.trim() : '';
        if (content) messages.push({ t: ts, sessionId, text: content.slice(0, maxChars) });
        break;
      }
      case 'assistant.turn_start':
        current = byInteraction.get(str(d.interactionId)) ?? current;
        roundStart = Number.isFinite(ts) ? ts : undefined;
        break;
      case 'assistant.turn_end':
        if (current && roundStart !== undefined && Number.isFinite(ts) && ts >= roundStart) current.roundsMs += ts - roundStart;
        roundStart = undefined;
        break;
      case 'tool.execution_start':
        if (str(d.toolCallId) && str(d.toolName)) toolNames.set(str(d.toolCallId), str(d.toolName).slice(0, 80));
        break;
      case 'tool.execution_complete': {
        const t = byInteraction.get(str(d.interactionId)) ?? current;
        if (!t) break;
        const name = toolNames.get(str(d.toolCallId)) ?? 'unknown';
        const stat = t.tools.get(name) ?? { count: 0, failed: 0 };
        if (d.success === false) stat.failed++;
        else stat.count++;
        t.tools.set(name, stat);
        break;
      }
    }
  }
  return { timings: out, messages };
}

function analysis(): TurnAnalysis {
  const tiers = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  return { files: [], totalAdded: 0, totalRemoved: 0, tools: [], toolCalls: 0,
    requestsDetail: [], tiers: tiers(), tierCredits: tiers(), durationMs: 0 };
}

interface ModelTokens { model: string; inputTokens: number; cachedTokens: number; outputTokens: number }

function modelTotals(value: unknown): ModelTokens[] {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map(t => ({ model: str(t.model) || 'unknown', inputTokens: num(t.inputTokens),
    cachedTokens: num(t.cachedTokens), outputTokens: num(t.outputTokens) }))
    .filter(t => t.inputTokens || t.outputTokens);
}

/** Relative cost weight for splitting a known group charge across its models. */
const weight = (t: ModelTokens) => Math.max(0, t.inputTokens - t.cachedTokens) + 0.1 * t.cachedTokens + 4 * t.outputTokens;

/**
 * Convert finished Agent Host turns into debug-usage turns (same ledger shape as
 * the debug-log tracker). The recorded `copilotUsage.totalNanoAiu` is the exact
 * turn charge including subagents; it is split per model by the main-agent and
 * subagent totals. Within one group of several models the split is weighted by
 * tokens, so only the per-model breakdown (never the turn total) is approximate.
 */
export function agentTurns(
  session: AgentHostSession,
  timings: Map<string, AgentHostTiming>,
  fallbackTs: number
): DebugLogTurn[] {
  const out: DebugLogTurn[] = [];
  for (const row of session.turns) {
    const u = row.usage;
    if (!u) continue;
    const meta = object(u._meta) ? u._meta : {};
    const usage = object(meta.copilotUsage) ? meta.copilotUsage : {};
    const direct = object(meta.directCopilotUsage) ? meta.directCopilotUsage : {};
    const total = valid(usage.totalNanoAiu) ? usage.totalNanoAiu / 1e9 : null;
    const directCredits = valid(direct.totalNanoAiu) ? direct.totalNanoAiu / 1e9 : total;
    const timing = row.eventId ? timings.get(row.eventId) : undefined;
    const ts = timing?.ts ?? fallbackTs;
    const call = object(meta['vscode.modelCall']) ? meta['vscode.modelCall'] : {};

    let main = modelTotals(meta.directTurnTokenTotals);
    const all = modelTotals(meta.turnTokenTotals);
    if (!main.length && !all.length && (num(u.inputTokens) || num(u.outputTokens))) {
      main = [{ model: str(u.model) || str(call.model) || 'unknown', inputTokens: num(u.inputTokens),
        cachedTokens: num(u.cacheReadTokens), outputTokens: num(u.outputTokens) }];
    }
    if (!main.length) main = all;
    const sub: ModelTokens[] = [];
    for (const t of all) {
      const m = main.find(x => x.model === t.model);
      const rest = { model: t.model, inputTokens: Math.max(0, t.inputTokens - (m?.inputTokens ?? 0)),
        cachedTokens: Math.max(0, t.cachedTokens - (m?.cachedTokens ?? 0)), outputTokens: Math.max(0, t.outputTokens - (m?.outputTokens ?? 0)) };
      if (main !== all && (rest.inputTokens || rest.outputTokens)) sub.push(rest);
    }
    if (!main.length && !sub.length) {
      if (total === null) continue;
      main = [{ model: str(u.model) || 'unknown', inputTokens: 0, cachedTokens: 0, outputTokens: 0 }];
    }
    const subCredits = total !== null && directCredits !== null ? Math.max(0, total - directCredits) : null;
    const requests: DebugLogRequest[] = [];
    const split = (group: ModelTokens[], credits: number | null, subagent: boolean) => {
      const sum = group.reduce((s, t) => s + weight(t), 0);
      group.forEach((t, i) => requests.push({
        spanId: `${row.id}:${subagent ? 'sub:' : ''}${t.model}`,
        model: t.model, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
        ...(t.cachedTokens ? { cachedTokens: Math.min(t.cachedTokens, t.inputTokens) } : {}),
        credits: credits === null ? null : group.length === 1 ? credits
          : sum > 0 ? credits * weight(t) / sum : i === 0 ? credits : 0,
        ts, agent: 'agent-host',
        ...(!subagent && timing?.roundsMs ? { durationMs: timing.roundsMs } : {}),
        ...(!subagent && group.length === 1 && valid(call.timeToFirstTokenMs) && !str(call.agentId) ? { ttftMs: Math.round(call.timeToFirstTokenMs) } : {}),
        ...(subagent ? { subagent: true } : {})
      }));
    };
    split(main, sub.length ? directCredits : total, false);
    if (sub.length) split(sub, subCredits, true);
    else if (subCredits && requests.length && requests[0].credits !== null) {
      // Subagent spend without a token breakdown stays in the turn total.
      requests[0].credits = (requests[0].credits ?? 0) + subCredits;
    }

    const a = analysis();
    let credits = 0, unknown = 0;
    for (const r of requests) {
      const cacheRead = Math.min(r.inputTokens, r.cachedTokens ?? 0);
      const tiers = { input: r.inputTokens - cacheRead, cacheRead, cacheWrite: 0, output: r.outputTokens };
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) a.tiers[k] += tiers[k];
      if (r.credits === null) { unknown++; continue; }
      credits += r.credits;
      a.requestsDetail.push({ model: r.model, promptTokens: r.inputTokens, completionTokens: r.outputTokens,
        credits: r.credits, durationMs: r.durationMs ?? 0, tiers });
    }
    a.durationMs = timing?.roundsMs ?? 0;
    for (const [name, s] of timing?.tools ?? []) {
      a.tools.push({ name, count: s.count, ...(s.failed ? { failed: s.failed } : {}) });
      a.toolCalls += s.count;
      if (s.failed) a.failedToolCalls = (a.failedToolCalls ?? 0) + s.failed;
    }
    for (const e of row.edits) {
      if (!e.path) continue;
      const prior = a.files.find(f => f.path === e.path);
      if (prior) {
        prior.added += e.added; prior.removed += e.removed; prior.edits++;
        if (e.type === 'create') prior.created = true;
      } else {
        const ext = path.extname(e.path).slice(1).toLowerCase() || 'unknown';
        a.files.push({ path: e.path, ext, added: e.added, removed: e.removed, edits: 1, ...(e.type === 'create' ? { created: true } : {}) });
      }
      a.totalAdded += e.added;
      a.totalRemoved += e.removed;
    }
    if (!timing && row.edits.length) {
      // Without events, at least count the edit tool calls.
      a.toolCalls = new Set(row.edits.map(e => e.toolCallId)).size;
      a.tools.push({ name: 'edit', count: a.toolCalls });
    }
    out.push({ sessionId: session.sessionId, turnId: row.id, timestamp: ts, requests, credits,
      unknownRequestCount: unknown, responseIds: [], requestAliases: [row.id], analysis: a });
  }
  return out.sort((x, y) => x.timestamp - y.timestamp);
}

/** Bounded read of a session's events.jsonl; undefined when missing or too large. */
export async function readAgentEvents(sdkSessionId: string, root = copilotSessionStateRoot(), limit = 64 * 1024 * 1024): Promise<string | undefined> {
  if (!/^[\w.-]{1,128}$/.test(sdkSessionId)) return undefined;
  const file = path.join(root, sdkSessionId, 'events.jsonl');
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
