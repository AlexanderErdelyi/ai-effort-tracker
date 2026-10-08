const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const { Database, migrateStore, sanitizeReassignments, sliceBranchRange, transferBranchDelta } = require('../out/store/database');
const { mergeStores } = require('../out/store/mergeStore');

const openDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-entry-move-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};
const clone = o => JSON.parse(JSON.stringify(o));
const zeros = () => new Array(24).fill(0);
const at = (d, h = 0, m = 0) => new Date(2025, 0, d, h, m).getTime();

/** A bucket with `ms` human coding in `hour` and `lines` human lines. */
function bucket(parts) {
  const b = { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0, linesHuman: 0, linesAi: 0, linesAiTranslation: 0, hours: zeros(),
    hoursByMode: { humanCoding: zeros(), aiGenerating: zeros(), reviewing: zeros() } };
  for (const { hour, ms = 0, ai = 0, human = 0, aiLines = 0 } of parts) {
    b.humanCoding += ms; b.aiGenerating += ai;
    b.hours[hour] += ms + ai;
    b.hoursByMode.humanCoding[hour] += ms;
    b.hoursByMode.aiGenerating[hour] += ai;
    b.linesHuman += human; b.linesAi += aiLines;
  }
  return b;
}

/** main: day 1 (1000 ms, 10 lines) and day 2 (09:00 2000 ms/20 lines, 14:00 4000 ms + 1000 ai/40 + 6 ai lines). */
function seed(db) {
  const d1 = bucket([{ hour: 10, ms: 1000, human: 10 }]);
  const d2 = bucket([{ hour: 9, ms: 2000, human: 20 }, { hour: 14, ms: 4000, ai: 1000, human: 40, aiLines: 6 }]);
  db.store['r::main'] = {
    workItemId: 'WI-MAIN', time: { humanCoding: 7000, aiGenerating: 1000, reviewing: 0, idle: 500 },
    copilotAcceptances: 6, humanKeystrokes: 70, chatTurnsHuman: 8,
    lineChanges: { '.al': { human: { added: 70, deleted: 7 }, ai: { added: 6, deleted: 0 } } },
    effectiveLines: { programming: { human: 70, ai: 6 } },
    daily: { '2025-01-01': d1, '2025-01-02': d2 },
    focusSessions: [{ ts: at(1, 11), ms: 1000, humanMs: 1000, aiMs: 0 }, { ts: at(2, 15), ms: 5000, humanMs: 4000, aiMs: 1000 }],
    files: {
      'a.al': { humanAdded: 10, humanDeleted: 1, aiAdded: 0, aiDeleted: 0, edits: 2, lastTs: at(1, 10) },
      'b.al': { humanAdded: 60, humanDeleted: 6, aiAdded: 6, aiDeleted: 0, edits: 6, lastTs: at(2, 14) }
    }
  };
  db.store['r::feature/42'] = { workItemId: '42', time: { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 }, copilotAcceptances: 0, lineChanges: {} };
  db.workItems['42'] = { id: '42', title: null, projectId: 'P1', estimate: null, externalRef: null, createdAt: 0 };
  db.creditLedger.push(
    { id: 'L1', ts: at(1, 10), model: 'm', credits: 1, source: 'auto', branch: 'r::main', workItemId: 'WI-MAIN', projectId: null },
    { id: 'L2', ts: at(2, 9, 30), model: 'm', credits: 2.5, source: 'auto', branch: 'r::main', workItemId: 'WI-MAIN', projectId: null },
    { id: 'L3', ts: at(2, 14, 30), model: 'm', credits: 4, source: 'auto', branch: 'r::main', workItemId: 'WI-MAIN', projectId: null }
  );
}

const total = (db, key) => {
  const b = db.store[key];
  const days = Object.values(b.daily ?? {});
  return {
    human: b.time.humanCoding, ai: b.time.aiGenerating, idle: b.time.idle,
    dayHuman: days.reduce((s, d) => s + d.humanCoding, 0), lines: days.reduce((s, d) => s + d.linesHuman + d.linesAi, 0),
    ext: (b.lineChanges['.al']?.human.added ?? 0) + (b.lineChanges['.al']?.ai.added ?? 0),
    files: Object.values(b.files ?? {}).reduce((s, f) => s + f.humanAdded + f.aiAdded, 0),
    sessions: (b.focusSessions ?? []).length, acc: b.copilotAcceptances
  };
};
const sum = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]]));

