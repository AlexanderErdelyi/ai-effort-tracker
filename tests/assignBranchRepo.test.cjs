const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const { Database, sanitizeReassignments } = require('../out/store/database');

const REPO = 'github.com/acme/app';
const KEY = `${REPO}::main`;

const openDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-assign-repo-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};
const zeros = () => new Array(24).fill(0);
const at = (d, h = 0) => new Date(2025, 0, d, h).getTime();
function bucket(hour, ms, lines) {
  const b = { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0, linesHuman: lines, linesAi: 0, linesAiTranslation: 0, hours: zeros(),
    hoursByMode: { humanCoding: zeros(), aiGenerating: zeros(), reviewing: zeros() } };
  b.hours[hour] = ms; b.hoursByMode.humanCoding[hour] = ms;
  return b;
}
const branch = (workItemId, day, ms, lines) => ({
  workItemId, time: { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0 }, copilotAcceptances: 1,
  lineChanges: { al: { human: { added: lines, deleted: 0 }, ai: { added: 0, deleted: 0 } } },
  daily: { [`2025-01-0${day}`]: bucket(10, ms, lines) }
});
function seed(db) {
  db.store['main'] = branch('7', 1, 4000, 40);
  db.store['feature'] = branch(null, 2, 1000, 10);
  db.creditLedger.push({ id: 'L1', ts: at(1, 10), model: 'm', credits: 2, source: 'auto', branch: 'main', workItemId: '7', projectId: null });
  db.timeEntries.push({ id: 'T1', startTs: at(1, 11), durationMs: 600_000, source: 'manual', createdAt: at(1, 12), branch: 'main', workItemId: '7' });
}

test('a single legacy branch is assigned to a new repository branch (#164)', t => {
  const db = openDb(t); seed(db);
  const plan = db.previewAssignBranchToRepo('main', REPO);
  assert.deepEqual({ target: plan.target, exists: plan.exists, active: plan.stats.activeMs, rows: plan.stats.ledgerRows }, { target: KEY, exists: false, active: 4000, rows: 1 });
  const rec = db.assignBranchToRepo('main', REPO);
  assert.equal(rec.kind, 'merge');
  assert.equal(rec.merge.createdTarget, true);
  const dst = db.store[KEY];
  assert.equal(dst.time.humanCoding, 4000);
  assert.equal(dst.lineChanges.al.human.added, 40);
  assert.equal(dst.workItemId, '7');
  assert.equal(db.store['main'].movedTo, KEY);
  assert.deepEqual(db.getLegacyBranches(), ['feature'], 'only the chosen branch moves');
  assert.equal(db.creditLedger[0].branch, KEY);
  assert.equal(db.timeEntries[0].branch, KEY);
});

test('undo brings the legacy branch back and drops the created repository branch (#164)', t => {
  const db = openDb(t); seed(db);
  const rec = db.assignBranchToRepo('main', REPO);
  assert.equal(db.undoEntryMove(rec.id).kind, 'move-undo');
  assert.equal(db.store[KEY], undefined, 'the empty target created by the assignment is removed');
  assert.equal(db.store['main'].movedTo, undefined);
  assert.equal(db.store['main'].time.humanCoding, 4000);
  assert.equal(db.store['main'].workItemId, '7');
  assert.equal(db.creditLedger[0].branch, 'main');
  assert.equal(db.timeEntries[0].branch, 'main');
  assert.deepEqual(db.getLegacyBranches(), ['feature', 'main']);
});

test('assigning onto an existing repository branch adds to it and undo keeps it (#164)', t => {
  const db = openDb(t); seed(db);
  db.store[KEY] = branch(null, 3, 2000, 20);
  const plan = db.previewAssignBranchToRepo('main', REPO);
  assert.equal(plan.exists, true);
  const rec = db.assignBranchToRepo('main', REPO);
  assert.equal(rec.merge.createdTarget, undefined);
  assert.equal(db.store[KEY].time.humanCoding, 6000);
  assert.equal(db.store[KEY].workItemId, '7', 'a target without a work item adopts it');
  db.undoEntryMove(rec.id);
  assert.equal(db.store[KEY].time.humanCoding, 2000, 'the pre-existing branch stays');
  assert.equal(db.store[KEY].workItemId, null);
  assert.equal(db.store['main'].time.humanCoding, 4000);
});

test('undo keeps a created branch that received new activity (#164)', t => {
  const db = openDb(t); seed(db);
  const rec = db.assignBranchToRepo('main', REPO);
  db.store[KEY].daily['2025-01-05'] = bucket(9, 500, 5);
  db.store[KEY].time.humanCoding += 500;
  db.undoEntryMove(rec.id);
  assert.ok(db.store[KEY], 'later activity keeps the repository branch');
  assert.equal(db.store[KEY].time.humanCoding, 500);
});

test('repository branches, reserved buckets and bad repositories are refused (#164)', t => {
  const db = openDb(t); seed(db);
  db.store[KEY] = branch(null, 3, 2000, 20);
  db.store['unknown'] = branch(null, 4, 100, 1);
  assert.equal(db.assignBranchToRepo(KEY, 'github.com/acme/other'), undefined, 'a repository branch keeps its repository');
  assert.equal(db.assignBranchToRepo('unknown', REPO), undefined);
  assert.equal(db.assignBranchToRepo('missing', REPO), undefined);
  assert.equal(db.assignBranchToRepo('main', ''), undefined);
  assert.equal(db.assignBranchToRepo('main', '__legacy__'), undefined);
  assert.equal(db.assignBranchToRepo('main', KEY), undefined, 'a branch key is not a repository');
  assert.equal(db.store['main'].movedTo, undefined);
});

test('sanitizeReassignments keeps createdTarget and line recount ids (#164)', () => {
  const [r] = sanitizeReassignments([{ id: 'x', ts: 1, branch: 'main', toBranch: KEY, kind: 'merge', fromWorkItemId: null, toWorkItemId: '7',
    move: { delta: {}, ledger: [], timeEntries: [] },
    merge: { source: { workItemId: '7', manual: false }, target: { workItemId: null, manual: false }, createdTarget: true, lineCleanups: ['c1', 3] } }]);
  assert.equal(r.merge.createdTarget, true);
  assert.deepEqual(r.merge.lineCleanups, ['c1']);
});
