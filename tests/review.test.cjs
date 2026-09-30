const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const r = require('../out/analysis/review');
const { ReviewStore } = require('../out/review/reviewStore');

const L = s => s.split('\n');
const keysOf = (lines, a, b) => r.keysForRange(lines, a, b);
let n = 0;
const mark = (marks, keys, status, at, note) => r.applyMark(marks, keys, status, at, 'm' + (++n), note);

test('changedLines finds inserted and modified lines, skips blank and unchanged', () => {
  const base = L('a\nb\nc\nd');
  assert.deepEqual([...r.changedLines(base, L('a\nb\nc\nd'))], []);
  assert.deepEqual([...r.changedLines(base, L('a\nX\nb\nc\nd'))], [1]);
  assert.deepEqual([...r.changedLines(base, L('a\nB\nc\nd'))], [1]);
  assert.deepEqual([...r.changedLines(base, L('a\nb\n\n   \nnew\nc\nd'))], [4]);
  assert.deepEqual([...r.changedLines(base, L('a\nc\nd'))], [], 'pure deletion has nothing to review');
  assert.deepEqual([...r.changedLines(null, L('x\n\ny'))], [0, 2], 'new file: every non-blank line');
  assert.deepEqual([...r.changedLines(L('a  \r\nb'), L('a\nb'))], [], 'line endings / trailing spaces ignored');
  assert.deepEqual([...r.changedLines(L('\uFEFFa\nb'.replace(/^\uFEFF/, '')), r.splitLines('\uFEFFa\nb'))], [], 'BOM ignored');
});

test('changedLines agrees between exact LCS and the large-file fallback on simple edits', () => {
  const base = Array.from({ length: 300 }, (_, i) => 'line ' + i);
  const cur = [...base.slice(0, 100), 'inserted 1', 'inserted 2', ...base.slice(100, 200), 'mod', ...base.slice(201)];
  const exact = [...r.changedLines(base, cur)];
  const approx = [...r.changedLines(base, cur, 10)];
  assert.deepEqual(exact, [100, 101, 202]);
  assert.deepEqual(approx, exact);
});

test('marks survive commits, shifts and blank lines; edits make lines (and short neighbours) unreviewed', () => {
  const v1 = L('procedure Foo()\nbegin\n    Customer.SetRange("No.", CustomerNo);\nend;');
  const marks = mark([], keysOf(v1, 0, 3), 'ok', 1000);
  let e = r.evaluateFile(v1, null, marks);
  assert.equal(e.total, 4); assert.equal(e.reviewed, 4);
  assert.deepEqual(r.evaluateFile(['', '', '', ...v1], null, marks).status.slice(3), ['ok', 'ok', 'ok', 'ok'], 'shifted down');

  const shifted = ['// header', '', ...v1];
  e = r.evaluateFile(shifted, null, marks);
  assert.deepEqual(e.status.slice(2), ['todo', 'ok', 'ok', 'ok'], 'a new neighbour asks for a second look at the adjacent line only');
  assert.equal(e.status[0], 'todo');
  const below = [...v1, '', '', 'codeunit 50100 Other'];
  assert.deepEqual(r.evaluateFile(below, null, marks).status.slice(0, 4), ['ok', 'ok', 'ok', 'todo']);

  const spaced = L('procedure Foo()\n\nbegin\n    Customer.SetRange("No.", CustomerNo);\n\nend;');
  assert.equal(r.evaluateFile(spaced, null, marks).reviewed, 4, 'blank lines do not break context');

  const edited = L('procedure Foo()\nbegin\n    Customer.SetRange("No.", OtherNo);\nend;');
  e = r.evaluateFile(edited, null, marks);
  assert.equal(e.status[2], 'todo', 'edited line');
  assert.equal(e.status[1], 'todo', 'short neighbour of an edit needs a look again');
  assert.equal(e.status[0], 'ok');

  const reindented = L('procedure Foo()\nbegin\n  Customer.SetRange("No.",   CustomerNo);\nend;');
  assert.equal(r.evaluateFile(reindented, null, marks).reviewed, 4, 'whitespace-only changes keep the review');
});

