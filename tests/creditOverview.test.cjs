const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCreditOverview, billingPeriod, localDay } = require('../out/analysis/creditOverview');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const e = (ts, credits, model = 'claude-sonnet-5.5', workItemId = '100', source = 'auto') => ({ ts, credits, model, workItemId, source });

test('billing period honours the renewal day and clamps it to short months', () => {
  let p = billingPeriod(at(2026, 10, 1), 1);
  assert.equal(localDay(p.start), '2026-10-01');
  assert.equal(localDay(p.end), '2026-11-01');
  assert.equal(localDay(p.prevStart), '2026-09-01');
  p = billingPeriod(at(2026, 10, 10), 15);
  assert.equal(localDay(p.start), '2026-09-15');
  assert.equal(localDay(p.end), '2026-10-15');
  p = billingPeriod(at(2026, 2, 28), 31);
  assert.equal(localDay(p.start), '2026-02-28');
  assert.equal(localDay(p.end), '2026-03-31');
  p = billingPeriod(at(2026, 1, 5), 20);
  assert.equal(localDay(p.start), '2025-12-20');
  assert.equal(localDay(p.prevStart), '2025-11-20');
});

test('KPIs split today, yesterday, rolling weeks and the period', () => {
  const now = at(2026, 10, 10, 18);
  const o = buildCreditOverview([
    e(at(2026, 10, 10, 9), 5), e(at(2026, 10, 10, 11), 7),
    e(at(2026, 10, 9), 3),
    e(at(2026, 10, 2), 4),
    e(at(2026, 9, 30), 20),
    e(at(2026, 9, 5), 8),
    e(at(2026, 10, 11, 1), 99),
  ], { now });
  assert.equal(o.today, 12);
  assert.equal(o.yesterday, 3);
  assert.equal(o.last7, 15);
  assert.equal(o.prev7, 24);
  assert.equal(o.period.start, '2026-10-01');
  assert.equal(o.period.credits, 19);
  assert.equal(o.period.elapsedDays, 10);
  assert.equal(o.period.totalDays, 31);
  assert.equal(o.period.prevCredits, 8, 'same first 10 days of the previous period');
  assert.equal(o.daily.length, 90);
  assert.equal(o.daily.at(-1).date, '2026-10-10');
  assert.equal(o.daily.at(-1).credits, 12);
  assert.equal(o.activeDays30, 4);
  assert.equal(o.avgPerActiveDay, 9.75);
});

test('daily series keeps the top five models and folds the rest into other', () => {
  const now = at(2026, 10, 10);
  const ledger = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((m, i) => e(now, 10 - i, m));
  const o = buildCreditOverview(ledger, { now, days: 7 });
  assert.deepEqual(o.models, ['a', 'b', 'c', 'd', 'e', 'other']);
  assert.equal(o.daily.length, 7);
  assert.equal(o.daily.at(-1).byModel.other, 5 + 4);
  assert.equal(o.daily.at(-1).credits, 10 + 9 + 8 + 7 + 6 + 5 + 4);
});

test('breakdowns cover model, work item, weekday, source and unattributed credits', () => {
  const now = at(2026, 10, 10);
  const o = buildCreditOverview([
    e(at(2026, 10, 5), 6, 'x', '1', 'auto'),
    e(at(2026, 10, 6), 2, 'y', null, 'manual'),
    e(at(2026, 10, 6), 4, 'x', '2', 'auto'),
  ], { now });
  const b = o.breakdown['7'];
  assert.equal(b.total, 12);
  assert.equal(b.unattributed, 2);
  assert.deepEqual(b.byModel.map(r => [r.key, r.credits]), [['x', 10], ['y', 2]]);
  assert.deepEqual(b.byWorkItem.map(r => r.key), ['1', '2']);
  assert.deepEqual(b.bySource.map(r => [r.key, r.credits]), [['auto', 10], ['manual', 2]]);
  assert.equal(b.byDayOfWeek[0].key, 'Mon');
  assert.equal(b.byDayOfWeek[0].credits, 6);
  assert.equal(b.byDayOfWeek[1].credits, 6);
});

test('budget pace reports under, will-exceed and over', () => {
  const now = at(2026, 10, 10);
  const ledger = [e(at(2026, 10, 1), 50), e(at(2026, 10, 9), 50)];
  let o = buildCreditOverview(ledger, { now, monthlyBudget: 1000 });
  assert.equal(o.budget.state, 'under');
  assert.equal(o.budget.pct, 10);
  assert.equal(o.budget.avgDaily, 10);
  assert.equal(o.budget.projected, 310);
  assert.equal(o.budget.resetDate, '2026-11-01');
  assert.equal(o.budget.daysLeft, 22);
  o = buildCreditOverview(ledger, { now, monthlyBudget: 200 });
  assert.equal(o.budget.state, 'will-exceed');
  assert.equal(o.budget.exceedDate, '2026-10-20');
  assert.equal(o.insights[0].level, 'warn');
  o = buildCreditOverview(ledger, { now, monthlyBudget: 80 });
  assert.equal(o.budget.state, 'over');
  assert.equal(o.budget.pct, 125);
  assert.equal(buildCreditOverview(ledger, { now }).budget, null);
});

test('insights flag spikes, unattributed spend, model concentration and weekly change', () => {
  const now = at(2026, 10, 20);
  const ledger = [
    e(at(2026, 10, 20), 60, 'big', null),
    e(at(2026, 10, 18), 5, 'big'),
    e(at(2026, 10, 16), 5, 'big'),
    e(at(2026, 10, 10), 5, 'big'),
    e(at(2026, 10, 9), 5, 'small'),
    e(at(2026, 10, 8), 5, 'big'),
  ];
  const titles = buildCreditOverview(ledger, { now }).insights.map(i => i.title);
  assert.ok(titles.some(t => /Today is .*× your usual day/.test(t)), titles.join(' | '));
  assert.ok(titles.some(t => /% of credits have no work item/.test(t)));
  assert.ok(titles.some(t => /^big is \d+% of your spend/.test(t)));
  assert.ok(titles.some(t => /Spend up \d+%/.test(t)));
  assert.ok(titles.length <= 4);
  assert.deepEqual(buildCreditOverview([], { now }).insights, []);
});

test('ignores non-numeric entries', () => {
  const now = at(2026, 10, 10);
  const o = buildCreditOverview([e(now, NaN), { ts: NaN, credits: 3, model: 'm' }, e(now, 2)], { now });
  assert.equal(o.today, 2);
});
