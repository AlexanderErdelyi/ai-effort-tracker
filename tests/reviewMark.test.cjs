const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const r = require('../out/analysis/review');
const { reviewMark, normalizeCategory, reviewResolveIssue } = require('../out/analysis/reviewMark');
const { ReviewStore } = require('../out/review/reviewStore');
const G = require('../out/review/reviewGit');

const L = s => s.split('\n');

test('evaluateFile reports reviewed blocks with the newest mark time; blank lines bridge', () => {
  const lines = L('a1\nb2\n\nc3\nd4\ne5');
  let marks = r.applyMark([], r.keysForLines(lines, [0, 1]), 'ok', 100, 'x');
  marks = r.applyMark(marks, r.keysForLines(lines, [3]), 'ok', 200, 'y');
  const ev = r.evaluateFile(lines, null, marks);
  assert.deepEqual(ev.reviewedBlocks, [{ start: 0, end: 3, lines: 3, at: 200 }]);
  assert.deepEqual(ev.todoBlocks, [{ start: 4, end: 5, lines: 2 }]);
});

test('blockContexts names the enclosing procedure, object or heading', () => {
  const al = L('codeunit 50100 "NOBJQM Sync Mgt"\n{\n    local procedure SyncJob(JobNo: Code[20])\n    begin\n        x := 1;\n    end;\n}');
  assert.deepEqual(r.blockContexts(al, [{ start: 4, end: 4 }, { start: 0, end: 0 }], 'app/src/Sync.Codeunit.al'), ['procedure SyncJob', 'codeunit "NOBJQM Sync Mgt"']);
  const md = L('# Plan\n\ntext\n## Acceptance criteria\n- one\n- two');
  assert.deepEqual(r.blockContexts(md, [{ start: 5, end: 5 }, { start: 2, end: 2 }], 'app/specs/plan.md'), ['## Acceptance criteria', '# Plan']);
  assert.equal(r.blockContext(L('# not a heading in python\nx = 1'), 1, 1, 'a.py'), 'x = 1', 'comments are no headings outside Markdown');
  assert.equal(r.blockContext(L('export async function load(a) {\n  return a;\n}'), 1, 1, 'a.ts'), 'function load');
});

test('normalizeCategory accepts aliases and rejects unknown names', () => {
  assert.equal(normalizeCategory('Specs'), 'specification');
  assert.equal(normalizeCategory('docs'), 'documentation');
  assert.equal(normalizeCategory('📋 Specification'), 'specification');
  assert.equal(normalizeCategory('program'), 'programming');
  assert.throws(() => normalizeCategory('stuff'), /Unknown category/);
});

function fakeIo(files, { branch = 'feature/x', changed = null, base = {} } = {}) {
  const updates = [];
  let store;
  const io = {
    exists: dir => dir === '/repo',
    readFile: abs => files[abs.replace(/^\/repo\//, '')] ?? null,
    currentBranch: () => branch,
    resolveBase: () => 'abc1234567',
    changedFiles: () => new Map(Object.keys(changed ?? files).map(k => [k, base[k] !== undefined ? k : null])),
    contentAt: (_root, _base, rel) => base[rel] ?? null,
    update: (repoId, change) => { store.repos[repoId] = change(store.repos[repoId]); updates.push(repoId); },
    now: () => 1000,
    newId: () => 'id' + updates.length + Math.random()
  };
  return { io, updates, setStore: s => { store = s; } };
}

const mkStore = (files = {}) => ({ version: 1, repos: { 'github.com/o/r': { files, coverage: { 'feature/x': { at: 5, base: 'abc', total: 0, reviewed: 0, issueLines: 0, files: [], issues: [] } }, roots: ['/repo'] } } });
const cat = rel => rel.endsWith('.md') ? (rel.includes('specs/') ? 'specification' : 'documentation') : 'programming';

test('review_mark marks only lines still to review in the matching files', () => {
  const files = { 'app/specs/plan.md': '# Plan\nstep 1\nstep 2', 'app/src/A.Codeunit.al': 'x := 1;\ny := 2;', 'README.md': 'hello' };
  const store = mkStore();
  const { io, updates, setStore } = fakeIo(files, { base: { 'app/src/A.Codeunit.al': 'x := 1;' } });
  setStore(store);
  const res = reviewMark(store, {}, { category: 'specs' }, cat, io);
  assert.equal(updates.length, 1);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].file, 'app/specs/plan.md');
  assert.equal(res.files[0].lines, 3);
  assert.deepEqual(res.files[0].ranges.map(x => [x.startLine, x.endLine, x.context]), [[1, 3, '# Plan']]);
  const ev = r.evaluateFile(L(files['app/specs/plan.md']), null, store.repos['github.com/o/r'].files['app/specs/plan.md']);
  assert.equal(ev.reviewed, 3);

  const code = reviewMark(store, {}, { paths: ['Codeunit'] }, cat, io);
  assert.equal(code.files[0].lines, 1, 'only the changed line vs the base');
  assert.deepEqual(code.files[0].ranges.map(x => x.startLine), [2]);

  const again = reviewMark(store, {}, { paths: ['app/specs/**'] }, cat, io);
  assert.equal(again.files.length, 0);
  assert.match(again.result, /Nothing to mark/);
  assert.equal(updates.length, 2, 'nothing written when nothing changes');
});