test('a whole-day range moves that day exactly and conserves totals (#156)', t => {
  const db = openDb(t); seed(db);
  const before = sum(total(db, 'r::main'), total(db, 'r::feature/42'));
  const preview = db.previewEntryMove('r::main', 'r::feature/42', { fromTs: at(2) });
  assert.equal(preview.estimated, false);
  assert.equal(preview.days, 1);
  assert.equal(preview.activeMs, 7000);
  assert.equal(preview.linesHuman, 60);
  assert.equal(preview.credits, 6.5);
  assert.equal(preview.ledgerRows, 2);
  assert.equal(preview.focusSessions, 1);

  const rec = db.moveEntries('r::main', 'r::feature/42', { fromTs: at(2) }, 'started on main');
  assert.equal(rec.kind, 'move');
  assert.equal(rec.toBranch, 'r::feature/42');
  assert.equal(rec.fromWorkItemId, 'WI-MAIN');
  assert.equal(rec.toWorkItemId, '42');
  assert.deepEqual(sum(total(db, 'r::main'), total(db, 'r::feature/42')), before, 'nothing lost or doubled');
  const dst = db.store['r::feature/42'];
  assert.equal(dst.daily['2025-01-02'].humanCoding, 6000);
  assert.equal(dst.daily['2025-01-02'].hours[14], 5000);
  assert.equal(db.store['r::main'].daily['2025-01-01'].humanCoding, 1000, 'day 1 stays');
  assert.equal(db.store['r::main'].daily['2025-01-02'].humanCoding, 0);
  assert.equal(dst.time.humanCoding, 6000);
  assert.equal(dst.time.aiGenerating, 1000);
  assert.equal(dst.time.idle, 0, 'no idle in the moved day');
  assert.equal(dst.files['b.al'].humanAdded, 60);
  assert.equal(dst.files['b.al'].lastTs, at(2, 14));
  assert.equal(dst.files['a.al'], undefined, 'file last edited before the range stays');
  assert.equal(dst.focusSessions.length, 1);
  const moved = db.creditLedger.filter(e => e.branch === 'r::feature/42');
  assert.deepEqual(moved.map(e => e.id).sort(), ['L2', 'L3']);
  assert.ok(moved.every(e => e.workItemId === '42' && e.projectId === 'P1'));
  assert.equal(db.creditLedger.find(e => e.id === 'L1').branch, 'r::main');
});

test('a range starting mid-day splits the day by hour (#156)', t => {
  const db = openDb(t); seed(db);
  const before = sum(total(db, 'r::main'), total(db, 'r::feature/42'));
  const rec = db.moveEntries('r::main', 'r::feature/42', { fromTs: at(2, 12) });
  assert.equal(rec.move.stats.estimated, true);
  const dst = db.store['r::feature/42'].daily['2025-01-02'];
  assert.equal(dst.humanCoding, 4000);
  assert.equal(dst.aiGenerating, 1000);
  assert.equal(dst.hours[9], 0);
  assert.equal(dst.hours[14], 5000);
  assert.equal(dst.linesHuman, Math.round(60 * 5000 / 7000));
  assert.equal(db.store['r::main'].daily['2025-01-02'].hours[9], 2000, '09:00 stays on main');
  assert.deepEqual(sum(total(db, 'r::main'), total(db, 'r::feature/42')), before);
  assert.deepEqual(db.creditLedger.filter(e => e.branch === 'r::feature/42').map(e => e.id), ['L3']);
});

test('ledger-only move leaves the counters alone (#156)', t => {
  const db = openDb(t); seed(db);
  const before = clone(db.store['r::main']);
  const rec = db.moveEntries('r::main', 'r::feature/42', { ledgerIds: ['L1'] });
  assert.equal(rec.move.stats.ledgerRows, 1);
  assert.equal(rec.range, undefined);
  assert.deepEqual(db.store['r::main'], before);
  assert.equal(db.creditLedger.find(e => e.id === 'L1').branch, 'r::feature/42');
  assert.equal(db.creditLedger.find(e => e.id === 'L2').branch, 'r::main');
  assert.equal(db.moveEntries('r::main', 'r::feature/42', { ledgerIds: ['nope'] }), undefined, 'nothing to move');
  assert.equal(db.moveEntries('r::main', 'r::main', { fromTs: 0 }), undefined, 'same branch');
});

