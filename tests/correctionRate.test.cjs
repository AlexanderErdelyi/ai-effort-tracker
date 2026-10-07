const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../out/analysis/correctionRate');

// 2026-10-12 is a Monday. Local times, like the effort store's day keys.
const at = (day, h = 10, m = 0) => new Date(2026, 9, day, h, m).getTime();
const NOW = at(21, 12);
const corr = (over = {}) => ({
  id: over.id ?? 'c', t: at(13), start: at(13), source: 'human', kind: 'modify', repo: 'app', path: 'src/a.Table.al',
  ext: 'al', branch: 'feat', line: 1, aiLines: 1, added: 1, removed: 1, aiAt: at(12), ...over
});
const aiDays = [
  { date: '2026-10-13', branch: 'feat', lines: 100 },
  { date: '2026-10-20', branch: 'feat', lines: 50 },
  { date: '2026-10-20', branch: 'other', lines: 50 },
  { date: '2026-10-01', branch: 'feat', lines: 999 } // before capture started
];
const ctx = { workItemOfBranch: { feat: '42' }, projectOfWorkItem: { 42: 'P' } };
const corrections = [
  corr({ id: 'c1', aiLines: 10, category: 'style' }),
  corr({ id: 'c2', source: 'ai', t: at(20, 9, 5), start: at(20, 9, 4), aiLines: 5, trigger: { t: at(20, 9), sessionId: 's' } }),
  corr({ id: 'c3', t: at(20, 11), start: at(20, 11), aiLines: 20, category: 'requirement change' })
];
const opts = over => ({ ...ctx, since: at(12, 8), now: NOW, ...over });

test('weekOf returns the Monday, also across a year boundary', () => {
  assert.equal(R.weekOf('2026-10-12'), '2026-10-12');
  assert.equal(R.weekOf('2026-10-18'), '2026-10-12');
  assert.equal(R.weekOf('2026-10-19'), '2026-10-19');
  assert.equal(R.weekOf('2027-01-01'), '2026-12-28');
  assert.equal(R.localDay(at(5, 23, 59)), '2026-10-05');
});

test('episodeReworkMs counts from the prompt and clamps to 1-30 minutes', () => {
  assert.equal(R.episodeReworkMs(1000, 1000), R.REWORK_MIN_MS);
  assert.equal(R.episodeReworkMs(at(1, 9, 5), at(1, 9, 7), at(1, 9)), 7 * 60_000);
  assert.equal(R.episodeReworkMs(at(1, 10), at(1, 10, 2), at(1, 9)), 2 * 60_000, 'a prompt an hour earlier is not the start');
  assert.equal(R.episodeReworkMs(at(1, 9), at(1, 12)), R.REWORK_MAX_MS);
});

test('rate per week: corrected AI lines per 100 AI lines, without requirement changes', () => {
  const r = R.correctionRateReport(corrections, aiDays, [], opts());
  assert.deepEqual(r.weeks.map(w => [w.week, w.aiLines, w.correctedLines, w.rate]), [['2026-10-12', 100, 10, 10], ['2026-10-19', 100, 5, 5]]);
  assert.equal(r.total.corrections, 2);
  assert.equal(r.total.aiLines, 200, 'AI lines before capture started do not count');
  assert.equal(r.total.rate, 7.5);
  assert.equal(r.total.human, 1);
  assert.equal(r.total.episodes, 2);
  assert.equal(r.total.reworkMs, R.REWORK_MIN_MS + 5 * 60_000);
  assert.deepEqual(r.weeks[1].byCategory, { [R.UNLABELLED]: 5 });
});

test('work item and project rows follow the branch mapping and skip groups without corrections', () => {
  const r = R.correctionRateReport(corrections, aiDays, [], opts());
  assert.deepEqual(r.workItems.map(g => [g.key, g.aiLines, g.correctedLines, g.rate]), [['42', 150, 15, 10]]);
  assert.deepEqual(r.projects.map(g => g.key), ['P']);
  const only = R.correctionRateReport(corrections, aiDays, [], opts({ workItemId: '42' }));
  assert.equal(only.total.aiLines, 150);
  const none = R.correctionRateReport(corrections, aiDays, [], opts({ projectId: 'X' }));
  assert.equal(none.total.corrections, 0);
  assert.equal(none.total.rate, null);
});

