const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../out/analysis/lessons');
const { LessonStore } = require('../out/store/lessonStore');
const { CorrectionStore } = require('../out/store/correctionStore');

const corr = (over = {}) => ({
  id: over.id ?? 'id-1', t: 1000, start: 900, source: 'human', kind: 'modify', repo: 'app', path: 'src/a.Table.al',
  ext: 'al', branch: 'feature', line: 3, aiLines: 1, added: 1, removed: 1, aiAt: 500, category: 'style', scope: '*.Table.al', ...over
});
const rule = (over = {}) => ({ ...L.createRule({ category: 'style', scope: '*.Table.al', text: 'No space before where(', ...over }, 'user', 100), ...(over.id ? { id: over.id } : {}) });
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `aet-lessons-${name}-`));

test('decodeLessonStore keeps valid rules and normalizes fields', () => {
  const d = L.decodeLessonStore(JSON.stringify({ rules: [
    { id: 'a', category: ' Style ', scope: '', text: ' x ', status: 'weird', createdBy: 'bot', examples: ['c1', 3] },
    { id: '', category: 'style' }, { id: 'b' }, null
  ] }));
  assert.equal(d.rules.length, 1);
  assert.deepEqual({ ...d.rules[0] }, { id: 'a', category: 'style', scope: '**', text: 'x', status: 'proposed', examples: ['c1'], createdBy: 'user', createdAt: 0, updatedAt: 0 });
  assert.throws(() => L.decodeLessonStore('{"rules":5}'), /Invalid/);
});

test('mergeLessonDelta: newer update wins, remove deletes', () => {
  const a = { ...rule({ id: 'a' }), updatedAt: 200 };
  const b = { ...rule({ id: 'b', text: 'other' }), updatedAt: 200 };
  let d = L.mergeLessonDelta(L.emptyLessonStore(), { upsert: [a, b], remove: [] });
  d = L.mergeLessonDelta(d, { upsert: [{ ...a, text: 'old', updatedAt: 100 }], remove: [] });
  assert.equal(d.rules.find(r => r.id === 'a').text, 'No space before where(');
  d = L.mergeLessonDelta(d, { upsert: [{ ...a, text: 'new', updatedAt: 300 }], remove: ['b'] });
  assert.deepEqual(d.rules.map(r => [r.id, r.text]), [['a', 'new']]);
  assert.ok(L.lessonDeltaIsEmpty(L.emptyLessonDelta()));
});

test('createRule and updateRule validate category, text and approval', () => {
  assert.throws(() => L.createRule({ category: '', scope: '**' }, 'user'), /category/);
  assert.throws(() => L.createRule({ category: 'not a lesson', scope: '**' }, 'user'), /lesson category/);
  assert.throws(() => L.createRule({ category: 'style', scope: '**', status: 'approved' }, 'user'), /text/);
  const r = L.createRule({ category: 'Style', scope: '  ', examples: ['x', 'x'], repo: ' app ' }, 'copilot', 5);
  assert.equal(r.category, 'style');
  assert.equal(r.scope, '**');
  assert.equal(r.repo, 'app');
  assert.deepEqual(r.examples, ['x']);
  assert.equal(r.status, 'proposed');
  assert.throws(() => L.updateRule(r, { status: 'approved' }), /text/);
  const ok = L.updateRule(r, { status: 'approved', text: ' Do it ', addExamples: ['x', 'y'], repo: '' }, 9);
  assert.equal(ok.approvedAt, 9);
  assert.equal(ok.text, 'Do it');
  assert.deepEqual(ok.examples, ['x', 'y']);
  assert.equal(ok.repo, undefined);
  assert.equal(L.updateRule(ok, { scope: 'src/**' }, 12).approvedAt, 9, 'approvedAt stays');
  assert.throws(() => L.updateRule(ok, { category: 'progress update' }), /lesson category/);
  assert.throws(() => L.updateRule(ok, { status: 'maybe' }), /Unknown status/);
  assert.throws(() => L.updateRule(ok, { text: '' }), /text/);
});