test('review_mark: dry run, clear keeps issues, ranged issue, validation', () => {
  const files = { 'a.al': 'l1;\nl2;\nl3;\nl4;' };
  const store = mkStore();
  const { io, updates, setStore } = fakeIo(files);
  setStore(store);
  const dry = reviewMark(store, {}, { all: true, dryRun: true }, cat, io);
  assert.equal(dry.dryRun, true);
  assert.match(dry.result, /^Would mark 4 lines in 1 file as reviewed\./);
  assert.equal(updates.length, 0);

  reviewMark(store, {}, { all: true }, cat, io);
  reviewMark(store, {}, { status: 'issue', paths: ['a.al'], startLine: 2, endLine: 2, note: 'wrong' }, cat, io);
  const cleared = reviewMark(store, {}, { status: 'clear', paths: ['a.al'] }, cat, io);
  assert.equal(cleared.files[0].lines, 3, 'the flagged line is not cleared');
  const ev = r.evaluateFile(L(files['a.al']), null, store.repos['github.com/o/r'].files['a.al']);
  assert.equal(ev.reviewed, 0);
  assert.equal(ev.issues.length, 1);
  assert.equal(ev.issues[0].note, 'wrong');

  const cr = reviewMark(store, {}, { status: 'clear', paths: ['a.al'], startLine: 1, endLine: 4 }, cat, io);
  assert.equal(cr.files[0].lines, 4, 'a range clears everything, issues too');
  assert.equal(r.evaluateFile(L(files['a.al']), null, store.repos['github.com/o/r'].files['a.al']).issues.length, 0);

  assert.throws(() => reviewMark(store, {}, {}, cat, io), /Say what to mark/);
  assert.throws(() => reviewMark(store, {}, { status: 'issue', paths: ['a.al'] }, cat, io), /needs "startLine"/);
  assert.throws(() => reviewMark(store, {}, { paths: ['a'], startLine: 3, endLine: 1 }, cat, io), /startLine ≤ endLine/);
  assert.throws(() => reviewMark(store, {}, { branch: 'other', all: true }, cat, io), /No folder known to AI Effort Tracker has branch other checked out/);
  assert.throws(() => reviewMark(store, { 'feature/y': { workItemId: '7' } }, { workItemId: '7', all: true }, cat, io), /work item 7 \(feature\/y\)/);
});

test('review_mark with no match lists the categories of the changed files', () => {
  const files = { 'app/docs/plan.md': 'x' };
  const store = mkStore();
  const { io, setStore } = fakeIo(files);
  setStore(store);
  const res = reviewMark(store, {}, { category: 'specification' }, () => 'documentation', io);
  assert.deepEqual(res.changedFilesByCategory, { documentation: 1 });
  assert.match(res.hint, /Match by "paths"/);
});

