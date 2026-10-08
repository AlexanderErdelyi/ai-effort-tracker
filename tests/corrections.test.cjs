const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../out/analysis/corrections');
const { CorrectionStore } = require('../out/store/correctionStore');
const { extractUserMessages } = require('../out/util/debugLog');

const own = (before, after, t) => { const o = {}; C.addOwnership(o, C.addedLineHashes(before, after), t); return o; };
const AI = ['procedure Foo()', 'begin', '    DoSomething(Customer);', '    DoOther(Vendor);', 'end;'];
const corr = (over = {}) => ({
  id: over.id ?? 'id-1', t: 1000, start: 900, source: 'human', kind: 'modify', repo: 'app', path: 'src/a.al',
  ext: 'al', branch: 'feature', line: 3, aiLines: 1, added: 1, removed: 1, aiAt: 500, ...over
});

test('diffHunks finds the changed region', () => {
  assert.deepEqual(C.diffHunks(['a', 'b', 'c'], ['a', 'x', 'c']), [{ a: 1, aEnd: 2, b: 1, bEnd: 2 }]);
  assert.deepEqual(C.diffHunks(['a', 'b'], ['a', 'b']), []);
});

test('ownership covers the lines an AI edit added, except trivial ones', () => {
  const owned = own([], AI, 1000);
  assert.ok(owned[C.lineHash('    DoSomething(Customer);')]);
  assert.equal(C.lineHash('end;'), undefined);
  assert.equal(C.addOwnership(owned, [C.lineHash('procedure Foo()')], 2000), false, 'the earliest time wins');
  assert.equal(owned[C.lineHash('procedure Foo()')], 1000);
});

test('a later change of AI-written lines is a correction', () => {
  const owned = own([], AI, 1000);
  const current = [...AI];
  current[2] = '    DoSomething(Customer, true);';
  const found = C.detectCorrections(AI, current, owned, 2000, 'src/a.al');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'modify');
  assert.equal(found[0].line, 3);
  assert.equal(found[0].aiLines, 1);
  assert.equal(found[0].aiAt, 1000);
  assert.deepEqual(found[0].before, ['    DoSomething(Customer);']);
  assert.deepEqual(found[0].after, ['    DoSomething(Customer, true);']);
  const noCode = C.detectCorrections(AI, current, owned, 2000, 'src/a.al', false);
  assert.equal(noCode[0].before, undefined);
  assert.equal(noCode[0].after, undefined);
});

test('human code, lines written during the burst and whitespace changes are ignored', () => {
  const current = [...AI];
  current[2] = '    DoSomething(Customer, true);';
  assert.deepEqual(C.detectCorrections(AI, current, {}, 2000), [], 'not AI-owned');
  assert.deepEqual(C.detectCorrections(AI, current, own([], AI, 3000), 2000), [], 'owned after the burst started');
  const indented = [...AI];
  indented[2] = '        DoSomething(Customer);';
  assert.deepEqual(C.detectCorrections(AI, indented, own([], AI, 1000), 2000), []);
});

test('lines inserted inside AI code count, lines appended elsewhere do not', () => {
  const owned = own([], AI, 1000);
  const inside = [...AI.slice(0, 3), '    // Validate the customer first', ...AI.slice(3)];
  const found = C.detectCorrections(AI, inside, owned, 2000);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'insert');
  assert.equal(found[0].line, 4);
  const human = ['// my own header comment', ...AI];
  const appended = [...human, 'procedure HumanBar()', 'begin', 'end;'];
  assert.deepEqual(C.detectCorrections(human, appended, own([], AI, 1000), 2000), []);
});

test('a moved AI block is one move', () => {
  const head = ['// file header comment'];
  const a = ['    FirstCallAlpha(x);', '    SecondCallAlpha(y);', '    ThirdCallAlpha(z);'];
  const b = ['    FirstCallBeta(x);', '    SecondCallBeta(y);'];
  const snapshot = [...head, ...a, ...b], current = [...head, ...b, ...a];
  const found = C.detectCorrections(snapshot, current, own([], [...a, ...b], 1000), 2000);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'move');
  assert.ok(found[0].fromLine);
});

