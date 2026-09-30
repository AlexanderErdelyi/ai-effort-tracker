import type { LedgerEntry, PersistedStore } from './database';
import { isDeepStrictEqual } from 'util';

const branchCounters = new Set([
  'copilotAcceptances', 'chatCharsHuman', 'chatTurnsHuman', 'humanCharsInserted',
  'aiCharsInserted', 'humanKeystrokes', 'aiInserts', 'aiInlineLines', 'aiChatLines',
  'aiInlineChars', 'aiChatChars', 'autoModelRequests'
]);
const fileCounters = new Set([
  'humanAdded', 'humanDeleted', 'aiAdded', 'aiDeleted', 'edits', 'effectiveHuman', 'effectiveAi'
]);
const entityMaps = new Set(['branches', 'workItems', 'projects']);
const rowArrays = new Set(['creditLedger', 'manualEffort', 'timeEntries', 'reassignments']);
const object = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));

function additive(keys: string[]): boolean {
  if (keys[0] !== 'branches') return false;
  if (keys.length === 3) return branchCounters.has(keys[2]);
  if (['time', 'lineChanges', 'daily', 'effectiveLines'].includes(keys[2])) return true;
  return keys[2] === 'files' && keys.length === 5 && fileCounters.has(keys[4]);
}

/**
 * Only the writer's delta from its last successful commit is applied. Entity
 * deletion wins over stale edits; independent fields merge; conflicting scalar
 * edits use commit order. Measurements are additive ONLY on the explicit
 * automatic-counter paths, never on manual durations, adjustments or money.
 */
function merge(base: any, local: any, disk: any, keys: string[] = []): any {
  if (isDeepStrictEqual(base, local)) return copy(disk);
  if (local === undefined) return undefined;
  if (base !== undefined && disk === undefined && (
    (keys.length === 2 && entityMaps.has(keys[0])) ||
    (keys.length === 2 && rowArrays.has(keys[0])) ||
    (keys[0] === 'branches' && keys[2] === 'files' && keys.length === 4)
  )) return undefined;
  if (typeof local === 'number' && additive(keys)) {
    return (typeof disk === 'number' ? disk : 0) + local - (typeof base === 'number' ? base : 0);
  }
  if (Array.isArray(local)) {
    const before = Array.isArray(base) ? base : [];
    const current = Array.isArray(disk) ? disk : [];
    if (keys[0] === 'branches' && keys[2] === 'daily') {
      return local.map((v, i) => merge(before[i], v, current[i], [...keys, String(i)]));
    }
    const idKey = keys.length === 1 && rowArrays.has(keys[0]) ? 'id'
      : keys[keys.length - 1] === 'requests' && keys.includes('debugUsage') ? 'spanId' : undefined;
    if (idKey) {
      const index = (rows: any[]) => Object.fromEntries(rows.map(row => [row[idKey], row]));
      const b = index(before), l = index(local), d = index(current);
      return [...new Set([...Object.keys(d), ...Object.keys(l)])]
        .map(id => merge(b[id], l[id], d[id], [...keys, id])).filter(v => v !== undefined);
    }
    // Set-like arrays (repos/aliases) and legacy focus sessions have no id.
    // Multiset subtraction preserves two independently recorded equal sessions.
    const remaining = [...before];
    const additions = local.filter(v => {
      const index = remaining.findIndex(b => isDeepStrictEqual(b, v));
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    const retained = [...current];
    for (const removed of remaining) {
      const index = retained.findIndex(v => isDeepStrictEqual(v, removed));
      if (index >= 0) retained.splice(index, 1);
    }
    for (const added of additions) {
      if (keys[keys.length - 1] === 'focusSessions' || !retained.some(v => isDeepStrictEqual(v, added))) {
        retained.push(copy(added));
      }
    }
    return keys[keys.length - 1] === 'focusSessions' ? retained.slice(-500) : retained;
  }
  if (object(local)) {
    let b = object(base) ? base : {}, d = object(disk) ? disk : {};
    if (keys.length === 2 && keys[0] === 'branches' &&
        (local.effectiveLinesVersion ?? 0) > (b.effectiveLinesVersion ?? 0)) {
      // An algorithm migration starts a fresh effective counter epoch. Two
      // stale hosts performing it must not each subtract the old v1 totals.
      const oldVersion = b.effectiveLinesVersion ?? 0;
      b = { ...b, effectiveLines: {}, effectiveLegacyBaseline: {} };
      if ((d.effectiveLinesVersion ?? 0) <= oldVersion) {
        d = { ...d, effectiveLines: {}, effectiveLegacyBaseline: {} };
      }
    }
    const result: Record<string, any> = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(local), ...Object.keys(d)])) {
      const value = merge(b[key], local[key], d[key], [...keys, key]);
      if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    if (keys.length === 2 && keys[0] === 'branches' && d.workItemIdManual && !local.workItemIdManual) {
      result.workItemId = d.workItemId;
      result.workItemIdManual = true;
    }
    // Same file seen by two hosts: timestamps are observations, not counters.
    if (keys[0] === 'branches' && keys[2] === 'files' && keys.length === 4) {
      result.lastTs = Math.max(local.lastTs ?? 0, d.lastTs ?? 0);
    }
    return result;
  }
  // A concurrently-created entity's empty defaults must not erase metadata.
  if (base === undefined && local === null && disk !== undefined) return copy(disk);
  return copy(local);
}

