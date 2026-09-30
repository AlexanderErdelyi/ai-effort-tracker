const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');

const settings = {};
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: key => settings[key] }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { mergeStores } = require('../out/store/mergeStore');
const budget = require('../out/analysis/budget');
const { listWorkItems, loadBudgetSnapshot } = require('../out/mcp/server');

const TODAY = '2025-03-20';
const noNaN = value => JSON.stringify(value, (_k, v) => {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), 'non-finite number in budget output');
  return v;
});

test('unestimated work items have no budget, no NaN and are flagged', () => {
  const b = budget.computeBudget({ estimateHours: null, usedHours: 3, usedCredits: 40, usedCost: null, today: TODAY });
  assert.equal(b.state, 'unestimated');
  assert.equal(b.pct, null);
  assert.equal(b.worst, null);
  assert.deepEqual(b.dims, {});
  assert.deepEqual(b.crossed, []);
  assert.equal(b.projection, null);
  assert.equal(b.series.length, 30);
  assert.deepEqual(b.series.at(-1), { date: TODAY, hours: 3, credits: 40 });
  noNaN(b);
  assert.equal(budget.budgetStatusLabel('7', b), 'WI 7: unestimated');
  // Garbage input never produces NaN either.
  noNaN(budget.computeBudget({ estimateHours: NaN, usedHours: NaN, usedCredits: Infinity, usedCost: NaN, hourlyCostRate: -1, daily: [{ date: TODAY, hours: NaN, credits: undefined }], categoryLines: { code: NaN }, branches: [{ branch: 'x', hours: NaN, credits: NaN }], today: TODAY }));
});

test('budgets come from explicit values, the estimate or the project default', () => {
  const derived = budget.computeBudget({
    estimateHours: 10, creditsPerEstimatedHour: 20, hourlyCostRate: 50, creditCostPerUnit: 0.04,
    usedHours: 6.4, usedCredits: 180, usedCost: 327.2, today: TODAY
  });
  assert.deepEqual(derived.dims.time, { budget: 10, used: 6.4, remaining: 3.6, pct: 64, source: 'estimate' });
  assert.deepEqual(derived.dims.credits, { budget: 200, used: 180, remaining: 20, pct: 90, source: 'project' });
  // 10h x 50 + 200 credits x 0.04
  assert.equal(derived.dims.cost.budget, 508);
  assert.equal(derived.dims.cost.source, 'estimate');
  assert.equal(derived.worst, 'credits');
  assert.equal(derived.state, 'warning');
  assert.deepEqual(derived.crossed, [80]);
  assert.equal(budget.budgetStatusLabel('1761', derived), 'WI 1761: 90% \u00b7 20 cr left');

  const explicit = budget.computeBudget({
    estimateHours: 10, creditBudget: 150, costBudget: 300, creditsPerEstimatedHour: 20,
    usedHours: 2, usedCredits: 180, usedCost: 100, today: TODAY
  });
  assert.equal(explicit.dims.credits.source, 'explicit');
  assert.equal(explicit.dims.credits.pct, 120);
  assert.equal(explicit.dims.cost.source, 'explicit');
  assert.equal(explicit.state, 'over');
  assert.deepEqual(explicit.crossed, [80, 100]);
  assert.equal(budget.budgetStatusLabel('1', explicit), 'WI 1: 120% \u00b7 30 cr over');

  // An explicit credit budget works without any estimate; no rate means no cost dimension.
  const creditsOnly = budget.computeBudget({ estimateHours: null, creditBudget: 100, usedHours: 1, usedCredits: 25, usedCost: null, today: TODAY });
  assert.deepEqual(Object.keys(creditsOnly.dims), ['credits']);
  assert.equal(creditsOnly.state, 'ok');
  assert.equal(budget.budgetStatusLabel('9', { ...budget.computeBudget({ estimateHours: 8, usedHours: 4.84, usedCredits: 0, usedCost: null, today: TODAY }) }), 'WI 9: 60.5% \u00b7 3.2h left');
});

test('burn rate projects the first budget to run out; series ends at the totals', () => {
  const b = budget.computeBudget({
    estimateHours: 20, creditBudget: 400,
    usedHours: 12, usedCredits: 100, usedCost: null,
    daily: [
      { date: '2025-03-01', hours: 5, credits: 10 },
      { date: '2025-03-14', hours: 3.5, credits: 70 },
      { date: '2025-03-20', hours: 3.5, credits: 0 }
    ],
    today: TODAY
  });
  assert.equal(b.burn.hoursPerDay, 1); // 7h over the last 7 days
  assert.equal(b.burn.creditsPerDay, 10);
  // time: 8h left at 1h/day = 8 days; credits: 300 left at 10/day = 30 days
  assert.deepEqual(b.projection, { dimension: 'time', daysLeft: 8, date: '2025-03-28' });
  assert.equal(b.series.length, 30);
  assert.equal(b.series[0].date, '2025-02-19');
  assert.deepEqual(b.series.at(-1), { date: TODAY, hours: 12, credits: 100 });
  // History before the window and adjustments become the starting offset.
  assert.equal(b.series.find(s => s.date === '2025-03-13').hours, 5);
  assert.equal(b.series.find(s => s.date === '2025-03-14').hours, 8.5);

  const idle = budget.computeBudget({ estimateHours: 5, usedHours: 2, usedCredits: 0, usedCost: null, today: TODAY });
  assert.equal(idle.projection, null);
  assert.equal(budget.budgetIsActive(idle), false);
  const spent = budget.computeBudget({ estimateHours: 5, usedHours: 6, usedCredits: 0, usedCost: null, today: TODAY });
  assert.deepEqual(spent.projection, { dimension: 'time', daysLeft: 0, date: TODAY });
});

