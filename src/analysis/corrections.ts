import { createHash } from 'crypto';
import { blockContext, changedLines, normalizeLine } from './review';

/**
 * Knowledge loop, step 1 (#131): capture how AI-written code gets corrected.
 *
 * Every line an AI edit adds is remembered as "AI-owned" (hash of the
 * normalized text → when it was written). When code changes later, the change
 * is compared with the file as it was before the edit burst; a change that
 * replaces or removes AI-owned lines, inserts lines between AI-owned lines or
 * moves them is a correction. Corrections keep a short before/after snippet,
 * the surrounding declaration and the prompts involved, so later steps can
 * label them and turn repeated ones into rules for Copilot.
 */

export const CORRECTIONS_FILE = 'corrections.json';
/** Shorter normalized lines (`end;`, `}`, `begin`) are too common to own. */
export const OWN_MIN_LENGTH = 6;
export const MAX_CORRECTIONS = 5000;
export const MAX_PROMPT_CHARS = 1000;
const HASH_LEN = 10;
const MAX_HASHES_PER_FILE = 20_000;
const MAX_OWNED_FILES = 3000;
const OWN_TTL_MS = 90 * 86_400_000;
const MAX_SNIPPET_LINES = 30;
const MAX_SNIPPET_CHARS = 300;
/** Lines searched above/below an insertion for AI-owned neighbours. */
const NEIGHBOUR_WINDOW = 5;
const MAX_HUNKS_PER_WINDOW = 40;
/** A moved block must keep this share of its lines. */
const MOVE_OVERLAP = 0.8;
const MOVE_MIN_LINES = 2;
/** The prompt that produced AI code is searched this far before it was written. */
const ORIGIN_WINDOW_MS = 3 * 3_600_000;
const LINK_TOLERANCE_MS = 2000;

export type CorrectionSource = 'human' | 'ai';
export type CorrectionKind = 'modify' | 'insert' | 'delete' | 'move';

export interface PromptRef { t: number; sessionId: string; text?: string }

export interface Correction {
  id: string;
  /** When the edit burst ended. */
  t: number;
  /** When the edit burst started. */
  start: number;
  /** `human`: you changed AI code; `ai`: Copilot reworked its own earlier code. */
  source: CorrectionSource;
  kind: CorrectionKind;
  repo: string;
  path: string;
  ext: string;
  branch: string;
  workItemId?: string;
  /** 1-based line in the file after the change. */
  line: number;
  /** Moves: 1-based line where the block was before. */
  fromLine?: number;
  /** AI-written lines that were replaced, removed or moved (0 for an insertion into AI code). */
  aiLines: number;
  added: number;
  removed: number;
  before?: string[];
  after?: string[];
  /** Declaration or heading the change is in, e.g. "procedure SyncJob". */
  context?: string;
  /** Moves: declaration or heading at the new position. */
  toContext?: string;
  /** When the AI wrote the touched lines (newest). */
  aiAt: number;
  /** Prompt that asked Copilot for the rework (source `ai`). */
  trigger?: PromptRef;
  /** Prompt that produced the AI code that was corrected. */
  origin?: PromptRef;
  /** Set by labeling (#132). */
  category?: string;
}

export interface FileOwnership {
  /** Last time this file's ownership changed. */
  u: number;
  /** Line hash → when the AI first wrote that text. */
  h: Record<string, number>;
}

export interface CorrectionStoreData {
  version: 1;
  /** Absolute file key → AI-owned lines. Never leaves this machine. */
  owned: Record<string, FileOwnership>;
  corrections: Correction[];
}

/** Changes from one VS Code window, merged into the latest file under the store lock. */
export interface CorrectionDelta {
  owned: Record<string, Record<string, number>>;
  add: Correction[];
  patch: Record<string, { trigger?: PromptRef; origin?: PromptRef }>;
}

export interface UserMessage { t: number; sessionId: string; text: string }

export const emptyCorrectionStore = (): CorrectionStoreData => ({ version: 1, owned: {}, corrections: [] });
export const emptyCorrectionDelta = (): CorrectionDelta => ({ owned: {}, add: [], patch: {} });
export const deltaIsEmpty = (d: CorrectionDelta) => !Object.keys(d.owned).length && !d.add.length && !Object.keys(d.patch).length;

