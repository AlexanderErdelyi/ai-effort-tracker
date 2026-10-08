const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelPrices, listCost } = require('../out/util/modelCatalog');
const tr = require('../out/analysis/usageTrends');

const tier = (input, cacheRead, cacheWrite, output) =>
  ({ input_price: input, cache_read_price: cacheRead, cache_write_price: cacheWrite, output_price: output, max_prompt_tokens: 200000 });
const prices = parseModelPrices(JSON.stringify([
  { id: 'opus', billing: { token_prices: { default: tier(400, 20, 500, 2000) } } },
  { id: 'sonnet', billing: { token_prices: { default: tier(200, 20, 250, 1000) } } },
  { id: 'cheap', billing: { token_prices: { default: tier(10, 1, 0, 40) } } }
]), 1);

const DAY = 86_400_000;
const NOW = new Date(2026, 5, 15, 12).getTime();
let seq = 0;
function call(ts, model, input, cached, output) {
  return { spanId: `c${++seq}`, ts, durationMs: 1000, model, inputTokens: input, cachedTokens: cached, outputTokens: output,
    credits: listCost(prices[model], { inputTokens: input, cachedTokens: cached, outputTokens: output }) };
}
function turn(sessionId, turnId, requests, extra = {}) {
  return { id: `${sessionId}-${turnId}`, ts: requests[0].ts, model: '', credits: 0, source: 'auto', branch: 'main',
    workItemId: 'WI-1', projectId: 'p1', debugUsage: { sessionId, turnId, requests, unpricedRequests: 0 }, ...extra };
}
const data = ledger => ({ creditLedger: ledger, toolsets: {}, modelPrices: prices, branches: {}, workItems: {}, projects: {} });

test('previous window has the same length and ends right before the current one', () => {
  assert.deepEqual(tr.previousWindow({ from: 1000, to: 1999 }), { from: 0, to: 999 });
  const from = new Date(2026, 5, 1).getTime(), to = new Date(2026, 5, 8).getTime() - 1;
  const prev = tr.previousWindow({ from, to });
  assert.equal(prev.to, from - 1);
  assert.equal(prev.to - prev.from, to - from);
});

test('delta direction and verdict per metric', () => {
  const c = tr.compareMetric;
  assert.equal(c('creditsPerTurn', 8, 10).verdict, 'better');
  assert.equal(c('creditsPerTurn', 12, 10).verdict, 'worse');
  assert.equal(c('creditsPerTurn', 12, 10).deltaPct, 20);
  assert.equal(c('cacheHitPct', 60, 50).verdict, 'better');
  assert.equal(c('cacheHitPct', 40, 50).verdict, 'worse');
  assert.equal(c('cacheHitPct', 40, 50).unit, 'points');
  assert.equal(c('cacheHitPct', 40, 50).delta, -10);
  assert.equal(c('cacheHitPct', 40, 50).deltaPct, null, 'percent metrics change in points');
  assert.equal(c('avoidable', 1, 4).verdict, 'better');
  assert.equal(c('avoidablePct', 9, 4).verdict, 'worse');
  assert.equal(c('premiumSharePct', 30, 70).verdict, 'better');
  for (const k of ['credits', 'calls', 'turns', 'sessions', 'subagentCredits']) {
    const d = c(k, 20, 10);
    assert.equal(d.direction, 'up');
    assert.equal(d.verdict, 'neutral', `${k} is a volume metric`);
  }
  assert.equal(c('creditsPerTurn', 10.05, 10).verdict, 'flat');
  assert.equal(c('cacheHitPct', 50.3, 50).verdict, 'flat');
  const none = c('creditsPerTurn', 5, null);
  assert.deepEqual([none.delta, none.direction, none.verdict], [null, null, null]);
  assert.equal(c('credits', 5, 0).deltaPct, null, 'no relative change from zero');
  assert.equal(c('credits', 5, 0).direction, 'up');
  assert.equal(c('cacheHitPct', null, 50).verdict, null);
  for (const k of tr.METRIC_KEYS) assert.ok(['lower', 'higher', 'neutral'].includes(tr.METRIC_BETTER[k]));
});

test('premium models are priced above the catalog median', () => {
  const isPremium = tr.premiumClassifier(prices);
  assert.equal(isPremium('opus'), true);
  assert.equal(isPremium('sonnet'), false);
  assert.equal(isPremium('cheap'), false);
  assert.equal(isPremium('unknown-model'), undefined);
  assert.equal(tr.premiumClassifier({ opus: prices.opus }), null, 'one priced model is not a mix');
});

test('comparison against the previous period: values, deltas, findings', () => {
  const filter = { days: 7 };
  const cur = NOW - 2 * DAY, prev = NOW - 9 * DAY, older = NOW - 20 * DAY;
  const d = data([
    turn('old', 't0', [call(older, 'cheap', 1000, 0, 10)]),
    // Previous week: opus with a model switch and a cold cache.
    turn('p1', 't1', [call(prev, 'opus', 60000, 0, 500)]),
    turn('p1', 't2', [call(prev + 60_000, 'sonnet', 60000, 0, 500)]),
    // This week: sonnet with a warm cache.
    turn('c1', 't1', [call(cur, 'sonnet', 60000, 0, 500)]),
    turn('c1', 't2', [call(cur + 60_000, 'sonnet', 62000, 59000, 500)])
  ]);
  const r = tr.usageComparison(d, filter, NOW);
  assert.equal(r.hasPrevious, true);
  assert.equal(r.partial, false);
  assert.equal(r.current.calls, 2);
  assert.equal(r.previous.calls, 2);
  assert.equal(r.current.premiumSharePct, 0);
  assert.ok(r.previous.premiumSharePct > 50);
  assert.equal(r.metrics.premiumSharePct.verdict, 'better');
  assert.equal(r.metrics.cacheHitPct.verdict, 'better');
  assert.equal(r.metrics.creditsPerTurn.verdict, 'better');
  assert.ok(r.previous.avoidable > 0, 'model switch wasted credits');
  assert.equal(r.current.avoidable, 0);
  assert.equal(r.metrics.avoidable.verdict, 'better');
  assert.equal(r.metrics.turns.verdict, 'flat');
  const sw = r.findings.find(f => f.id === 'model-switch-cache');
  assert.equal(sw.status, 'resolved');
  assert.equal(sw.creditsAtStake, null);
  assert.ok(sw.previousCreditsAtStake > 0);
  assert.equal(new Date(r.previousPeriod.to).getTime(), new Date(r.period.from).getTime() - 1);
  // Scope filter applies to both periods.
  const scoped = tr.usageComparison(d, { ...filter, workItemId: 'WI-other' }, NOW);
  assert.equal(scoped.hasPrevious, false);
  assert.equal(scoped.current.calls, 0);
});

