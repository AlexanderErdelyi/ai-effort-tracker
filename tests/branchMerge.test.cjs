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
const { caseVariantBranchGroups } = require('../out/util/branchKey');
const { checkDataHealth } = require('../out/analysis/dataHealth');

const openDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-branch-merge-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};
const clone = o => JSON.parse(JSON.stringify(o));
const zeros = () => new Array(24).fill(0);
const at = (d, h = 0) => new Date(2025, 0, d, h).getTime();

function bucket(hour, ms, lines) {
  const b = { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0, linesHuman: lines, linesAi: 0, linesAiTranslation: 0, hours: zeros(),
    hoursByMode: { humanCoding: zeros(), aiGenerating: zeros(), reviewing: zeros() } };
  b.hours[hour] = ms; b.hoursByMode.humanCoding[hour] = ms;
  return b;
}
const branch = (workItemId, day, ms, lines, extra = {}) => ({
  workItemId, time: { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0 }, copilotAcceptances: 1,
  lineChanges: { '.al': { human: { added: lines, deleted: 0 }, ai: { added: 0, deleted: 0 } } },
  daily: { [`2025-01-0${day}`]: bucket(10, ms, lines) }, ...extra
});

/** `UAT-Integration` (big, WI 7) and `UAT-integration` (small, no work item, adjustment and credit log). */
function seed(db) {
  db.store['UAT-Integration'] = branch(null, 1, 9000, 90);
  db.store['UAT-integration'] = branch('7', 2, 1000, 10, {
    timeAdjustment: { humanCoding: -500 },
    creditsLog: [{ ts: at(2, 10), model: 'm', credits: 2 }]
  });
  db.workItems['7'] = { id: '7', title: 'Seven', projectId: null, estimate: null, externalRef: null, createdAt: 0 };
  db.creditLedger.push(
    { id: 'L1', ts: at(1, 10), model: 'm', credits: 1, source: 'auto', branch: 'UAT-Integration', workItemId: null, projectId: null },
    { id: 'L2', ts: at(2, 10), model: 'm', credits: 3, source: 'auto', branch: 'UAT-integration', workItemId: '7', projectId: null }
  );
  db.timeEntries.push({ id: 'T1', startTs: at(2, 11), durationMs: 600_000, source: 'manual', createdAt: at(2, 12), branch: 'UAT-integration', workItemId: '7' });
}
const active = b => b.time.humanCoding + b.time.aiGenerating + b.time.reviewing;

test('merging moves everything, removes the source and adopts its work item (#159)', t => {
  const db = openDb(t); seed(db);
  const before = active(db.store['UAT-Integration']) + active(db.store['UAT-integration']);
  const preview = db.previewBranchMerge('UAT-integration', 'UAT-Integration');
  assert.equal(preview.activeMs, 1000);
  assert.equal(preview.ledgerRows, 1);

  const rec = db.mergeBranches('UAT-integration', 'UAT-Integration');
  assert.equal(rec.kind, 'merge');
  assert.equal(rec.toBranch, 'UAT-Integration');
  const dst = db.store['UAT-Integration'];
  assert.equal(active(dst), before);
  assert.equal(dst.lineChanges['.al'].human.added, 100);
  assert.deepEqual(Object.keys(dst.daily).sort(), ['2025-01-01', '2025-01-02']);
  assert.equal(dst.workItemId, '7', 'the target had no work item and adopts the source one');
  assert.deepEqual(dst.timeAdjustment, { humanCoding: -500 });
  assert.equal(dst.creditsLog.length, 1);
  assert.equal(db.store['UAT-integration'].movedTo, 'UAT-Integration');
  assert.ok(!db.getAllBranches().includes('UAT-integration'));
  assert.ok(db.creditLedger.every(e => e.branch === 'UAT-Integration'));
  assert.equal(db.timeEntries[0].branch, 'UAT-Integration');
  assert.deepEqual(db.getCaseVariantBranches(), []);
  assert.equal(db.getEntryMoves()[0].id, rec.id);
  // Late writes under the old name land on the target.
  assert.equal(db.canonicalBranchKey('UAT-integration'), 'UAT-Integration');
});