/** Hash of a line's normalized text; undefined for lines too short to own. */
export function lineHash(line: string): string | undefined {
  const n = normalizeLine(line);
  return n.length >= OWN_MIN_LENGTH ? createHash('sha1').update(n).digest('hex').slice(0, HASH_LEN) : undefined;
}

/** Hashes of the lines in `after` that were added or modified compared with `before`. */
export function addedLineHashes(before: readonly string[], after: readonly string[]): string[] {
  const out = new Set<string>();
  for (const i of changedLines(before, after)) {
    const h = lineHash(after[i]);
    if (h) out.add(h);
  }
  return [...out];
}

/** Remember lines as AI-written at `t`; a line keeps the time it was first written. */
export function addOwnership(owned: Record<string, number>, hashes: Iterable<string>, t: number): boolean {
  let changed = false;
  for (const h of hashes) {
    if (owned[h] === undefined || owned[h] > t) { owned[h] = t; changed = true; }
  }
  return changed;
}

export interface Hunk { a: number; aEnd: number; b: number; bEnd: number }

/**
 * Changed regions between two versions: `a[a..aEnd)` became `b[b..bEnd)`.
 * Lines compare after trimming their ends. LCS on the differing middle; when
 * that is too large, the whole middle is one hunk.
 */
export function diffHunks(a0: readonly string[], b0: readonly string[], maxCells = 4_000_000): Hunk[] {
  const ids = new Map<string, number>();
  const intern = (s: string) => { const k = s.trimEnd(); let v = ids.get(k); if (v === undefined) ids.set(k, v = ids.size); return v; };
  const a = a0.map(intern), b = b0.map(intern);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n && !m) return [];
  if (!n || !m || (n + 1) * (m + 1) > maxCells) return [{ a: start, aEnd: endA, b: start, bEnd: endB }];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let open: Hunk | undefined;
  const flush = () => { if (open) { hunks.push(open); open = undefined; } };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { flush(); i++; j++; continue; }
    open ??= { a: start + i, aEnd: start + i, b: start + j, bEnd: start + j };
    if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) { i++; open.aEnd = start + i; }
    else { j++; open.bEnd = start + j; }
  }
  flush();
  return hunks;
}

const snippet = (lines: readonly string[]): string[] =>
  lines.slice(0, MAX_SNIPPET_LINES).map(l => { const s = l.trimEnd(); return s.length > MAX_SNIPPET_CHARS ? s.slice(0, MAX_SNIPPET_CHARS - 1) + '…' : s; });

const signature = (lines: readonly string[]) => lines.map(normalizeLine).filter(Boolean);

/** Multiset overlap of two line lists. */
function overlap(x: readonly string[], y: readonly string[]): number {
  const pool = new Map<string, number>();
  for (const s of x) pool.set(s, (pool.get(s) ?? 0) + 1);
  let n = 0;
  for (const s of y) { const k = pool.get(s) ?? 0; if (k > 0) { n++; pool.set(s, k - 1); } }
  return n;
}

export type DetectedChange = Omit<Correction, 'id' | 't' | 'start' | 'source' | 'repo' | 'path' | 'ext' | 'branch' | 'workItemId'>;

/**
 * Corrections of AI code between the file before an edit burst (`snapshot`)
 * and now (`current`). Only lines the AI wrote before the burst started count.
 * Whitespace-only changes are skipped.
 */