test('lessonGroups counts episodes and work items and suggests repeated lessons', () => {
  const cs = [
    corr({ id: 'a', t: 1000, start: 1000, workItemId: '1', note: 'No space' }),
    corr({ id: 'b', t: 1001, start: 1000, workItemId: '1', note: 'No space' }),
    corr({ id: 'c', t: 50000000, start: 50000000, workItemId: '2', note: 'Other' }),
    corr({ id: 'd', t: 99000000, start: 99000000, branch: 'hotfix', note: 'No space' }),
    corr({ id: 'e', category: 'progress update' }),
    corr({ id: 'f', category: undefined, scope: undefined }),
    corr({ id: 'g', category: 'logic bug', scope: undefined, path: 'src/b.Page.al', source: 'ai' })
  ];
  const groups = L.lessonGroups(cs, [], { minOccurrences: 3, minWorkItems: 2 });
  assert.equal(groups.length, 2);
  const g = groups[0];
  assert.equal(g.key, 'style|*.table.al');
  assert.equal(g.count, 4);
  assert.equal(g.human, 4);
  assert.equal(g.episodes, 3, 'a and b are one editing sitting');
  assert.deepEqual(g.workItems, ['#1', '#2', 'hotfix']);
  assert.deepEqual(g.notes, ['No space', 'Other']);
  assert.deepEqual(g.examples, ['d', 'c', 'b', 'a']);
  assert.ok(g.suggested);
  assert.equal(groups[1].scope, '**/*.Page.al');
  assert.equal(groups[1].suggested, false);

  const withRule = L.lessonGroups(cs, [rule({ id: 'r1', scope: '*.TABLE.al' })], { minOccurrences: 3, minWorkItems: 2 });
  assert.deepEqual(withRule.find(x => x.category === 'style').ruleIds, ['r1']);
  assert.equal(L.lessonGroups(cs, [], { minOccurrences: 4 })[0].suggested, false);
});

