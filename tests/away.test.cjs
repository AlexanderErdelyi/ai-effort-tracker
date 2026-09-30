const test = require('node:test');
const assert = require('node:assert/strict');
const away = require('../out/analysis/away');

const MIN = 60_000;
const cfg = { minMs: 15 * MIN, maxMs: 240 * MIN };
const T0 = Date.UTC(2026, 0, 5, 9, 0);

test('awayPeriod applies min/max limits', () => {
  assert.equal(away.awayPeriod(T0, T0 + 10 * MIN, [], cfg), null);
  assert.equal(away.awayPeriod(T0, T0 + 300 * MIN, [], cfg), null);
  assert.equal(away.awayPeriod(T0 + MIN, T0, [], cfg), null);
  assert.equal(away.awayPeriod(NaN, T0, [], cfg), null);
  const p = away.awayPeriod(T0, T0 + 30 * MIN, [], cfg);
  assert.deepEqual(p, { start: T0, end: T0 + 30 * MIN, durationMs: 30 * MIN, coveredMs: 0 });
});

test('time another window was active is subtracted (overlaps merged, clipped)', () => {
  const others = [
    { start: T0 - 5 * MIN, end: T0 + 5 * MIN },
    { start: T0 + 3 * MIN, end: T0 + 8 * MIN },
    { start: T0 + 50 * MIN, end: T0 + 70 * MIN }
  ];
  assert.equal(away.coveredMs(T0, T0 + 60 * MIN, others), 18 * MIN);
  const p = away.awayPeriod(T0, T0 + 60 * MIN, others, cfg);
  assert.equal(p.durationMs, 42 * MIN);
  assert.equal(p.coveredMs, 18 * MIN);
  assert.equal(away.awayPeriod(T0, T0 + 30 * MIN, [{ start: T0, end: T0 + 20 * MIN }], cfg), null);
});

test('addBeat merges close beats, splits gaps and prunes old windows', () => {
  let f = away.parseHeartbeats(null);
  f = away.addBeat(f, 'a', T0, T0 + 15_000);
  f = away.addBeat(f, 'a', T0 + 30_000, T0 + 45_000);
  assert.deepEqual(f.windows.a.active, [[T0, T0 + 45_000]]);
  f = away.addBeat(f, 'a', T0 + 10 * MIN, T0 + 10 * MIN + 15_000);
  assert.equal(f.windows.a.active.length, 2);
  f = away.addBeat(f, 'b', T0 + 20 * MIN, T0 + 21 * MIN);
  assert.deepEqual(away.otherWindowsActivity(f, 'a'), [{ start: T0 + 20 * MIN, end: T0 + 21 * MIN }]);
  const later = T0 + away.HEARTBEAT_KEEP_MS + 30 * MIN;
  f = away.addBeat(f, 'c', later - 15_000, later);
  assert.deepEqual(Object.keys(f.windows), ['c']);
});

test('parseHeartbeats and otherWindowsActivity tolerate junk', () => {
  assert.deepEqual(away.parseHeartbeats('not json'), { windows: {} });
  assert.deepEqual(away.parseHeartbeats('[1,2]'), { windows: {} });
  const f = away.parseHeartbeats(JSON.stringify({ windows: { x: { updatedAt: T0, active: [[T0, T0 + MIN], ['a', 3], null] }, y: null } }));
  assert.deepEqual(away.otherWindowsActivity(f, 'z'), [{ start: T0, end: T0 + MIN }]);
  assert.deepEqual(away.prune(f, T0 + MIN).windows.x.active, [[T0, T0 + MIN]]);
  assert.match(away.describeAway({ start: T0, end: T0 + 75 * MIN, durationMs: 75 * MIN, coveredMs: 0 }), /^1 h 15 min \(\d\d:\d\d\u2013\d\d:\d\d\)$/);
});