export function detectCorrections(
  snapshot: readonly string[], current: readonly string[], owned: Readonly<Record<string, number>>,
  start: number, file?: string, captureCode = true
): DetectedChange[] {
  const ownedAt = (line: string) => {
    const h = lineHash(line);
    const t = h ? owned[h] : undefined;
    return t !== undefined && t < start ? t : undefined;
  };
  const nearestOwned = (from: number, step: 1 | -1): number | undefined => {
    for (let k = 1, i = from; k <= NEIGHBOUR_WINDOW && i >= 0 && i < current.length; i += step, k++) {
      if (!lineHash(current[i])) continue;
      return ownedAt(current[i]);
    }
    return undefined;
  };
  const hunks = diffHunks(snapshot, current).slice(0, MAX_HUNKS_PER_WINDOW).map(h => {
    const removed = snapshot.slice(h.a, h.aEnd), added = current.slice(h.b, h.bEnd);
    return { h, removed, added, rs: signature(removed), as: signature(added) };
  }).filter(x => x.rs.join('\n') !== x.as.join('\n'));

  // A block cut in one place and pasted in another is one move.
  const moved = new Map<number, number>();
  const taken = new Set<number>();
  hunks.forEach((del, di) => {
    if (del.as.length || del.rs.length < MOVE_MIN_LINES) return;
    const ins = hunks.findIndex((x, xi) => !taken.has(xi) && !x.rs.length && x.as.length >= MOVE_MIN_LINES
      && overlap(del.rs, x.as) >= MOVE_OVERLAP * Math.max(del.rs.length, x.as.length));
    if (ins >= 0) { moved.set(di, ins); taken.add(ins); }
  });

  const out: DetectedChange[] = [];
  hunks.forEach((x, xi) => {
    if (taken.has(xi)) return;
    let aiLines = 0, aiAt = 0;
    for (const line of x.removed) {
      const t = ownedAt(line);
      if (t !== undefined) { aiLines++; aiAt = Math.max(aiAt, t); }
    }
    const to = moved.get(xi);
    if (to !== undefined) {
      if (!aiLines) return;
      const dest = hunks[to];
      out.push({
        kind: 'move', line: dest.h.b + 1, fromLine: x.h.a + 1, aiLines, added: dest.as.length, removed: x.rs.length,
        before: captureCode ? snippet(x.removed) : undefined,
        context: blockContext(snapshot, x.h.a, Math.max(x.h.a, x.h.aEnd - 1), file) || undefined,
        toContext: blockContext(current, dest.h.b, Math.max(dest.h.b, dest.h.bEnd - 1), file) || undefined,
        aiAt
      });
      return;
    }
    if (!x.rs.length) {
      // An insertion counts when it sits inside AI code (e.g. added docs or a missing check).
      const above = nearestOwned(x.h.b - 1, -1), below = nearestOwned(x.h.bEnd, 1);
      if (above === undefined || below === undefined) return;
      aiAt = Math.max(above, below);
    } else if (!aiLines) return;
    const kind: CorrectionKind = !x.rs.length ? 'insert' : !x.as.length ? 'delete' : 'modify';
    const anchor = kind === 'delete' ? Math.min(x.h.b, Math.max(0, current.length - 1)) : x.h.b;
    out.push({
      kind, line: anchor + 1, aiLines, added: x.as.length, removed: x.rs.length,
      before: captureCode && x.removed.length ? snippet(x.removed) : undefined,
      after: captureCode && x.added.length ? snippet(x.added) : undefined,
      context: (kind === 'delete'
        ? blockContext(snapshot, x.h.a, Math.max(x.h.a, x.h.aEnd - 1), file)
        : blockContext(current, x.h.b, Math.max(x.h.b, x.h.bEnd - 1), file)) || undefined,
      aiAt
    });
  });
  return out;
}

const ref = (m: UserMessage, captureText: boolean): PromptRef =>
  captureText ? { t: m.t, sessionId: m.sessionId, text: m.text.slice(0, MAX_PROMPT_CHARS) } : { t: m.t, sessionId: m.sessionId };

/**
 * Prompts behind a correction. `origin`: the newest prompt sent before the AI
 * wrote the corrected code. `trigger` (AI rework only): the newest prompt sent
 * after that and before the rework started; without one the AI fixed its own
 * code within the same request, which is not a correction.
 */
export function linkPrompts(
  c: Pick<Correction, 'aiAt' | 'start' | 'source'>, messages: readonly UserMessage[], captureText = true
): { trigger?: PromptRef; origin?: PromptRef } {
  let origin: UserMessage | undefined, trigger: UserMessage | undefined;
  for (const m of messages) {
    if (m.t <= c.aiAt + LINK_TOLERANCE_MS && m.t >= c.aiAt - ORIGIN_WINDOW_MS && (!origin || m.t > origin.t)) origin = m;
    if (c.source === 'ai' && m.t > c.aiAt + LINK_TOLERANCE_MS && m.t <= c.start + LINK_TOLERANCE_MS && (!trigger || m.t > trigger.t)) trigger = m;
  }
  return { ...(trigger ? { trigger: ref(trigger, captureText) } : {}), ...(origin ? { origin: ref(origin, captureText) } : {}) };
}

