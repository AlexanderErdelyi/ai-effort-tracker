const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
const disposable = () => ({ dispose() {} });
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeTextDocument: disposable },
    window: {
      showWarningMessage() {},
      state: { focused: true },
      onDidChangeWindowState: disposable,
      onDidChangeTextEditorSelection: disposable,
      onDidChangeTextEditorVisibleRanges: disposable,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeTextEditorViewColumn: disposable,
      onDidChangeActiveTerminal: disposable,
      onDidOpenTerminal: disposable
    }
  };
  return load.call(this, name, ...args);
};
const { TimeTracker } = require('../out/trackers/timeTracker');
const { GitTracker } = require('../out/trackers/gitTracker');
const { Database } = require('../out/store/database');

function fixture(t) {
  let now = 1000000;
  const realNow = Date.now;
  Date.now = () => now;
  const totals = new Map(), focus = [], checkpoints = [];
  const db = {
    recordTime(branch, mode, ms) {
      const counts = totals.get(branch) ?? {};
      counts[mode] = (counts[mode] ?? 0) + ms;
      totals.set(branch, counts);
    },
    recordFocusSession(branch, ms, humanMs, aiMs) { focus.push({ branch, ms, humanMs, aiMs }); },
    getTodayActiveMs: () => 0,
    flush: async () => { checkpoints.push(JSON.parse(JSON.stringify([...totals]))); }
  };
  const tracker = new TimeTracker(db, { update() {}, updateToday() {} });
  t.after(() => { tracker.dispose(); Date.now = realNow; });
  return { tracker, totals, focus, checkpoints, advance: ms => { now += ms; } };
}

test('A -> B -> A preserves the full hour and settles partial ticks on the old branch', t => {
  const { tracker, totals, focus, checkpoints, advance } = fixture(t);
  tracker.setBranch('branch-a');
  tracker.startTracking();
  for (let i = 0; i < 3600; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
  }
  advance(500);
  tracker.setBranch('branch-b');
  const a = () => Object.values(totals.get('branch-a')).reduce((n, ms) => n + ms, 0);
  assert.equal(a(), 3600500);
  assert.equal(focus.length, 1);
  assert.equal(focus[0].branch, 'branch-a');
  assert.equal(focus[0].ms, 3600500);
  assert.equal(checkpoints.at(-1).find(([b]) => b === 'branch-a')[1].humanCoding, 3599500);
  for (let i = 0; i < 1500; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
  }
  tracker.setBranch('branch-a');
  assert.equal(a(), 3600500, 'returning to a branch must not reset its tracked time');
  assert.equal(focus[1].branch, 'branch-b');
  assert.equal(focus[1].ms, 1500000);
  advance(500);
  tracker.tick();
  assert.equal(a(), 3601000);
});

test('same branch polls do not split focus or trigger checkpoints', t => {
  const { tracker, checkpoints, focus, advance } = fixture(t);
  tracker.setBranch('branch-a');
  tracker.startTracking();
  for (let i = 0; i < 65; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
    tracker.setBranch('branch-a');
  }
  assert.equal(checkpoints.length, 1);
  assert.equal(focus.length, 0);
  tracker.stopTracking();
  assert.equal(focus.length, 1);
  assert.equal(focus[0].branch, 'branch-a');
});

test('switching after a sleep gap never fabricates time or moves the prior focus streak', t => {
  const { tracker, totals, focus, advance } = fixture(t);
  tracker.setBranch('branch-a');
  tracker.startTracking();
  for (let i = 0; i < 65; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
  }
  advance(3600000);
  tracker.setBranch('branch-b');
  assert.equal(Object.values(totals.get('branch-a')).reduce((n, ms) => n + ms, 0), 65000);
  assert.equal(focus.length, 1);
  assert.equal(focus[0].branch, 'branch-a');
  assert.equal(totals.has('branch-b'), false);
});

test('branch changes while stopped do not accrue time', t => {
  const { tracker, totals, advance } = fixture(t);
  tracker.setBranch('branch-a');
  advance(2000);
  tracker.setBranch('branch-b');
  assert.equal(totals.size, 0);
  tracker.startTracking();
  advance(500);
  tracker.stopTracking();
  assert.equal(totals.get('branch-b').reviewing, 500);
  advance(2000);
  tracker.setBranch('branch-a');
  assert.equal(totals.has('branch-a'), false);
  assert.equal(totals.get('branch-b').reviewing, 500);
});

test('one hour on the reported branch survives switching and reopening the real store', async t => {
  const { tracker, advance } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-branch-switch-'));
  const db = new Database(dir);
  tracker.db = db;
  t.after(() => {
    tracker.stopTracking();
    db.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const branch = 'feature/#1987-role-center-enforcement';
  tracker.setBranch(branch);
  tracker.startTracking();
  for (let i = 0; i < 3600; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
  }
  tracker.setBranch('another-branch');
  for (let i = 0; i < 1500; i++) {
    tracker.markEdit('human');
    advance(1000);
    tracker.tick();
  }
  tracker.setBranch(branch);
  tracker.stopTracking();
  await db.flush();
  const restarted = new Database(dir);
  assert.equal(restarted.getSummaryForBranch(branch).roi.actualHours, 1);
  assert.equal(restarted.getSummaryForBranch('another-branch').roi.actualHours, 25 / 60);
  restarted.flushSync();
});

test('branch refresh does not overlap asynchronous git lookups or apply after disposal', async t => {
  const original = GitTracker.getCurrentBranch;
  t.after(() => { GitTracker.getCurrentBranch = original; });
  let resolve, calls = 0, branch = 'a';
  const assignments = [];
  GitTracker.getCurrentBranch = () => {
    calls++;
    return new Promise(r => { resolve = r; });
  };
  const tracker = new GitTracker({ setWorkItemForBranch: (...args) => assignments.push(args) }, {
    getBranch: () => branch, setBranch: b => { branch = b; }
  });
  const first = tracker.refreshBranch();
  await tracker.refreshBranch();
  assert.equal(calls, 1);
  resolve('feature/123-work');
  await first;
  assert.equal(branch, 'feature/123-work');
  assert.deepEqual(assignments, [['feature/123-work', '123']]);
  const second = tracker.refreshBranch();
  tracker.dispose();
  resolve('b');
  await second;
  assert.equal(branch, 'feature/123-work');
});
