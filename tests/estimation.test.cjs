const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');

const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: { showWarningMessage() {} } };
  return load.call(this, name, ...args);
};
const est = require('../out/analysis/estimation');
const { Database } = require('../out/store/database');
const { estimationTool, callTool } = require('../out/mcp/server');

const TODAY = '2025-03-31';
const item = (id, o = {}) => ({
  id, title: null, projectId: 'p', estimateHours: null, estimatePoints: null, categories: [], actualHours: 0,
  credits: 0, mix: {}, firstDay: '2025-03-01', lastDay: '2025-03-05', ...o
});

test('finished = done, or dormant 14 days with tracked time; explicit active never finishes', () => {
  assert.equal(est.isFinished(item('a', { status: 'done', lastDay: TODAY }), TODAY), true);
  assert.equal(est.isFinished(item('b', { actualHours: 2, lastDay: '2025-03-17' }), TODAY), true);
  assert.equal(est.isFinished(item('c', { actualHours: 2, lastDay: '2025-03-18' }), TODAY), false);
  assert.equal(est.isFinished(item('d', { actualHours: 0, lastDay: '2025-01-01' }), TODAY), false);
  assert.equal(est.isFinished(item('e', { status: 'active', actualHours: 5, lastDay: '2024-01-01' }), TODAY), false);
});

test('accuracy: factors, within ±20 %, sizes, months, categories and worst misses', () => {
  const items = [
    item('1', { status: 'done', estimateHours: 2, actualHours: 2.2, lastDay: '2025-02-10' }),
    item('2', { status: 'done', estimateHours: 8, actualHours: 12, lastDay: '2025-03-02',
      categories: [{ category: 'programming', estimateHours: 6, actualHours: 10 }, { category: 'documentation', estimateHours: 2, actualHours: 2 }] }),
    item('3', { status: 'done', estimateHours: 20, actualHours: 10, lastDay: '2025-03-03', projectId: 'q' }),
    item('4', { status: 'done', estimatePoints: 3, actualHours: 4 }),
    item('5', { status: 'done', actualHours: 1 }),
    item('6', { estimateHours: 5, actualHours: 1, lastDay: TODAY })
  ];
  const acc = est.estimateAccuracy(items, TODAY);
  assert.equal(acc.finished, 5);
  assert.equal(acc.rows.length, 3);
  assert.equal(acc.unestimated, 2);
  assert.equal(acc.points, 1);
  assert.equal(acc.overall.medianFactor, 1.1);
  assert.equal(acc.overall.withinPct, 33);
  assert.equal(acc.overall.overPct, 33);
  assert.equal(acc.overall.underPct, 33);
  assert.deepEqual(acc.bySize.map(g => g.key), ['small', 'medium', 'large']);
  assert.deepEqual(acc.byMonth.map(g => [g.key, g.count]), [['2025-02', 1], ['2025-03', 2]]);
  assert.deepEqual(acc.byProject.map(g => [g.key, g.count]), [['p', 2], ['q', 1]]);
  const prog = acc.byCategory.find(c => c.category === 'programming');
  assert.equal(prog.factor, 1.67);
  assert.equal(acc.worst[0].id, '3');
  assert.equal(est.estimateAccuracy(items, TODAY, { projectId: 'q' }).rows.length, 1);
  assert.equal(est.estimateAccuracy([], TODAY).overall, null);
});

test('suggestion prefers similar titles, then the project, and reports the bias', () => {
  const items = [
    item('a', { status: 'done', title: 'E-Invoice export XRechnung', actualHours: 10, credits: 300, estimateHours: 8 }),
    item('b', { status: 'done', title: 'XRechnung import', actualHours: 6, credits: 100, estimateHours: 4 }),
    item('c', { status: 'done', title: 'Role center', actualHours: 1, credits: 20, estimateHours: 1 }),
    item('d', { status: 'done', title: 'Job queue', actualHours: 2, projectId: 'q', estimateHours: 1 }),
    item('tiny', { status: 'done', title: 'XRechnung typo', actualHours: 0.1 }),
    item('open', { title: 'XRechnung archive', actualHours: 1, lastDay: TODAY })
  ];
  const s = est.suggestEstimate(items, { title: 'Archive XRechnung in DMS', projectId: 'p', excludeId: 'open' }, TODAY);
  assert.equal(s.basis, 'similar');
  assert.deepEqual(s.comparables.map(c => c.id).sort(), ['a', 'b']);
  assert.ok(s.hours.median >= 6 && s.hours.median <= 10);
  assert.ok(s.hours.low <= s.hours.median && s.hours.median <= s.hours.high);
  // Project p has 3 finished estimated items (1.25×, 1.5×, 1×) → project bias.
  assert.equal(s.biasFactor, 1.25);
  assert.equal(s.biasSamples, 3);
  assert.equal(est.adjustForBias(4, s.biasFactor), 5);
  assert.equal(est.adjustForBias(4, null), null);

  const p = est.suggestEstimate(items, { title: 'Something else', projectId: 'q' }, TODAY);
  assert.equal(p.basis, 'project');
  assert.deepEqual(p.comparables.map(c => c.id), ['d']);
  assert.equal(est.suggestEstimate(items, { title: 'Nothing' }, TODAY).basis, 'all');
  const none = est.suggestEstimate([], { title: 'x' }, TODAY);
  assert.equal(none.basis, 'none');
  assert.equal(none.hours, null);
  assert.match(none.note, /No finished work items/);
});

