const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get() {} }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const backup = require('../out/store/backup');

function fixture(t) {
  const dir = path.join(__dirname, `.backup-${randomUUID()}`);
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

const rule = (id, text) => ({ id, category: 'documentation', scope: '**/*.al', text, status: 'approved', createdBy: 'user', createdAt: 1, updatedAt: 1 });
const writeLessons = (dir, rules) => fs.writeFileSync(path.join(dir, 'lessons.json'), JSON.stringify({ version: 1, rules }));

test('bundle round trip keeps every data set and drops secret settings', t => {
  const { dir, open } = fixture(t);
  const db = open();
  db.recordTime('feature/a', 'humanCoding', 30 * 60000);
  writeLessons(dir, [rule('r1', 'Document public procedures')]);
  const bundle = backup.buildBundle({
    dir, effort: db.backupSnapshot(), extensionVersion: '9.9.9',
    settings: { 'aiEffortTracker.githubToken': 'ghp_secret', 'aiEffortTracker.hourlyRate': 120 }
  });
  assert.equal(bundle.settings['aiEffortTracker.githubToken'], undefined);
  const raw = backup.serializeBundle(bundle);
  assert.ok(!raw.includes('ghp_secret'));
  const parsed = backup.parseBackup(raw, 'x.json');
  assert.equal(parsed.data.effort.branches['feature/a'].time.humanCoding, 30 * 60000);
  assert.equal(parsed.data.lessons.rules[0].text, 'Document public procedures');
  assert.deepEqual(parsed.settings, { 'aiEffortTracker.hourlyRate': 120 });
  assert.equal(parsed.extensionVersion, '9.9.9');
  assert.match(backup.dataSet('effort').summarize(parsed.data.effort), /0\.5 h active · 1 branch/);
});

test('parseBackup rejects garbage and newer formats, accepts plain store files', t => {
  const { open, file } = fixture(t);
  assert.throws(() => backup.parseBackup('not json'), /not valid JSON/);
  assert.throws(() => backup.parseBackup('{"hello":1}', 'random.json'), /not an AI Effort Tracker backup/);
  assert.throws(() => backup.parseBackup(JSON.stringify({ format: backup.BACKUP_FORMAT, version: 99, data: {} })), /newer version/);
  assert.throws(() => backup.parseBackup(JSON.stringify({ format: backup.BACKUP_FORMAT, version: 1, data: {} })), /no data/);
  const settings = backup.parseBackup(JSON.stringify({
    format: backup.BACKUP_FORMAT, version: 1, data: { lessons: { rules: [] } },
    settings: { 'aiEffortTracker.githubToken': 'x', 'other.setting': 1, 'aiEffortTracker.profile': 'senior' }
  })).settings;
  assert.deepEqual(settings, { 'aiEffortTracker.profile': 'senior' });

  const db = open();
  db.recordTime('main', 'reviewing', 1000);
  db.flushSync();
  const plain = backup.parseBackup(fs.readFileSync(file, 'utf8'), 'C:\\copy\\effort-tracker.json.bak');
  assert.deepEqual(Object.keys(plain.data), ['effort']);
  assert.equal(plain.data.effort.branches.main.time.reviewing, 1000);
  const lessons = backup.parseBackup(JSON.stringify({ version: 1, rules: [rule('r1', 'x')] }), 'lessons.json');
  assert.deepEqual(Object.keys(lessons.data), ['lessons']);
});

test('restoreSnapshot replaces data, keeps the old file as .bak and idle windows adopt it', async t => {
  const { open, file, read } = fixture(t);
  const a = open();
  a.recordTime('keep', 'humanCoding', 1000);
  a.flushSync();
  const snapshot = a.backupSnapshot();
  a.recordTime('later', 'humanCoding', 5000);
  a.flushSync();
  const b = open();
  assert.ok(b.backupSnapshot().branches.later, 'second window sees the later branch');

  a.restoreSnapshot(snapshot);
  assert.deepEqual(Object.keys(read().branches), ['keep']);
  assert.ok(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).branches.later, 'replaced data kept as .bak');
  assert.deepEqual(Object.keys(a.backupSnapshot().branches), ['keep']);

  // The idle second window must adopt the restored file, not re-add "later".
  await b.flushAsync(true);
  assert.deepEqual(Object.keys(b.backupSnapshot().branches), ['keep']);
  b.recordTime('keep', 'humanCoding', 500);
  b.flushSync();
  assert.deepEqual(Object.keys(read().branches), ['keep']);
  assert.equal(read().branches.keep.time.humanCoding, 1500);
});

