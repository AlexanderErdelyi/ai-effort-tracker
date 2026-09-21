const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const load = Module._load;
const config = { baselineLocPerMinute: 8 };
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: key => config[key] }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { categorize, categorizeExt, ALL_CATEGORIES } = require('../out/util/fileTypes');
const { renderDashboardHtml } = require('../out/ui/dashboard');
afterEach(() => {
  delete config['categoryRules.extensions'];
  delete config['categoryRules.folders'];
});

function store(t, branches = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-translation-'));
  const file = path.join(dir, 'effort-tracker.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 11, branches, workItems: {}, projects: {},
    creditLedger: [], manualEffort: [], reassignments: [], timeEntries: []
  }));
  const db = new Database(dir);
  t.after(() => { db.flushSync(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, file };
}
function fileStat(effectiveAi) {
  return { humanAdded: 0, humanDeleted: 0, aiAdded: effectiveAi, aiDeleted: 0,
    edits: 1, lastTs: 1000, effectiveAi };
}
function historical() {
  return {
    workItemId: null, time: { humanCoding: 1000, aiGenerating: 2000, reviewing: 3000, idle: 4000 },
    copilotAcceptances: 1, lineChanges: {
      xlf: { human: { added: 0, deleted: 0 }, ai: { added: 91201, deleted: 86016 } }
    },
    effectiveLinesVersion: 2, effectiveLegacyBaseline: {},
    effectiveLines: {
      programming: { human: 4, ai: 396 }, documentation: { human: 0, ai: 105 },
      config: { human: 0, ai: 21 }, other: { human: 0, ai: 5395 }
    },
    files: { 'Translations/Core.de-DE.xlf': fileStat(5395) }
  };
}

test('dedicated translation formats and explicit user rules use the separate category', () => {
  assert.ok(ALL_CATEGORIES.includes('translation'));
  for (const ext of ['xlf', 'xliff', 'po', 'pot', 'resx']) {
    assert.equal(categorize(`C:\\app\\text.${ext.toUpperCase()}`), 'translation');
    assert.equal(categorizeExt(ext), 'translation');
  }
  assert.equal(categorize('app.json'), 'config');
  assert.equal(categorize('app.xml'), 'config');
  assert.equal(categorize('Core.xlf', true), 'other');
  config['categoryRules.extensions'] = { '*.xlf': 'programming' };
  assert.equal(categorize('Core.xlf'), 'programming');
  config['categoryRules.folders'] = { Translations: 'translation' };
  assert.equal(categorize('app\\Translations\\en.json'), 'translation');
  assert.equal(categorize('app\\Translations\\Core.xlf'), 'translation');
});

test('historical 5921 lines become 526 productivity plus 5395 translation, without losing history', t => {
  const original = historical();
  const { db, dir, file } = store(t, { branch: original });
  const summary = db.getSummaryForBranch('branch');
  assert.equal(summary.effectiveLinesAi + summary.effectiveLinesHuman, 526);
  assert.deepEqual(summary.effectiveByCategory.translation, { human: 0, ai: 5395 });
  assert.equal(Object.values(summary.effectiveByCategory).reduce((n, x) => n + x.human + x.ai, 0), 5921);
  assert.deepEqual(summary.byExt, original.lineChanges);
  assert.equal(summary.byCategory.translation.ai.added, 5395);
  assert.equal(summary.roi.actualHours, 6000 / 3600000);
  db.getSummaryForBranch('branch');
  db.flushSync();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.branches.branch.effectiveLines.other.ai, 0);
  assert.equal(disk.branches.branch.files['Translations/Core.de-DE.xlf'].effectiveCategory, 'translation');
  const restarted = new Database(dir);
  restarted.recordEffectiveLines('branch', 'Translations/Core.de-DE.xlf', 'ai', 7);
  const after = restarted.getSummaryForBranch('branch');
  assert.equal(after.effectiveLinesAi + after.effectiveLinesHuman, 526);
  assert.equal(after.effectiveByCategory.translation.ai, 5402);
  restarted.flushSync();
});

test('reclassification also runs before first new edit and preserves unattributable history', t => {
  const old = historical();
  old.effectiveLines.other.ai += 100;
  old.effectiveLegacyBaseline.other = { human: 0, ai: 200 };
  const { db } = store(t, { branch: old });
  db.recordEffectiveLines('branch', 'Translations/Core.de-DE.xlf', 'human', 3);
  const summary = db.getSummaryForBranch('branch');
  assert.deepEqual(summary.effectiveByCategory.translation, { human: 3, ai: 5395 });
  assert.equal(summary.effectiveByCategory.other.ai, 300);
  assert.equal(summary.effectiveLinesAi + summary.effectiveLinesHuman, 826);
  db.getSummaryForBranch('branch');
  assert.equal(db.getSummaryForBranch('branch').effectiveByCategory.translation.ai, 5395);
});

