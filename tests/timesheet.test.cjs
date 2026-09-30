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
const { Database } = require('../out/store/database');
const ts = require('../out/analysis/timesheet');

test('week helpers start on Monday and cross month/year boundaries', () => {
  assert.equal(ts.weekStartOf('2026-01-01'), '2025-12-29');
  assert.equal(ts.weekStartOf('2026-01-04'), '2025-12-29');
  assert.equal(ts.weekStartOf('2026-01-05'), '2026-01-05');
  assert.deepEqual(ts.weekDays('2026-01-07'), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11']);
  assert.equal(ts.shiftWeek('2026-01-05', -1), '2025-12-29');
  assert.equal(ts.shiftWeek('2026-01-05', 2), '2026-01-19');
});

test('rounding: none keeps 2 decimals, quarter and half hours round to nearest', () => {
  assert.equal(ts.roundHours(1.234, 'none'), 1.23);
  assert.equal(ts.roundHours(1.13, '0.25'), 1.25);
  assert.equal(ts.roundHours(1.12, '0.25'), 1);
  assert.equal(ts.roundHours(1.3, '0.5'), 1.5);
  assert.equal(ts.roundHours(0.2, '0.5'), 0);
  assert.equal(ts.roundHours(NaN, '0.5'), 0);
  assert.equal(ts.roundHours(-2, 'none'), 0);
  assert.equal(ts.normalizeRounding('0.3'), 'none');
});

test('buildTimesheet fills the grid, totals rounded cells, skips empty rows and exports CSV', () => {
  const src = [
    { workItemId: '7', title: 'Login, "SSO"', externalRef: 'AB#7', projectId: 'p', daily: [
      { date: '2026-01-05', hours: 1.1 }, { date: '2026-01-05', hours: 0.2 }, { date: '2026-01-07', hours: 2.6 }, { date: '2026-01-12', hours: 9 }, { date: 'junk', hours: 3 }, { date: '2026-01-06', hours: NaN }
    ] },
    { workItemId: '8', title: null, externalRef: null, projectId: null, daily: [{ date: '2025-12-31', hours: 4 }] },
    { workItemId: '9', title: '=cmd', externalRef: null, projectId: null, daily: [{ date: '2026-01-11', hours: 0.4 }] }
  ];
  const s = ts.buildTimesheet(src, '2026-01-07', '0.5');
  assert.equal(s.weekStart, '2026-01-05');
  assert.deepEqual(s.rows.map(r => r.workItemId), ['7', '9']);
  assert.deepEqual(s.rows[0].cells, [1.5, 0, 2.5, 0, 0, 0, 0]);
  assert.equal(s.rows[0].total, 4);
  assert.deepEqual(s.rows[1].cells, [0, 0, 0, 0, 0, 0, 0.5]);
  assert.deepEqual(s.dayTotals, [1.5, 0, 2.5, 0, 0, 0, 0.5]);
  assert.equal(s.total, 4.5);
  assert.equal(s.rawTotal, 4.3);
  const csv = ts.timesheetCsv(s).split('\n');
  assert.equal(csv[0], 'work_item,external_ref,title,day,hours');
  assert.equal(csv[1], '7,AB#7,"Login, ""SSO""",2026-01-05,1.5');
  assert.equal(csv[3], "9,,'=cmd,2026-01-11,0.5");
  assert.equal(csv.length, 4);
  const exact = ts.buildTimesheet(src, '2026-01-05');
  assert.equal(exact.rounding, 'none');
  assert.equal(exact.rows[0].cells[0], 1.3);
});

test('timesheet hours match work item totals (tracked + manual) and unassigned branches get their own row', t => {
  const dir = path.join(__dirname, `.timesheet-${randomUUID()}`);
  fs.mkdirSync(dir);
  const db = new Database(dir);
  t.after(() => {
    if (db.saveTimer) clearTimeout(db.saveTimer);
    if (db.refreshTimer) clearInterval(db.refreshTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.upsertWorkItem('42', { title: 'Timesheet' });
  db.setWorkItemForBranch('feature/a', '42');
  db.setWorkItemForBranch('feature/b', '42');
  db.recordTime('feature/a', 'humanCoding', 60 * 60000);
  db.recordTime('feature/b', 'aiGenerating', 30 * 60000);
  db.recordTime('feature/b', 'idle', 90 * 60000);
  db.recordTime('scratch', 'reviewing', 15 * 60000);
  const start = new Date(); start.setHours(9, 0, 0, 0);
  db.addTimeEntry({ source: 'manual', workItemId: '42', startTs: start.getTime(), endTs: start.getTime() + 45 * 60000, durationMs: 45 * 60000 });
  const week = ts.weekStartOf(Date.now());
  const sheet = ts.buildTimesheet(db.getTimesheetSource(), week);
  const row = sheet.rows.find(r => r.workItemId === '42');
  const sum = db.getWorkItemSummary('42');
  const activeHours = (sum.humanCodingMs + sum.aiGeneratingMs + sum.reviewingMs) / 3600000;
  assert.equal(row.total, Math.round(activeHours * 100) / 100);
  assert.equal(row.total, 2.25);
  const un = sheet.rows.find(r => r.workItemId === '__unassigned__');
  assert.equal(un.total, 0.25);
  assert.equal(sheet.total, 2.5);
});