test('review_mark end to end against a real git repository and the durable store', t => {
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['--version'], os.tmpdir()); } catch { t.skip('git not available'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-mark-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo); git(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'A.al'), 'procedure A()\nbegin\nend;\n');
  git(['add', '.'], repo); git(['commit', '-qm', 'base'], repo);
  git(['checkout', '-qb', 'feature/x'], repo);
  fs.writeFileSync(path.join(repo, 'A.al'), 'procedure A()\nbegin\n  x := 1;\nend;\n');
  fs.mkdirSync(path.join(repo, 'specs'));
  fs.writeFileSync(path.join(repo, 'specs', 'plan.md'), '# Plan\n\nstep\n');

  assert.deepEqual([...G.changedFilesSync(repo, G.resolveReviewBaseSync(repo)).keys()].sort(), ['A.al', 'specs/plan.md']);
  const storeDir = path.join(dir, 'store');
  const rs = new ReviewStore(storeDir);
  rs.updateRepo('local/repo', x => r.withRoot(x, repo));
  const io = {
    exists: d => fs.existsSync(d),
    readFile: abs => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } },
    currentBranch: root => git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim(),
    resolveBase: G.resolveReviewBaseSync, changedFiles: G.changedFilesSync, contentAt: G.contentAtSync,
    update: (id, change) => rs.updateRepo(id, change), now: () => Date.now(), newId: () => String(Math.random())
  };
  const res = reviewMark(rs.load(), {}, { paths: ['A.al'] }, cat, io);
  assert.equal(res.branch, 'feature/x');
  assert.deepEqual(res.files.map(f => [f.file, f.lines]), [['A.al', 1]], 'only the added line');
  assert.equal(res.files[0].ranges[0].context, 'procedure A');
  const spec = reviewMark(rs.load(), {}, { category: 'specification' }, cat, io);
  assert.deepEqual(spec.files.map(f => [f.file, f.lines]), [['specs/plan.md', 2]]);
  const saved = new ReviewStore(storeDir).repo('local/repo');
  assert.equal(Object.keys(saved.files).length, 2);
  assert.deepEqual(saved.roots, [repo]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fixed issues stop flagging their lines and are listed for verification', () => {
  const lines = L('a line one\nb line two\nc line three');
  let marks = r.applyMark([], r.keysForLines(lines, [1]), 'issue', 100, 'iss', 'wrong', { branch: 'feature/x', line: 2 });
  assert.equal(marks[0].branch, 'feature/x');
  assert.equal(marks[0].line, 2);
  let ev = r.evaluateFile(lines, null, marks);
  assert.equal(ev.issues.length, 1);
  assert.equal(ev.issues[0].flagged, 1);
  assert.deepEqual(r.resolvedIssuesOf('a.al', marks, ev, 'feature/x', true), [], 'open issues are not resolved');

  marks = r.setIssueFix(marks, 'iss', { at: 200, by: 'ai', note: 'used the right field' });
  ev = r.evaluateFile(lines, null, marks);
  assert.equal(ev.issues.length, 0);
  assert.equal(ev.status[1], 'todo', 'the fixed line needs a look again');
  assert.deepEqual(ev.fixed, [{ markId: 'iss', line: 1, indices: [1] }]);
  const res = r.resolvedIssuesOf('a.al', marks, ev, 'other', false);
  assert.deepEqual(res, [{ path: 'a.al', line: 2, lines: 1, note: 'wrong', at: 100, markId: 'iss', by: 'ai', fixedAt: 200, fixNote: 'used the right field' }]);

  // marking the lines reviewed keeps the fix record (it waits for accept)
  marks = r.applyMark(marks, r.keysForLines(lines, [1]), 'ok', 300, 'ok1');
  const kept = marks.find(m => m.id === 'iss');
  assert.deepEqual(kept.lines, []);
  const round = r.decodeReviewStore(JSON.stringify({ version: 1, repos: { x: { files: { 'a.al': marks }, coverage: {} } } })).repos.x.files['a.al'];
  assert.deepEqual(round.find(m => m.id === 'iss'), kept, 'fixed marks without lines survive a reload');
  assert.equal(r.resolvedIssuesOf('a.al', round, r.evaluateFile(lines, null, round), 'feature/x', false)[0].lines, 0);

  // reopen / accept
  assert.equal(r.setIssueFix(marks, 'iss', null).some(m => m.id === 'iss'), false, 'reopening a fix without lines drops it');
  assert.equal(r.dropMark(marks, 'iss').some(m => m.id === 'iss'), false);
  assert.equal(r.dropMark(marks, 'nope'), null);
  assert.equal(r.setIssueFix(marks, 'nope', null), null);
});