test('long lines moved as a block keep their review, isolated short duplicates do not', () => {
  const block = ['    SalesHeader.SetRange("Document Type", DocType);', '    SalesHeader.SetRange("No.", DocumentNo);'];
  const v1 = ['begin', ...block, 'end;', 'x := 1;'];
  const marks = mark([], keysOf(v1, 0, 4), 'ok', 1);
  const moved = ['trigger OnRun()', 'var a: Integer;', ...block, 'y := 2;', 'end;'];
  const e = r.evaluateFile(moved, null, marks);
  assert.deepEqual(e.status.slice(2, 4), ['ok', 'ok']);
  assert.equal(e.status[5], 'todo', 'short line in a new context is not assumed reviewed');
  const single = ['foo', '    SalesHeader.SetRange("Document Type", DocType);', 'bar'];
  assert.equal(r.evaluateFile(single, null, marks).status[1], 'todo', 'a lone moved line is not trusted');
});

test('only changed lines count; issues show everywhere; newest decision wins; clear un-reviews', () => {
  const lines = L('a1 := 1;\na2 := 2;\na3 := 3;\na4 := 4;\na5 := 5;');
  const changed = new Set([1, 2, 3]);
  let marks = mark([], keysOf(lines, 0, 4), 'ok', 1);
  marks = mark(marks, keysOf(lines, 3, 4), 'issue', 2, 'Check rounding');
  let e = r.evaluateFile(lines, changed, marks);
  assert.equal(e.total, 3);
  assert.equal(e.reviewed, 2);
  assert.equal(e.issueLines, 2);
  assert.deepEqual(e.issues.map(i => [i.line, i.lines, i.note]), [[3, 2, 'Check rounding']]);
  assert.equal(e.status[0], undefined);
  assert.equal(e.status[4], 'issue', 'issue on an unchanged line is still shown');

  marks = mark(marks, keysOf(lines, 3, 4), 'ok', 3);
  e = r.evaluateFile(lines, changed, marks);
  assert.equal(e.reviewed, 3); assert.equal(e.issues.length, 0);

  marks = mark(marks, keysOf(lines, 2, 2), 'clear', 4);
  e = r.evaluateFile(lines, changed, marks);
  assert.equal(e.status[2], 'todo');
  assert.deepEqual(e.todoBlocks, [{ start: 2, end: 2, lines: 1 }]);
  assert.equal(marks.reduce((s, m) => s + m.lines.length, 0), 5, 'each line kept once');
});

test('todo blocks are bridged by blank lines only', () => {
  const lines = L('a := 1;\n\nb := 2;\nc := 3;\nd := 4;');
  const e = r.evaluateFile(lines, new Set([0, 2, 4]), []);
  assert.deepEqual(e.todoBlocks, [{ start: 0, end: 2, lines: 2 }, { start: 4, end: 4, lines: 1 }]);
});

test('applyMark prunes old marks and caps the per-file size', () => {
  const lines = Array.from({ length: 10 }, (_, i) => 'value ' + i + ' := ' + i + ';');
  const old = mark([], keysOf(lines, 0, 4), 'ok', 0);
  const now = 500 * 86_400_000;
  const fresh = mark(old, keysOf(lines, 5, 9), 'ok', now);
  assert.equal(fresh.length, 1, 'mark older than ~13 months is dropped');
  const big = Array.from({ length: 30000 }, (_, i) => 'x' + i);
  let marks = mark([], keysOf(big, 0, 29999), 'ok', now);
  marks = mark(marks, keysOf(big.map(s => s + 'y'), 0, 29999), 'ok', now + 1);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, now + 1);
});

test('store decoding rejects foreign files and skips bad entries', () => {
  assert.throws(() => r.decodeReviewStore('{"branches":{}}'));
  const s = r.decodeReviewStore(JSON.stringify({ version: 1, repos: {
    'github.com/o/r': { files: { 'a.al': [{ id: 'x', status: 'ok', at: 1, lines: ['0123456789ab0123456789ab', 'short'] }, { id: 'y', status: 'bad', lines: [] }] },
      coverage: { main: { at: 5, base: 'abc', total: 3, reviewed: 1, issueLines: 0, files: [{ path: 'a.al', total: 3, reviewed: 1 }], issues: [] } } },
    broken: 7 } }));
  assert.deepEqual(Object.keys(s.repos), ['github.com/o/r']);
  assert.deepEqual(s.repos['github.com/o/r'].files['a.al'][0].lines, ['0123456789ab0123456789ab']);
  assert.equal(s.repos['github.com/o/r'].coverage.main.files[0].issueLines, 0);
});