test('scopeMatches and findRules filter by path, repo and status', () => {
  assert.ok(L.scopeMatches('*.Table.al', 'src/Tables/Cust.Table.al'));
  assert.ok(L.scopeMatches('src/**', 'C:/work/app/src/x.al'), 'absolute path matches through a sub-path');
  assert.ok(!L.scopeMatches('docs/**', 'src/x.md'));
  const rules = [
    { ...rule({ id: 'a', status: 'approved' }) },
    { ...rule({ id: 'b', scope: 'docs/**', text: 'Docs', status: 'approved', repo: 'other' }) },
    { ...rule({ id: 'c', text: 'Proposed' }) },
    { ...rule({ id: 'd', text: 'Old', status: 'approved' }), status: 'retired' }
  ];
  assert.deepEqual(L.findRules(rules).map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(L.findRules(rules, { repo: 'app' }).map(r => r.id), ['a']);
  assert.deepEqual(L.findRules(rules, { path: 'src/T.Table.al', includeProposed: true }).map(r => r.id).sort(), ['a', 'c']);
  assert.deepEqual(L.findRules(rules, { path: 'docs/readme.md', repo: 'OTHER' }).map(r => r.id), ['b']);
});

test('proposeRuleDelta creates once and adds examples to the open proposal', () => {
  const first = L.proposeRuleDelta(L.emptyLessonStore(), { category: 'style', scope: '*.al', text: 'Use tabs', examples: ['x'] }, 10);
  assert.ok(first.created);
  assert.equal(first.rule.createdBy, 'copilot');
  const d = L.mergeLessonDelta(L.emptyLessonStore(), first.delta);
  const again = L.proposeRuleDelta(d, { category: 'Style', scope: '*.AL', text: 'use TABS', examples: ['y'] }, 20);
  assert.equal(again.created, false);
  assert.deepEqual(again.rule.examples, ['x', 'y']);
  const approved = L.mergeLessonDelta(d, { upsert: [L.updateRule(first.rule, { status: 'approved' }, 30)], remove: [] });
  const none = L.proposeRuleDelta(approved, { category: 'style', scope: '*.al', text: 'Use tabs' }, 40);
  assert.ok(L.lessonDeltaIsEmpty(none.delta));
  assert.equal(none.rule.status, 'approved');
  assert.throws(() => L.proposeRuleDelta(d, { category: 'style', scope: '*.al', text: ' ' }), /text/);
});

test('lessonInstructionFiles writes one file per scope with approved rules only', () => {
  const rules = [
    rule({ id: 'a', status: 'approved', text: 'Rule A' }),
    rule({ id: 'b', status: 'approved', category: 'naming', text: "Don't abbreviate" }),
    rule({ id: 'c', text: 'Proposed only' }),
    rule({ id: 'd', status: 'approved', scope: '**/*.Table.al', text: 'Rule D' })
  ];
  const files = L.lessonInstructionFiles(rules);
  assert.deepEqual(files.map(f => f.name), ['aet-lessons-table-al.instructions.md', 'aet-lessons-table-al-2.instructions.md']);
  const f = files[1].content;
  assert.match(f, /^---\napplyTo: '\*\.Table\.al'\ndescription: /);
  assert.match(f, new RegExp(L.GENERATED_MARKER));
  assert.match(f, /## Naming\n\n- Don't abbreviate\n\n## Style\n\n- Rule A/);
  assert.doesNotMatch(f, /Proposed only/);
  assert.equal(L.scopeSlug('**'), 'all');
  assert.equal(L.scopeSlug('src/**/*.md'), 'src-all-md');
});

test('writeLessonExport removes and overwrites only generated files', () => {
  const dir = tmp('export'), skills = tmp('skills');
  try {
    const rules = [rule({ id: 'a', status: 'approved', scope: 'docs/**', text: 'Docs rule' })];
    let r = L.writeLessonExport(rules, dir, skills);
    assert.deepEqual(r.written, ['aet-lessons-docs-all.instructions.md']);
    assert.equal(r.rules, 1);
    assert.ok(fs.existsSync(path.join(skills, 'lessons-review', 'SKILL.md')));
    assert.match(fs.readFileSync(path.join(skills, 'lessons-review', 'SKILL.md'), 'utf8'), /^---\nname: lessons-review\n/);

    fs.writeFileSync(path.join(dir, 'aet-lessons-mine.instructions.md'), 'my own file');
    fs.writeFileSync(path.join(skills, 'lessons-review', 'SKILL.md'), 'edited skill');
    r = L.writeLessonExport([], dir, skills);
    assert.deepEqual(r.removed, ['aet-lessons-docs-all.instructions.md']);
    assert.ok(fs.existsSync(path.join(dir, 'aet-lessons-mine.instructions.md')), 'files without the marker stay');
    assert.equal(r.skill, undefined);
    assert.equal(fs.readFileSync(path.join(skills, 'lessons-review', 'SKILL.md'), 'utf8'), 'edited skill');

    fs.writeFileSync(path.join(dir, 'aet-lessons-docs-all.instructions.md'), 'edited by hand');
    r = L.writeLessonExport(rules, dir);
    assert.deepEqual(r.skipped, ['aet-lessons-docs-all.instructions.md']);
    assert.deepEqual(r.written, []);
    assert.equal(fs.readFileSync(path.join(dir, 'aet-lessons-docs-all.instructions.md'), 'utf8'), 'edited by hand');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(skills, { recursive: true, force: true });
  }
});

test('LessonStore applies deltas durably', () => {
  const dir = tmp('store');
  try {
    const a = rule({ id: 'a' });
    new LessonStore(dir).apply({ upsert: [a], remove: [] });
    const s = new LessonStore(dir);
    assert.deepEqual(s.load().rules.map(r => r.id), ['a']);
    s.apply({ upsert: [{ ...a, text: 'changed', updatedAt: a.updatedAt + 1 }], remove: [] });
    assert.equal(new LessonStore(dir).load().rules[0].text, 'changed');
    s.apply({ upsert: [], remove: ['a'] });
    assert.deepEqual(new LessonStore(dir).load().rules, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP get_lessons and propose_rule', () => {
  const dir = tmp('mcp');
  const prev = process.env.AET_STORE_PATH;
  try {
    new CorrectionStore(dir).apply({ owned: {}, add: [
      corr({ id: 'a', t: 1000, start: 1000, workItemId: '1', note: 'No space' }),
      corr({ id: 'b', t: 50000000, start: 50000000, workItemId: '2', note: 'No space' }),
      corr({ id: 'c', t: 99000000, start: 99000000, workItemId: '3' })
    ], patch: {} });
    process.env.AET_STORE_PATH = path.join(dir, 'store.json');
    const { callTool } = require('../out/mcp/server');
    let r = callTool('get_lessons', { includeCandidates: true }, {});
    assert.deepEqual(r.rules, []);
    assert.match(r.note, /No rules yet/);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].repeated, true);
    assert.deepEqual(r.candidates[0].notes, ['No space']);

    const p = callTool('propose_rule', { category: 'style', scope: '*.Table.al', text: 'No space before where(', correctionIds: ['a', 'b'] }, {});
    assert.equal(p.created, true);
    assert.equal(p.rule.status, 'proposed');
    assert.equal(callTool('propose_rule', { category: 'style', scope: '*.Table.al', text: 'no space before WHERE(', correctionIds: ['c'] }, {}).rule.examples, 3);
    assert.throws(() => callTool('propose_rule', { category: 'style', scope: '*.al' }, {}), /text/);

    assert.deepEqual(callTool('get_lessons', { path: 'src/x.Table.al' }, {}).rules, []);
    r = callTool('get_lessons', { path: 'src/x.Table.al', includeProposed: true, includeCandidates: true }, {});
    assert.equal(r.rules.length, 1);
    assert.equal(r.candidates.length, 0, 'the group has a rule now');
    const stored = new LessonStore(dir).load().rules;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].createdBy, 'copilot');
  } finally {
    if (prev === undefined) delete process.env.AET_STORE_PATH; else process.env.AET_STORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lessons settings in package.json match the defaults', () => {
  const props = require('../package.json').contributes.configuration.properties;
  assert.equal(props['aiEffortTracker.lessons.minOccurrences'].default, L.DEFAULT_MIN_OCCURRENCES);
  assert.equal(props['aiEffortTracker.lessons.minWorkItems'].default, L.DEFAULT_MIN_WORK_ITEMS);
  assert.ok(require('../package.json').contributes.commands.some(c => c.command === 'aiEffortTracker.exportLessons'));
});
