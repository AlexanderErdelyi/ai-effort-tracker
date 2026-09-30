const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkDataHealth, duplicateLedgerIndexes, MAX_PLAUSIBLE_DAY_MS } = require('../out/analysis/dataHealth');

const NOW = Date.UTC(2026, 8, 10, 12);
const H = 3_600_000;
const env = { schemaVersion: 13, expectedSchemaVersion: 13, file: { sizeBytes: 1000, hasBackup: true, historyCount: 3 }, rates: {} };
const branch = (workItemId, ms, daily = {}) => ({ workItemId, time: { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0 }, daily });
const wi = (id, extra = {}) => ({ id, title: null, projectId: 'p1', estimate: 4, externalRef: null, createdAt: 0, ...extra });
const row = (id, extra = {}) => ({ id, ts: NOW - H, model: 'm', credits: 1, source: 'auto', ...extra });

function clean() {
  return {
    branches: { 'feature/100': branch('100', H) },
    workItems: { 100: wi('100') },
    projects: { p1: { id: 'p1', name: 'P', repos: [], createdAt: 0 } },
    creditLedger: [row('a', { branch: 'feature/100', workItemId: '100' })],
    timeEntries: [],
    modelPrices: { m: {} }
  };
}
const envWithRates = { ...env, rates: { p1: { cost: 50, sell: 100 } } };

test('a clean store passes every check', () => {
  const r = checkDataHealth(clean(), envWithRates, NOW);
  assert.deepEqual(r.checks.map(c => c.id), []);
  assert.equal(r.status, 'ok');
  assert.equal(r.score, 100);
  assert.ok(r.passed.length >= 15);
});

test('finds unassigned time and credits and repairs stale attribution', () => {
  const d = clean();
  d.branches.main = branch(null, 3 * H);
  d.branches['feature/200-x'] = branch('200', H);
  d.branches.quick = branch(null, 60_000);
  d.workItems[200] = wi('200');
  d.creditLedger.push(row('b', { branch: 'main', credits: 5 }), row('c', { branch: 'feature/200-x', workItemId: null, credits: 2 }),
    row('d', { branch: 'unknown', credits: 3 }));
  const r = checkDataHealth(d, envWithRates, NOW);
  const by = Object.fromEntries(r.checks.map(c => [c.id, c]));
  assert.equal(by['unassigned-branches'].count, 1, 'short checkouts are ignored');
  assert.equal(by['unassigned-branches'].examples[0].action.arg, 'main');
  assert.equal(by['stale-credit-attribution'].count, 1);
  assert.equal(by['stale-credit-attribution'].fix.arg, 'stale-credit-attribution');
  assert.equal(by['unassigned-credits'].count, 2);
  const noBranch = by['unassigned-credits'].examples.find(x => x.label.startsWith('No branch'));
  assert.equal(noBranch.action.command, 'editLedgerEntry');
  assert.equal(r.status, 'warning');
});

test('flags invalid numbers, orphans, duplicates, heavy days and future rows', () => {
  const d = clean();
  d.branches['feature/100'].time.reviewing = NaN;
  d.branches['feature/100'].daily = { '2026-09-09': { humanCoding: MAX_PLAUSIBLE_DAY_MS - H, aiGenerating: 0, reviewing: 0, idle: 0 } };
  d.timeEntries.push({ id: 't1', workItemId: '100', startTs: new Date(2026, 8, 9, 10).getTime(), durationMs: 2 * H, source: 'manual', createdAt: 0 });
  d.branches.old = branch('999', H);
  d.workItems[300] = wi('300', { projectId: 'gone', estimate: -1 });
  const turn = { sessionId: 's', turnId: 't', requests: [{ spanId: 'x', model: 'm', credits: 1, inputTokens: 1, outputTokens: 1 }], unpricedRequests: 0 };
  d.creditLedger.push(row('e', { workItemId: '100', debugUsage: turn }), row('f', { workItemId: '100', debugUsage: { ...turn, requests: [] } }),
    row('g', { workItemId: '100', ts: NOW + 3 * 86_400_000 }));
  const r = checkDataHealth(d, envWithRates, NOW);
  const by = Object.fromEntries(r.checks.map(c => [c.id, c]));
  assert.equal(by['invalid-numbers'].count, 2);
  assert.equal(by['orphans'].count, 2);
  assert.equal(by['duplicate-ledger'].count, 1);
  assert.equal(by['implausible-days'].count, 1);
  assert.equal(by['future-timestamps'].count, 1);
  assert.equal(r.status, 'error');
  assert.equal(r.checks[0].severity, 'error', 'errors come first');
  // The repair keeps the copy with the most model calls.
  assert.deepEqual(duplicateLedgerIndexes(d.creditLedger).map(i => d.creditLedger[i].id), ['f']);
});

test('work items, projects, prices, persistence and schema', () => {
  const d = clean();
  d.workItems[400] = wi('400', { projectId: null, estimate: null });
  d.creditLedger.push(row('h', { workItemId: '400', model: 'new-model',
    debugUsage: { sessionId: 's2', turnId: 't2', requests: [{ spanId: 'y', model: 'new-model', credits: null, inputTokens: 1, outputTokens: 1 }], unpricedRequests: 1 } }));
  const r = checkDataHealth(d, { schemaVersion: 14, expectedSchemaVersion: 13, file: { sizeBytes: 10, hasBackup: false, historyCount: 0 },
    lastSaveError: { ts: NOW, message: 'EACCES' }, rates: { p1: { cost: null, sell: 100 } } }, NOW);
  const ids = r.checks.map(c => c.id);
  for (const id of ['save-error', 'schema', 'backups', 'wi-no-project', 'wi-no-estimate', 'project-no-rates', 'unpriced-requests', 'missing-prices']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(r.checks.find(c => c.id === 'schema').severity, 'error', 'a newer writer is an error');
  assert.equal(r.checks.find(c => c.id === 'project-no-rates').examples[0].action.arg, 'p1');
  // Done items need no estimate.
  d.workItems[400].status = 'done';
  assert.equal(checkDataHealth(d, envWithRates, NOW).checks.some(c => c.id === 'wi-no-estimate'), false);
});
