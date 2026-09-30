/**
 * Data health check (issue #104). Pure: no vscode, no fs. The extension and
 * the MCP server feed it the store contents plus a few file facts and get a
 * list of problems, each with a count, examples and a fix action.
 */
import type { LedgerEntry, Project, TimeEntry, WorkItem, ManualEffortEntry } from '../store/database';

export const HEALTH_SNAPSHOT_FILE = 'health-snapshot.json';
const UNASSIGNED = '__unassigned__';
const DAY_MS = 86_400_000;
/** Active time per calendar day above this is almost certainly double counting. */
export const MAX_PLAUSIBLE_DAY_MS = 16 * 3_600_000;
/** Branch time below this is noise (a quick checkout), not worth assigning. */
const MIN_UNASSIGNED_MS = 5 * 60_000;
const LARGE_STORE_BYTES = 25 * 1024 * 1024;
const MAX_EXAMPLES = 8;

export type HealthSeverity = 'error' | 'warning' | 'info';

export interface HealthAction {
  label: string;
  /** Extension command (without prefix) to run, e.g. `moveBranchToWorkItem`. */
  command: string;
  arg?: string;
}

export interface HealthExample {
  label: string;
  action?: HealthAction;
}

export interface HealthCheck {
  id: string;
  severity: HealthSeverity;
  title: string;
  count: number;
  detail: string;
  examples: HealthExample[];
  /** One action that fixes the whole check (e.g. an automatic repair). */
  fix?: HealthAction;
}

export interface HealthReport {
  checkedAt: string;
  status: 'ok' | HealthSeverity;
  /** 100 = nothing found. Errors weigh most. */
  score: number;
  counts: Record<HealthSeverity, number>;
  checks: HealthCheck[];
  /** Titles of the checks that found nothing. */
  passed: string[];
  stats: {
    branches: number;
    workItems: number;
    projects: number;
    ledgerEntries: number;
    timeEntries: number;
    storeBytes: number | null;
    backups: number | null;
  };
}

interface HealthBranch {
  workItemId: string | null;
  time?: Record<string, number>;
  timeAdjustment?: Record<string, number>;
  daily?: Record<string, { humanCoding?: number; aiGenerating?: number; reviewing?: number; idle?: number }>;
}

export interface HealthData {
  branches: Record<string, HealthBranch>;
  workItems: Record<string, WorkItem>;
  creditLedger: LedgerEntry[];
  projects: Record<string, Project>;
  timeEntries?: TimeEntry[];
  manualEffort?: ManualEffortEntry[];
  modelPrices?: Record<string, unknown>;
}

export interface HealthEnv {
  schemaVersion: number;
  expectedSchemaVersion: number;
  file?: {
    sizeBytes: number;
    hasBackup: boolean;
    historyCount: number;
    /** Size and age of the oldest retained history copy, for growth. */
    oldestHistoryBytes?: number | null;
    oldestHistoryAgeMs?: number | null;
  };
  lastSaveError?: { ts: number; message: string } | null;
  /** Effective rates per project (project override, else global default); null = not configured. */
  rates?: Record<string, { cost: number | null; sell: number | null }>;
}

const ACTIVE_MODES = ['humanCoding', 'aiGenerating', 'reviewing'] as const;

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hours = (ms: number) => Math.round(ms / 360_000) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const badNumber = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v));
const badNonNegative = (v: unknown) => badNumber(v) || (typeof v === 'number' && v < 0);
const realWorkItem = (id: string | null | undefined): id is string => !!id && id !== UNASSIGNED;

function branchActiveMs(b: HealthBranch): number {
  let ms = 0;
  for (const m of ACTIVE_MODES) {
    const raw = b.time?.[m];
    const adj = b.timeAdjustment?.[m];
    const v = (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0) + (typeof adj === 'number' && Number.isFinite(adj) ? adj : 0);
    ms += Math.max(0, v);
  }
  return ms;
}

function examples<T>(items: T[], map: (t: T) => HealthExample): HealthExample[] {
  return items.slice(0, MAX_EXAMPLES).map(map);
}