test('empty and partial previous periods', () => {
  const only = data([turn('c1', 't1', [call(NOW - DAY, 'sonnet', 60000, 0, 500)])]);
  const r = tr.usageComparison(only, { days: 7 }, NOW);
  assert.equal(r.hasPrevious, false);
  assert.equal(r.previous, null);
  for (const k of tr.METRIC_KEYS) assert.equal(r.metrics[k].delta, null, `${k} shows "–" without previous data`);
  assert.match(r.note, /nothing to compare/);
  assert.ok(r.findings.every(f => f.status === null));
  // Tracking started in the middle of the previous week.
  const partial = data([
    turn('p1', 't1', [call(NOW - 9 * DAY, 'sonnet', 60000, 0, 500)]),
    turn('c1', 't1', [call(NOW - DAY, 'sonnet', 60000, 0, 500)])
  ]);
  const p = tr.usageComparison(partial, { days: 7 }, NOW);
  assert.equal(p.hasPrevious, true);
  assert.equal(p.partial, true);
  assert.match(p.note, /partly covered/);
  // Metrics without inputs stay null instead of 0.
  const empty = tr.periodMetrics(data([]), { days: 7 }, NOW);
  assert.deepEqual([empty.calls, empty.creditsPerTurn, empty.cacheHitPct, empty.avoidablePct, empty.premiumSharePct], [0, null, null, null, null]);
});

test('findings trend marks new, resolved, better, worse and same', () => {
  const f = (id, stake) => ({ id, title: id, severity: 'low', category: 'cache', detail: '', recommendation: '', creditsAtStake: stake, evidence: {} });
  const rows = tr.findingsTrend([f('a', 5), f('b', 20), f('c', 10), f('d', 10)], [f('b', 10), f('c', 30), f('d', 10.2), f('e', 4)]);
  const s = Object.fromEntries(rows.map(x => [x.id, x.status]));
  assert.deepEqual(s, { a: 'new', b: 'worse', c: 'better', d: 'same', e: 'resolved' });
  assert.ok(tr.findingsTrend([f('a', 5)], null).every(x => x.status === null));
});

test('trend buckets per day for short ranges and per week for long ones', () => {
  const d = data([
    turn('s1', 't1', [call(NOW - 3 * DAY, 'sonnet', 60000, 0, 500)]),
    turn('s1', 't2', [call(NOW - 3 * DAY + 60_000, 'sonnet', 62000, 59000, 500)]),
    turn('s2', 't1', [call(NOW - 40 * DAY, 'opus', 60000, 0, 500)], { workItemId: 'WI-2' })
  ]);
  const week = tr.usageTrend(d, { days: 7 }, NOW);
  assert.equal(week.granularity, 'day');
  assert.ok(week.points.length >= 7 && week.points.length <= 8);
  assert.equal(week.points.reduce((n, p) => n + p.calls, 0), 2);
  const hit = week.points.find(p => p.calls);
  assert.equal(hit.turns, 2);
  assert.ok(hit.cacheHitPct > 0);
  const quiet = week.points.find(p => !p.calls);
  assert.deepEqual([quiet.creditsPerTurn, quiet.cacheHitPct, quiet.premiumSharePct], [null, null, null]);
  for (let i = 1; i < week.points.length; i++) assert.equal(week.points[i].from, week.points[i - 1].to + 1);

  const quarter = tr.usageTrend(d, { days: 90 }, NOW);
  assert.equal(quarter.granularity, 'week');
  assert.ok(quarter.points.length >= 13 && quarter.points.length <= 14);
  assert.equal(quarter.points.reduce((n, p) => n + p.calls, 0), 3);
  const scoped = tr.usageTrend(d, { days: 90, workItemId: 'WI-2' }, NOW);
  assert.equal(scoped.points.reduce((n, p) => n + p.calls, 0), 1);
  assert.equal(scoped.points.find(p => p.calls).premiumSharePct, 100);

  const from = new Date(2026, 5, 1).getTime(), to = new Date(2026, 5, 15).getTime() - 1;
  const custom = tr.usageTrend(d, { from, to }, NOW);
  assert.equal(custom.points.length, 14);
  assert.equal(custom.points[0].start, '2026-06-01');
  // All time starts at the first call instead of ten years of empty weeks.
  const all = tr.usageTrend(d, { days: 3650 }, NOW);
  assert.ok(all.points.length <= 8);
  assert.equal(all.points.reduce((n, p) => n + p.calls, 0), 3);
  assert.deepEqual(tr.usageTrend(data([]), { days: 3650 }, NOW).points, []);
});