test('rollup counts a file changed on two branches once and lists issues', () => {
  const store = r.emptyReviewStore();
  let repo = r.emptyRepoReview();
  repo = r.withCoverage(repo, 'feature/1-a', { at: 10, base: 'b', total: 10, reviewed: 5, issueLines: 0,
    files: [{ path: 'x.al', total: 10, reviewed: 5, issueLines: 0 }], issues: [] });
  repo = r.withCoverage(repo, 'feature/1-b', { at: 20, base: 'b', total: 14, reviewed: 12, issueLines: 1,
    files: [{ path: 'x.al', total: 10, reviewed: 10, issueLines: 0 }, { path: 'y.al', total: 4, reviewed: 2, issueLines: 1 }],
    issues: [{ path: 'y.al', line: 3, lines: 1, note: 'null check', at: 15 }] });
  repo = r.withCoverage(repo, 'other', { at: 30, base: 'b', total: 99, reviewed: 0, issueLines: 0, files: [], issues: [] });
  store.repos.r = repo;
  const roll = r.rollupCoverage(store, ['feature/1-a', 'feature/1-b']);
  assert.equal(roll.total, 14);
  assert.equal(roll.reviewed, 12);
  assert.equal(roll.openIssues, 1);
  assert.equal(roll.complete, false);
  assert.deepEqual(roll.filesLeft.map(f => [f.path, f.unreviewed]), [['y.al', 2]]);
  assert.equal(roll.branches.length, 2);
  assert.equal(r.rollupCoverage(store, ['nope']), null);
});

test('exclude globs', () => {
  const ex = r.excludeMatcher(r.DEFAULT_REVIEW_EXCLUDE);
  assert.ok(ex('package-lock.json'));
  assert.ok(ex('web/package-lock.json'));
  assert.ok(ex('out/extension.js'));
  assert.ok(ex('Translations/App.g.xlf'));
  assert.ok(!ex('Translations/App.de-DE.xlf'));
  assert.ok(!ex('src/outline.ts'));
  assert.ok(r.excludeMatcher(['src/**/*.{al,xml}'])('src\\a\\b.AL'));
});