test('open issues whose lines were all edited count as changed only on their branch', () => {
  const before = L('keep me\nbad code here');
  const marks = r.applyMark([], r.keysForLines(before, [1]), 'issue', 100, 'iss', 'bad', { branch: 'feature/x', line: 2 });
  const after = L('keep me\ngood code now');
  const ev = r.evaluateFile(after, null, marks);
  assert.equal(ev.issues.length, 0);
  assert.equal(r.resolvedIssuesOf('a.al', marks, ev, 'feature/x', true)[0].by, 'changed');
  assert.deepEqual(r.resolvedIssuesOf('a.al', marks, ev, 'main', true), [], 'another branch without that code');
  const legacy = marks.map(m => { const c = { ...m }; delete c.branch; return c; });
  assert.equal(r.resolvedIssuesOf('a.al', legacy, ev, 'main', true).length, 1, 'older marks: when the file changed on the branch');
  assert.equal(r.resolvedIssuesOf('a.al', legacy, ev, 'main', false).length, 0);
  assert.equal(r.resolvedIssuesOf('a.al', marks, null, 'feature/x', true)[0].line, 2, 'deleted file');
});

test('coverage keeps resolved issues; rollup counts them; the fix prompt asks to resolve', () => {
  const resolved = [{ path: 'a.al', line: 3, lines: 0, note: 'n', at: 1, markId: 'm1', by: 'ai', fixedAt: 5, fixNote: 'done' }];
  const cov = { at: 10, base: 'b', total: 1, reviewed: 0, issueLines: 0, files: [{ path: 'a.al', total: 1, reviewed: 0, issueLines: 0 }], issues: [], resolved };
  const repo = r.withCoverage({ files: {}, coverage: {} }, 'feature/x', cov);
  const back = r.decodeReviewStore(JSON.stringify({ version: 1, repos: { x: repo } }));
  assert.deepEqual(back.repos.x.coverage['feature/x'].resolved, resolved);
  const roll = r.rollupCoverage(back, ['feature/x']);
  assert.equal(roll.toVerify, 1);
  assert.equal(roll.complete, false);
  const prompt = r.fixIssuesPrompt('feature/x', [{ path: 'a.al', line: 3, lines: 1, note: 'n', markId: 'm1' }]);
  assert.match(prompt, /issueId `m1`/);
  assert.match(prompt, /review_resolve_issue/);
});

test('review_resolve_issue reports fixed, reopens and removes issues', () => {
  const lines = L('x := 1;\ny := 2;');
  const mk = (id, idx, note) => r.applyMark([], r.keysForLines(lines, [idx]), 'issue', 100, id, note)[0];
  const store = mkStore({ 'src/a.al': [mk('aaaaaaaa-1', 0, 'first')], 'src/b.al': [mk('bbbbbbbb-1', 0, 'one'), mk('bbbbbbbb-2', 1, 'two')] });
  const { io, updates, setStore } = fakeIo({});
  setStore(store);
  const files = () => store.repos['github.com/o/r'].files;

  assert.throws(() => reviewResolveIssue(store, {}, io), /issueId/);
  assert.throws(() => reviewResolveIssue(store, { issueId: 'zzzzzzzz' }, io), /No review issue/);
  const many = reviewResolveIssue(store, { file: 'b.al' }, io);
  assert.equal(many.candidates.length, 2);
  assert.equal(updates.length, 0, 'ambiguous: nothing written');

  const res = reviewResolveIssue(store, { file: 'a.al', note: 'fixed the value' }, io);
  assert.match(res.result, /fixed by Copilot/);
  assert.deepEqual(files()['src/a.al'][0].fixed, { at: 1000, by: 'ai', note: 'fixed the value' });
  assert.match(reviewResolveIssue(store, { issueId: 'aaaaaaaa-1' }, io).result, /already reported fixed/);
  assert.match(reviewResolveIssue(store, { issueId: 'aaaaaaaa-1', action: 'reopen' }, io).result, /open again/);
  assert.equal(files()['src/a.al'][0].fixed, undefined);

  assert.match(reviewResolveIssue(store, { issueId: 'bbbbbbbb-2', action: 'remove' }, io).result, /removed/);
  assert.deepEqual(files()['src/b.al'].map(m => m.id), ['bbbbbbbb-1']);
  assert.match(reviewResolveIssue(store, { issueId: 'bbbbbbbb' }, io).result, /fixed by Copilot/, 'a unique prefix is enough');
  assert.throws(() => reviewResolveIssue(store, { issueId: 'bbbbbbbb', action: 'nope' }, io), /action/);
});