export function checkDataHealth(data: HealthData, env: HealthEnv, now = Date.now()): HealthReport {
  const checks: HealthCheck[] = [];
  const passed: string[] = [];
  const add = (c: HealthCheck) => { if (c.count > 0) checks.push(c); else passed.push(c.title); };
  const wis = data.workItems ?? {};
  const projects = data.projects ?? {};
  const ledger = Array.isArray(data.creditLedger) ? data.creditLedger : [];
  const timeEntries = Array.isArray(data.timeEntries) ? data.timeEntries : [];
  const branches = Object.entries(data.branches ?? {});

  // --- Persistence -----------------------------------------------------------
  add({
    id: 'save-error', severity: 'error', title: 'Saving works',
    count: env.lastSaveError ? 1 : 0,
    detail: env.lastSaveError
      ? `The last save failed (${new Date(env.lastSaveError.ts).toLocaleString()}): ${env.lastSaveError.message}. Changes stay in memory and are retried; check disk space and file permissions.`
      : '',
    examples: []
  });

  const f = env.file;
  add({
    id: 'backups', severity: 'warning', title: 'Backups exist',
    count: f && f.sizeBytes > 0 && (!f.hasBackup || f.historyCount === 0) ? 1 : 0,
    detail: f ? `Backup file: ${f.hasBackup ? 'yes' : 'missing'}; history copies: ${f.historyCount}. Both are written on the next save; if they stay missing, the storage folder may not be writable.` : '',
    examples: []
  });

  add({
    id: 'schema', severity: env.schemaVersion > env.expectedSchemaVersion ? 'error' : 'warning', title: 'Schema version is current',
    count: env.schemaVersion !== env.expectedSchemaVersion ? 1 : 0,
    detail: env.schemaVersion > env.expectedSchemaVersion
      ? `The data file has schema ${env.schemaVersion} but this extension only knows ${env.expectedSchemaVersion}. Another VS Code window or machine runs a newer version – update this one so it cannot drop newer fields.`
      : `The data file has schema ${env.schemaVersion}; it is migrated to ${env.expectedSchemaVersion} on the next save.`,
    examples: []
  });

  const growth = f && f.oldestHistoryBytes && f.oldestHistoryAgeMs && f.oldestHistoryBytes > 0
    ? f.sizeBytes / f.oldestHistoryBytes : null;
  const big = !!f && f.sizeBytes > LARGE_STORE_BYTES;
  const fastGrowth = growth !== null && growth > 1.5 && (f?.sizeBytes ?? 0) > 5 * 1024 * 1024;
  add({
    id: 'store-size', severity: 'info', title: 'Data file size is reasonable',
    count: big || fastGrowth ? 1 : 0,
    detail: f ? `The data file is ${(f.sizeBytes / 1048576).toFixed(1)} MB` +
      (growth !== null ? ` (${growth.toFixed(2)}× the copy from ${Math.round((f.oldestHistoryAgeMs ?? 0) / DAY_MS)} days ago)` : '') +
      `. Every window rewrites it every few seconds while you work; ${ledger.length} credit rows are the main driver.` : '',
    examples: []
  });

  // --- Invalid numbers -------------------------------------------------------
  const invalid: string[] = [];
  for (const [name, b] of branches) {
    for (const [m, v] of Object.entries(b.time ?? {})) if (badNonNegative(v)) invalid.push(`Branch ${name}: time.${m} = ${String(v)}`);
    for (const [m, v] of Object.entries(b.timeAdjustment ?? {})) if (badNumber(v)) invalid.push(`Branch ${name}: adjustment.${m} = ${String(v)}`);
    for (const [day, d] of Object.entries(b.daily ?? {})) {
      for (const m of [...ACTIVE_MODES, 'idle'] as const) if (badNonNegative(d?.[m])) invalid.push(`Branch ${name} ${day}: ${m} = ${String(d?.[m])}`);
    }
  }
  for (const e of ledger) {
    if (badNonNegative(e.credits) || e.credits === undefined) invalid.push(`Credit row ${e.id}: credits = ${String(e.credits)}`);
    if (badNonNegative(e.cost)) invalid.push(`Credit row ${e.id}: cost = ${String(e.cost)}`);
    if (badNonNegative(e.ts)) invalid.push(`Credit row ${e.id}: timestamp = ${String(e.ts)}`);
  }
  for (const t of timeEntries) if (badNonNegative(t.durationMs) || t.durationMs === undefined) invalid.push(`Time entry ${t.id}: duration = ${String(t.durationMs)}`);
  for (const w of Object.values(wis)) {
    for (const k of ['estimate', 'billableHours', 'creditBudget', 'costBudget'] as const) {
      if (badNonNegative(w[k])) invalid.push(`Work item #${w.id}: ${k} = ${String(w[k])}`);
    }
  }
  add({
    id: 'invalid-numbers', severity: 'error', title: 'All numbers are valid',
    count: invalid.length,
    detail: 'Negative, NaN or infinite values make totals wrong. Correct them via the matching edit command (time adjustment, credit entry, time entry, estimate).',
    examples: invalid.slice(0, MAX_EXAMPLES).map(label => ({ label }))
  });

  // --- Duplicates ------------------------------------------------------------
  const seenIds = new Map<string, number>();
  const seenTurns = new Map<string, LedgerEntry[]>();
  for (const e of ledger) {
    seenIds.set(e.id, (seenIds.get(e.id) ?? 0) + 1);
    if (e.debugUsage?.sessionId && e.debugUsage.turnId) {
      const k = `${e.debugUsage.sessionId}|${e.debugUsage.turnId}`;
      seenTurns.set(k, [...(seenTurns.get(k) ?? []), e]);
    }
  }
  const dupIds = [...seenIds].filter(([, n]) => n > 1);
  const dupTurns = [...seenTurns].filter(([, rows]) => rows.length > 1);
  add({
    id: 'duplicate-ledger', severity: 'error', title: 'No duplicate credit rows',
    count: dupIds.length + dupTurns.length,
    detail: 'The same credit row or chat turn is stored more than once, so its credits count twice. The repair keeps the most complete copy of each chat turn and one copy of each row id.',
    examples: [
      ...dupIds.map(([id, n]) => ({ label: `Row ${id} ×${n}` })),
      ...dupTurns.map(([k, rows]) => ({ label: `Chat turn ${k.split('|')[1]} ×${rows.length} (${round2(rows.reduce((s, r) => s + (r.credits || 0), 0))} credits)` }))
    ].slice(0, MAX_EXAMPLES),
    fix: dupIds.length + dupTurns.length ? { label: 'Remove duplicates', command: 'fixDataHealth', arg: 'duplicate-ledger' } : undefined
  });

  // --- References to missing items -------------------------------------------
  const orphans: HealthExample[] = [];
  for (const [name, b] of branches) {
    if (realWorkItem(b.workItemId) && !wis[b.workItemId]) orphans.push({ label: `Branch ${name} → missing work item #${b.workItemId}`, action: { label: 'Reassign', command: 'moveBranchToWorkItem', arg: name } });
  }
  for (const w of Object.values(wis)) {
    if (w.projectId && !projects[w.projectId]) orphans.push({ label: `Work item #${w.id} → missing project ${w.projectId}`, action: { label: 'Assign project', command: 'assignWorkItemToProject', arg: w.id } });
  }
  const ledgerOrphans = ledger.filter(e => realWorkItem(e.workItemId) && !wis[e.workItemId]);
  if (ledgerOrphans.length) orphans.push({ label: `${ledgerOrphans.length} credit rows → missing work items (${[...new Set(ledgerOrphans.map(e => '#' + e.workItemId))].slice(0, 4).join(', ')})` });
  for (const t of timeEntries) {
    if (t.workItemId && realWorkItem(t.workItemId) && !wis[t.workItemId]) orphans.push({ label: `Time entry ${t.id} → missing work item #${t.workItemId}`, action: { label: 'Edit', command: 'editTimeEntry', arg: t.id } });
    else if (t.projectId && !projects[t.projectId]) orphans.push({ label: `Time entry ${t.id} → missing project ${t.projectId}`, action: { label: 'Edit', command: 'editTimeEntry', arg: t.id } });
  }
  add({
    id: 'orphans', severity: 'warning', title: 'No references to deleted items',
    count: orphans.length,
    detail: 'Effort that points to a work item or project that no longer exists is missing from every roll-up.',
    examples: orphans.slice(0, MAX_EXAMPLES)
  });

  // --- Unassigned effort -----------------------------------------------------
  // A branch named after an existing work item is almost certainly that item.
  const hintFor = (branch: string) => {
    const id = [...branch.matchAll(/(\d{3,})/g)].map(m => m[1]).find(n => wis[n]);
    return id ? ` (looks like #${id})` : '';
  };
  const unassigned = branches
    .filter(([, b]) => !realWorkItem(b.workItemId))
    .map(([name, b]) => ({ name, ms: branchActiveMs(b) }))
    .filter(x => x.ms >= MIN_UNASSIGNED_MS)
    .sort((a, b) => b.ms - a.ms);
  const unassignedMs = unassigned.reduce((n, x) => n + x.ms, 0);
  add({
    id: 'unassigned-branches', severity: 'warning', title: 'All tracked time belongs to a work item',
    count: unassigned.length,
    detail: `${hours(unassignedMs)} h of active time sits on ${unassigned.length} branch(es) without a work item, so it is missing from work-item and project totals.`,
    examples: examples(unassigned, x => ({ label: `${x.name} – ${hours(x.ms)} h${hintFor(x.name)}`, action: { label: 'Assign', command: 'moveBranchToWorkItem', arg: x.name } }))
  });

  const branchWi = new Map(branches.map(([name, b]) => [name, b.workItemId]));
  const noWi = ledger.filter(e => !realWorkItem(e.workItemId));
  const stale = noWi.filter(e => e.branch && realWorkItem(branchWi.get(e.branch)) && wis[branchWi.get(e.branch)!]);
  add({
    id: 'stale-credit-attribution', severity: 'warning', title: 'Credits follow their branch\u2019s work item',
    count: stale.length,
    detail: `${stale.length} credit rows (${round2(stale.reduce((n, e) => n + (e.credits || 0), 0))} credits) were captured before their branch was linked to a work item. The repair attributes them to the branch's current work item.`,
    examples: examples([...new Set(stale.map(e => e.branch!))], b => ({ label: `${b} → #${branchWi.get(b)}` })),
    fix: stale.length ? { label: 'Attribute to work items', command: 'fixDataHealth', arg: 'stale-credit-attribution' } : undefined
  });

  const staleIds = new Set(stale.map(e => e.id));
  const loose = noWi.filter(e => !staleIds.has(e.id) && (e.credits || 0) > 0);
  const looseByBranch = new Map<string, { credits: number; rows: LedgerEntry[] }>();
  for (const e of loose) {
    const k = e.branch && e.branch !== 'unknown' ? e.branch : '';
    const g = looseByBranch.get(k) ?? { credits: 0, rows: [] };
    g.credits += e.credits || 0; g.rows.push(e);
    looseByBranch.set(k, g);
  }
  add({
    id: 'unassigned-credits', severity: 'warning', title: 'All credits belong to a work item',
    count: loose.length,
    detail: `${round2(loose.reduce((n, e) => n + (e.credits || 0), 0))} credits in ${loose.length} rows have no work item, so they are missing from work-item ROI.`,
    examples: examples([...looseByBranch].sort((a, b) => b[1].credits - a[1].credits), ([branch, g]) => branch
      ? { label: `${branch} – ${round2(g.credits)} credits (${g.rows.length} rows)${hintFor(branch)}`, action: { label: 'Assign branch', command: 'moveBranchToWorkItem', arg: branch } }
      : { label: `No branch – ${round2(g.credits)} credits (${g.rows.length} rows)`, action: { label: 'Edit first row', command: 'editLedgerEntry', arg: g.rows[0].id } })
  });

  // --- Work items & projects -------------------------------------------------
  const lastActivity = new Map<string, number>();
  const bump = (id: string | null | undefined, ts: number) => { if (realWorkItem(id) && Number.isFinite(ts)) lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, ts)); };
  for (const e of ledger) bump(e.workItemId, e.ts);
  for (const t of timeEntries) bump(t.workItemId, t.startTs ?? t.createdAt);
  for (const [, b] of branches) {
    const days = Object.keys(b.daily ?? {}).sort();
    if (days.length) bump(b.workItemId, new Date(days[days.length - 1] + 'T12:00:00').getTime());
  }
  const tracked = Object.values(wis).filter(w => w.id !== UNASSIGNED && w.id !== 'unknown' && lastActivity.has(w.id));
  const noProject = tracked.filter(w => !w.projectId);
  add({
    id: 'wi-no-project', severity: 'warning', title: 'Work items belong to a project',
    count: noProject.length,
    detail: 'Work items without a project use the global rates and are missing from project ROI.',
    examples: examples(noProject, w => ({ label: `#${w.id}${w.title ? ' ' + w.title : ''}`, action: { label: 'Assign project', command: 'assignWorkItemToProject', arg: w.id } }))
  });

  const recent = (id: string) => now - (lastActivity.get(id) ?? 0) <= 14 * DAY_MS;
  const noEstimate = tracked.filter(w => w.status !== 'done' && recent(w.id) && !(typeof w.estimate === 'number' && w.estimate > 0));
  add({
    id: 'wi-no-estimate', severity: 'info', title: 'Active work items have an estimate',
    count: noEstimate.length,
    detail: 'Without an estimate there is no budget, no burn-down and no estimation accuracy for these items.',
    examples: examples(noEstimate, w => ({ label: `#${w.id}${w.title ? ' ' + w.title : ''}`, action: { label: 'Set estimate', command: 'setWorkItemEstimate', arg: w.id } }))
  });

  if (env.rates) {
    const usedProjects = new Set(tracked.map(w => w.projectId).filter((p): p is string => !!p));
    const noRates = Object.values(projects).filter(p => usedProjects.has(p.id) && (env.rates![p.id]?.cost == null || env.rates![p.id]?.sell == null));
    add({
      id: 'project-no-rates', severity: 'warning', title: 'Projects have cost and sell rates',
      count: noRates.length,
      detail: 'Without an hourly cost and sell rate (per project or as global default) ROI and value produced stay empty.',
      examples: examples(noRates, p => ({ label: `${p.name}: ${env.rates![p.id]?.cost == null ? 'no cost rate' : ''}${env.rates![p.id]?.cost == null && env.rates![p.id]?.sell == null ? ', ' : ''}${env.rates![p.id]?.sell == null ? 'no sell rate' : ''}`, action: { label: 'Set rates', command: 'setProjectRates', arg: p.id } }))
    });
  }

  // --- Credits capture -------------------------------------------------------
  const monthAgo = now - 30 * DAY_MS;
  let unpriced = 0;
  const unpricedModels = new Map<string, number>();
  const usedModels = new Map<string, number>();
  for (const e of ledger) {
    if (!e.debugUsage) continue;
    unpriced += e.debugUsage.unpricedRequests || 0;
    for (const r of e.debugUsage.requests ?? []) {
      if (r.credits === null) unpricedModels.set(r.model, (unpricedModels.get(r.model) ?? 0) + 1);
      if ((r.ts ?? e.ts) >= monthAgo) usedModels.set(r.model, (usedModels.get(r.model) ?? 0) + 1);
    }
  }
  add({
    id: 'unpriced-requests', severity: 'info', title: 'Every model call has a credit value',
    count: unpriced,
    detail: `${unpriced} model calls in the debug logs carried no credit value (usually free models or calls logged before billing). Their credits count as 0.`,
    examples: examples([...unpricedModels].sort((a, b) => b[1] - a[1]), ([m, n]) => ({ label: `${m}: ${n} calls` }))
  });

  if (data.modelPrices) {
    const prices = data.modelPrices;
    const missing = [...usedModels].filter(([m]) => m && !prices[m]).sort((a, b) => b[1] - a[1]);
    add({
      id: 'missing-prices', severity: 'info', title: 'Token prices known for used models',
      count: missing.length,
      detail: 'Without token prices the Optimize tab cannot estimate savings for these models. Prices are captured automatically from the Copilot debug logs when the model is listed there.',
      examples: examples(missing, ([m, n]) => ({ label: `${m} (${n} calls in 30 days)` }))
    });
  }

  const future = ledger.filter(e => Number.isFinite(e.ts) && e.ts > now + DAY_MS);
  add({
    id: 'future-timestamps', severity: 'warning', title: 'No timestamps in the future',
    count: future.length,
    detail: 'Rows dated in the future usually come from a wrong system clock on another machine; they distort daily charts and budgets.',
    examples: examples(future, e => ({ label: `Credit row ${e.id} at ${new Date(e.ts).toISOString().slice(0, 16)}`, action: { label: 'Edit', command: 'editLedgerEntry', arg: e.id } }))
  });

  // --- Implausible days --------------------------------------------------------
  const perDay = new Map<string, number>();
  for (const [, b] of branches) {
    for (const [day, d] of Object.entries(b.daily ?? {})) {
      const ms = ACTIVE_MODES.reduce((n, m) => n + (typeof d?.[m] === 'number' && Number.isFinite(d[m]) ? Math.max(0, d[m]!) : 0), 0);
      perDay.set(day, (perDay.get(day) ?? 0) + ms);
    }
  }
  for (const t of timeEntries) {
    if (t.source !== 'manual' || !(t.durationMs > 0)) continue;
    const day = localDay(t.startTs ?? t.createdAt);
    perDay.set(day, (perDay.get(day) ?? 0) + t.durationMs);
  }
  const heavy = [...perDay].filter(([, ms]) => ms > MAX_PLAUSIBLE_DAY_MS).sort((a, b) => b[0].localeCompare(a[0]));
  add({
    id: 'implausible-days', severity: 'warning', title: 'No day has more than 16 h tracked',
    count: heavy.length,
    detail: 'Days with more than 16 active hours (tracked plus manual time entries) usually mean double counting, e.g. two windows or a time entry on top of tracked time. Correct them with Adjust Tracked Time or by editing the time entries.',
    examples: examples(heavy, ([day, ms]) => ({ label: `${day}: ${hours(ms)} h`, action: { label: 'Adjust', command: 'adjustTrackedTime' } }))
  });

  const counts: Record<HealthSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const c of checks) counts[c.severity]++;
  const order: Record<HealthSeverity, number> = { error: 0, warning: 1, info: 2 };
  checks.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    checkedAt: new Date(now).toISOString(),
    status: counts.error ? 'error' : counts.warning ? 'warning' : counts.info ? 'info' : 'ok',
    score: Math.max(0, 100 - 25 * counts.error - 8 * counts.warning - 2 * counts.info),
    counts,
    checks,
    passed,
    stats: {
      branches: branches.length,
      workItems: Object.keys(wis).length,
      projects: Object.keys(projects).length,
      ledgerEntries: ledger.length,
      timeEntries: timeEntries.length,
      storeBytes: f?.sizeBytes ?? null,
      backups: f ? f.historyCount + (f.hasBackup ? 1 : 0) : null
    }
  };
}