/** Drop old ownership and corrections, and cap the store's size. */
export function pruneCorrectionStore(data: CorrectionStoreData, now: number): CorrectionStoreData {
  let files = Object.entries(data.owned).filter(([, f]) => now - f.u <= OWN_TTL_MS);
  if (files.length > MAX_OWNED_FILES) files = files.sort((x, y) => y[1].u - x[1].u).slice(0, MAX_OWNED_FILES);
  const owned: Record<string, FileOwnership> = {};
  for (const [key, f] of files) {
    let entries = Object.entries(f.h).filter(([, t]) => now - t <= OWN_TTL_MS);
    if (entries.length > MAX_HASHES_PER_FILE) entries = entries.sort((x, y) => y[1] - x[1]).slice(0, MAX_HASHES_PER_FILE);
    if (entries.length) owned[key] = { u: f.u, h: Object.fromEntries(entries) };
  }
  const corrections = data.corrections.length > MAX_CORRECTIONS
    ? [...data.corrections].sort((x, y) => x.t - y.t).slice(-MAX_CORRECTIONS)
    : data.corrections;
  return { version: 1, owned, corrections };
}

/** Apply one window's changes to the latest store (other windows may have written meanwhile). */
export function mergeCorrectionDelta(data: CorrectionStoreData, delta: CorrectionDelta, now: number): CorrectionStoreData {
  const owned = { ...data.owned };
  for (const [key, hashes] of Object.entries(delta.owned)) {
    const prev = owned[key];
    const h = { ...(prev?.h ?? {}) };
    for (const [k, t] of Object.entries(hashes)) if (h[k] === undefined || h[k] > t) h[k] = t;
    owned[key] = { u: now, h };
  }
  const ids = new Set(data.corrections.map(c => c.id));
  const corrections = data.corrections.map(c => delta.patch[c.id] ? { ...c, ...delta.patch[c.id] } : c);
  for (const c of delta.add) {
    if (ids.has(c.id)) continue;
    ids.add(c.id);
    corrections.push(delta.patch[c.id] ? { ...c, ...delta.patch[c.id] } : c);
  }
  return pruneCorrectionStore({ version: 1, owned, corrections }, now);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strs = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;

function decodePrompt(v: unknown): PromptRef | undefined {
  if (!isObj(v) || !finite(v.t) || typeof v.sessionId !== 'string') return undefined;
  return { t: v.t, sessionId: v.sessionId, ...(typeof v.text === 'string' ? { text: v.text } : {}) };
}

function decodeCorrection(v: unknown): Correction | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !finite(v.t) || typeof v.path !== 'string') return undefined;
  const kind = (['modify', 'insert', 'delete', 'move'] as const).find(k => k === v.kind);
  if (!kind) return undefined;
  const num = (x: unknown) => finite(x) ? x : 0;
  const s = (x: unknown) => typeof x === 'string' && x ? x : undefined;
  const c: Correction = {
    id: v.id, t: v.t, start: finite(v.start) ? v.start : v.t, source: v.source === 'ai' ? 'ai' : 'human', kind,
    repo: s(v.repo) ?? '', path: v.path, ext: s(v.ext) ?? '', branch: s(v.branch) ?? 'unknown',
    line: Math.max(1, num(v.line)), aiLines: num(v.aiLines), added: num(v.added), removed: num(v.removed), aiAt: num(v.aiAt)
  };
  if (s(v.workItemId)) c.workItemId = s(v.workItemId);
  if (finite(v.fromLine)) c.fromLine = v.fromLine;
  if (strs(v.before)) c.before = strs(v.before);
  if (strs(v.after)) c.after = strs(v.after);
  if (s(v.context)) c.context = s(v.context);
  if (s(v.toContext)) c.toContext = s(v.toContext);
  if (s(v.category)) c.category = s(v.category);
  const trigger = decodePrompt(v.trigger), origin = decodePrompt(v.origin);
  if (trigger) c.trigger = trigger;
  if (origin) c.origin = origin;
  return c;
}

