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
const { Database } = require('../out/store/database');
const { branchKey } = require('../out/util/branchKey');

function tempDb(t) {
  const dir = path.join(__dirname, `.projectPeriod-${randomUUID()}`);
  fs.mkdirSync(dir);
  const db = new Database(dir);
  t.after(() => {
    if (db.saveTimer) clearTimeout(db.saveTimer);
    if (db.refreshTimer) clearInterval(db.refreshTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const DAY = 86400000;
const NOW = Date.now();
const midnight = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const OLD = midnight(NOW) - 40 * DAY + 10 * 3600000;
const RECENT = midnight(NOW) - 2 * DAY + 10 * 3600000;
const LAST7 = { from: midnight(NOW) - 6 * DAY };

function at(ts, fn) {
  const real = Date.now;
  Date.now = () => ts;
  try { fn(); } finally { Date.now = real; }
}

const A = 'github.com/o/a', B = 'github.com/o/b';
const XA = branchKey(A, 'feature/x'), XB = branchKey(B, 'feature/x'), YA = branchKey(A, 'feature/y');

function seed(db) {
  db.upsertProject({ id: 'p1', name: 'P' });
  db.linkRepoToProject('p1', A);
  db.linkRepoToProject('p1', B);
  db.upsertWorkItem('100', { title: 'X', projectId: 'p1' });
  db.upsertWorkItem('200', { title: 'Y', projectId: 'p1' });
  db.reassignBranchToWorkItem(XA, '100');
  db.reassignBranchToWorkItem(XB, '100');
  db.reassignBranchToWorkItem(YA, '200');
  at(OLD, () => {
    db.recordTime(XA, 'humanCoding', 600000);
    db.recordLineChange(XA, '.ts', 'human', 10, 0, 'src/a.ts');
    db.recordCredits(XA, 'gpt', 5);
    db.recordTime(YA, 'aiGenerating', 300000);
  });
  at(RECENT, () => {
    db.recordTime(XA, 'reviewing', 120000);
    db.recordTime(XB, 'humanCoding', 60000);
    db.recordLineChange(XB, '.ts', 'ai', 30, 0, 'src/b.ts');
    db.recordCredits(XB, 'gpt', 2);
    db.recordTime(YA, 'humanCoding', 240000);
    db.recordCredits(YA, 'gpt', 1.5);
  });
  db.addManualEffort({ workItemId: '200', ts: RECENT, mode: 'humanCoding', durationMs: 30000, linesAdded: 4 });
  db.addManualEffort({ workItemId: '200', ts: OLD, mode: 'humanCoding', durationMs: 90000 });
  db.addTimeEntry({ projectId: 'p1', startTs: RECENT, durationMs: 45000, mode: 'humanCoding' });
  db.addTimeEntry({ workItemId: '100', startTs: OLD, durationMs: 15000, mode: 'humanCoding' });
}

const active = f => f.humanCodingMs + f.aiGeneratingMs + f.reviewingMs;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('the last 7 days only count work done in that window', t => {
  const db = tempDb(t);
  seed(db);
  const p = db.getProjectPeriod(LAST7);
  const x = p.workItems['100'], y = p.workItems['200'];
  assert.equal(active(x), 120000 + 60000);
  assert.equal(x.linesAiAdded, 30);
  assert.equal(x.linesHumanAdded, 0);
  near(x.creditsTotal, 2);
  assert.equal(active(y), 240000 + 30000);
  assert.equal(y.linesHumanAdded, 4);
  near(y.creditsTotal, 1.5);

  const pr = p.projects.p1;
  assert.equal(active(pr), active(x) + active(y) + 45000);
  near(pr.creditsTotal, 3.5);
  assert.equal(pr.linesAiAdded + pr.linesHumanAdded, 34);
  assert.equal(pr.roi.currency, 'USD');
});

test('work items add up to the project and repositories split the branches', t => {
  const db = tempDb(t);
  seed(db);
  for (const w of [LAST7, {}]) {
    const p = db.getProjectPeriod(w);
    const items = Object.values(p.workItems);
    const pr = p.projects.p1;
    assert.equal(active(pr), items.reduce((a, f) => a + active(f), 0) + 45000);
    near(pr.creditsTotal, items.reduce((a, f) => a + f.creditsTotal, 0));
    assert.equal(pr.linesHumanAdded, items.reduce((a, f) => a + f.linesHumanAdded, 0));
    const repos = Object.fromEntries(pr.repoBreakdown.map(r => [r.repoId, r]));
    assert.deepEqual(Object.keys(repos).sort(), [A, B]);
    near(pr.repoBreakdown.reduce((a, r) => a + r.credits, 0), pr.creditsTotal);
  }
  const r = Object.fromEntries(db.getProjectPeriod(LAST7).projects.p1.repoBreakdown.map(x => [x.repoId, x]));
  assert.equal(r[A].activeMs, 120000 + 240000);
  assert.equal(r[B].activeMs, 60000);
  assert.equal(r[B].linesAiAdded, 30);
  near(r[A].credits, 1.5);
});

test('an open window matches the all-time project summary', t => {
  const db = tempDb(t);
  seed(db);
  const all = db.getProjectPeriod({}).projects.p1;
  const s = db.getProjectSummary('p1');
  assert.equal(all.humanCodingMs, s.humanCodingMs);
  assert.equal(all.aiGeneratingMs, s.aiGeneratingMs);
  assert.equal(all.reviewingMs, s.reviewingMs);
  near(all.creditsTotal, s.credits.credits);
  for (const id of ['100', '200']) {
    const w = db.getWorkItemSummary(id);
    assert.equal(active(db.getProjectPeriod({}).workItems[id]), w.humanCodingMs + w.aiGeneratingMs + w.reviewingMs);
    near(db.getProjectPeriod({}).workItems[id].creditsTotal, w.creditsTotal);
  }
});

test('a window without activity is all zeros', t => {
  const db = tempDb(t);
  seed(db);
  const p = db.getProjectPeriod({ from: NOW + 10 * DAY, to: NOW + 20 * DAY });
  const pr = p.projects.p1;
  assert.equal(active(pr), 0);
  assert.equal(pr.creditsTotal, 0);
  assert.equal(pr.linesAiAdded + pr.linesHumanAdded, 0);
  assert.ok(pr.repoBreakdown.every(r => r.activeMs === 0 && r.credits === 0));
  assert.equal(active(p.workItems['100']), 0);
});
