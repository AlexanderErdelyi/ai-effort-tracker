import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

/**
 * Chat-session titles for the session list (issue #95). Read on demand from
 * VS Code's own local files and kept in memory only — never persisted:
 *  1. the chat title VS Code shows (chatSessions/<id>.jsonl `customTitle`),
 *  2. else the first user prompt from Copilot's debug log.
 * No vscode dependency: shared by the extension and the stdio MCP server.
 */

export const MAX_LOG_BYTES = 256 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const HEAD_BYTES = 8 * 1024 * 1024;
const INDEX_TTL_MS = 60_000;
const SAFE_ID = /^[\w.-]{1,128}$/;

export interface SessionFiles { chat?: string; log?: string }

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => s.length > max ? s.slice(0, max).trimEnd() + '…' : s;

function unescapeJson(raw: string): string | undefined {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return undefined; }
}

/** Stream a file in chunks; `visit` receives overlapping text windows. Stops when it returns false. */
function scan(file: string, limit: number, visit: (text: string) => boolean | void): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, limit);
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (let pos = 0; pos < size;) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + decoder.write(buf.subarray(0, n));
      const cut = text.lastIndexOf('\n');
      if (cut < 0 && pos < size) { carry = text; continue; }
      const complete = pos < size ? text.slice(0, cut + 1) : text;
      carry = pos < size ? text.slice(cut + 1) : '';
      if (visit(complete) === false) return;
    }
  } catch { /* unreadable: no title */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const TITLE = /"k":\["customTitle"\],"v":"((?:[^"\\]|\\.)*)"|"customTitle":"((?:[^"\\]|\\.)*)"/g;

/** Latest chat title recorded in a VS Code chat-session file (.jsonl patch log or legacy .json). */
export function readChatTitle(file: string, maxChars = 80): string | undefined {
  let title: string | undefined;
  scan(file, MAX_LOG_BYTES, text => {
    if (!text.includes('customTitle')) return;
    TITLE.lastIndex = 0;
    for (let m = TITLE.exec(text); m; m = TITLE.exec(text)) {
      const v = unescapeJson(m[1] ?? m[2]);
      if (v && flat(v)) title = flat(v);
    }
  });
  return title ? clip(title, maxChars) : undefined;
}

/** First user prompt in a Copilot debug log (reads only the head of the file). */
export function readFirstPrompt(file: string, maxChars = 80): string | undefined {
  let prompt: string | undefined;
  scan(file, HEAD_BYTES, text => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"user_message"')) continue;
      try {
        const row = JSON.parse(line);
        const content = row?.type === 'user_message' && typeof row.attrs?.content === 'string' ? flat(row.attrs.content) : '';
        if (content) { prompt = clip(content, maxChars); return false; }
      } catch { /* partial line */ }
    }
  });
  return prompt;
}

/** User-prompt excerpts keyed by span id (= turn id). Returned only, never persisted. */
export function promptExcerpts(file: string, maxChars: number): Map<string, string> {
  const out = new Map<string, string>();
  scan(file, MAX_LOG_BYTES, text => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"user_message"')) continue;
      try {
        const row = JSON.parse(line);
        const content = row?.type === 'user_message' && typeof row.attrs?.content === 'string' ? flat(row.attrs.content) : '';
        if (!content || typeof row.spanId !== 'string' || out.has(row.spanId)) continue;
        out.set(row.spanId, clip(content, maxChars));
      } catch { /* partial line */ }
    }
  });
  return out;
}

/** Workspace-storage roots from a path-delimited list (MCP env) or array. */
export function storageRoots(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? '').split(path.delimiter);
  return list.filter(Boolean);
}

/**
 * Finds chat-session and debug-log files by session id across all workspace
 * storage folders (plus empty-window chats) and caches titles in memory.
 */
export class SessionTitleResolver {
  private index = new Map<string, SessionFiles>();
  private indexedAt = 0;
  private titles = new Map<string, { stamp: string; title: string | null }>();

  constructor(private readonly roots: string[], private readonly maxChars = 80) {}

  private rebuild(): void {
    const index = new Map<string, SessionFiles>();
    const newest = (id: string, key: keyof SessionFiles, file: string) => {
      const cur = index.get(id) ?? {};
      if (!cur[key] || mtime(file) > mtime(cur[key]!)) cur[key] = file;
      index.set(id, cur);
    };
    const chatDir = (dir: string) => {
      for (const name of list(dir)) {
        const m = /^(.+)\.jsonl?$/.exec(name);
        if (m && SAFE_ID.test(m[1])) newest(m[1], 'chat', path.join(dir, name));
      }
    };
    for (const root of this.roots) {
      for (const ws of list(root)) {
        chatDir(path.join(root, ws, 'chatSessions'));
        const logs = path.join(root, ws, 'GitHub.copilot-chat', 'debug-logs');
        for (const id of list(logs)) {
          if (!SAFE_ID.test(id)) continue;
          const file = path.join(logs, id, 'main.jsonl');
          if (fs.existsSync(file)) newest(id, 'log', file);
        }
      }
      chatDir(path.join(path.dirname(root), 'globalStorage', 'emptyWindowChatSessions'));
    }
    this.index = index;
    this.indexedAt = Date.now();
  }

  files(sessionId: string): SessionFiles {
    if (!SAFE_ID.test(sessionId)) return {};
    const age = Date.now() - this.indexedAt;
    if (age > INDEX_TTL_MS || (!this.index.has(sessionId) && age > 5_000)) this.rebuild();
    return this.index.get(sessionId) ?? {};
  }

  /** Debug log for prompt excerpts, if it still exists and is not oversized. */
  logFile(sessionId: string): string | undefined {
    const file = this.files(sessionId).log;
    try { return file && fs.statSync(file).size <= MAX_LOG_BYTES ? file : undefined; } catch { return undefined; }
  }

  title(sessionId: string): string | undefined {
    const f = this.files(sessionId);
    const stamp = [f.chat, f.log].map(p => p ? `${p}:${mtime(p)}` : '').join('|');
    const hit = this.titles.get(sessionId);
    if (hit && hit.stamp === stamp) return hit.title ?? undefined;
    const title = (f.chat && readChatTitle(f.chat, this.maxChars)) || (f.log && readFirstPrompt(f.log, this.maxChars)) || null;
    this.titles.set(sessionId, { stamp, title });
    return title ?? undefined;
  }

  titlesFor(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const t = this.title(id);
      if (t) out[id] = t;
    }
    return out;
  }
}

function list(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