test('categories are apportioned by line share; branches report their share', () => {
  const b = budget.computeBudget({
    estimateHours: 10, estimateBreakdown: { code: 6, docs: 4 },
    usedHours: 8, usedCredits: 30, usedCost: null,
    categoryLines: { code: 300, docs: 100 },
    branches: [{ branch: 'a', hours: 6, credits: 10 }, { branch: 'b', hours: 2, credits: 20 }],
    today: TODAY
  });
  assert.deepEqual(b.categories, [
    { category: 'code', budgetHours: 6, usedHours: 6, pct: 100 },
    { category: 'docs', budgetHours: 4, usedHours: 2, pct: 50 }
  ]);
  assert.deepEqual(b.branches.map(x => [x.branch, x.hoursPct, x.creditsPct]), [['b', 25, 66.7], ['a', 75, 33.3]]);
});

test('thresholds normalise and alerts fire once per crossing, re-arming below', () => {
  assert.deepEqual(budget.normalizeThresholds([100, 80.4, 80, -5, 'x', 5000]), [80, 100]);
  assert.deepEqual(budget.normalizeThresholds([]), [80, 100]);
  assert.deepEqual(budget.normalizeThresholds(undefined), [80, 100]);
  assert.deepEqual(budget.normalizeThresholds([50, 75, 100]), [50, 75, 100]);

  let notified;
  let r = budget.budgetAlertChanges([80], notified);
  assert.deepEqual(r, { fire: [80], rearm: [], next: [80] });
  notified = r.next;
  r = budget.budgetAlertChanges([80], notified);
  assert.deepEqual(r, { fire: [], rearm: [], next: [80] });
  r = budget.budgetAlertChanges([80, 100], notified);
  assert.deepEqual(r.fire, [100]);
  notified = r.next;
  // The estimate was raised: both re-arm, nothing fires.
  r = budget.budgetAlertChanges([], notified);
  assert.deepEqual(r, { fire: [], rearm: [80, 100], next: [] });
  assert.equal(budget.addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(budget.addDays('2024-03-01', -1), '2024-02-29');
});

function fixture(t) {
  const dir = path.join(__dirname, `.budget-${randomUUID()}`);
  fs.mkdirSync(dir);
  const instances = [];
  t.after(() => {
    for (const db of instances) {
      if (db.saveTimer) clearTimeout(db.saveTimer);
      if (db.refreshTimer) clearInterval(db.refreshTimer);
    }
    for (const k of Object.keys(settings)) delete settings[k];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = () => { const db = new Database(dir); instances.push(db); return db; };
  const file = path.join(dir, 'effort-tracker.json');
  return { dir, file, open, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('work item summaries carry budget status across branches and ledger credits', t => {
  const { open } = fixture(t);
  settings['budget.creditsPerEstimatedHour'] = 10;
  const db = open();
  db.upsertWorkItem('1761', { title: 'Budgets', estimate: 2 });
  db.setWorkItemForBranch('feature/a', '1761');
  db.setWorkItemForBranch('feature/b', '1761');
  db.recordTime('feature/a', 'humanCoding', 60 * 60000);
  db.recordTime('feature/b', 'aiGenerating', 30 * 60000);
  db.recordCredits('feature/b', 'gpt', 16);
  const s = db.getWorkItemSummary('1761');
  noNaN(s.budget);
  assert.equal(s.budget.dims.time.budget, 2);
  assert.equal(s.budget.dims.time.used, 1.5);
  assert.equal(s.budget.dims.credits.budget, 20);
  assert.equal(s.budget.dims.credits.source, 'project');
  assert.equal(s.budget.dims.credits.used, 16);
  assert.equal(s.budget.worst, 'credits');
  assert.equal(s.budget.state, 'warning');
  assert.ok(s.budget.burn.hoursPerDay > 0);
  assert.deepEqual(s.budget.branches.map(b => b.branch), ['feature/b', 'feature/a']);
  assert.equal(s.budget.series.at(-1).credits, 16);

  // A project default overrides the global credits-per-hour setting.
  db.upsertProject({ id: 'p', name: 'P', settings: { creditsPerEstimatedHour: 50 } });
  db.upsertWorkItem('1761', { projectId: 'p' });
  assert.equal(db.getWorkItemSummary('1761').budget.dims.credits.budget, 100);

  db.setWorkItemBudget('1761', { creditBudget: 12, costBudget: -4 });
  let wi = db.getWorkItem('1761');
  assert.equal(wi.creditBudget, 12);
  assert.equal('costBudget' in wi, false);
  const over = db.getWorkItemSummary('1761');
  assert.equal(over.creditBudget, 12);
  assert.equal(over.budget.state, 'over');
  db.setWorkItemBudget('1761', { creditBudget: null });
  wi = db.getWorkItem('1761');
  assert.equal('creditBudget' in wi, false);

  const empty = db.getWorkItemSummary('unestimated');
  assert.equal(empty.budget.state, 'unestimated');
});

test('budget fields sanitise on load, persist, and notified thresholds merge across windows', t => {
  const { open, file, read } = fixture(t);
  const seed = open();
  seed.upsertWorkItem('w', { estimate: 4 });
  seed.flushSync();
  const raw = read();
  raw.workItems.w.creditBudget = -3;
  raw.workItems.w.costBudget = 'abc';
  raw.workItems.w.budgetAlerts = [100, 'x', 80, 80, -1];
  fs.writeFileSync(file, JSON.stringify(raw));
  const db = open();
  const wi = db.getWorkItem('w');
  assert.equal('creditBudget' in wi, false);
  assert.equal('costBudget' in wi, false);
  assert.deepEqual(wi.budgetAlerts, [80, 100]);
  db.flushSync();
  assert.equal(read().schemaVersion, 13);

  // Two stale windows: one records 80 and 100 were notified, the other re-arms 100.
  const a = open(), b = open();
  a.setBudgetAlerts('w', []);
  a.flushSync();
  b.setBudgetAlerts('w', [80, 100, 120]);
  b.flushSync();
  const merged = open().getWorkItem('w').budgetAlerts;
  assert.deepEqual(merged, [120]);
});

test('MCP list_work_items attaches budget status from the extension snapshot', t => {
  const dir = path.join(__dirname, `.budget-${randomUUID()}`);
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapFile = path.join(dir, budget.BUDGET_SNAPSHOT_FILE);
  const data = { creditLedger: [], toolsets: {}, modelPrices: {}, branches: {}, projects: {},
    workItems: { hot: { id: 'hot', title: 'At risk', projectId: 'p' }, calm: { id: 'calm', title: 'Fine', projectId: 'p' } } };
  assert.equal(loadBudgetSnapshot(snapFile), null);
  assert.match(listWorkItems(data, {}, null).budgetNote, /No budget snapshot/);
  fs.writeFileSync(snapFile, JSON.stringify({ generatedAt: '2025-03-20T10:00:00.000Z', workItems: {
    hot: { state: 'over', pct: 130, worst: 'credits' }, calm: { state: 'ok', pct: 10, worst: 'time' } } }));
  const snap = loadBudgetSnapshot(snapFile);
  const out = listWorkItems(data, {}, snap);
  assert.equal(out.budgetAsOf, '2025-03-20T10:00:00.000Z');
  // Items without usage are listed only when at risk.
  assert.deepEqual(out.workItems.map(w => [w.workItemId, w.budget.state]), [['hot', 'over']]);
  assert.deepEqual(listWorkItems(data, { projectId: 'other' }, snap).workItems, []);
  fs.writeFileSync(snapFile, '{"generatedAt":');
  assert.equal(loadBudgetSnapshot(snapFile), null);
  assert.equal(typeof mergeStores, 'function');
});

test('health repairs: auto-mapped branches take their unassigned credits along, duplicates are removed', t => {
  const { open, file } = fixture(t);
  const db = open();
  db.recordCredits('feature/x', 'gpt', 5);
  assert.ok(!db.getCreditEntries()[0].workItemId);
  db.setWorkItemForBranch('feature/x', '500');
  assert.equal(db.getCreditEntries()[0].workItemId, '500');
  db.flushSync();

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const turn = { sessionId: 's', turnId: 't', requests: [{ spanId: 'a', model: 'gpt', credits: 2, inputTokens: 1, outputTokens: 1 }], unpricedRequests: 0 };
  raw.creditLedger.push(
    { id: 'd1', ts: 1, model: 'gpt', credits: 2, source: 'import', branch: 'feature/y', workItemId: null, debugUsage: turn },
    { id: 'd2', ts: 2, model: 'gpt', credits: 1, source: 'import', branch: 'feature/y', workItemId: null, debugUsage: { ...turn, requests: [] } });
  raw.branches['feature/y'] = { ...raw.branches['feature/x'], workItemId: '500' };
  fs.writeFileSync(file, JSON.stringify(raw));
  const db2 = open();
  assert.equal(db2.removeDuplicateLedgerEntries(), 1);
  assert.equal(db2.reattributeUnassignedCredits(), 1);
  db2.flushSync();
  const after = open().getCreditEntries();
  assert.deepEqual(after.map(e => e.id).filter(id => id.startsWith('d')), ['d1']);
  assert.equal(after.find(e => e.id === 'd1').workItemId, '500');
});