test('linkPrompts finds the origin and, for AI rework, the trigger prompt', () => {
  const msgs = [
    { t: 900_000, sessionId: 's', text: 'write Foo' },
    { t: 1_500_000, sessionId: 's', text: 'sort the functions' },
    { t: 9_000_000, sessionId: 's', text: 'later' }
  ];
  const ai = C.linkPrompts({ aiAt: 1_000_000, start: 2_000_000, source: 'ai' }, msgs);
  assert.equal(ai.origin.text, 'write Foo');
  assert.equal(ai.trigger.text, 'sort the functions');
  const human = C.linkPrompts({ aiAt: 1_000_000, start: 2_000_000, source: 'human' }, msgs, false);
  assert.equal(human.trigger, undefined);
  assert.deepEqual(human.origin, { t: 900_000, sessionId: 's' });
  assert.equal(C.linkPrompts({ aiAt: 1_000_000, start: 1_200_000, source: 'ai' }, msgs.slice(0, 1)).trigger, undefined);
});

test('merge keeps the earliest ownership, dedupes corrections, applies patches and round-trips', () => {
  let data = C.emptyCorrectionStore();
  data = C.mergeCorrectionDelta(data, { owned: { f: { h1: 5000 } }, add: [corr()], patch: {} }, 10_000);
  data = C.mergeCorrectionDelta(data, {
    owned: { f: { h1: 3000, h2: 6000 } }, add: [corr()],
    patch: { 'id-1': { origin: { t: 400, sessionId: 's', text: 'make it' } } }
  }, 11_000);
  assert.equal(data.corrections.length, 1);
  assert.deepEqual(data.owned.f.h, { h1: 3000, h2: 6000 });
  assert.equal(data.corrections[0].origin.text, 'make it');
  assert.deepEqual(C.decodeCorrectionStore(JSON.stringify(data)), data);
  const later = C.pruneCorrectionStore(data, 11_000 + 91 * 86_400_000);
  assert.deepEqual(later.owned, {}, 'ownership expires');
  assert.equal(later.corrections.length, 1, 'corrections are kept');
  assert.deepEqual(C.decodeCorrectionStore('{"version":1,"owned":5,"corrections":[{"id":3}]}'), C.emptyCorrectionStore());
});

test('extractUserMessages reads prompts and skips subagent sessions', () => {
  const lines = [
    { type: 'session_start', sid: 'main', ts: 1, attrs: {} },
    { type: 'user_message', sid: 'main', ts: 1000, attrs: { content: '  fix the sorting  ' } },
    { type: 'llm_request', sid: 'main', ts: 1100, attrs: {} },
    { type: 'session_start', sid: 'child', ts: 2, attrs: { parentSessionId: 'main' } },
    { type: 'user_message', sid: 'child', ts: 1200, attrs: { content: 'subagent task' } }
  ].map(r => JSON.stringify(r)).join('\n') + '\n{broken';
  assert.deepEqual(extractUserMessages(lines, 3), [{ t: 1000, sessionId: 'main', text: 'fix' }]);
});

