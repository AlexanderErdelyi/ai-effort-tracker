const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { lineDiff, meaningfulLineVersions } = require('../out/util/lineDiff');
const { lastReflogMessage, rewritesWorkingTree, recentWorkingTreeOp, gitDirFor } = require('../out/util/gitOps');
const { planChurnFix, findChurnOutliers, distribute } = require('../out/analysis/lineChurn');
const { checkDataHealth } = require('../out/analysis/dataHealth');

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const openDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-line-guard-'));
  const db = new Database(dir);
  t.after(() => { if (db.saveTimer) clearTimeout(db.saveTimer); if (db.refreshTimer) clearInterval(db.refreshTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};
const clone = o => JSON.parse(JSON.stringify(o));
const zeros = () => new Array(24).fill(0);
const bucket = (linesAi, cats, translation) => {
  const b = { humanCoding: 0, aiGenerating: 1000, reviewing: 0, idle: 0, linesHuman: 0, linesAi, hours: zeros(),
    hoursByMode: { humanCoding: zeros(), aiGenerating: zeros(), reviewing: zeros() } };
  if (cats) b.linesByCategory = cats;
  if (translation !== undefined) b.linesAiTranslation = translation;
  return b;
};

test('lineDiff counts only lines that really changed (#160)', () => {
  const doc = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  assert.deepEqual(lineDiff(doc, [...doc]), { added: 0, deleted: 0 });
  const edited = [...doc]; edited.splice(100, 0, 'new');
  assert.deepEqual(lineDiff(doc, edited), { added: 1, deleted: 0 });
  const changed = [...doc]; changed[10] = 'x'; changed[400] = 'y';
  assert.deepEqual(lineDiff(doc, changed), { added: 2, deleted: 2 });
  assert.equal(meaningfulLineVersions(doc, changed), 4);
  assert.deepEqual(lineDiff([], ['a', 'b']), { added: 2, deleted: 0 });
  // Huge blocks fall back to multiset matching.
  const big = Array.from({ length: 1500 }, (_, i) => `b${i}`);
  assert.deepEqual(lineDiff(big, [...big].reverse()), { added: 0, deleted: 0 });
});

test('reflog parsing tells working-tree git operations from commits (#160)', () => {
  const log = 'a b Me <m> 1 +0100\tcommit: x\nb c Me <m> 2 +0100\tcheckout: moving from main to dev\n';
  assert.equal(lastReflogMessage(log), 'checkout: moving from main to dev');
  assert.equal(rewritesWorkingTree('checkout: moving from main to dev'), true);
  assert.equal(rewritesWorkingTree('pull: Fast-forward'), true);
  assert.equal(rewritesWorkingTree('reset: moving to HEAD~1'), true);
  assert.equal(rewritesWorkingTree('rebase (finish): returning to refs/heads/x'), true);
  assert.equal(rewritesWorkingTree('commit: add feature'), false);
  assert.equal(rewritesWorkingTree('commit (amend): fix'), false);
  assert.equal(rewritesWorkingTree(''), false);
});

test('recentWorkingTreeOp reads the HEAD reflog and index.lock, also for linked worktrees (#160)', t => {
  const root = tmp(t, 'aet-gitops-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const file = path.join(repo, 'src', 'a.al');
  const head = path.join(repo, '.git', 'logs', 'HEAD');
  fs.writeFileSync(head, 'a b Me <m> 1 +0100\tcheckout: moving from main to dev\n');
  const now = fs.statSync(head).mtimeMs;
  assert.equal(recentWorkingTreeOp(file, now + 1000), true);
  assert.equal(recentWorkingTreeOp(file, now + 60_000), false);
  fs.appendFileSync(head, 'b c Me <m> 2 +0100\tcommit: x\n');
  assert.equal(recentWorkingTreeOp(file, fs.statSync(head).mtimeMs + 1000), false);
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  assert.equal(recentWorkingTreeOp(file, now + 3_600_000), true);

  // Linked worktree: `.git` is a file pointing at the worktree's git dir.
  const wtGit = path.join(repo, '.git', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wtGit, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'logs', 'HEAD'), 'a b Me <m> 1 +0100\tpull: Fast-forward\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(gitDirFor(wt), wtGit);
  assert.equal(recentWorkingTreeOp(path.join(wt, 'x.md'), Date.now()), true);
  assert.equal(recentWorkingTreeOp(path.join(root, 'nogit', 'x.md')), false);
});

test('planChurnFix keeps plausible files and recounts or drops implausible ones (#160)', () => {
  assert.equal(planChurnFix({ aiAdded: 900, aiDeleted: 900, edits: 2 }), undefined, 'below 2000 lines');
  assert.equal(planChurnFix({ aiAdded: 5000, aiDeleted: 0, edits: 100, effectiveAi: 100 }), undefined, 'below 200 per edit');
  assert.equal(planChurnFix({ aiAdded: 3000, aiDeleted: 1000, edits: 5, effectiveAi: 2000 }), undefined, 'effective close to raw');
  assert.deepEqual(planChurnFix({ aiAdded: 40_000, aiDeleted: 38_000, edits: 64, effectiveAi: 2024 }),
    { aiAdded: 1038, aiDeleted: 986, effectiveAi: 2024 });
  assert.deepEqual(planChurnFix({ aiAdded: 1_600_000, aiDeleted: 1_560_000, edits: 53, effectiveAi: 1_560_000 }),
    { aiAdded: 0, aiDeleted: 0, effectiveAi: 0 });
  assert.deepEqual(planChurnFix({ aiAdded: 17_000, aiDeleted: 0, edits: 1 }), { aiAdded: 0, aiDeleted: 0, effectiveAi: 0 });
});

test('distribute splits proportionally without exceeding any day', () => {
  assert.deepEqual(distribute(10, { a: 30, b: 10 }), { a: 8, b: 2 });
  assert.deepEqual(distribute(100, { a: 3, b: 4 }), { a: 3, b: 4 });
  const parts = distribute(7, { a: 1, b: 1, c: 100 });
  assert.equal(Object.values(parts).reduce((s, v) => s + v, 0), 7);
  assert.ok((parts.a ?? 0) <= 1 && (parts.b ?? 0) <= 1);
  assert.deepEqual(distribute(0, { a: 3 }), {});
});

/** develop: a regenerated xlf, an AL file with rewrite churn and a normal file; feature: clean. */
function seed(db) {
  db.store['repo\u0000develop'] = {
    workItemId: null, time: { humanCoding: 0, aiGenerating: 1000, reviewing: 0, idle: 0 }, copilotAcceptances: 80,
    lineChanges: {
      'xlf': { human: { added: 0, deleted: 0 }, ai: { added: 60_000, deleted: 59_000 } },
      'al': { human: { added: 5, deleted: 1 }, ai: { added: 40_500, deleted: 38_000 } }
    },
    effectiveLines: { translation: { human: 0, ai: 59_000 }, programming: { human: 4, ai: 2200 } },
    files: {
      'Translations/App.de-DE.xlf': { humanAdded: 0, humanDeleted: 0, aiAdded: 60_000, aiDeleted: 59_000, edits: 10, lastTs: 1, effectiveAi: 59_000, effectiveCategory: 'translation' },
      'src/Big.Codeunit.al': { humanAdded: 0, humanDeleted: 0, aiAdded: 40_000, aiDeleted: 38_000, edits: 64, lastTs: 1, effectiveAi: 2024, effectiveCategory: 'programming' },
      'src/Small.al': { humanAdded: 5, humanDeleted: 1, aiAdded: 500, aiDeleted: 0, edits: 20, lastTs: 1, effectiveAi: 176, effectiveCategory: 'programming' }
    },
    daily: {
      '2025-01-01': bucket(70_500, { translation: { human: 0, ai: 30_000 }, programming: { human: 0, ai: 40_500 } }, 30_000),
      '2025-01-02': bucket(20_000, { translation: { human: 0, ai: 20_000 } }, 20_000),
      '2025-01-03': bucket(10_000)
    }
  };
  db.store['repo\u0000feature'] = {
    workItemId: null, time: { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 }, copilotAcceptances: 1,
    lineChanges: { 'al': { human: { added: 0, deleted: 0 }, ai: { added: 30, deleted: 0 } } },
    files: { 'src/F.al': { humanAdded: 0, humanDeleted: 0, aiAdded: 30, aiDeleted: 0, edits: 3, lastTs: 1, effectiveAi: 30 } },
    daily: { '2025-01-02': bucket(30) }
  };
}

test('data health flags implausible line churn with a recount fix (#160)', t => {
  const db = openDb(t); seed(db);
  const r = checkDataHealth(db.getHealthData().data, { schemaVersion: 1, expectedSchemaVersion: 1 });
  const c = r.checks.find(x => x.id === 'implausible-line-churn');
  assert.ok(c);
  assert.equal(c.count, 2);
  assert.equal(c.fix.arg, 'implausible-line-churn');
  assert.match(c.examples[0].label, /App\.de-DE\.xlf: 119,000 → 0 AI lines/);
  assert.equal(findChurnOutliers(db.store).length, 2);
});

test('fixLineChurn recounts files, totals and days and undo restores everything (#160)', t => {
  const db = openDb(t); seed(db);
  const original = clone(db.store);
  const res = db.fixLineChurn();
  assert.equal(res.files, 2);
  assert.equal(res.branches, 1);
  const d = db.store['repo\u0000develop'];
  assert.deepEqual(d.files['Translations/App.de-DE.xlf'], { ...original['repo\u0000develop'].files['Translations/App.de-DE.xlf'], aiAdded: 0, aiDeleted: 0, effectiveAi: 0 });
  assert.equal(d.files['src/Big.Codeunit.al'].aiAdded + d.files['src/Big.Codeunit.al'].aiDeleted, 2024);
  assert.equal(d.files['src/Big.Codeunit.al'].effectiveAi, 2024);
  assert.deepEqual(d.files['src/Small.al'], original['repo\u0000develop'].files['src/Small.al']);
  assert.deepEqual(d.lineChanges['xlf'].ai, { added: 0, deleted: 0 });
  assert.equal(d.lineChanges['al'].ai.added, 40_500 - (40_000 - d.files['src/Big.Codeunit.al'].aiAdded));
  assert.equal(d.effectiveLines.translation.ai, 0);
  assert.equal(d.effectiveLines.programming.ai, 2200);
  // Daily: translation lines 50k on categorized days + 10k from the legacy day.
  const days = d.daily;
  assert.equal(days['2025-01-01'].linesByCategory.translation.ai + days['2025-01-02'].linesByCategory.translation.ai, 0);
  assert.equal(days['2025-01-01'].linesAiTranslation + days['2025-01-02'].linesAiTranslation, 0);
  const removedCode = 40_000 - d.files['src/Big.Codeunit.al'].aiAdded;
  assert.equal(days['2025-01-01'].linesByCategory.programming.ai, 40_500 - removedCode);
  const totalAi = Object.values(days).reduce((s, b) => s + b.linesAi, 0);
  assert.equal(totalAi, 100_500 - 60_000 - removedCode);
  assert.ok(Object.values(days).every(b => b.linesAi >= 0));
  assert.deepEqual(db.store['repo\u0000feature'], original['repo\u0000feature']);
  assert.equal(db.getLineChurnOutliers().length, 0);
  assert.equal(db.fixLineChurn(), undefined, 'nothing left to fix');

  const runs = db.getLineCleanups();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].batchId, res.batchId);
  assert.equal(runs[0].lines, res.lines);
  assert.equal(db.undoLineCleanup(res.batchId), 1);
  assert.deepEqual(db.store, original);
  assert.equal(db.undoLineCleanup(res.batchId), 0);
});

test('a branch merge carries line recounts and its undo brings them back (#160)', t => {
  const db = openDb(t); seed(db);
  const res = db.fixLineChurn();
  const rec = db.mergeBranches('repo\u0000develop', 'repo\u0000feature');
  assert.ok(rec);
  assert.equal(db.store['repo\u0000feature'].lineCleanups.length, 1);
  assert.deepEqual(db.store['repo\u0000develop'].lineCleanups, []);
  assert.equal(db.getLineCleanups()[0].batchId, res.batchId);

  db.undoEntryMove(rec.id);
  assert.equal(db.store['repo\u0000feature'].lineCleanups, undefined);
  assert.equal(db.store['repo\u0000develop'].lineCleanups.length, 1);
  assert.equal(db.undoLineCleanup(res.batchId), 1);
  assert.equal(db.store['repo\u0000develop'].files['Translations/App.de-DE.xlf'].aiAdded, 60_000);
});

test('undo after a merge restores the counts on the merge target (#160)', t => {
  const db = openDb(t); seed(db);
  const res = db.fixLineChurn();
  db.mergeBranches('repo\u0000develop', 'repo\u0000feature');
  assert.equal(db.undoLineCleanup(res.batchId), 1);
  const f = db.store['repo\u0000feature'];
  assert.equal(f.files['Translations/App.de-DE.xlf'].aiAdded, 60_000);
  assert.equal(f.lineChanges['xlf'].ai.added, 60_000);
  assert.equal(f.lineCleanups, undefined);
});
