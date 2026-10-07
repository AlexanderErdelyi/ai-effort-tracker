const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');

const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { buildCalendar, calendarStart, localDay } = require('../out/analysis/calendar');
const { Database } = require('../out/store/database');
const { mergeStores } = require('../out/store/mergeStore');

const at = (day, hour = 10) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour).getTime(); };
const bucket = (o = {}) => ({ humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0, linesHuman: 0, linesAi: 0, hours: [], ...o });

test('grid starts on a Sunday about a year back and ends today', () => {
  const start = calendarStart('2026-10-07');
  const [y, m, d] = start.split('-').map(Number);
  assert.equal(new Date(y, m - 1, d, 12).getDay(), 0);
  assert.equal(start, '2025-10-05');
  const empty = buildCalendar({ branches: {}, today: '2026-10-07' });
  assert.deepEqual(empty, { start, end: '2026-10-07', days: [], totals: { activeDays: 0, activeMs: 0, credits: 0, lines: 0 }, max: { activeMs: 0, credits: 0, lines: 0 } });
});

test('days combine branch buckets, ledger credits and manual effort per work item', () => {
  const cal = buildCalendar({
    today: '2026-10-07',
    branches: {
      'feature/a': { workItemId: '100', daily: {
        '2026-10-06': bucket({ humanCoding: 60000, aiGenerating: 30000, reviewing: 10000, linesHuman: 5, linesAi: 20, linesByCategory: { code: { human: 5, ai: 15 }, docs: { human: 0, ai: 5 } } }),
        '2026-10-07': bucket({ humanCoding: 1000 })
      } },
      'feature/b': { workItemId: null, daily: {
        '2026-10-06': bucket({ aiGenerating: 5000, linesAi: 3 }),
        '2024-01-01': bucket({ humanCoding: 999999 })
      } }
    },
    ledger: [
      { ts: at('2026-10-06'), credits: 4.5, branch: 'feature/a' },
      { ts: at('2026-10-06', 23), credits: 1, branch: 'feature/b', workItemId: '200' },
      { ts: at('2026-10-05'), credits: 2, branch: null, workItemId: '300' },
      { ts: at('2020-01-01'), credits: 50, branch: 'feature/a' },
      { ts: at('2026-10-05'), credits: Number.NaN, branch: 'feature/a' }
    ],
    manualEffort: [{ ts: at('2026-10-06'), workItemId: '100', category: 'spec', durationMs: 3600000, linesAdded: 7, isAi: false }],
    timeEntries: [{ startTs: at('2026-10-05'), createdAt: at('2026-10-07'), durationMs: 120000, branch: 'feature/a' }]
  });

  assert.deepEqual(cal.days.map(d => d.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
  const d = cal.days[1];
  assert.equal(d.humanMs, 60000);
  assert.equal(d.aiMs, 35000);
  assert.equal(d.reviewMs, 10000);
  assert.equal(d.manualMs, 3600000);
  assert.equal(d.activeMs, 60000 + 35000 + 10000 + 3600000);
  assert.equal(d.linesHuman, 12);
  assert.equal(d.linesAi, 23);
  assert.equal(d.credits, 5.5);
  assert.deepEqual(d.categories, { code: { human: 5, ai: 15 }, docs: { human: 0, ai: 5 }, spec: { human: 7, ai: 0 } });
  assert.deepEqual(d.items, [
    { branch: null, workItemId: '100', activeMs: 3600000, lines: 7, credits: 0 },
    { branch: 'feature/a', workItemId: '100', activeMs: 100000, lines: 25, credits: 4.5 },
    { branch: 'feature/b', workItemId: '200', activeMs: 5000, lines: 3, credits: 1 }
  ]);

  const before = cal.days[0];
  assert.equal(before.credits, 2);
  assert.equal(before.manualMs, 120000);
  assert.equal(before.categories, null);
  assert.deepEqual(before.items.map(i => [i.branch, i.workItemId]), [['feature/a', '100'], [null, '300']]);

  assert.deepEqual(cal.totals, { activeDays: 3, activeMs: 120000 + d.activeMs + 1000, credits: 7.5, lines: 35 });
  assert.deepEqual(cal.max, { activeMs: d.activeMs, credits: 5.5, lines: 35 });
});

test('placeholder work items are reported as unassigned', () => {
  const cal = buildCalendar({
    today: '2026-10-07',
    branches: { main: { workItemId: '__unassigned__', daily: { '2026-10-07': bucket({ humanCoding: 1000 }) } }, x: { workItemId: '42', daily: {} } },
    ledger: [{ ts: at('2026-10-07'), credits: 1, branch: 'x', workItemId: '__unassigned__' }],
    manualEffort: [{ ts: at('2026-10-07'), workItemId: 'unknown', durationMs: 5000 }]
  });
  assert.deepEqual(cal.days[0].items.map(i => [i.branch, i.workItemId]), [[null, null], ['main', null], ['x', '42']]);
});

test('days before the per-category counter keep totals but no category split', () => {
  const cal = buildCalendar({ today: '2026-10-07', branches: { main: { daily: { '2026-10-01': bucket({ linesHuman: 10 }) } } } });
  assert.equal(cal.days[0].categories, null);
  assert.equal(cal.days[0].linesHuman, 10);
});

test('recorded line changes fill the per-category day counter and merge additively', t => {
  const dir = path.join(__dirname, `.calendar-${randomUUID()}`);
  fs.mkdirSync(dir);
  const instances = [];
  t.after(() => {
    for (const db of instances) {
      if (db.saveTimer) clearTimeout(db.saveTimer);
      if (db.refreshTimer) clearInterval(db.refreshTimer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new Database(dir); instances.push(db);
  db.recordLineChange('main', '.ts', 'ai', 12, 0, 'src/a.ts');
  db.recordLineChange('main', '.ts', 'human', 3, 1, 'src/a.ts');
  db.recordLineChange('main', '.md', 'human', 4, 0, 'docs/readme.md');
  db.recordLineChange('main', '.ts', 'human', 0, 9, 'src/a.ts');
  db.flushSync();

  const today = localDay(Date.now());
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'effort-tracker.json'), 'utf8'));
  const counters = raw.branches.main.daily[today].linesByCategory;
  const total = Object.values(counters).reduce((s, v) => s + v.human + v.ai, 0);
  assert.equal(total, 19);
  const day = db.getCalendar(today).days.find(d => d.date === today);
  assert.equal(day.linesAi, 12);
  assert.equal(day.linesHuman, 7);
  assert.deepEqual(day.categories, counters);

  const base = JSON.parse(JSON.stringify(raw));
  const local = JSON.parse(JSON.stringify(raw));
  const disk = JSON.parse(JSON.stringify(raw));
  const cat = Object.keys(counters)[0];
  local.branches.main.daily[today].linesByCategory[cat].ai += 2;
  disk.branches.main.daily[today].linesByCategory[cat].ai += 5;
  const merged = mergeStores(base, local, disk);
  assert.equal(merged.branches.main.daily[today].linesByCategory[cat].ai, counters[cat].ai + 7);
});