test('CorrectionStore merges deltas from separate writers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-corr-'));
  try {
    const one = new CorrectionStore(dir), two = new CorrectionStore(dir);
    one.apply({ owned: { f: { h1: 10 } }, add: [corr({ id: 'a' })], patch: {} }, 1000);
    two.apply({ owned: { g: { h2: 20 } }, add: [corr({ id: 'b' })], patch: {} }, 1000);
    const data = one.load();
    assert.deepEqual(data.corrections.map(c => c.id).sort(), ['a', 'b']);
    assert.deepEqual(Object.keys(data.owned).sort(), ['f', 'g']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCorrections filters and counts; the markdown report lists them', () => {
  const day = 86_400_000, now = 100 * day;
  const data = { version: 1, owned: { f: { u: 1, h: { x: 1 } } }, corrections: [
    corr({ id: 'a', t: now - 1000, source: 'ai', kind: 'insert', path: 'src/Sales.al', workItemId: '42',
      trigger: { t: 1, sessionId: 's', text: 'add docs' } }),
    corr({ id: 'b', t: now - 2000, source: 'human', kind: 'modify', path: 'src/Purch.al' }),
    corr({ id: 'c', t: now - 10 * day, source: 'human', kind: 'delete', path: 'docs/readme.md', ext: 'md' })
  ] };
  const all = C.listCorrections(data, {}, now);
  assert.equal(all.total, 3);
  assert.deepEqual(all.corrections.map(c => c.id), ['a', 'b', 'c']);
  assert.deepEqual(all.bySource, { ai: 1, human: 2 });
  assert.equal(all.owned, undefined);
  assert.deepEqual(C.listCorrections(data, { days: 7 }, now).corrections.map(c => c.id), ['a', 'b']);
  assert.deepEqual(C.listCorrections(data, { source: 'human', path: 'SRC\\' }, now).corrections.map(c => c.id), ['b']);
  assert.deepEqual(C.listCorrections(data, { workItemId: '42' }, now).corrections.map(c => c.id), ['a']);
  assert.equal(C.listCorrections(data, { limit: 1 }, now).corrections.length, 1);
  const md = C.correctionsMarkdown(all);
  assert.match(md, /# Captured corrections/);
  assert.match(md, /## Your changes to AI code \(2\)/);
  assert.match(md, /### modify in src\/Purch\.al:3/);
  assert.match(md, /### "add docs"/);
  assert.match(md, /- insert src\/Sales\.al:3/);
  assert.match(C.correctionsMarkdown(C.listCorrections(C.emptyCorrectionStore(), {}, now)), /Nothing captured yet/);
});

test('groupEpisodes groups AI rework per prompt and human edits per sitting', () => {
  const min = 60_000, p1 = { t: 1, sessionId: 's', text: 'make it sales or purchase' };
  const list = [
    corr({ id: 'a1', t: 10 * min, start: 10 * min, source: 'ai', path: 'plan.md', trigger: p1, added: 2 }),
    corr({ id: 'a2', t: 11 * min, start: 11 * min, source: 'ai', path: 'ac.md', trigger: p1, added: 3 }),
    corr({ id: 'a3', t: 12 * min, start: 12 * min, source: 'ai', path: 'plan.md', trigger: { t: 2, sessionId: 's' } }),
    corr({ id: 'h1', t: 20 * min, start: 20 * min, source: 'human', path: 'x.al', workItemId: '7' }),
    corr({ id: 'h2', t: 25 * min, start: 25 * min, source: 'human', path: 'y.al' }),
    corr({ id: 'h3', t: 60 * min, start: 60 * min, source: 'human', path: 'x.al' })
  ];
  const eps = C.groupEpisodes(list);
  assert.deepEqual(eps.map(e => e.correctionIds), [['h3'], ['h1', 'h2'], ['a3'], ['a1', 'a2']]);
  const promptEp = eps[3];
  assert.equal(promptEp.prompt, 'make it sales or purchase');
  assert.deepEqual(promptEp.files, ['plan.md', 'ac.md']);
  assert.equal(promptEp.added, 5);
  assert.equal(eps[1].workItemId, '7');
});

test('placeholder work items are not stored on corrections', () => {
  assert.equal(C.realWorkItemId('__unassigned__'), undefined);
  assert.equal(C.realWorkItemId('unknown'), undefined);
  assert.equal(C.realWorkItemId('2294'), '2294');
  const raw = JSON.stringify({ version: 1, owned: {}, corrections: [corr({ id: 'a', workItemId: '__unassigned__' })] });
  assert.equal(C.decodeCorrectionStore(raw).corrections[0].workItemId, undefined);
});

test('MCP list_corrections reads the store next to the effort store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-corr-mcp-'));
  const prev = process.env.AET_STORE_PATH;
  try {
    new CorrectionStore(dir).apply({ owned: { f: { h: 1 } }, add: [corr({ id: 'a', t: Date.now(), kind: 'move' })], patch: {} });
    process.env.AET_STORE_PATH = path.join(dir, 'store.json');
    const { callTool } = require('../out/mcp/server');
    const result = callTool('list_corrections', { kind: 'move', source: 'bogus' }, {});
    assert.equal(result.total, 1);
    assert.equal(result.corrections[0].id, 'a');
    assert.equal(result.corrections[0].suggestion.category, 'ordering/structure', 'unlabelled corrections carry a suggestion');
    assert.equal(result.owned, undefined);
    assert.equal(callTool('list_corrections', { kind: 'insert' }, {}).total, 0);
  } finally {
    if (prev === undefined) delete process.env.AET_STORE_PATH; else process.env.AET_STORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const L = require('../out/analysis/correctionLabels');

test('a cleared label removes category, scope, note and who labelled it', () => {
  const now = Date.now();
  const data = { version: 1, owned: {}, corrections: [corr({ id: 'a', t: now })] };
  let next = C.mergeCorrectionDelta(data, L.labelDelta(data, ['a', 'missing'], { category: ' Wrong  Fact ', note: 'Use field 20' }, 'user', now), now);
  const c = next.corrections[0];
  assert.equal(c.category, 'wrong fact');
  assert.equal(c.scope, '**/*.al', 'scope defaults to the file type');
  assert.equal(c.note, 'Use field 20');
  assert.equal(c.labeledBy, 'user');
  next = C.mergeCorrectionDelta(next, L.labelDelta(next, ['a'], { category: '' }, 'user', now), now);
  const d = next.corrections[0];
  assert.equal(d.category, undefined);
  assert.equal(d.scope, undefined);
  assert.equal(d.note, undefined);
  assert.equal(d.labeledBy, undefined);
});

test('labels survive the store round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-corr-label-'));
  try {
    const store = new CorrectionStore(dir);
    store.apply({ owned: {}, add: [corr({ id: 'a', t: Date.now() }), corr({ id: 'b', t: Date.now() })], patch: {} });
    store.apply(L.labelDelta(store.load(), ['a'], { category: 'style', scope: 'app/**' }, 'copilot'));
    const fresh = new CorrectionStore(dir).load();
    assert.equal(fresh.corrections.find(c => c.id === 'a').category, 'style');
    assert.equal(fresh.corrections.find(c => c.id === 'a').scope, 'app/**');
    assert.equal(fresh.corrections.find(c => c.id === 'a').labeledBy, 'copilot');
    assert.equal(fresh.corrections.find(c => c.id === 'b').category, undefined);
    assert.equal(C.listCorrections(fresh, { category: 'none' }).total, 1);
    assert.equal(C.listCorrections(fresh, { category: 'Style' }).total, 1);
    assert.deepEqual(C.listCorrections(fresh, {}).byCategory, { style: 1, '(unlabeled)': 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('suggestions guess the category from the change or the prompt', () => {
  const rules = L.compileKeywordRules(L.DEFAULT_KEYWORD_RULES);
  assert.equal(L.suggestLabel(corr({ before: ['exit(7);'], after: ['exit(9);'] }), rules).category, 'wrong fact');
  assert.equal(L.suggestLabel(corr({ before: ['if x where (a) then'], after: ['if x where(a) then'] }), rules).category, 'style');
  assert.equal(L.suggestLabel(corr({ kind: 'insert', before: [], after: ['    // Returns the total'] }), rules).category, 'documentation');
  assert.equal(L.suggestLabel(corr({ kind: 'move' }), rules).category, 'ordering/structure');
  assert.equal(L.suggestLabel(corr({ before: ['a := 1;'], after: ['b := Calc(a);'] }), rules), undefined);
  const ai = text => L.suggestLabel(corr({ source: 'ai', trigger: { t: 1, sessionId: 's', text } }), rules).category;
  assert.equal(ai('update the status of the spec with what you did'), 'progress update');
  assert.equal(ai('this is wrong, the field should be 20'), 'logic bug');
  assert.equal(ai('please add documentation to the procedures'), 'documentation');
  assert.equal(ai('the customer also wants an email field'), 'requirement change');
  assert.equal(L.suggestLabel(corr({ source: 'ai', trigger: { t: 1, sessionId: 's', text: 'yes 20 is right' }, before: ['field(13; X)'], after: ['field(20; X)'] }), rules).category, 'wrong fact', 'the change decides when no keyword matches');
  assert.equal(L.compileKeywordRules([{ pattern: '(', category: 'x' }, { pattern: 'ok', category: '' }, null, { pattern: 'ok', category: 'Naming' }]).length, 1);
});

test('more change heuristics for your own edits (#151)', () => {
  const rules = L.compileKeywordRules(L.DEFAULT_KEYWORD_RULES);
  const h = over => L.suggestLabel(corr(over), rules);
  assert.equal(h({ before: ['Message(TEXT);'], after: ['message(Text);'] }).category, 'style', 'letter case');
  assert.equal(h({ path: 'src/a.ts', ext: 'ts', before: ["const a = 'x'"], after: ['const a = "x";'] }).category, 'style', 'quotes and semicolons');
  const reorder = h({ before: ['    DoA(Customer);', '    DoB(Vendor);'], after: ['    DoB(Vendor);', '    DoA(Customer);'] });
  assert.equal(reorder.category, 'ordering/structure');
  const renamed = h({ before: ['x := Calc(cust);', 'Show(cust);'], after: ['x := Calc(Customer);', 'Show(Customer);'] });
  assert.equal(renamed.category, 'naming');
  assert.match(renamed.reason, /cust.*Customer/);
  assert.equal(h({ before: ['if a then'], after: ['IF a THEN'] }).category, 'style', 'keyword case is style, not a rename');
  assert.equal(h({ path: 'test/Sales.Test.al', before: ['a := 1;'], after: ['b := Calc(a);'] }).category, 'tests');
  assert.equal(h({ path: 'specs/feature/plan.md', ext: 'md', before: ['a b c'], after: ['a b d e'] }).category, 'documentation', 'specs/ holds documents, not tests');
  assert.equal(h({ kind: 'insert', before: [], after: ['if not Customer.Get(No) then', "    Error('Customer %1 not found', No);"] }).category, 'error handling');
  assert.equal(h({ path: 'docs/readme.md', ext: 'md', before: ['old text here'], after: ['new words there'] }).category, 'documentation');
  const ai = over => L.suggestLabel(corr({ source: 'ai', trigger: { t: 1, sessionId: 's', text: 'go on' }, ...over }), rules);
  assert.equal(ai({ path: 'test/x.al', before: ['a := 1;'], after: ['b := Calc(a);'] }).source, 'default', 'AI rework keeps the default: its prompt says why');
  assert.equal(ai({ before: ['exit(7);'], after: ['exit(9);'] }).category, 'wrong fact', 'plain checks still apply to AI rework');
});

test('code moved between two corrections is ordering/structure (#151)', () => {
  const block = ['    Total := Total + Line.Amount;', '    Count := Count + 1;'];
  const list = [
    corr({ id: 'del', kind: 'delete', line: 40, before: block, after: [], added: 0, removed: 2 }),
    corr({ id: 'ins', kind: 'insert', t: 1500, line: 10, before: [], after: block, added: 2, removed: 0 }),
    corr({ id: 'same', kind: 'modify', t: 1600, line: 41, before: block, after: ['x'], path: 'src/b.al' }),
    corr({ id: 'again', kind: 'modify', t: 1700, line: 42, before: ['x'], after: block, path: 'src/b.al' })
  ];
  const moves = L.crossMoves(list);
  assert.ok(moves.has('del') && moves.has('ins'));
  assert.ok(!moves.has('same') && !moves.has('again'), 'rewriting the same spot is not a move');
  const s = L.suggestLabel(list[0], L.compileKeywordRules(L.DEFAULT_KEYWORD_RULES), { moves });
  assert.equal(s.category, 'ordering/structure');
});

test('suggestions follow your earlier labels of similar corrections (#149)', () => {
  const trigger = { t: 1, sessionId: 's', text: 'mark the open points as answered' };
  const labelled = [1, 2, 3].map(n => corr({ id: 'l' + n, source: 'ai', path: 'specs/plan.md', ext: 'md', trigger, before: ['- [ ] point ' + n], after: ['- [x] point ' + n], category: 'progress update', scope: '**/*.md', labeledBy: 'user', note: 'Status only' }));
  const fresh = corr({ id: 'u', source: 'ai', path: 'specs/plan.md', ext: 'md', trigger, before: ['- [ ] point 4'], after: ['- [x] point 4'] });
  const other = corr({ id: 'o', source: 'ai', path: 'src/x.al', trigger: { t: 9, sessionId: 'z', text: 'rename the procedure' }, before: ['procedure A()'], after: ['procedure B()'] });
  const suggest = L.createSuggester([...labelled, fresh, other], L.DEFAULT_KEYWORD_RULES);
  const s = suggest(fresh);
  assert.equal(s.source, 'history');
  assert.equal(s.category, 'progress update');
  assert.equal(s.scope, '**/*.md');
  assert.equal(s.note, 'Status only');
  assert.match(s.reason, /3 corrections/);
  assert.notEqual(suggest(other).source, 'history', 'a different prompt on other code does not copy the label');
  const bulk = labelled.map(c => ({ ...c, labeledBy: 'rule' }));
  assert.notEqual(L.createSuggester([...bulk, fresh], L.DEFAULT_KEYWORD_RULES)(fresh).source, 'history', 'bulk-accepted labels are not history');
});

test('labelling records the suggestion and accuracy is measured per source (#150)', () => {
  const now = Date.now();
  const data = { version: 1, owned: {}, corrections: [
    corr({ id: 'n', t: now, before: ['exit(7);'], after: ['exit(9);'] }),
    corr({ id: 'k', t: now, source: 'ai', trigger: { t: 1, sessionId: 's', text: 'update the status' } })
  ] };
  let next = C.mergeCorrectionDelta(data, L.labelDelta(data, ['n'], { category: 'wrong fact' }, 'user', now), now);
  next = C.mergeCorrectionDelta(next, L.labelDelta(next, ['k'], { category: 'requirement change' }, 'copilot', now), now);
  assert.deepEqual(next.corrections.find(c => c.id === 'n').suggested, { category: 'wrong fact', source: 'heuristic' });
  assert.equal(next.corrections.find(c => c.id === 'k').suggested.source, 'keyword');
  assert.ok(next.corrections.find(c => c.id === 'k').suggested.rule);
  const relabel = C.mergeCorrectionDelta(next, L.labelDelta(next, ['n'], { category: 'style' }, 'user', now), now);
  assert.equal(relabel.corrections.find(c => c.id === 'n').suggested.category, 'wrong fact', 'relabelling keeps the first suggestion');
  const cleared = C.mergeCorrectionDelta(next, L.labelDelta(next, ['n'], { category: '' }, 'user', now), now);
  assert.equal(cleared.corrections.find(c => c.id === 'n').suggested, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-corr-suggested-'));
  try {
    const store = new CorrectionStore(dir);
    store.apply({ owned: {}, add: next.corrections, patch: {} });
    assert.deepEqual(new CorrectionStore(dir).load().corrections.find(c => c.id === 'n').suggested, { category: 'wrong fact', source: 'heuristic' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rule = '\\b(status)\\b';
  const judged = (id, category, source, by = 'user', extra = {}) => corr({ id, category, labeledBy: by, suggested: { category: source === 'keyword' ? 'progress update' : 'wrong fact', source, ...extra } });
  const acc = L.suggestionAccuracy([
    judged('1', 'wrong fact', 'heuristic'),
    judged('2', 'style', 'heuristic'),
    judged('3', 'logic bug', 'keyword', 'user', { rule }),
    judged('4', 'logic bug', 'keyword', 'copilot', { rule }),
    judged('5', 'progress update', 'keyword', 'user', { rule }),
    judged('6', 'wrong fact', 'heuristic', 'rule'),
    corr({ id: '7', category: 'style', labeledBy: 'user' })
  ]);
  assert.equal(acc.judged, 5);
  assert.equal(acc.accepted, 2);
  assert.equal(acc.bulk, 1);
  assert.deepEqual(acc.bySource.map(x => [x.source, x.judged, x.accepted]), [['keyword', 3, 1], ['heuristic', 2, 1]]);
  assert.deepEqual(acc.overriddenRules, [{ rule, category: 'progress update', judged: 3, overridden: 2, usually: 'logic bug' }]);
  assert.equal(L.suggestionAccuracy([]).rate, null);
});

test('scope suggestions follow the AL object type or file extension', () => {
  assert.equal(L.suggestScope('app/src/Sales.Codeunit.al'), '**/*.Codeunit.al');
  assert.equal(L.suggestScope('docs\\spec.md'), '**/*.md');
  assert.equal(L.suggestScope('scripts/Makefile'), 'scripts/**');
});

test('the corrections view counts labels, suggestions and lessons', () => {
  const now = Date.now();
  const data = { version: 1, owned: {}, corrections: [
    corr({ id: 'h1', t: now, before: ['exit(7);'], after: ['exit(9);'] }),
    corr({ id: 'h2', t: now + 1000, category: 'style', scope: '**/*.al', labeledBy: 'user' }),
    corr({ id: 'a1', t: now - 60_000, source: 'ai', trigger: { t: now - 70_000, sessionId: 's', text: 'new requirement: add email' } })
  ] };
  const v = L.correctionsView(data, ['Wrong Fact', 'style', ''], L.DEFAULT_KEYWORD_RULES);
  assert.deepEqual(v.categories, ['wrong fact', 'style']);
  assert.deepEqual(v.stats, { total: 3, human: 2, ai: 1, prompts: 1, labeled: 1, suggested: 2, lessons: 1 });
  assert.deepEqual(v.byCategory.map(g => [g.category, g.count, g.lesson]), [['style', 1, true]]);
  const items = v.episodes.flatMap(e => e.items);
  assert.equal(items.find(i => i.id === 'h1').suggestion.category, 'wrong fact');
  assert.equal(items.find(i => i.id === 'h2').suggestion, undefined, 'labelled corrections get no suggestion');
  const accepted = C.mergeCorrectionDelta(data, L.acceptSuggestionsDelta(v, now), now);
  assert.equal(accepted.corrections.find(c => c.id === 'h1').category, 'wrong fact');
  assert.equal(accepted.corrections.find(c => c.id === 'h1').labeledBy, 'rule');
  assert.equal(accepted.corrections.find(c => c.id === 'a1').category, 'requirement change');
  assert.equal(accepted.corrections.find(c => c.id === 'h2').labeledBy, 'user', 'existing labels are kept');
});

test('package.json defaults match the built-in categories and keyword rules', () => {
  const props = require('../package.json').contributes.configuration.properties;
  assert.deepEqual(props['aiEffortTracker.corrections.categories'].default, L.DEFAULT_LESSON_CATEGORIES);
  assert.deepEqual(props['aiEffortTracker.corrections.keywordRules'].default, L.DEFAULT_KEYWORD_RULES);
});

test('MCP label_correction labels by id or episode and writes the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-corr-mcp-label-'));
  const prev = process.env.AET_STORE_PATH;
  try {
    const now = Date.now();
    new CorrectionStore(dir).apply({ owned: {}, add: [
      corr({ id: 'a', t: now }),
      corr({ id: 'b', t: now, source: 'ai', trigger: { t: now - 5, sessionId: 's', text: 'p' } }),
      corr({ id: 'c', t: now + 1, source: 'ai', trigger: { t: now - 5, sessionId: 's', text: 'p' } })
    ], patch: {} });
    process.env.AET_STORE_PATH = path.join(dir, 'store.json');
    const { callTool } = require('../out/mcp/server');
    const r = callTool('label_correction', { ids: ['a', 'zzz'], category: 'Logic Bug', note: 'Check the sign' }, {});
    assert.equal(r.labeled, 1);
    assert.deepEqual(r.unknownIds, ['zzz']);
    assert.equal(r.corrections[0].category, 'logic bug');
    const ep = callTool('list_corrections', { source: 'ai' }, {}).episodes[0];
    assert.equal(callTool('label_correction', { episodeId: ep.id, category: 'requirement change', scope: 'docs/**' }, {}).labeled, 2);
    const stored = new CorrectionStore(dir).load().corrections;
    assert.ok(stored.filter(c => c.source === 'ai').every(c => c.category === 'requirement change' && c.scope === 'docs/**' && c.labeledBy === 'copilot'));
    assert.equal(callTool('list_corrections', { category: 'none' }, {}).total, 0);
    assert.throws(() => callTool('label_correction', { ids: ['a'] }, {}), /category/);
    assert.throws(() => callTool('label_correction', { category: 'style' }, {}), /ids/);
    assert.throws(() => callTool('label_correction', { episodeId: 'nope', category: 'style' }, {}), /episode/);
  } finally {
    if (prev === undefined) delete process.env.AET_STORE_PATH; else process.env.AET_STORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
