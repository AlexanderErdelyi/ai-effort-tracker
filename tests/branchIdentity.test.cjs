const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const K = require('../out/util/branchKey');
const { Database, migrateStore, moveBranchKey } = require('../out/store/database');
const { mergeStores } = require('../out/store/mergeStore');
const { rollupCoverage } = require('../out/analysis/review');

const openDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-branch-id-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};

test('branch keys split at the last :: and keep Windows paths intact (#154)', () => {
  assert.equal(K.branchKey('github.com/o/app', 'main'), 'github.com/o/app::main');
  assert.equal(K.branchKey(null, 'main'), 'main');
  assert.deepEqual(K.parseBranchKey('C:\\src\\app::feature/x'), { repoId: 'C:\\src\\app', name: 'feature/x' });
  assert.deepEqual(K.parseBranchKey('main'), { repoId: null, name: 'main' });
  assert.equal(K.branchNameOf('a::b::main'), 'main');
  assert.equal(K.repoLabel('github.com/o/app'), 'app');
  assert.equal(K.repoLabel('C:\\src\\app\\'), 'app');
  assert.equal(K.branchLabel('github.com/o/app::main'), 'main (app)');
  assert.equal(K.branchLabel('main'), 'main');
});

test('filters: a key matches exactly, a plain name matches every repo (#154)', () => {
  assert.equal(K.branchMatches('r1::main', 'r1::main'), true);
  assert.equal(K.branchMatches('r1::main', 'r2::main'), false);
  assert.equal(K.branchMatches('r1::main', 'main'), true);
  assert.equal(K.branchMatches('main', 'main'), true);
  assert.equal(K.branchMatches(null, 'main'), false);
  assert.equal(K.refsInclude(['main'], 'r1', 'main'), true);
  assert.equal(K.refsInclude(['r1::main'], 'r1', 'main'), true);
  assert.equal(K.refsInclude(['r2::main'], 'r1', 'main'), false);
});

test('resolveBranchRef prefers exact, then the preferred repo, then a unique match (#154)', () => {
  const keys = ['r1::main', 'r2::main', 'r1::dev', 'legacy'];
  assert.equal(K.resolveBranchRef('r2::main', keys), 'r2::main');
  assert.equal(K.resolveBranchRef('main', keys, 'r2'), 'r2::main');
  assert.equal(K.resolveBranchRef('main', keys), undefined, 'ambiguous');
  assert.equal(K.resolveBranchRef('dev', keys), 'r1::dev');
  assert.equal(K.resolveBranchRef('legacy', keys), 'legacy');
  assert.equal(K.resolveBranchRef('r3::main', keys), undefined);
});

test('pickRepoFolder follows the active file in a multi-root workspace (#154)', () => {
  const folders = ['C:\\src\\app', 'C:\\src\\app\\sub', 'D:/other'];
  assert.equal(K.pickRepoFolder('c:/SRC/app/sub/x.al', folders), 'C:\\src\\app\\sub', 'deepest, case-insensitive');
  assert.equal(K.pickRepoFolder('C:\\src\\app\\y.al', folders), 'C:\\src\\app');
  assert.equal(K.pickRepoFolder('D:\\other\\z.md', folders), 'D:/other');
  assert.equal(K.pickRepoFolder('C:\\src\\application\\a', folders, 'D:/other'), 'D:/other', 'prefix is not containment');
  assert.equal(K.pickRepoFolder(undefined, folders, 'gone'), 'C:\\src\\app');
  assert.equal(K.pickRepoFolder(undefined, []), undefined);
});

test('Database: main in two repositories stays two branches (#154)', t => {
  const db = openDb(t);
  db.recordTime('github.com/o/a::main', 'humanCoding', 1000);
  db.recordTime('github.com/o/b::main', 'humanCoding', 5000);
  const all = db.getAllBranches().sort();
  assert.deepEqual(all, ['github.com/o/a::main', 'github.com/o/b::main']);
  const a = db.getSummaryForBranch('github.com/o/a::main');
  assert.deepEqual([a.repoId, a.name, a.humanCodingMs], ['github.com/o/a', 'main', 1000]);
  db.flushSync();
});