test('work item and project rollups exclude automatic/manual translations from generated value, not cost/time', t => {
  const { db } = store(t);
  const project = db.upsertProject({ name: 'Project', settings: {
    hourlySellRate: 166, hourlyCostRate: 44, currency: 'EUR', creditCostPerUnit: 0.01
  } });
  db.upsertWorkItem('1', { projectId: project.id });
  db.setWorkItemForBranch('branch', '1');
  db.recordEffectiveLines('branch', 'code.al', 'ai', 480);
  db.recordTime('branch', 'humanCoding', 3600000);
  db.recordCredits('branch', 'model', 100);
  const before = db.getWorkItemSummary('1');
  db.recordEffectiveLines('branch', 'Core.xlf', 'ai', 5395);
  db.addManualEffort({ workItemId: '1', category: 'translation', linesAdded: 40, linesDeleted: 10, isAi: false });
  const work = db.getWorkItemSummary('1');
  assert.deepEqual(work.generated, before.generated);
  assert.deepEqual(work.generated, { equivalentHours: 1, generatedValue: 166 });
  assert.deepEqual(work.roi, before.roi);
  assert.deepEqual(work.effectiveByCategory.translation, { human: 50, ai: 5395 });
  assert.equal(work.effectiveLinesAi + work.effectiveLinesHuman, 480);
  const p = db.getProjectSummary(project.id);
  assert.equal(p.effectiveLinesAi + p.effectiveLinesHuman, 480);
  assert.deepEqual(p.effectiveByCategory.translation, work.effectiveByCategory.translation);
  const actual = db.getEstimateVsActual('1').byCategory.find(c => c.category === 'translation');
  assert.equal(actual.actual, 5445, 'translation estimate actuals remain available separately');
});

test('extension-only legacy data and git-seeded translation totals are separated', t => {
  const legacy = historical();
  delete legacy.files;
  delete legacy.effectiveLines;
  delete legacy.effectiveLinesVersion;
  const { db } = store(t, { legacy });
  const old = db.getSummaryForBranch('legacy');
  assert.equal(old.effectiveLinesAi, 0);
  assert.equal(old.effectiveByCategory.translation.ai, 91201);
  db.seedEffectiveLinesFromGit('seeded', {
    programming: { added: 10, removed: 2 }, translation: { added: 100, removed: 20 }
  });
  const seeded = db.getSummaryForBranch('seeded');
  assert.equal(seeded.effectiveLinesAi, 12);
  assert.equal(seeded.effectiveByCategory.translation.ai, 120);
});

test('explicit recategorization preserves counts and updates productivity in both directions', t => {
  const { db } = store(t);
  db.recordEffectiveLines('branch', 'Core.xlf', 'ai', 100);
  config['categoryRules.extensions'] = { xlf: 'programming' };
  const code = db.getSummaryForBranch('branch');
  assert.equal(code.effectiveLinesAi, 100);
  assert.equal(code.effectiveByCategory.translation.ai, 0);
  delete config['categoryRules.extensions'];
  const translation = db.getSummaryForBranch('branch');
  assert.equal(translation.effectiveLinesAi, 0);
  assert.equal(translation.effectiveByCategory.translation.ai, 100);
});

test('new translation folder rules reclassify existing JSON effective counters', t => {
  const old = historical();
  old.effectiveLines = { config: { human: 0, ai: 100 } };
  old.files = { 'Translations/en.json': fileStat(100) };
  config['categoryRules.folders'] = { Translations: 'translation' };
  const { db } = store(t, { branch: old });
  const summary = db.getSummaryForBranch('branch');
  assert.equal(summary.effectiveLinesAi, 0);
  assert.equal(summary.effectiveByCategory.translation.ai, 100);
  assert.equal(summary.byCategory.translation.ai.added, 100);
});

test('dashboard displays translation counts separately and keeps productivity at 526', t => {
  const { db } = store(t, { branch: historical() });
  const summary = db.getSummaryForBranch('branch');
  const html = renderDashboardHtml([summary], 'branch', 'test');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function insights'));
  new vm.Script(script);
  const start = script.indexOf('function insights(');
  const end = script.indexOf('function billingHtml(', start);
  const context = { CFG: { baselineLocPerMinute: 8 }, roiOf: () => ({}) };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  const insight = context.insights(summary);
  assert.equal(insight.totalNet, 526);
  assert.equal(insight.manualEquivMin, 65.75);
  const separate = context.translationSummaryHtml(summary);
  assert.match(separate, /5395/);
  assert.match(separate, /Excluded from productivity/);
  assert.match(separate, /Tracked time and credit costs remain included/);
});
