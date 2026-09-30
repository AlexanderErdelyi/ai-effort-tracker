const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const Module = require('node:module');
const load = Module._load;
const warnings = [];
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get() {} }) },
    window: { showWarningMessage: message => warnings.push(message) }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { withStoreLock, StoreBusyError } = require('../out/store/persistence');

function fixture(t) {
  const dir = path.join(__dirname, `.persistence-${randomUUID()}`);
  fs.mkdirSync(dir);
  const instances = [];
  t.after(() => {
    for (const db of instances) {
      if (db.saveTimer) clearTimeout(db.saveTimer);
      if (db.refreshTimer) clearInterval(db.refreshTimer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = () => { const db = new Database(dir); instances.push(db); return db; };
  const file = path.join(dir, 'effort-tracker.json');
  return { dir, file, open, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('constructors leave foreign and legacy staging files untouched', t => {
  const { open, file } = fixture(t);
  const staging = [file + '.tmp', file + `.987654-${randomUUID()}.tmp`];
  for (const target of staging) fs.writeFileSync(target, 'writer-owned bytes');
  open(); open();
  for (const target of staging) assert.equal(fs.readFileSync(target, 'utf8'), 'writer-owned bytes');
});

test('two stale windows add only their own time deltas, including new and identical branches', t => {
  const { open, read } = fixture(t);
  const seed = open();
  seed.recordTime('shared', 'humanCoding', 60 * 60000);
  seed.flushSync();
  const a = open(), b = open();
  a.recordTime('shared', 'humanCoding', 10 * 60000);
  b.recordTime('shared', 'humanCoding', 25 * 60000);
  a.recordTime('branch-a', 'aiGenerating', 1000);
  b.recordTime('branch-b', 'reviewing', 2000);
  a.recordTime('new-shared', 'humanCoding', 500);
  b.recordTime('new-shared', 'humanCoding', 500);
  a.flushSync();
  b.flushSync();
  a.recordTime('shared', 'humanCoding', 60000);
  a.flushSync();
  b.recordTime('shared', 'humanCoding', 60000);
  b.flushSync();
  const store = read();
  assert.equal(store.branches.shared.time.humanCoding, 97 * 60000);
  assert.equal(store.branches['new-shared'].time.humanCoding, 1000);
  assert.equal(store.branches['branch-a'].time.aiGenerating, 1000);
  assert.equal(store.branches['branch-b'].time.reviewing, 2000);
  const day = Object.values(store.branches.shared.daily)[0];
  assert.equal(day.humanCoding, 97 * 60000);
  assert.equal(day.hours.reduce((a, b) => a + b), 97 * 60000);
  assert.equal(day.hoursByMode.humanCoding.reduce((a, b) => a + b), 97 * 60000);
  b.flushSync();
  assert.deepEqual(read(), store, 'no duplicate delta when clean');
});

test('tracked line/character counters are additive, metadata is not', t => {
  const { open, read } = fixture(t);
  const a = open(), b = open();
  for (const db of [a, b]) {
    db.recordLineChange('same', 'ts', 'human', 3, 1, 'a.ts');
    db.recordEffectiveLines('same', 'a.ts', 'human', 2);
    db.recordChars('same', 'human', 4);
    db.recordFocusSession('same', 100, 90, 10);
  }
  a.flushSync(); b.flushSync();
  const branch = read().branches.same;
  assert.equal(branch.lineChanges.ts.human.added, 6);
  assert.equal(branch.files['a.ts'].edits, 2);
  assert.equal(branch.files['a.ts'].effectiveHuman, 4);
  assert.equal(branch.effectiveLines.programming.human, 4);
  assert.equal(branch.humanCharsInserted, 8);
  assert.equal(branch.focusSessions.length, 2);
});

test('two stale hosts upgrading effective-line counters do not subtract the old epoch twice', t => {
  const { open, read, file } = fixture(t);
  const seed = open();
  seed.recordTime('branch', 'humanCoding', 100); seed.flushSync();
  const initial = read();
  initial.branches.branch.effectiveLinesVersion = 1;
  initial.branches.branch.effectiveLines = { programming: { human: 1000, ai: 0 } };
  initial.branches.branch.effectiveLegacyBaseline = { programming: { human: 500, ai: 0 } };
  fs.writeFileSync(file, JSON.stringify(initial));
  const a = open(), b = open();
  a.recordEffectiveLines('branch', 'a.ts', 'human', 2);
  b.recordEffectiveLines('branch', 'b.ts', 'human', 3);
  a.flushSync(); b.flushSync();
  assert.equal(read().branches.branch.effectiveLines.programming.human, 5);
  assert.equal(read().branches.branch.effectiveLinesVersion, 2);
});

test('concurrent creation, assignment, metadata edits and ledger attribution survive', t => {
  const { open, read } = fixture(t);
  const a = open(), b = open();
  a.upsertProject({ id: 'project', name: 'Project', settings: { hourlyCostRate: 90 } });
  a.upsertWorkItem('1234', { title: 'Named task', projectId: 'project', estimate: 4 });
  a.reassignBranchToWorkItem('feature/1234-task', '1234');
  b.setWorkItemForBranch('feature/1234-task', '1234');
  b.recordTime('feature/1234-task', 'humanCoding', 100);
  b.recordCredits('feature/1234-task', 'model', 2);
  a.flushSync(); b.flushSync();
  const c = open(), d = open();
  c.upsertWorkItem('1234', { title: 'Renamed' });
  d.upsertWorkItem('1234', { estimate: 8 });
  c.flushSync(); d.flushSync();
  const store = read();
  assert.equal(store.workItems['1234'].title, 'Renamed');
  assert.equal(store.workItems['1234'].estimate, 8);
  assert.equal(store.workItems['1234'].projectId, 'project');
  assert.equal(store.creditLedger[0].projectId, 'project');
  assert.equal(store.branches['feature/1234-task'].workItemIdManual, true);
});

test('manual branch reassignment beats stale auto-detection and includes concurrent credits', t => {
  const { open, read } = fixture(t);
  const seed = open();
  seed.setWorkItemForBranch('feature/1234-task', '1234'); seed.flushSync();
  const a = open(), b = open();
  a.reassignBranchToWorkItem('feature/1234-task', '5678');
  b.setWorkItemForBranch('feature/1234-task', '1234');
  b.recordCredits('feature/1234-task', 'model', 3);
  a.flushSync(); b.flushSync();
  assert.equal(read().branches['feature/1234-task'].workItemId, '5678');
  assert.equal(read().creditLedger[0].workItemId, '5678');
  assert.equal(read().reassignments.length, 1);
});

test('work-item deletion wins against stale edits and detaches concurrently added rows/branches', t => {
  const { open, read } = fixture(t);
  const seed = open();
  seed.setWorkItemForBranch('feature/1234-task', '1234'); seed.flushSync();
  const a = open(), b = open();
  a.deleteWorkItem('1234');
  b.upsertWorkItem('1234', { title: 'Stale edit must not revive' });
  b.setWorkItemForBranch('other', '1234');
  b.recordTime('feature/1234-task', 'humanCoding', 25);
  b.addManualEffort({ workItemId: '1234', durationMs: 100 });
  b.addTimeEntry({ workItemId: '1234', durationMs: 100 });
  b.recordCredits('other', 'model', 1);
  a.flushSync(); b.flushSync();
  const store = read();
  assert.equal(store.workItems['1234'], undefined);
  assert.equal(store.branches.other.workItemId, '__unassigned__');
  assert.equal(store.branches['feature/1234-task'].time.humanCoding, 25);
  for (const row of [...store.creditLedger, ...store.manualEffort, ...store.timeEntries]) {
    assert.equal(row.workItemId, '__unassigned__');
  }
  assert.equal(open().getWorkItem('1234'), undefined, 'migration must not resurrect');
});

test('id-keyed rows merge field edits, independent inserts, clears and delete-wins conflicts', t => {
  const { open, read } = fixture(t);
  const seed = open();
  const time = seed.addTimeEntry({ durationMs: 1000, note: 'old', workItemId: '1234' });
  const manual = seed.addManualEffort({ workItemId: '1234', durationMs: 1000, note: 'old' });
  seed.recordCredits('branch', 'model', 10, 'old');
  const ledger = seed.getCreditEntries()[0];
  seed.flushSync();
  const a = open(), b = open();
  a.updateTimeEntry(time.id, { durationMs: 200 });
  b.updateTimeEntry(time.id, { note: 'new' });
  a.deleteManualEffort(manual.id);
  b.updateManualEffort(manual.id, { durationMs: 2000 });
  a.deleteLedgerEntry(ledger.id);
  b.updateLedgerEntry(ledger.id, { credits: 100 });
  a.addTimeEntry({ durationMs: 50 });
  b.addTimeEntry({ durationMs: 60 });
  a.flushSync(); b.flushSync();
  const store = read();
  assert.equal(store.timeEntries.find(e => e.id === time.id).durationMs, 200);
  assert.equal(store.timeEntries.find(e => e.id === time.id).note, 'new');
  assert.equal(store.timeEntries.length, 3);
  assert.equal(store.manualEffort.length, 0);
  assert.equal(store.creditLedger.length, 0);
  const c = open(), d = open();
  c.deleteTimeEntry(time.id);
  d.updateTimeEntry(time.id, { note: null });
  c.flushSync(); d.flushSync();
  assert.equal(read().timeEntries.some(e => e.id === time.id), false);
});

test('manual overrides are scalar deltas, not maxima or summed snapshots; clears stay cleared', t => {
  const { open, read } = fixture(t);
  const seed = open();
  seed.setWorkItemForBranch('branch', '1234');
  seed.recordTime('branch', 'humanCoding', 3600000);
  seed.setTimeAdjustment('branch', 'humanCoding', -1000);
  seed.setBillableHours('1234', 5); seed.flushSync();
  const a = open(), b = open();
  a.setTimeAdjustment('branch', 'humanCoding', -60000);
  a.setBillableHours('1234', 1);
  b.recordTime('branch', 'humanCoding', 60000);
  a.flushSync(); b.flushSync();
  assert.equal(read().branches.branch.timeAdjustment.humanCoding, -60000);
  assert.equal(read().workItems['1234'].billableHours, 1);
  const c = open(), d = open();
  c.clearTimeAdjustment('branch'); c.setBillableHours('1234', null);
  d.recordTime('branch', 'humanCoding', 60000);
  c.flushSync(); d.flushSync();
  assert.equal(read().branches.branch.timeAdjustment, undefined);
  assert.equal(read().workItems['1234'].billableHours, undefined);
});

test('repo array additions and removals merge rather than restoring stale links', t => {
  const { open, read } = fixture(t);
  const seed = open();
  seed.upsertProject({ id: 'project', repos: ['host/old', 'host/keep'] }); seed.flushSync();
  const a = open(), b = open();
  a.unlinkRepoFromProject('project', 'host/old');
  b.linkRepoToProject('project', 'host/new');
  a.flushSync(); b.flushSync();
  assert.deepEqual(read().projects.project.repos.sort(), ['host/keep', 'host/new']);
});

test('independently captured credits deduplicate by request identity; exact beats estimate', t => {
  const { open, read } = fixture(t);
  const a = open(), b = open();
  a.recordAutoChatUsage('branch', 'model', 3, { requestId: 'same', exact: true });
  b.recordAutoChatUsage('branch', 'model', 15, { requestId: 'same', exact: false });
  a.recordImportedUsage('branch', 'model', 7, { promptId: 'turn' });
  b.recordImportedUsage('branch', 'model', 7, { promptId: 'turn' });
  a.flushSync(); b.flushSync();
  assert.equal(read().creditLedger.length, 2);
  assert.equal(read().creditLedger.find(e => e.note === 'auto:jsonl:same').credits, 3);
  assert.equal(read().branches.branch.autoModelRequests, 1);
});

function debugTurn(ids) {
  return {
    sessionId: 'session', turnId: 'turn', timestamp: 1000, requestAliases: ['alias'],
    requests: ids.map(id => ({ spanId: id, responseId: id, model: 'model', credits: 2, inputTokens: 10, outputTokens: 5 })),
    analysis: { requestsDetail: [], toolCalls: 0 }
  };
}

test('concurrent debug-log spans union and derive charges once; manual charge overrides survive', t => {
  const { open, read } = fixture(t);
  const a = open(), b = open();
  a.recordDebugUsage('branch', debugTurn(['one', 'shared']));
  b.recordDebugUsage('branch', debugTurn(['two', 'shared']));
  a.flushSync(); b.flushSync();
  assert.equal(read().creditLedger.length, 1);
  assert.equal(read().creditLedger[0].credits, 6);
  assert.equal(read().creditLedger[0].debugUsage.requests.length, 3);
  const c = open(), d = open();
  c.updateLedgerEntry(read().creditLedger[0].id, { credits: 1 });
  d.recordDebugUsage('branch', debugTurn(['one', 'two', 'shared', 'three']));
  c.flushSync(); d.flushSync();
  assert.equal(read().creditLedger[0].credits, 1);
  assert.equal(read().creditLedger[0].debugUsage.requests.length, 4);
});

test('concurrent debug/export capture reconciles proven aliases without double charging', t => {
  const { open, read } = fixture(t);
  const a = open(), b = open();
  a.recordDebugUsage('branch', debugTurn(['one', 'two']));
  b.recordImportedUsage('branch', 'model', 4, { promptId: 'alias', responseIds: ['one', 'two'] });
  a.flushSync(); b.flushSync();
  assert.equal(read().creditLedger.length, 1);
  assert.equal(read().creditLedger[0].credits, 4);
});

test('async flush followed immediately by mutation + shutdown cannot publish an old snapshot', async t => {
  const { open, read } = fixture(t);
  const db = open();
  let asynchronousRenames = 0;
  const rename = fs.promises.rename;
  fs.promises.rename = async (...args) => {
    asynchronousRenames++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return rename(...args);
  };
  t.after(() => { fs.promises.rename = rename; });
  db.recordTime('branch', 'humanCoding', 100);
  const pending = db.flushAsync();
  db.recordTime('branch', 'humanCoding', 200);
  db.flushSync();
  await pending;
  assert.equal(read().branches.branch.time.humanCoding, 300);
  assert.equal(asynchronousRenames, 0, 'no I/O continuations may outlive shutdown');
  assert.equal(db.dirty, false);
});

test('public checkpoint is deferred, coalesces requests, and cannot race synchronous shutdown', async t => {
  const { open, read } = fixture(t);
  const db = open();
  db.recordTime('old', 'humanCoding', 100); db.flushSync();
  db.recordTime('old', 'humanCoding', 200);
  const pending = db.flush();
  assert.equal(db.flush(), pending);
  assert.equal(read().branches.old.time.humanCoding, 100, 'caller returns before filesystem commit');
  db.recordTime('new', 'humanCoding', 300);
  db.flushSync();
  await pending;
  assert.equal(read().branches.old.time.humanCoding, 300);
  assert.equal(read().branches.new.time.humanCoding, 300);
});

test('clean public checkpoints refresh disk state without overwriting backups', async t => {
  const { open, file } = fixture(t);
  const seed = open();
  seed.recordTime('branch', 'humanCoding', 100); seed.flushSync();
  const observer = open(), writer = open();
  writer.recordTime('branch', 'humanCoding', 200); writer.flushSync();
  const backup = fs.readFileSync(file + '.bak', 'utf8');
  assert.equal(observer.getRawTime('branch').humanCoding, 100);
  await observer.flush();
  assert.equal(observer.getRawTime('branch').humanCoding, 300);
  assert.equal(observer.dirty, false);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
});

test('idle windows refresh shared totals automatically, and shutdown stops their refresh timer', async t => {
  const { open } = fixture(t);
  const seed = open();
  seed.recordTime('branch', 'humanCoding', 100); seed.flushSync();
  const observer = open(), writer = open();
  writer.recordTime('branch', 'humanCoding', 200); writer.flushSync();
  assert.equal(observer.dirty, false);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(observer.getRawTime('branch').humanCoding, 300);
  observer.flushSync();
  assert.equal(observer.refreshTimer, undefined);
});

test('public fire-and-forget checkpoint handles failures without rejecting and schedules retry', async t => {
  const { open, file, read } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw new Error('injected public checkpoint failure');
    return rename(from, to);
  };
  try {
    await assert.doesNotReject(db.flush());
    assert.equal(db.dirty, true);
    assert.ok(db.saveTimer);
  } finally { fs.renameSync = rename; }
  await db.flush();
  assert.equal(read().branches.branch.time.humanCoding, 100);
});

test('failed atomic rename leaves dirty baseline intact; automatic retry needs no further edits', async t => {
  const { open, read, file } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  db.recordTime('branch', 'humanCoding', 200);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try {
    await db.flushAsync();
    assert.equal(db.dirty, true);
    assert.ok(db.saveTimer);
    assert.equal(read().branches.branch.time.humanCoding, 100);
    assert.ok(warnings.some(w => w.includes('could not save')));
  } finally { fs.renameSync = rename; }
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(read().branches.branch.time.humanCoding, 300);
  assert.equal(db.dirty, false);
});

test('sync failures are explicit, retain unsaved data, and retry without duplicate increments', t => {
  const { open, read, file } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file) throw new Error('injected shutdown failure');
    return rename(from, to);
  };
  try { assert.throws(() => db.flushSync(), /injected shutdown failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(db.dirty, true);
  db.flushSync(); db.flushSync();
  assert.equal(read().branches.branch.time.humanCoding, 100);
});

test('fsync failure is not mistaken for a durable save', t => {
  const { open, read } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  db.recordTime('branch', 'humanCoding', 200);
  const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' }); };
  try { assert.throws(() => db.flushSync(), /injected fsync failure/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(read().branches.branch.time.humanCoding, 100);
  assert.equal(db.dirty, true);
  db.flushSync();
  assert.equal(read().branches.branch.time.humanCoding, 300);
});

test('busy save yields and schedules retry; nested same-process contenders never steal a live lock', async t => {
  const { open, file, read } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100);
  await withStoreLock(file, 0, () => {
    assert.throws(() => withStoreLock(file, 0, () => assert.fail('lock stolen')), StoreBusyError);
    return db.flushAsync();
  });
  assert.equal(db.dirty, true);
  assert.ok(db.saveTimer);
  await db.flush();
  assert.equal(read().branches.branch.time.humanCoding, 100);
});

test('healthy loads never overwrite backup/history; frequent saves retain older recovery snapshots', t => {
  const { open, file, read } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  const backup = fs.readFileSync(file + '.bak', 'utf8');
  const history = fs.readdirSync(file + '.history').map(name => [name, fs.readFileSync(path.join(file + '.history', name), 'utf8')]);
  open();
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
  for (let i = 0; i < 10; i++) { db.recordTime('branch', 'humanCoding', 100); db.flushSync(); }
  assert.equal(read().branches.branch.time.humanCoding, 1200);
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).branches.branch.time.humanCoding, 1100);
  for (const [name, data] of history) assert.equal(fs.readFileSync(path.join(file + '.history', name), 'utf8'), data);
});

test('sampled recovery retention is bounded at 24 hourly and 7 daily copies', t => {
  const { open, file } = fixture(t);
  const db = open();
  const OriginalDate = Date;
  let now = Date.UTC(2026, 0, 1);
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try {
    for (let i = 0; i < 40; i++) {
      now += 8 * 3600000;
      db.recordTime('branch', 'humanCoding', 100); db.flushSync();
    }
  } finally { global.Date = OriginalDate; }
  const names = fs.readdirSync(file + '.history');
  assert.equal(names.filter(n => n.startsWith('hour-')).length, 24);
  assert.equal(names.filter(n => n.startsWith('day-')).length, 7);
});

test('corrupt main recovers prior state, preserves damaged bytes, and never erases history on load', t => {
  const { open, file } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  fs.writeFileSync(file, '{"broken":');
  const recovered = open();
  assert.equal(recovered.getRawTime('branch').humanCoding, 100);
  assert.ok(fs.readdirSync(path.dirname(file)).some(n => n.includes('.corrupt-')));
  assert.equal(fs.readFileSync(file + '.bak', 'utf8').includes('"humanCoding": 100'), true);
});

test('recovery can fall back to sampled history when both main and latest backup are corrupt', t => {
  const { open, file } = fixture(t);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  fs.writeFileSync(file, 'damaged main');
  fs.writeFileSync(file + '.bak', 'damaged backup');
  assert.equal(open().getRawTime('branch').humanCoding, 100);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), 'damaged backup', 'load does not overwrite recovery evidence');
});

test('unrecoverable corruption and read permission errors fail closed without replacing data', t => {
  const { open, file } = fixture(t);
  fs.writeFileSync(file, 'not json');
  assert.throws(open, /No readable/);
  assert.ok(warnings.some(w => w.includes('could not load tracking data')));
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
  const read = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(target, ...args);
  };
  try { assert.throws(open, /denied/); }
  finally { fs.readFileSync = read; }
});

test('legacy credits migrate exactly once across instances without refreshing backups on clean load', t => {
  const { open, file, read } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({
    legacy: { workItemId: '1234', time: { humanCoding: 100 }, lineChanges: {},
      creditsLog: [{ ts: 1, model: 'model', credits: 3 }] }
  }));
  const a = open(), b = open();
  assert.equal(a.getCreditEntries()[0].id, b.getCreditEntries()[0].id);
  a.recordTime('legacy', 'humanCoding', 10); a.flushSync();
  b.recordTime('legacy', 'humanCoding', 20); b.flushSync();
  assert.equal(read().creditLedger.length, 1);
  assert.equal(read().branches.legacy.time.humanCoding, 130);
});