test('undoing a merge restores both branches exactly (#159)', t => {
  const db = openDb(t); seed(db);
  const snapshot = clone({ a: db.store['UAT-Integration'], b: db.store['UAT-integration'], l: db.creditLedger, te: db.timeEntries });
  const rec = db.mergeBranches('UAT-integration', 'UAT-Integration');
  const undo = db.undoEntryMove(rec.id);
  assert.equal(undo.kind, 'move-undo');
  assert.equal(undo.undoOf, rec.id);
  const a = db.store['UAT-Integration'], b = db.store['UAT-integration'];
  assert.equal(b.movedTo, undefined);
  assert.equal(a.workItemId, null);
  assert.equal(b.workItemId, '7');
  assert.equal(active(a), active(snapshot.a));
  assert.equal(active(b), active(snapshot.b));
  assert.equal(a.timeAdjustment, undefined);
  assert.deepEqual(b.timeAdjustment, { humanCoding: -500 });
  assert.equal(a.creditsLog, undefined);
  assert.deepEqual(b.creditsLog, snapshot.b.creditsLog);
  assert.deepEqual(db.creditLedger.map(e => [e.id, e.branch, e.workItemId]), snapshot.l.map(e => [e.id, e.branch, e.workItemId]));
  assert.equal(db.timeEntries[0].branch, 'UAT-integration');
  assert.ok(db.getAllBranches().includes('UAT-integration'));
  assert.equal(db.undoEntryMove(rec.id), undefined, 'a merge is undone only once');
  assert.ok(db.getEntryMoves().find(m => m.id === rec.id).undone);
});

test('a target with its own work item keeps it (#159)', t => {
  const db = openDb(t); seed(db);
  db.store['UAT-Integration'].workItemId = '9';
  db.mergeBranches('UAT-integration', 'UAT-Integration');
  assert.equal(db.store['UAT-Integration'].workItemId, '9');
  assert.equal(db.creditLedger.find(e => e.id === 'L2').workItemId, '9', 'moved rows take the target work item');
});

test('case variants are grouped per repository only (#159)', () => {
  assert.deepEqual(caseVariantBranchGroups(['UAT-Integration', 'UAT-integration', 'main']), [['UAT-Integration', 'UAT-integration']]);
  assert.deepEqual(caseVariantBranchGroups(['r1::main', 'r2::main', 'r1::Main']), [['r1::Main', 'r1::main']]);
  assert.deepEqual(caseVariantBranchGroups(['r1::main', 'r2::Main']), [], 'different repositories are never flagged');
  assert.deepEqual(caseVariantBranchGroups(['r1::main', 'Main']), [], 'a repo branch and a legacy branch are not grouped');
});

test('data health flags case variants and offers Merge into the bigger one (#159)', () => {
  const b = (ms) => ({ workItemId: '1', time: { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0 }, daily: {} });
  const data = {
    branches: { 'r::Feature': b(9000), 'r::feature': b(1000), 'q::feature': b(1000), 'r::old': { ...b(5), movedTo: 'r::Old' }, 'r::Old': b(5) },
    workItems: { 1: { id: '1', title: 'x', projectId: 'p1', estimate: 1, externalRef: null, createdAt: 0 } },
    projects: { p1: { id: 'p1', name: 'P', repos: [], createdAt: 0 } },
    creditLedger: [], timeEntries: [], modelPrices: {}
  };
  const env = { schemaVersion: 13, expectedSchemaVersion: 13, file: { sizeBytes: 1, hasBackup: true, historyCount: 1 }, rates: {} };
  const c = checkDataHealth(data, env).checks.find(x => x.id === 'case-variant-branches');
  assert.equal(c.count, 1, 'tombstones and other repositories are ignored');
  assert.deepEqual(c.examples[0].action, { label: 'Merge', command: 'mergeBranches', arg: 'r::feature' });
});

test('canonicalBranchKey adopts an existing casing only when asked (#159)', t => {
  const db = openDb(t);
  db.store['r::Feature/1'] = branch('1', 1, 10, 1);
  assert.equal(db.canonicalBranchKey('r::feature/1', true), 'r::Feature/1');
  assert.equal(db.canonicalBranchKey('r::feature/1', false), 'r::feature/1');
  assert.equal(db.canonicalBranchKey('q::feature/1', true), 'q::feature/1', 'another repository is not adopted');
  assert.equal(db.canonicalBranchKey('r::Feature/1', true), 'r::Feature/1');
});

test('sanitizeReassignments keeps merge records and their payload (#159)', t => {
  const db = openDb(t); seed(db);
  const rec = db.mergeBranches('UAT-integration', 'UAT-Integration');
  const [back] = sanitizeReassignments(clone([rec]));
  assert.equal(back.kind, 'merge');
  assert.deepEqual(back.merge, rec.merge);
  assert.deepEqual(back.move.delta, rec.move.delta);
});
