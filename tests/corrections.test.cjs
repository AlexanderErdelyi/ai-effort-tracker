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
    assert.equal(result.owned, undefined);
    assert.equal(callTool('list_corrections', { kind: 'insert' }, {}).total, 0);
  } finally {
    if (prev === undefined) delete process.env.AET_STORE_PATH; else process.env.AET_STORE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