test('category trend compares the recent weeks with the weeks before', () => {
  const r = R.correctionRateReport(corrections, aiDays, [], opts({ trendWeeks: 1 }));
  assert.equal(r.recent.rate, 5);
  assert.equal(r.previous.rate, 10);
  const by = Object.fromEntries(r.categories.map(c => [c.category, c]));
  assert.equal(by.style.trend, 'gone');
  assert.equal(by[R.UNLABELLED].trend, 'new');
  assert.equal(r.categories[0].category, 'style', 'sorted by corrected lines');
});

test('rule effect: rate in scope before vs after approval', () => {
  const rule = (over = {}) => ({ id: 'r1', category: 'style', scope: '**/*.Table.al', text: 'x', status: 'approved', examples: [], createdBy: 'user', createdAt: 0, updatedAt: 0, approvedAt: at(16), ...over });
  const r = R.correctionRateReport(corrections, aiDays, [rule(), rule({ id: 'p', status: 'proposed' }), rule({ id: 'n', approvedAt: undefined })], opts());
  assert.deepEqual(r.rules.map(e => e.id), ['r1']);
  const e = r.rules[0];
  assert.equal(e.days, 6);
  assert.deepEqual([e.before.aiLines, e.before.correctedLines, e.before.rate], [100, 10, 10], 'before starts when capture started');
  assert.deepEqual([e.after.aiLines, e.after.correctedLines, e.after.rate], [100, 0, 0]);
  assert.equal(e.change, -1);
  assert.equal(e.early, true);
  assert.equal(e.unlabelledAfter, 1);
  const other = R.correctionRateReport(corrections, aiDays, [rule({ repo: 'elsewhere' })], opts()).rules[0];
  assert.equal(other.before.correctedLines, 0, 'corrections of other repositories do not count');
  const scoped = R.correctionRateReport(corrections, aiDays, [rule({ scope: '**/*.Page.al' })], opts()).rules[0];
  assert.equal(scoped.before.corrections, 0);
});

test('rateInputsFromStore and correctionTrackingSince read the stores', () => {
  const inp = R.rateInputsFromStore(
    { feat: { workItemId: '42', daily: { '2026-10-13': { linesAi: 7 }, '2026-10-14': { linesAi: 0 } } }, x: {} },
    { 42: { projectId: 'P' }, 43: {} }
  );
  assert.deepEqual(inp, { aiDays: [{ date: '2026-10-13', branch: 'feat', lines: 7 }], workItemOfBranch: { feat: '42' }, projectOfWorkItem: { 42: 'P' } });
  assert.equal(R.correctionTrackingSince({ corrections: [corr({ start: 500, t: 600 })], owned: { f: { h: { a: 300, b: 0 } } } }), 300);
  assert.equal(R.correctionTrackingSince({ corrections: [], owned: {} }), null);
});

test('rateInputsFromStore leaves translation lines out of the denominator', () => {
  const files = { 'Translations/App.en-US.xlf': { aiAdded: 900 }, 'src/a.al': { aiAdded: 100 } };
  const inp = R.rateInputsFromStore({
    legacy: { files, daily: { '2026-10-13': { linesAi: 500 } } },
    exact: { files, daily: { '2026-10-14': { linesAi: 500, linesAiTranslation: 450 }, '2026-10-15': { linesAi: 40, linesAiTranslation: 40 } } },
    custom: { files: { 'loc/a.json': { aiAdded: 10 } }, daily: { '2026-10-16': { linesAi: 10 } } }
  }, {}, f => f.startsWith('loc/'));
  assert.deepEqual(inp.aiDays, [
    { date: '2026-10-13', branch: 'legacy', lines: 500 },
    { date: '2026-10-14', branch: 'exact', lines: 50 }
  ]);
  const def = R.rateInputsFromStore({ legacy: { files, daily: { '2026-10-13': { linesAi: 500 } } } }, {});
  assert.deepEqual(def.aiDays, [{ date: '2026-10-13', branch: 'legacy', lines: 50 }]);
});