/**
 * Credit rows to drop so every row id and every debug chat turn is stored once.
 * Keeps the copy with the most model calls (then exact, then the latest).
 * Returns indexes into `ledger`, so duplicate ids can be removed individually.
 */
export function duplicateLedgerIndexes(ledger: LedgerEntry[]): number[] {
  const drop = new Set<number>();
  const byId = new Map<string, number>();
  ledger.forEach((e, i) => {
    if (byId.has(e.id)) drop.add(i); else byId.set(e.id, i);
  });
  const byTurn = new Map<string, number[]>();
  ledger.forEach((e, i) => {
    if (drop.has(i) || !e.debugUsage?.sessionId || !e.debugUsage.turnId) return;
    const k = `${e.debugUsage.sessionId}|${e.debugUsage.turnId}`;
    byTurn.set(k, [...(byTurn.get(k) ?? []), i]);
  });
  for (const idx of byTurn.values()) {
    if (idx.length < 2) continue;
    const rank = (i: number) => [ledger[i].debugUsage!.requests?.length ?? 0, ledger[i].exact ? 1 : 0, ledger[i].ts];
    const best = idx.reduce((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] > rb[k] ? a : b;
      return a;
    });
    for (const i of idx) if (i !== best) drop.add(i);
  }
  return [...drop].sort((a, b) => a - b);
}