function worker(directory, name) {
  const child = spawn(process.execPath, [path.join(__dirname, 'persistenceWorker.cjs'), directory, name], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('exit', code => { if (code !== 0) reject(new Error(errors)); });
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors || `Worker exit ${code}`)));
  });
  return { child, ready, done };
}

test('four actual processes serialize concurrent commits without lost or doubled deltas', async t => {
  const { dir, file, read } = fixture(t);
  const workers = ['a', 'b', 'c', 'd'].map(name => worker(dir, name));
  t.after(() => workers.forEach(w => { if (w.child.exitCode === null) w.child.kill(); }));
  await Promise.all(workers.map(w => w.ready));
  const readFailures = [];
  const checkpoints = new Map();
  let backupReads = 0;
  const monitor = setInterval(() => {
    for (const target of [file, file + '.bak']) {
      try {
        assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).branches);
        if (target.endsWith('.bak')) backupReads++;
      } catch (error) {
        if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) readFailures.push(error);
      }
    }
    try {
      for (const name of fs.readdirSync(file + '.history').filter(n => n.endsWith('.json'))) {
        const raw = fs.readFileSync(path.join(file + '.history', name), 'utf8');
        assert.ok(JSON.parse(raw).branches);
        if (checkpoints.has(name)) assert.equal(raw, checkpoints.get(name), 'sampled checkpoints must remain immutable');
        else checkpoints.set(name, raw);
      }
    } catch (error) {
      if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) readFailures.push(error);
    }
  }, 5);
  try {
    fs.writeFileSync(path.join(dir, 'go'), '');
    await Promise.all(workers.map(w => w.done));
  } finally { clearInterval(monitor); }
  assert.deepEqual(readFailures, [], 'concurrent readers never observe partial/concatenated JSON');
  assert.ok(backupReads > 0);
  assert.ok(checkpoints.size > 0);
  assert.equal(read().branches.shared.time.humanCoding, 4 * 15 * 100);
  for (const name of ['a', 'b', 'c', 'd']) assert.equal(read().branches[name].time.aiGenerating, 150);
});

