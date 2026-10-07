const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');

const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const {
  creditKind, confidenceOf, creditConfidence, emptyCreditSplit, addCredit,
  timeConfidence, linesConfidence, inheritLevel, derivedConfidence
} = require('../out/analysis/confidence');
const { buildCreditOverview } = require('../out/analysis/creditOverview');
const { Database } = require('../out/store/database');

const part = (value, kind) => ({ key: kind, label: kind, value, kind });

function tempDb(t) {
  const dir = path.join(__dirname, `.confidence-${randomUUID()}`);
  fs.mkdirSync(dir);
  const db = new Database(dir);
  t.after(() => {
    if (db.saveTimer) clearTimeout(db.saveTimer);
    if (db.refreshTimer) clearInterval(db.refreshTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('credit kinds follow how the amount was captured', () => {
  assert.equal(creditKind({ credits: 1, source: 'manual' }), 'manual');
  assert.equal(creditKind({ credits: 1, source: 'import', debugUsage: { creditsOverridden: true } }), 'manual');
  assert.equal(creditKind({ credits: 1, source: 'auto', exact: true }), 'exact');
  assert.equal(creditKind({ credits: 1, source: 'import', debugUsage: {} }), 'exact');
  assert.equal(creditKind({ credits: 1, source: 'import', debugUsage: { unpricedRequests: 2 } }), 'partial');
  assert.equal(creditKind({ credits: 1, source: 'import', debugUsage: { logWarnings: 1 } }), 'partial');
  assert.equal(creditKind({ credits: 1, source: 'auto' }), 'estimated');
});

test('a split is pure from 98% of one kind, otherwise mixed', () => {
  assert.equal(confidenceOf([]).level, 'none');
  assert.equal(confidenceOf([part(0, 'measured')]).level, 'none');
  assert.equal(confidenceOf([part(98, 'measured'), part(2, 'manual')]).level, 'exact');
  assert.equal(confidenceOf([part(97, 'measured'), part(3, 'manual')]).level, 'mixed');
  assert.equal(confidenceOf([part(99, 'estimated'), part(1, 'measured')]).level, 'estimated');
  assert.equal(confidenceOf([part(5, 'manual')]).level, 'manual');
  const c = confidenceOf([part(3, 'measured'), part(1, 'manual'), part(-4, 'estimated'), part(Number.NaN, 'estimated')], 'n');
  assert.equal(c.total, 4);
  assert.equal(c.measuredShare, 0.75);
  assert.equal(c.parts.length, 2);
  assert.equal(c.note, 'n');
});

test('credit splits count partial amounts as estimated', () => {
  const s = emptyCreditSplit();
  addCredit(s, { credits: 10, exact: true });
  addCredit(s, { credits: 5, debugUsage: { unpricedRequests: 1 } });
  addCredit(s, { credits: Number.NaN, source: 'manual' });
  assert.deepEqual(s, { exact: 10, partial: 5, estimated: 0, manual: 0 });
  const c = creditConfidence(s);
  assert.equal(c.level, 'mixed');
  assert.ok(c.parts.some(p => p.key === 'partial' && /lower bound/.test(p.label)));
});

test('time and lines confidence, with a note for branch moves', () => {
  const t = timeConfidence({ trackedMs: 1000, adjustedMs: 0, manualMs: 0, timeLogMs: 0, reassignments: 2 });
  assert.equal(t.level, 'exact');
  assert.equal(t.note, '2 branch moves: tracked time moved with the branch');
  assert.equal(timeConfidence({ trackedMs: 1000, adjustedMs: 0, manualMs: 1000, timeLogMs: 0, reassignments: 1 }).note, '1 branch move: tracked time moved with the branch');
  assert.equal(timeConfidence({ trackedMs: 0, adjustedMs: 0, manualMs: 0, timeLogMs: 500 }).level, 'manual');
  assert.equal(linesConfidence({ trackedLines: 0, inferredLines: 50, manualLines: 0 }).level, 'estimated');
});

test('derived figures inherit the level of their inputs', () => {
  assert.equal(inheritLevel('none', 'none'), 'none');
  assert.equal(inheritLevel('exact', 'none', 'exact'), 'exact');
  assert.equal(inheritLevel('exact', 'manual'), 'mixed');
  const exact = confidenceOf([part(1, 'measured')]);
  const manual = confidenceOf([part(1, 'manual')]);
  const d = derivedConfidence([{ label: 'Time', conf: exact }, { label: 'Credits', conf: manual }, { label: 'X', conf: confidenceOf([]) }]);
  assert.equal(d.level, 'mixed');
  assert.equal(d.measuredShare, 0.5);
  assert.deepEqual(d.inputs, [{ label: 'Time', level: 'exact' }, { label: 'Credits', level: 'manual' }]);
});

test('credit overview breakdowns carry a confidence split', () => {
  const now = new Date(2026, 9, 7, 12).getTime();
  const o = buildCreditOverview([
    { ts: now - 1000, credits: 8, model: 'm', source: 'auto', exact: true },
    { ts: now - 2000, credits: 2, model: 'm', source: 'manual' }
  ], { now, monthlyBudget: 0, renewalDay: 1 });
  const b = o.breakdown['30'];
  assert.deepEqual(b.byConfidence, { exact: 8, partial: 0, estimated: 0, manual: 2 });
  assert.equal(b.confidence.level, 'mixed');
  assert.equal(b.confidence.total, 10);
});

test('work item, project and global confidence come from the stored data', t => {
  const db = tempDb(t);
  db.upsertProject({ id: 'p1', name: 'P' });
  db.upsertWorkItem('100', { title: 'Feature', projectId: 'p1' });
  db.reassignBranchToWorkItem('feature/a', '100');
  db.recordTime('feature/a', 'humanCoding', 60000);
  db.recordEffectiveLines('feature/a', 'src/a.ts', 'ai', 20);

  let s = db.getWorkItemSummary('100');
  assert.equal(s.confidence.time.level, 'exact');
  assert.equal(s.confidence.time.note, '1 branch move: tracked time moved with the branch');
  assert.equal(s.confidence.lines.level, 'exact');
  assert.equal(s.confidence.credits.level, 'none');
  assert.equal(s.confidence.roi.level, 'exact');

  db.recordCredits('feature/a', 'gpt', 3, 'typed');
  db.addManualEffort({ workItemId: '100', mode: 'humanCoding', durationMs: 60000, linesAdded: 20 });
  db.addTimeEntry({ workItemId: '100', durationMs: 30000, source: 'manual' });
  db.setTimeAdjustment('feature/a', 'humanCoding', -10000);

  s = db.getWorkItemSummary('100');
  assert.equal(s.confidence.credits.level, 'manual');
  const time = Object.fromEntries(s.confidence.time.parts.map(p => [p.key, p.value]));
  assert.deepEqual(time, { tracked: 50000, adjusted: 10000, manual: 60000, timeLog: 30000 });
  assert.equal(s.confidence.time.level, 'mixed');
  assert.equal(s.confidence.lines.level, 'mixed');
  assert.equal(s.confidence.roi.level, 'mixed');

  const totals = db.getCredits();
  assert.equal(totals.byConfidence.manual, 3);

  db.upsertProject({ id: 'p1', name: 'P' });
  db.upsertWorkItem('100', { projectId: 'p1' });
  const p = db.getProjectSummary('p1');
  assert.equal(p.confidence.credits.level, 'manual');
  assert.equal(p.confidence.time.level, 'mixed');
  assert.equal(p.confidence.time.note, '1 branch move: tracked time moved with the branch');

  const g = db.getConfidence();
  assert.equal(g.credits.level, 'manual');
  assert.equal(g.time.level, 'mixed');
  assert.ok(g.lines.total >= 40);
});

test('branches with only raw line churn count their lines as inferred', t => {
  const db = tempDb(t);
  db.reassignBranchToWorkItem('old', '7');
  db.recordLineChange('old', '.ts', 'human', 12, 0, 'src/x.ts');
  const lines = db.getWorkItemSummary('7').confidence.lines;
  assert.equal(lines.level, 'estimated');
  assert.equal(lines.parts[0].key, 'inferred');
});