export function decodeCorrectionStore(raw: string): CorrectionStoreData {
  const v = JSON.parse(raw) as unknown;
  if (!isObj(v) || v.version !== 1) throw new Error('Invalid corrections store');
  const owned: Record<string, FileOwnership> = {};
  if (isObj(v.owned)) {
    for (const [key, f] of Object.entries(v.owned)) {
      if (!isObj(f) || !isObj(f.h)) continue;
      const h: Record<string, number> = {};
      for (const [k, t] of Object.entries(f.h)) if (finite(t)) h[k] = t;
      owned[key] = { u: finite(f.u) ? f.u : 0, h };
    }
  }
  const corrections = Array.isArray(v.corrections)
    ? v.corrections.map(decodeCorrection).filter((c): c is Correction => !!c)
    : [];
  return { version: 1, owned, corrections };
}

export interface ListCorrectionsArgs {
  workItemId?: string; branch?: string; path?: string; repo?: string;
  source?: CorrectionSource; kind?: CorrectionKind; days?: number; limit?: number;
}

/** Newest corrections matching the filter (MCP `list_corrections`, "Show Captured Corrections"). */
export function listCorrections(data: CorrectionStoreData, args: ListCorrectionsArgs, now = Date.now()) {
  const path = args.path?.toLowerCase().replace(/\\/g, '/');
  const repo = args.repo?.toLowerCase();
  const since = finite(args.days) && args.days > 0 ? now - args.days * 86_400_000 : -Infinity;
  const matches = data.corrections.filter(c =>
    c.t >= since
    && (!args.workItemId || c.workItemId === args.workItemId)
    && (!args.branch || c.branch === args.branch)
    && (!path || c.path.toLowerCase().replace(/\\/g, '/').includes(path))
    && (!repo || c.repo.toLowerCase().includes(repo))
    && (!args.source || c.source === args.source)
    && (!args.kind || c.kind === args.kind)
  ).sort((x, y) => y.t - x.t);
  const limit = Math.max(1, Math.min(500, Math.floor(finite(args.limit) ? args.limit : 50)));
  const count = (pick: (c: Correction) => string) => {
    const out: Record<string, number> = {};
    for (const c of matches) out[pick(c)] = (out[pick(c)] ?? 0) + 1;
    return out;
  };
  return {
    total: matches.length,
    bySource: count(c => c.source),
    byKind: count(c => c.kind),
    byExt: count(c => c.ext || '(none)'),
    corrections: matches.slice(0, limit)
  };
}

/** Markdown report of the newest corrections ("Show Captured Corrections"). */
export function correctionsMarkdown(result: ReturnType<typeof listCorrections>): string {
  const fmt = (r: Record<string, number>) => Object.entries(r).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const fence = (lines: string[] | undefined, mark: string) => lines?.length
    ? ['```diff', ...lines.map(l => `${mark} ${l}`), '```'] : [];
  const out = [
    '# Captured corrections',
    '',
    `${result.total} correction(s). Source: ${fmt(result.bySource)}. Kind: ${fmt(result.byKind)}. File type: ${fmt(result.byExt)}.`,
    ''
  ];
  if (!result.total) {
    out.push('Nothing captured yet. Corrections appear when you or Copilot change code an AI edit wrote earlier.');
  }
  for (const c of result.corrections) {
    out.push(`## ${c.source === 'ai' ? 'AI rework' : 'Your change'}: ${c.kind} in ${c.path}:${c.line}`);
    out.push('');
    out.push(`- When: ${new Date(c.t).toLocaleString()} · branch ${c.branch}${c.workItemId ? ` · work item ${c.workItemId}` : ''}`);
    if (c.context) out.push(`- In: ${c.toContext && c.toContext !== c.context ? `${c.context} → ${c.toContext}` : c.context}`);
    out.push(`- AI lines touched: ${c.aiLines} · +${c.added} / -${c.removed}${c.fromLine ? ` · moved from line ${c.fromLine}` : ''}`);
    if (c.trigger?.text) out.push(`- Asked: ${c.trigger.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (c.origin?.text) out.push(`- Code came from: ${c.origin.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    out.push('', ...fence(c.before, '-'), ...fence(c.after, '+'), '');
  }
  return out.join('\n');
}