function usageIdentity(entry: LedgerEntry): string | undefined {
  if (entry.source === 'manual') return undefined;
  if (entry.debugUsage) return `debug:${entry.debugUsage.sessionId}:${entry.debugUsage.turnId}`;
  if (/^(auto:jsonl:|auto:ccreq:|import:debug:)/.test(entry.note ?? '')) return entry.note;
  return undefined;
}

function normalizeDebug(entry: LedgerEntry): void {
  const usage = entry.debugUsage;
  if (!usage) return;
  const known = usage.requests.reduce((sum, r) => sum + (r.credits ?? 0), 0);
  usage.unpricedRequests = usage.requests.filter(r => r.credits === null).length +
    Math.max(0, (usage.exportRequests ?? 0) - usage.requests.length);
  if (!usage.creditsOverridden) entry.credits = Math.max(known, usage.exportCredits ?? 0);
  entry.exact = !usage.creditsOverridden && !usage.logWarnings && usage.unpricedRequests === 0;
  entry.promptTokens = usage.requests.reduce((sum, r) => sum + r.inputTokens, 0);
  entry.completionTokens = usage.requests.reduce((sum, r) => sum + r.outputTokens, 0);
  entry.model = [...new Set(usage.requests.map(r => r.model))].join(' + ') || 'unknown';
}

/** Align semantically identical captures before the keyed-array merge. */
function alignCredits(base: PersistedStore, local: PersistedStore, disk: PersistedStore): void {
  const ids = new Map<string, string>();
  for (const store of [disk, base, local]) {
    for (const entry of store.creditLedger) {
      const identity = usageIdentity(entry);
      if (!identity) continue;
      const id = ids.get(identity);
      if (id) entry.id = id;
      else ids.set(identity, entry.id);
    }
  }
}