test('Database: assigning legacy branches folds totals and repoints rows (#154)', t => {
  const db = openDb(t);
  const repo = 'github.com/o/a', key = `${repo}::main`;
  db.recordTime('main', 'humanCoding', 1000);
  db.recordLineChange('main', '.al', 'ai', 10, 2);
  db.recordCredits('main', 'm', 3);
  db.addTimeEntry({ branch: 'main', durationMs: 60000, source: 'manual' });
  db.recordTime(key, 'humanCoding', 500);
  db.recordLineChange(key, '.al', 'ai', 5, 0);
  db.recordTime('feature/x', 'reviewing', 200);
  assert.deepEqual(db.getLegacyBranches(), ['feature/x', 'main']);

  assert.equal(db.assignBranchesToRepo(['main'], repo), 1);
  assert.deepEqual(db.getLegacyBranches(), ['feature/x']);
  assert.ok(!db.getAllBranches().includes('main'), 'tombstone hidden');
  const s = db.getSummaryForBranch(key);
  assert.equal(s.humanCodingMs, 1500 + 60000, 'tracked time of both plus the moved manual entry');
  assert.equal(s.linesAiAdded, 15);
  assert.ok(db.creditLedger.every(e => e.branch !== 'main'));
  assert.ok(db.timeEntries.every(e => e.branch !== 'main'));
  assert.equal(db.resolveBranch('main', repo), key);

  db.recordTime('main', 'humanCoding', 100);
  assert.equal(db.getSummaryForBranch(key).humanCodingMs, 1600 + 60000, 'writes to a moved key are redirected');
  assert.equal(db.assignBranchesToRepo(['main'], repo), 0, 'already moved');
  db.flushSync();
});

const branch = (ms = 0) => ({ time: { humanCoding: ms, aiGenerating: 0, reviewing: 0, idle: 0 }, lineChanges: {}, copilotAcceptances: 0 });
const baseStore = branches => migrateStore({ schemaVersion: 13, branches, workItems: {}, creditLedger: [], projects: {}, manualEffort: [], reassignments: [], timeEntries: [] });
const clone = o => JSON.parse(JSON.stringify(o));

test('a stale window writing to a moved branch is folded on the next load (#154)', () => {
  const base = baseStore({ main: branch(100) });
  const disk = clone(base);
  moveBranchKey(disk, 'main', 'r::main');
  const local = clone(base);
  local.branches.main.time.humanCoding += 50;
  const merged = migrateStore(clone(mergeStores(base, local, disk)));
  assert.equal(merged.branches['r::main'].time.humanCoding, 150);
  assert.equal(merged.branches.main.time.humanCoding, 0);
  assert.equal(merged.branches.main.movedTo, 'r::main');
});

test('two windows folding the same branch do not double count (#154)', () => {
  const base = baseStore({ main: branch(100) });
  const disk = clone(base); moveBranchKey(disk, 'main', 'r::main');
  const local = clone(base); moveBranchKey(local, 'main', 'r::main');
  const merged = migrateStore(clone(mergeStores(base, local, disk)));
  assert.equal(merged.branches['r::main'].time.humanCoding, 100);
  assert.equal(merged.branches.main.time.humanCoding, 0);
});

test('review rollup accepts a branch key or a plain name (#154)', () => {
  const cov = n => ({ total: n, reviewed: 0, issueLines: 0, issues: [], files: [{ path: `f${n}`, total: n, reviewed: 0, issueLines: 0 }], at: n });
  const store = { repos: { r1: { coverage: { main: cov(10) } }, r2: { coverage: { main: cov(20) } } } };
  assert.equal(rollupCoverage(store, ['r1::main']).branches.length, 1);
  assert.equal(rollupCoverage(store, ['r2::main']).branches[0].repo, 'r2');
  assert.equal(rollupCoverage(store, ['main']).branches.length, 2);
  assert.equal(rollupCoverage(store, ['r3::main']), null);
});