test('a process dying while holding its ticket is recovered safely on next acquisition', async t => {
  const { dir, open, file, read } = fixture(t);
  const crashed = worker(dir, 'crash');
  await crashed.done;
  assert.equal(fs.readdirSync(file + '.locks').length, 1);
  const db = open();
  db.recordTime('branch', 'humanCoding', 100); db.flushSync();
  assert.equal(read().branches.branch.time.humanCoding, 100);
  assert.equal(fs.readdirSync(file + '.locks').length, 0);
});

test('an older window overwriting the whole file cannot drop newer data (legacy writer heal)', t => {
  const { open, read, file } = fixture(t);
  const seed = open();
  seed.recordTime('shared', 'humanCoding', 60000);
  seed.flushSync();
  // The legacy window loaded here and keeps a stale in-memory copy.
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete stale.writer;
  const current = open();
  current.recordTime('shared', 'humanCoding', 30000);
  current.recordTime('new-branch', 'reviewing', 5000);
  current.setWorkItemForBranch('new-branch', 'WI-9');
  current.flushSync();
  assert.equal(read().writer, 'ai-effort-tracker/merge-v2');
  // Older version: whole-file replacement with its own delta and no stamp.
  stale.branches.shared.time.humanCoding += 1000;
  stale.branches['legacy-branch'] = JSON.parse(JSON.stringify(stale.branches.shared));
  fs.writeFileSync(file, JSON.stringify(stale));
  warnings.length = 0;
  current.recordTime('new-branch', 'reviewing', 1000);
  current.flushSync();
  const store = read();
  assert.equal(store.writer, 'ai-effort-tracker/merge-v2');
  assert.ok(store.branches['new-branch'], 'branch created by the newer window survives');
  assert.equal(store.branches['new-branch'].time.reviewing, 6000);
  assert.equal(store.branches['new-branch'].workItemId, 'WI-9');
  assert.equal(store.branches.shared.time.humanCoding, 90000, 'counter never regresses to the stale value');
  assert.ok(store.branches['legacy-branch'], 'data added by the older window is kept');
  assert.ok(warnings.some(w => /older version/.test(w)), 'user is told to reload windows');
});

test('a merging writer without the stamp heals only once the stamp exists', t => {
  const { open, read } = fixture(t);
  const a = open();
  a.recordTime('x', 'humanCoding', 1000);
  a.flushSync();
  const b = open();
  b.recordTime('x', 'humanCoding', 1000);
  b.flushSync();
  assert.equal(read().branches.x.time.humanCoding, 2000);
});