export function mergeStores(baseline: PersistedStore, snapshot: PersistedStore, latest: PersistedStore): PersistedStore {
  const base = copy(baseline), local = copy(snapshot), disk = copy(latest);
  alignCredits(base, local, disk);
  const result: PersistedStore = merge(base, local, disk);
  const diskCredits = new Map(disk.creditLedger.map(e => [e.id, e]));
  const baseCredits = new Map(base.creditLedger.map(e => [e.id, e]));
  const localCredits = new Map(local.creditLedger.map(e => [e.id, e]));
  for (const entry of result.creditLedger) {
    const previous = diskCredits.get(entry.id);
    const before = baseCredits.get(entry.id);
    const incoming = localCredits.get(entry.id);
    if (previous && incoming && !before && incoming.source === 'auto' &&
        !incoming.debugUsage && usageIdentity(incoming) && incoming.branch) {
      const branch = result.branches[incoming.branch];
      if (branch?.autoModelRequests) branch.autoModelRequests--;
    }
    if (previous && incoming && !before && previous.exact && !incoming.exact && !entry.debugUsage) {
      // Concurrent first capture: an estimate must not downgrade an exact row.
      Object.assign(entry, copy(previous));
    }
    if (entry.debugUsage) {
      if (previous?.debugUsage?.creditsOverridden && !incoming?.debugUsage?.creditsOverridden) {
        entry.credits = previous.credits;
        entry.debugUsage.creditsOverridden = true;
      }
      for (const request of entry.debugUsage.requests) {
        if (request.credits === null) {
          request.credits = previous?.debugUsage?.requests.find(r => r.spanId === request.spanId)?.credits ?? null;
        }
      }
      normalizeDebug(entry);
    }
  }
  // Reconcile debug-log vs export/live capture overlaps by proven request aliases.
  for (const debug of result.creditLedger.filter(e => e.debugUsage)) {
    const aliases = new Set(debug.debugUsage!.requestAliases ?? []);
    const responses = new Set(debug.responseIds ?? []);
    result.creditLedger = result.creditLedger.filter(entry => {
      if (entry === debug || entry.source === 'manual' || entry.debugUsage) return true;
      const alias = entry.note?.replace(/^(auto:jsonl:|import:debug:)/, '');
      const matches = (alias && aliases.has(alias)) || entry.responseIds?.some(id => responses.has(id));
      if (!matches) return true;
      if (entry.source === 'import' && !(alias && aliases.has(alias)) &&
          entry.responseIds?.some(id => !responses.has(id))) {
        throw new Error('Concurrent credit captures overlap only partially; review the ledger before retrying.');
      }
      if (entry.source === 'import' && entry.exact) {
        debug.debugUsage!.exportCredits = Math.max(debug.debugUsage!.exportCredits ?? 0, entry.credits);
        debug.debugUsage!.exportRequests = Math.max(debug.debugUsage!.exportRequests ?? 0, entry.analysis?.requestsDetail.length ?? 0);
      }
      return false;
    });
    normalizeDebug(debug);
  }
  const deletedItems = new Set(Object.keys(base.workItems).filter(id => !local.workItems[id] || !disk.workItems[id]));
  for (const id of deletedItems) delete result.workItems[id];
  for (const branch of Object.values(result.branches)) {
    if (branch.workItemId && deletedItems.has(branch.workItemId)) {
      branch.workItemId = '__unassigned__';
      branch.workItemIdManual = true;
    }
  }
  for (const entry of [...result.creditLedger, ...result.manualEffort, ...result.timeEntries]) {
    if (entry.workItemId && deletedItems.has(entry.workItemId)) {
      entry.workItemId = '__unassigned__';
      if ('projectId' in entry) delete entry.projectId;
    }
  }
  for (const entry of result.creditLedger) {
    const branch = entry.branch ? result.branches[entry.branch] : undefined;
    if (branch && entry.branch && (
      branch.workItemId !== base.branches[entry.branch]?.workItemId ||
      branch.workItemId !== local.branches[entry.branch]?.workItemId ||
      branch.workItemId !== disk.branches[entry.branch]?.workItemId
    )) entry.workItemId = branch.workItemId;
    if (entry.workItemId && result.workItems[entry.workItemId]) {
      const wi = result.workItems[entry.workItemId];
      if (wi.projectId !== base.workItems[wi.id]?.projectId ||
          entry.workItemId !== baseCredits.get(entry.id)?.workItemId) {
        entry.projectId = wi.projectId;
      }
    }
  }
  return result;
}
