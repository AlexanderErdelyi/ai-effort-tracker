const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'vscode') return { window: {}, workspace: { getConfiguration: () => ({ get() {} }) } };
  return load.call(this, name, ...rest);
};
const F = require('../out/analysis/dashboardFilter');
const { buildCreditOverview, localDay } = require('../out/analysis/creditOverview');
const { parseSessionQuery } = require('../out/ui/sessionsPanel');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('normalizeFilter coerces untrusted input', () => {
  assert.deepEqual(F.normalizeFilter(undefined), F.DEFAULT_FILTER);
  assert.deepEqual(F.normalizeFilter({ range: 'bogus', projectId: 7 }), F.DEFAULT_FILTER);
  assert.deepEqual(F.normalizeFilter({ range: '7', from: '2026-01-01', projectId: ' P1 ', workItemId: '42' }),
    { range: '7', from: '', to: '', projectId: 'P1', workItemId: '42', repoId: '' });
  assert.equal(F.normalizeFilter({ range: 'custom' }).range, '30');
  assert.deepEqual(F.normalizeFilter({ range: 'custom', from: '2026-03-10', to: '2026-03-01' }),
    { range: 'custom', from: '2026-03-01', to: '2026-03-10', projectId: '', workItemId: '', repoId: '' });
  assert.equal(F.normalizeFilter({ range: 'custom', from: 'March', to: '2026-03-01' }).from, '');
});

test('filterWindow covers rolling days, the billing period, all time and custom days', () => {
  const now = at(2026, 10, 10, 18);
  const f = r => ({ ...F.DEFAULT_FILTER, ...r });
  assert.equal(localDay(F.filterWindow(f({ range: '7' }), now).from), '2026-10-04');
  assert.equal(F.filterWindow(f({ range: '7' }), now).to, undefined);
  assert.equal(localDay(F.filterWindow(f({ range: 'period' }), now, 15).from), '2026-09-15');
  assert.deepEqual(F.filterWindow(f({ range: 'all' }), now), {});
  const w = F.filterWindow(f({ range: 'custom', from: '2026-03-01', to: '2026-03-05' }), now);
  assert.equal(localDay(w.from), '2026-03-01');
  assert.equal(localDay(w.to), '2026-03-06');
  assert.ok(F.inWindow(at(2026, 3, 5, 23), w));
  assert.ok(!F.inWindow(at(2026, 3, 6, 0), w));
  assert.ok(!F.inWindow(at(2026, 2, 28), w));
  assert.deepEqual(F.filterWindow(f({ range: 'custom', to: '2026-03-05' }), now), { to: w.to });
});

test('matchesScope handles all, one project, no project and one work item', () => {
  const f = r => ({ ...F.DEFAULT_FILTER, ...r });
  const a = { projectId: 'P1', workItemId: '1' }, b = { projectId: null, workItemId: '2' }, c = {};
  assert.ok([a, b, c].every(e => F.matchesScope(e, f({}))));
  assert.deepEqual([a, b, c].map(e => F.matchesScope(e, f({ projectId: 'P1' }))), [true, false, false]);
  assert.deepEqual([a, b, c].map(e => F.matchesScope(e, f({ projectId: F.NO_PROJECT }))), [false, true, true]);
  assert.deepEqual([a, b, c].map(e => F.matchesScope(e, f({ workItemId: '2' }))), [false, true, false]);
  assert.equal(F.matchesScope(a, f({ projectId: 'P2', workItemId: '1' })), false);
  assert.equal(F.isScoped(f({})), false);
  assert.equal(F.isScoped(f({ workItemId: '1' })), true);
});

test('credit overview adds a custom breakdown for an explicit window', () => {
  const now = at(2026, 10, 10, 18);
  const entries = [at(2026, 3, 1), at(2026, 3, 5, 23), at(2026, 3, 6, 1), at(2026, 10, 9)]
    .map((ts, i) => ({ ts, credits: i + 1, model: 'm', workItemId: '1', source: 'auto' }));
  const w = F.filterWindow({ ...F.DEFAULT_FILTER, range: 'custom', from: '2026-03-01', to: '2026-03-05' }, now);
  const o = buildCreditOverview(entries, { now, window: w });
  assert.equal(o.breakdown.custom.total, 3);
  assert.equal(o.breakdown.custom.entries, 2);
  assert.equal(buildCreditOverview(entries, { now }).breakdown.custom, undefined);
  assert.equal(buildCreditOverview(entries, { now, window: {} }).breakdown.custom.total, 10);
});

test('session queries pass the project through', () => {
  assert.equal(parseSessionQuery({ projectId: 'P1' }).filter.projectId, 'P1');
  assert.equal(parseSessionQuery({}).filter.projectId, undefined);
  assert.deepEqual(parseSessionQuery({ from: '2026-01-01', days: 3650 }).filter.days, undefined);
  assert.equal(parseSessionQuery({ days: 3650 }).filter.days, 3650);
});
