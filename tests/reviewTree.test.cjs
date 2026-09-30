const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReviewTree, folderTree } = require('../out/analysis/reviewTree');
const { categorizeWith, CATEGORY_LABELS, ALL_CATEGORIES } = require('../out/util/categoryRules');

const row = (p, total = 10, reviewed = 0, issueLines = 0) => ({ path: p, total, reviewed, issueLines });
const rows = [
  row('app/src/Job/codeunit/SyncMgt.Codeunit.al', 20, 5, 2),
  row('app/specs/us-1819/01/plan.md', 8),
  row('app/src/Job/table/JobDefinition.Table.al', 6, 6),
  row('app/src/Job/page/Deviations.Page.al', 4),
  row('app/specs/us-1819/02/plan.md', 3),
  row('app/specs/us-1819/acceptance-criteria.md', 2),
  row('app/src/Job/page/CardPage.Page.al', 5, 1),
  row('app/Translations/App.de-DE.xlf', 50)
];
const shape = nodes => nodes.map(n => n.kind === 'file' ? n.row.path.split('/').pop() : { [n.label]: shape(n.children) });
const rules = { extensions: {}, folders: { specs: 'specification' } };
const tree = () => buildReviewTree(rows, 'category', p => categorizeWith(p, rules), c => CATEGORY_LABELS[c] ?? c, ALL_CATEGORIES);

test('category grouping: categories in order, compact folders, shared folder hoisted', () => {
  const t = tree();
  assert.deepEqual(shape(t), [
    { '💻 Programming': [
      { codeunit: ['SyncMgt.Codeunit.al'] },
      { page: ['CardPage.Page.al', 'Deviations.Page.al'] },
      { table: ['JobDefinition.Table.al'] }
    ] },
    { '📋 Specification': [{ '01': ['plan.md'] }, { '02': ['plan.md'] }, 'acceptance-criteria.md'] },
    { Translations: ['App.de-DE.xlf'] }
  ]);
  const [prog, spec, tr] = t;
  assert.equal(prog.commonPath, 'app/src/Job');
  assert.equal(spec.commonPath, 'app/specs/us-1819');
  assert.equal(tr.commonPath, 'app/Translations');
  assert.deepEqual([prog.files, prog.total, prog.reviewed, prog.issueLines], [4, 35, 12, 2]);
  assert.equal(prog.children[1].key, 'app/src/Job/page');
  assert.equal(prog.children[1].id, 'open:programming/app/src/Job/page');
  const ids = t.flatMap(function all(n) { return n.kind === 'group' ? [n.id, ...n.children.flatMap(all)] : []; });
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('folder grouping compacts single-child chains; flat list sorts by path', () => {
  assert.deepEqual(shape(folderTree(rows)), [{ app: [
    { 'specs/us-1819': [{ '01': ['plan.md'] }, { '02': ['plan.md'] }, 'acceptance-criteria.md'] },
    { 'src/Job': [{ codeunit: ['SyncMgt.Codeunit.al'] }, { page: ['CardPage.Page.al', 'Deviations.Page.al'] }, { table: ['JobDefinition.Table.al'] }] },
    { Translations: ['App.de-DE.xlf'] }
  ] }]);
  const top = folderTree(rows)[0];
  assert.deepEqual([top.files, top.total, top.reviewed], [8, 98, 12]);
  assert.deepEqual(buildReviewTree(rows, 'none', () => 'x', c => c).map(n => n.row.path)[0], 'app/specs/us-1819/01/plan.md');
  assert.deepEqual(shape(buildReviewTree([row('README.md')], 'category', () => 'documentation', c => c, ALL_CATEGORIES)), [{ documentation: ['README.md'] }]);
  assert.deepEqual(buildReviewTree([row('a.al')], 'category', () => { throw new Error('x'); }, c => c).map(n => n.key), ['other']);
});