test('title tokens drop stop words, numbers and short words', () => {
  assert.deepEqual([...est.titleTokens('Fix the 1234 export for XRechnungen')].sort(), ['export', 'xrechnung']);
  assert.equal(est.weightedPercentile([{ value: 1, weight: 1 }, { value: 9, weight: 3 }], 0.5), 9);
});

function fixture(t) {
  const dir = path.join(__dirname, `.est-${randomUUID()}`);
  fs.mkdirSync(dir);
  const dbs = [];
  t.after(() => {
    for (const db of dbs) {
      if (db.saveTimer) clearTimeout(db.saveTimer);
      if (db.refreshTimer) clearInterval(db.refreshTimer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, open: () => { const db = new Database(dir); dbs.push(db); return db; } };
}

test('work item status: done sets doneAt, reopen clears it, persists and sanitises', t => {
  const { dir, open } = fixture(t);
  const db = open();
  db.upsertWorkItem('7', { title: 'Seven', estimate: 2 });
  db.setWorkItemForBranch('feature/7', '7');
  db.recordTime('feature/7', 'humanCoding', 90 * 60000);
  const done = db.setWorkItemStatus('7', 'done');
  assert.equal(done.status, 'done');
  assert.ok(done.doneAt > 0);
  const s = db.getWorkItemSummary('7');
  assert.equal(s.status, 'done');
  assert.ok(s.activity.lastDay);
  assert.equal(s.activity.activeDays, 1);
  const i = est.toEstimationItem(s);
  assert.equal(i.estimateHours, 2);
  assert.equal(i.actualHours, 1.5);
  assert.equal(est.isFinished(i, '2099-01-01'), true);
  db.flushSync();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'effort-tracker.json'), 'utf8'));
  assert.equal(raw.workItems['7'].status, 'done');
  raw.workItems['7'].status = 'bogus';
  fs.writeFileSync(path.join(dir, 'effort-tracker.json'), JSON.stringify(raw));
  const re = open().getWorkItem('7');
  assert.equal('status' in re, false);
  assert.equal('doneAt' in re, false);
  db.setWorkItemStatus('7', 'active');
  assert.equal(db.getWorkItem('7').status, 'active');
  assert.equal('doneAt' in db.getWorkItem('7'), false);
  db.setWorkItemStatus('7', null);
  assert.equal('status' in db.getWorkItem('7'), false);
});

test('MCP estimation tools read the snapshot and explain when it is missing', () => {
  assert.match(estimationTool('estimate_accuracy', {}, null).note, /No estimation snapshot/);
  const snap = { generatedAt: '2025-03-31T10:00:00Z', items: [
    item('a', { status: 'done', title: 'Payment export', estimateHours: 4, actualHours: 6 }),
    item('b', { status: 'done', title: 'Payment import', estimateHours: 2, actualHours: 3 }),
    item('c', { status: 'done', title: 'Payment fix', estimateHours: 2, actualHours: 2 }),
    item('n', { title: 'Payment archive', lastDay: TODAY, actualHours: 1 })
  ] };
  const acc = estimationTool('estimate_accuracy', {}, snap, TODAY);
  assert.equal(acc.overall.count, 3);
  assert.equal(acc.asOf, snap.generatedAt);
  const s = estimationTool('suggest_estimate', { workItemId: 'n' }, snap, TODAY);
  assert.equal(s.basis, 'similar');
  assert.equal(s.biasFactor, 1.5);
  assert.throws(() => estimationTool('suggest_estimate', { workItemId: 'zzz' }, snap, TODAY), /Unknown work item/);
  assert.throws(() => callTool('nope', {}, {}), /Unknown tool/);
});