test('a dirty window keeps its own unsaved delta but does not resurrect restored-away data', t => {
  const { open, read } = fixture(t);
  const a = open();
  a.recordTime('keep', 'humanCoding', 1000);
  a.flushSync();
  const snapshot = a.backupSnapshot();
  a.recordTime('gone', 'humanCoding', 5000);
  a.flushSync();
  const b = open();
  b.recordTime('keep', 'reviewing', 700);
  a.restoreSnapshot(snapshot);
  b.flushSync();
  const store = read();
  assert.deepEqual(Object.keys(store.branches), ['keep']);
  assert.equal(store.branches.keep.time.humanCoding, 1000);
  assert.equal(store.branches.keep.time.reviewing, 700);
});

test('restoreSnapshot refuses invalid data and leaves the store untouched', t => {
  const { open, read } = fixture(t);
  const db = open();
  db.recordTime('main', 'humanCoding', 1000);
  db.flushSync();
  const before = read();
  assert.throws(() => db.restoreSnapshot({ nonsense: true }));
  assert.deepEqual(read(), before);
});

test('restoreSideStore replaces the file and keeps the previous one', t => {
  const { dir } = fixture(t);
  writeLessons(dir, [rule('old', 'old rule')]);
  backup.restoreSideStore(dir, 'lessons', { version: 1, rules: [rule('new', 'new rule')] });
  const file = path.join(dir, 'lessons.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rules[0].id, 'new');
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).rules[0].id, 'old');
  assert.throws(() => backup.restoreSideStore(dir, 'lessons', { rules: 'bad' }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rules[0].id, 'new');
});

test('safety copies rotate to the newest ten and checkpoints are listed', t => {
  const { dir, open } = fixture(t);
  const db = open();
  db.recordTime('main', 'humanCoding', 1000);
  db.flushSync();
  db.recordTime('main', 'humanCoding', 1000);
  db.flushSync();
  const bundle = backup.buildBundle({ dir, effort: db.backupSnapshot() });
  const files = [];
  for (let i = 0; i < 12; i++) {
    const f = backup.writeSafetyCopy(dir, bundle, new Date(Date.UTC(2025, 0, 1, 0, i)));
    fs.utimesSync(f, new Date(Date.UTC(2025, 0, 1, 0, i)), new Date(Date.UTC(2025, 0, 1, 0, i)));
    files.push(f);
  }
  const kept = backup.listSafetyCopies(dir);
  assert.equal(kept.length, backup.SAFETY_KEEP);
  assert.equal(kept[0].file, files[11]);
  assert.ok(!fs.existsSync(files[0]) && !fs.existsSync(files[1]));
  assert.equal(backup.parseBackup(fs.readFileSync(kept[0].file, 'utf8')).data.effort.branches.main.time.humanCoding, 2000);

  const checkpoints = backup.listCheckpoints(dir);
  assert.ok(checkpoints.some(c => c.set === 'effort' && c.kind === 'previous'));
  assert.ok(checkpoints.every(c => c.set === 'effort'));
});

test('an unreadable side store is skipped and reported instead of aborting the backup', t => {
  const { dir, open } = fixture(t);
  fs.writeFileSync(path.join(dir, 'lessons.json'), '{broken');
  const bundle = backup.buildBundle({ dir, effort: open().backupSnapshot() });
  assert.equal(bundle.data.lessons, undefined);
  assert.equal(bundle.skipped.length, 1);
  assert.match(bundle.skipped[0], /Rules for Copilot/);
  assert.ok(bundle.data.effort);
});