test('ReviewStore applies concurrent updates to the latest file and keeps a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-review-'));
  try {
    const a = new ReviewStore(dir), b = new ReviewStore(dir);
    const lines = L('first := 1;\nsecond := 2;');
    a.load(); b.load();
    a.updateRepo('repo', rr => ({ ...rr, files: { ...rr.files, 'a.al': mark(rr.files['a.al'] ?? [], keysOf(lines, 0, 0), 'ok', 1) } }));
    b.updateRepo('repo', rr => ({ ...rr, files: { ...rr.files, 'b.al': mark(rr.files['b.al'] ?? [], keysOf(lines, 1, 1), 'ok', 2) } }));
    const fresh = new ReviewStore(dir).repo('repo');
    assert.deepEqual(Object.keys(fresh.files).sort(), ['a.al', 'b.al'], 'second window did not overwrite the first');
    assert.ok(fs.existsSync(path.join(dir, r.REVIEW_FILE + '.bak')));
    fs.writeFileSync(path.join(dir, r.REVIEW_FILE), '{ truncated');
    assert.deepEqual(Object.keys(new ReviewStore(dir).repo('repo').files), ['a.al'], 'recovers from .bak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health check flags done work items with unreviewed lines or open issues', () => {
  const { checkDataHealth } = require('../out/analysis/dataHealth');
  const wi = (id, status) => ({ id, title: 'T' + id, projectId: null, estimate: 1, externalRef: null, createdAt: 0, ...(status ? { status } : {}) });
  const data = { branches: {}, workItems: { 1: wi('1', 'done'), 2: wi('2', 'done'), 3: wi('3'), 4: wi('4', 'done') }, projects: {}, creditLedger: [] };
  const env = { schemaVersion: 1, expectedSchemaVersion: 1, review: {
    1: { total: 10, reviewed: 10, openIssues: 0 }, 2: { total: 10, reviewed: 7, openIssues: 0 },
    3: { total: 10, reviewed: 0, openIssues: 0 }, 4: { total: 5, reviewed: 5, openIssues: 1 } } };
  const check = checkDataHealth(data, env).checks.find(c => c.id === 'done-not-reviewed');
  assert.equal(check.count, 2);
  assert.deepEqual(check.examples.map(e => e.label), ['#2 T2: 7/10 lines reviewed', '#4 T4: 5/5 lines reviewed, 1 open issue']);
  assert.equal(check.examples[0].action.command, 'review.showProgress');
  assert.ok(!checkDataHealth(data, { schemaVersion: 1, expectedSchemaVersion: 1 }).passed.includes('Finished work items are fully reviewed'), 'no check without review data');
});

test('MCP review_status: overview, work item and branch detail', () => {
  const store = r.emptyReviewStore();
  let repo = r.emptyRepoReview();
  repo = r.withCoverage(repo, 'feature/7-x', { at: Date.UTC(2026, 0, 2), base: 'b', total: 8, reviewed: 8, issueLines: 0, files: [{ path: 'a.al', total: 8, reviewed: 8, issueLines: 0 }], issues: [] });
  repo = r.withCoverage(repo, 'feature/9-y', { at: Date.UTC(2026, 0, 3), base: 'b', total: 6, reviewed: 2, issueLines: 1,
    files: [{ path: 'b.al', total: 6, reviewed: 2, issueLines: 1 }], issues: [{ path: 'b.al', line: 4, lines: 1, note: 'wrong filter', at: Date.UTC(2026, 0, 3) }] });
  repo = r.withCoverage(repo, 'spike', { at: Date.UTC(2026, 0, 1), base: 'b', total: 3, reviewed: 0, issueLines: 0, files: [{ path: 'c.al', total: 3, reviewed: 0, issueLines: 0 }], issues: [] });
  store.repos.r = repo;
  const branches = { 'feature/7-x': { workItemId: '7' }, 'feature/9-y': { workItemId: '9' }, spike: { workItemId: null } };
  const wis = { 7: { title: 'Seven', status: 'done' }, 9: { title: 'Nine', status: 'done' } };
  const all = r.reviewStatus(store, branches, wis, {});
  assert.deepEqual(all.workItems.map(w => [w.workItemId, w.pct, w.complete]), [['9', 33.3, false], ['7', 100, true]]);
  assert.deepEqual(all.branchesWithoutWorkItem.map(b => b.branch), ['spike']);
  assert.deepEqual(all.doneButNotReviewed, ['9']);
  const one = r.reviewStatus(store, branches, wis, { workItemId: '9' });
  assert.equal(one.review.issues[0].note, 'wrong filter');
  assert.equal(one.review.filesLeft[0].path, 'b.al');
  assert.match(r.reviewStatus(store, branches, wis, { workItemId: '404' }).note, /No review coverage/);
  assert.equal(r.reviewStatus(store, branches, wis, { branch: 'spike' }).review.unreviewed, 3);

  const { callTool } = require('../out/mcp/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-mcp-review-'));
  const prev = process.env.AET_STORE_PATH;
  try {
    process.env.AET_STORE_PATH = path.join(dir, 'effort-tracker.json');
    fs.writeFileSync(path.join(dir, r.REVIEW_FILE), JSON.stringify(store));
    const data = { creditLedger: [], toolsets: {}, modelPrices: {}, branches, workItems: wis, projects: {} };
    assert.deepEqual(callTool('review_status', {}, data).doneButNotReviewed, ['9']);
  } finally {
    if (prev === undefined) delete process.env.AET_STORE_PATH; else process.env.AET_STORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review_issues reads flagged code live with current line numbers and lists other-branch issues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-review-issues-'));
  try {
    const v1 = ['codeunit 50100 Calc', '{', '    procedure Total(x: Decimal): Decimal', '    begin', '        exit(Round(x, 1));', '    end;', '}'];
    let marks = mark([], r.keysForLines(v1, [4]), 'issue', 1000, 'rounding precision should be 0.01');
    marks = mark(marks, r.keysForLines(v1, [2]), 'ok', 1100);
    // File on disk now has two extra lines at the top: the issue moved from line 5 to 7.
    const now = ['// header', '', ...v1];
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'Calc.al'), now.join('\r\n'));
    let repo = r.withRoot(r.emptyRepoReview(), dir);
    repo.files['src/Calc.al'] = marks;
    repo.files['src/Gone.al'] = mark([], r.keysForLines(['a line that is only on another branch'], [0]), 'issue', 2000, 'other branch');
    repo = r.withCoverage(repo, 'feature/9-y', { at: 3000, base: 'b', total: 1, reviewed: 0, issueLines: 1,
      files: [{ path: 'src/Gone.al', total: 1, reviewed: 0, issueLines: 1 }], issues: [{ path: 'src/Gone.al', line: 1, lines: 1, note: 'other branch', at: 2000, markId: repo.files['src/Gone.al'][0].id }] });
    const store = r.emptyReviewStore();
    store.repos['github.com/o/r'] = repo;
    const io = { exists: d => fs.existsSync(d), readFile: f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }, currentBranch: () => 'feature/7-x' };
    const branches = { 'feature/7-x': { workItemId: '7' }, 'feature/9-y': { workItemId: '9' } };
    const out = r.reviewIssues(store, branches, { 7: { title: 'Seven' } }, {}, io);
    assert.equal(out.openIssues, 1);
    const i = out.issues[0];
    assert.equal(i.file, 'src/Calc.al');
    assert.equal(i.startLine, 7);
    assert.equal(i.endLine, 7);
    assert.equal(i.note, 'rounding precision should be 0.01');
    assert.equal(i.branch, 'feature/7-x');
    assert.ok(fs.existsSync(i.absolutePath));
    assert.match(i.code, /^7>\|         exit\(Round\(x, 1\)\);$/m);
    assert.match(i.code, /^4 \|/m);
    assert.deepEqual(out.onOtherBranches.map(x => [x.branch, x.file, x.note]), [['feature/9-y', 'src/Gone.al', 'other branch']]);
    assert.match(out.instructions, /call review_resolve_issue with its issueId/);

    // Work item filter: WI 7 is checked out, so its issues are live; WI 9's issue only exists on its branch.
    assert.equal(r.reviewIssues(store, branches, {}, { workItemId: '7' }, io).openIssues, 1);
    const wi9 = r.reviewIssues(store, branches, {}, { workItemId: '9' }, io);
    assert.equal(wi9.openIssues, 0);
    assert.equal(wi9.onOtherBranches.length, 1);
    assert.equal(r.reviewIssues(store, branches, {}, { path: 'nomatch' }, io).openIssues, 0);
    assert.equal(r.reviewIssues(store, branches, {}, { contextLines: 0 }, io).issues[0].code.split('\n').length, 1);

    // Fixing the flagged line clears the issue; resolving the other-branch mark drops it too.
    fs.writeFileSync(path.join(dir, 'src', 'Calc.al'), now.join('\n').replace('Round(x, 1)', 'Round(x, 0.01)'));
    store.repos['github.com/o/r'].files['src/Gone.al'] = mark(repo.files['src/Gone.al'], r.keysForLines(['a line that is only on another branch'], [0]), 'ok', 4000);
    const after = r.reviewIssues(store, branches, {}, {}, io);
    assert.equal(after.openIssues, 0);
    assert.equal(after.onOtherBranches.length, 0);
    assert.match(after.note, /No open review issues/);

    // Unknown folder: issues fall back to the saved coverage with a hint.
    const lost = r.reviewIssues(store, branches, {}, {}, { ...io, exists: () => false });
    assert.equal(lost.openIssues, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo roots and issue mark ids persist; excerpt and fix prompt format', () => {
  let repo = r.withRoot(r.emptyRepoReview(), 'C:\\a');
  repo = r.withRoot(repo, 'C:\\b');
  assert.equal(r.withRoot(repo, 'C:\\b'), repo, 'unchanged when already first');
  repo = r.withRoot(repo, 'C:\\a');
  assert.deepEqual(repo.roots, ['C:\\a', 'C:\\b']);
  repo = r.withCoverage(repo, 'x', { at: 1, base: '', total: 0, reviewed: 0, issueLines: 1, files: [], issues: [{ path: 'p', line: 1, lines: 1, note: 'n', at: 1, markId: 'm1' }] });
  const store = r.emptyReviewStore();
  store.repos.r = repo;
  const back = r.decodeReviewStore(JSON.stringify(store));
  assert.deepEqual(back.repos.r.roots, ['C:\\a', 'C:\\b']);
  assert.equal(back.repos.r.coverage.x.issues[0].markId, 'm1');

  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  assert.equal(r.issueExcerpt(lines, [9, 10], 1), ' 9 | i\n10>| j\n11>| k');
  const prompt = r.fixIssuesPrompt('feature/1', [{ path: 'src/a.al', line: 10, lines: 2, note: 'wrong filter', code: '10>| j' }, { path: 'b.al', line: 3, lines: 1, note: '' }], 5);
  assert.match(prompt, /issues \(5\) I flagged on branch `feature\/1`/);
  assert.match(prompt, /1\. `src\/a\.al:10` \(2 lines\): wrong filter\n   ```\n   10>\| j\n   ```/);
  assert.match(prompt, /2\. `b\.al:3`: \(no note\)/);
  assert.match(prompt, /and 3 more/);
  assert.match(prompt, /review_issues/);
  assert.match(r.fixIssuesPrompt(null, [{ path: 'a', line: 1, lines: 1, note: 'x' }]), /^Fix the code review issue I flagged\./);
});
