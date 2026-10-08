const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const { extractWorkItemId, migrateStore } = require('../out/store/database');

test('work item id is found with #, AB# and the usual separators (#158)', () => {
  for (const [branch, id] of [
    ['#2134-Fehler-bei-Debitoranlage', '2134'],
    ['feature/#2134-x', '2134'],
    ['AB#2134-x', '2134'],
    ['2134-x', '2134'],
    ['feature/2134_x', '2134'],
    ['bugfix/2134', '2134'],
    ['#2134', '2134']
  ]) assert.equal(extractWorkItemId(branch), id, branch);
  for (const branch of ['main', 'release/debug-log-credits', 'v1.2.3', 'feature/12-x', 'x1234y']) {
    assert.equal(extractWorkItemId(branch), undefined, branch);
  }
});

test('auto-parked # branches are adopted on load and their credits follow; manual choices stay (#158)', () => {
  const branch = () => ({ time: {}, lineChanges: {}, copilotAcceptances: 0 });
  const raw = {
    schemaVersion: 13,
    branches: {
      '#2134-Fehler': { ...branch(), workItemId: '__unassigned__' },
      '#3000-kept': { ...branch(), workItemId: '__unassigned__', workItemIdManual: true },
      'main': { ...branch(), workItemId: '__unassigned__' }
    },
    workItems: { __unassigned__: { id: '__unassigned__', title: 'Unassigned', projectId: null, estimate: null, externalRef: null, createdAt: 1 } },
    creditLedger: [
      { id: 'a', ts: 1, model: 'm', credits: 2, source: 'auto', branch: '#2134-Fehler', workItemId: '__unassigned__', projectId: null },
      { id: 'b', ts: 1, model: 'm', credits: 3, source: 'auto', branch: '#3000-kept', workItemId: '__unassigned__', projectId: null }
    ],
    projects: {}
  };
  const store = migrateStore(raw);
  assert.equal(store.branches['#2134-Fehler'].workItemId, '2134');
  assert.ok(store.workItems['2134']);
  assert.equal(store.creditLedger.find(e => e.id === 'a').workItemId, '2134');
  assert.equal(store.branches['#3000-kept'].workItemId, '__unassigned__');
  assert.equal(store.creditLedger.find(e => e.id === 'b').workItemId, '__unassigned__');
  assert.equal(store.workItems['3000'], undefined);
  assert.equal(store.branches.main.workItemId, '__unassigned__');
  assert.deepEqual(migrateStore(JSON.parse(JSON.stringify(store))).branches, store.branches, 'idempotent');
});

const { deriveWorkItemTitle, autoTitleWorkItems } = require('../out/store/database');
const { mergeStores } = require('../out/store/mergeStore');

test('branch names become readable work item titles (#157)', () => {
  for (const [branch, id, title] of [
    ['#2134-Fehler-bei-Debitoranlage-und-Änderung', '2134', 'Fehler bei Debitoranlage und Änderung'],
    ['feature/2134-add_login-page', '2134', 'add login page'],
    ['users/alex/AB#2134-fix', '2134', 'fix'],
    ['bugfix/fix-2134-crash', '2134', 'fix crash'],
    ['feature/21345-keep-other-ids-2134', '2134', '21345 keep other ids']
  ]) assert.equal(deriveWorkItemTitle(branch, id), title, branch);
  assert.equal(deriveWorkItemTitle('bugfix/2134', '2134'), undefined);
  assert.equal(deriveWorkItemTitle('#2134', '2134'), undefined);
});

const wi = (id, extra = {}) => ({ id, title: null, projectId: null, estimate: null, externalRef: null, createdAt: 1, ...extra });

test('only single-branch items without a manual title are auto-titled (#157)', () => {
  const branches = {
    '#1-x': { workItemId: '100' },
    '#100-Login-page': { workItemId: '100' },
    '#200-Report': { workItemId: '200' },
    '#300-a': { workItemId: '300' }, '#300-b': { workItemId: '300' },
    '#400-old': { workItemId: '400' }
  };
  delete branches['#1-x'];
  const items = { 100: wi('100'), 200: wi('200', { title: 'Mine' }), 300: wi('300'), 400: wi('400', { title: 'stale', titleAuto: true }) };
  assert.equal(autoTitleWorkItems(branches, items), true);
  assert.deepEqual([items[100].title, items[100].titleAuto], ['Login page', true]);
  assert.deepEqual([items[200].title, items[200].titleAuto], ['Mine', undefined]);
  assert.equal(items[300].title, null);
  assert.equal(items[400].title, 'old');
  assert.equal(autoTitleWorkItems(branches, items), false, 'idempotent');
});

test('auto title on load, manual rename is sticky, clearing re-derives (#157)', () => {
  const branch = () => ({ time: {}, lineChanges: {}, copilotAcceptances: 0 });
  const store = migrateStore({ schemaVersion: 13, branches: { '#2134-Fehler-bei-Anlage': { ...branch(), workItemId: '2134' } },
    workItems: { 2134: wi('2134') }, creditLedger: [], projects: {} });
  assert.deepEqual([store.workItems['2134'].title, store.workItems['2134'].titleAuto], ['Fehler bei Anlage', true]);
  store.workItems['2134'] = { ...store.workItems['2134'], title: 'Debitor fix' };
  delete store.workItems['2134'].titleAuto;
  assert.equal(migrateStore(JSON.parse(JSON.stringify(store))).workItems['2134'].title, 'Debitor fix');
});

test('a concurrent auto title never overwrites a manual rename in either commit order (#157)', () => {
  const base = { schemaVersion: 13, branches: {}, workItems: { 7: wi('7') }, creditLedger: [], projects: {}, manualEffort: [], reassignments: [], timeEntries: [] };
  const manual = JSON.parse(JSON.stringify(base)); manual.workItems[7].title = 'Manual';
  const auto = JSON.parse(JSON.stringify(base)); Object.assign(auto.workItems[7], { title: 'from branch', titleAuto: true });
  for (const [local, disk] of [[auto, manual], [manual, auto]]) {
    const r = mergeStores(base, local, disk).workItems[7];
    assert.deepEqual([r.title, r.titleAuto], ['Manual', undefined]);
  }
});

test('Database: live branch mapping auto-titles, rename sticks, clearing re-derives (#157/#158)', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { Database } = require('../out/store/database');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-name-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const branch = '#2134-Fehler-bei-Anlage';
  db.setWorkItemForBranch(branch, extractWorkItemId(branch));
  assert.equal(db.getWorkItem('2134').title, 'Fehler bei Anlage');
  db.upsertWorkItem('2134', { title: 'Debitor fix' });
  db.setWorkItemForBranch(branch, '2134');
  assert.deepEqual([db.getWorkItem('2134').title, db.getWorkItem('2134').titleAuto], ['Debitor fix', undefined]);
  db.upsertWorkItem('2134', { title: null });
  assert.deepEqual([db.getWorkItem('2134').title, db.getWorkItem('2134').titleAuto], ['Fehler bei Anlage', true]);
  db.flushSync();
});