test('time-log rows in the range follow and take the new work item (#156)', t => {
  const db = openDb(t); seed(db);
  db.timeEntries.push(
    { id: 'T1', branch: 'r::main', workItemId: 'WI-MAIN', startTs: at(2, 8), durationMs: 60000, source: 'manual', createdAt: at(2, 8) },
    { id: 'T2', branch: 'r::main', workItemId: 'OTHER', startTs: at(2, 9), durationMs: 60000, source: 'manual', createdAt: at(2, 9) },
    { id: 'T3', branch: 'r::main', startTs: at(1, 9), durationMs: 60000, source: 'manual', createdAt: at(1, 9) }
  );
  const rec = db.moveEntries('r::main', 'r::feature/42', { fromTs: at(2) });
  assert.equal(rec.move.stats.timeEntries, 2);
  const get = id => db.timeEntries.find(e => e.id === id);
  assert.equal(get('T1').branch, 'r::feature/42');
  assert.equal(get('T1').workItemId, '42');
  assert.equal(get('T2').workItemId, 'OTHER', 'an explicit other work item is kept');
  assert.equal(get('T3').branch, 'r::main');
  db.undoEntryMove(rec.id);
  assert.equal(get('T1').branch, 'r::main');
  assert.equal(get('T1').workItemId, 'WI-MAIN');
});

test('undo restores the source exactly and can run once (#156)', t => {
  const db = openDb(t); seed(db);
  const src = clone(db.store['r::main']);
  const ledger = clone(db.creditLedger);
  const rec = db.moveEntries('r::main', 'r::feature/42', { fromTs: at(2, 12) });
  db.recordTime('r::feature/42', 'humanCoding', 10);
  const undo = db.undoEntryMove(rec.id);
  assert.equal(undo.kind, 'move-undo');
  assert.equal(undo.undoOf, rec.id);
  assert.deepEqual(db.store['r::main'], src);
  assert.deepEqual(db.creditLedger, ledger);
  assert.equal(db.store['r::feature/42'].time.humanCoding, 10, 'later tracking on the target stays');
  assert.equal(db.undoEntryMove(rec.id), undefined, 'already undone');
  const moves = db.getEntryMoves();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].undone, true);
  assert.deepEqual(moves[0].move.delta, {}, 'the undo payload is not handed to the UI');
});

test('a move survives a save/load round trip and stays undoable (#156)', t => {
  const db = openDb(t); seed(db);
  const src = clone(db.store['r::main']);
  const rec = db.moveEntries('r::main', 'r::feature/42', { fromTs: 0 });
  assert.equal(db.store['r::main'].time.humanCoding, 0, 'everything moved');
  const persisted = migrateStore(clone({ schemaVersion: 13, branches: db.store, workItems: db.workItems, creditLedger: db.creditLedger, projects: {}, manualEffort: [], reassignments: db.reassignments, timeEntries: [] }));
  const r = persisted.reassignments.find(x => x.id === rec.id);
  assert.equal(r.kind, 'move');
  assert.ok(Object.keys(r.move.delta).length > 0);
  assert.deepEqual(sanitizeReassignments(clone(persisted.reassignments)), persisted.reassignments, 'idempotent');
  db.undoEntryMove(rec.id);
  assert.deepEqual(db.store['r::main'].time, src.time);
  assert.deepEqual(db.store['r::main'].daily, src.daily);
});

test('a concurrent window writing to the source is not lost or doubled (#156)', () => {
  const branch = (extra = {}) => ({ workItemId: null, time: { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 }, copilotAcceptances: 0, lineChanges: {}, ...extra });
  const base = migrateStore({
    schemaVersion: 13, workItems: {}, creditLedger: [], projects: {}, manualEffort: [], reassignments: [], timeEntries: [],
    branches: {
      main: branch({ time: { humanCoding: 3000, aiGenerating: 0, reviewing: 0, idle: 0 }, daily: { '2025-01-02': bucket([{ hour: 14, ms: 3000, human: 5 }]) } }),
      feat: branch()
    }
  });
  const local = clone(base);
  const { delta } = sliceBranchRange(local.branches.main, at(2));
  transferBranchDelta(local.branches.main, local.branches.feat, delta);
  const disk = clone(base);
  disk.branches.main.time.humanCoding += 700;
  disk.branches.main.daily['2025-01-02'].humanCoding += 700;
  disk.branches.main.daily['2025-01-02'].hours[15] += 700;
  const merged = mergeStores(base, local, disk);
  assert.equal(merged.branches.feat.time.humanCoding, 3000);
  assert.equal(merged.branches.main.time.humanCoding, 700, 'the other window keeps its new time');
  assert.equal(merged.branches.main.daily['2025-01-02'].hours[15], 700);
  assert.equal(merged.branches.feat.daily['2025-01-02'].hours[14], 3000);
  assert.equal(merged.branches.main.daily['2025-01-02'].hours[14], 0);
});
