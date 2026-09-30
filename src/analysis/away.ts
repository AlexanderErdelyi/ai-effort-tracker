/**
 * Away detection (issue #103). Pure helpers: the away period between going
 * idle and coming back, minus the time another VS Code window was active, and
 * the shared per-window activity ("heartbeat") file format.
 */

export const HEARTBEAT_FILE = 'window-activity.json';
/** Consecutive active beats closer than this merge into one interval. */
export const BEAT_GAP_MS = 60_000;
/** Other windows' activity older than this is irrelevant for any away period. */
export const HEARTBEAT_KEEP_MS = 12 * 3_600_000;

export interface Interval { start: number; end: number }

export interface AwayConfig {
  minMs: number;
  maxMs: number;
}

export interface AwayPeriod {
  start: number;
  end: number;
  /** Away time not covered by another VS Code window's activity. */
  durationMs: number;
  /** Part of the period another window was active (not asked about). */
  coveredMs: number;
}

export interface HeartbeatFile {
  windows: Record<string, { updatedAt: number; active: [number, number][] }>;
}

/** Total length of the union of `intervals` clipped to [start, end]. */
export function coveredMs(start: number, end: number, intervals: Interval[]): number {
  const clipped = intervals
    .map(i => ({ start: Math.max(start, i.start), end: Math.min(end, i.end) }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0, curS = -Infinity, curE = -Infinity;
  for (const i of clipped) {
    if (i.start > curE) {
      if (curE > curS) total += curE - curS;
      curS = i.start; curE = i.end;
    } else curE = Math.max(curE, i.end);
  }
  if (curE > curS) total += curE - curS;
  return total;
}

/**
 * The away period to ask about, or null when it is too short, too long
 * (overnight, weekend) or mostly spent in another VS Code window.
 */
export function awayPeriod(start: number, end: number, others: Interval[], cfg: AwayConfig): AwayPeriod | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const span = end - start;
  if (span < cfg.minMs || span > cfg.maxMs) return null;
  const covered = coveredMs(start, end, others);
  const durationMs = span - covered;
  if (durationMs < cfg.minMs) return null;
  return { start, end, durationMs, coveredMs: covered };
}

/** Record activity from `start` to `end` for one window, merging with its last interval. */
export function addBeat(file: HeartbeatFile, windowId: string, start: number, end: number, now = end): HeartbeatFile {
  const out: HeartbeatFile = { windows: { ...(file?.windows ?? {}) } };
  const w = out.windows[windowId] ? { ...out.windows[windowId], active: [...out.windows[windowId].active] } : { updatedAt: now, active: [] };
  const last = w.active[w.active.length - 1];
  if (last && start - last[1] <= BEAT_GAP_MS) w.active[w.active.length - 1] = [last[0], Math.max(last[1], end)];
  else w.active.push([start, end]);
  w.updatedAt = now;
  out.windows[windowId] = w;
  return prune(out, now);
}

/** Drop old intervals and windows that stopped reporting. */
export function prune(file: HeartbeatFile, now: number): HeartbeatFile {
  const windows: HeartbeatFile['windows'] = {};
  for (const [id, w] of Object.entries(file?.windows ?? {})) {
    if (!w || !Array.isArray(w.active) || now - (w.updatedAt || 0) > HEARTBEAT_KEEP_MS) continue;
    const active = w.active.filter(a => Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]) && now - a[1] <= HEARTBEAT_KEEP_MS);
    if (active.length) windows[id] = { updatedAt: w.updatedAt, active };
  }
  return { windows };
}

/** Active intervals of every window except `windowId`. */
export function otherWindowsActivity(file: HeartbeatFile | null | undefined, windowId: string): Interval[] {
  const out: Interval[] = [];
  for (const [id, w] of Object.entries(file?.windows ?? {})) {
    if (id === windowId || !Array.isArray(w?.active)) continue;
    for (const a of w.active) if (Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1])) out.push({ start: a[0], end: a[1] });
  }
  return out;
}

export function parseHeartbeats(raw: string | null | undefined): HeartbeatFile {
  if (!raw) return { windows: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && v.windows && typeof v.windows === 'object' ? v as HeartbeatFile : { windows: {} };
  } catch {
    return { windows: {} };
  }
}

/** "25 min (10:05–10:30)" in local time. */
export function describeAway(p: AwayPeriod): string {
  const t = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const mins = Math.round(p.durationMs / 60_000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `${dur} (${t(p.start)}\u2013${t(p.end)})`;
}
