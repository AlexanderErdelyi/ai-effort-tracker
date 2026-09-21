const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDebugLog } = require('../out/util/debugLog');
const { countLineDiff, toolEditImpact } = require('../out/util/editImpact');
const { parseDebugExport } = require('../out/util/debugExport');

const row = (type, spanId, attrs = {}, extra = {}) => ({
  type, spanId, sid: 'session', ts: 1000, dur: 12, status: 'ok', attrs, ...extra
});
const root = (id = 'root') => row('user_message', id, { content: 'PRIVATE PROMPT' });
const request = (spanId = 'request', attrs = {}, extra = {}) =>
  row('llm_request', spanId, { model: 'model', inputTokens: 100, outputTokens: 10,
    copilotUsageNanoAiu: 1e9, ...attrs }, { parentSpanId: 'root', ...extra });
const parse = rows => parseDebugLog(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const patch = '*** Begin Patch\n*** Update File: C:\\code.ts\n@@\n-old secret\n+new secret\n+other secret\n*** End Patch';
const tool = (id = 'tool', extra = {}) => row('tool_call', id, {
  args: JSON.stringify({ input: patch, explanation: 'PRIVATE EXPLANATION' }),
  result: JSON.stringify({ node: { children: [{ text: 'The following files were successfully edited:' }, { text: 'C:\\code.ts' }] } })
}, { name: 'apply_patch', parentSpanId: 'root', ...extra });

test('root graph groups multiple rounds and nested spans, independently of row order', () => {
  const result = parse([
    request('one', { responseId: 'shared' }, { parentSpanId: 'nested' }),
    root(), row('generic', 'nested', {}, { parentSpanId: 'root' }),
    row('turn_start', 'turn_start-root-0', { turnId: '0' }),
    row('turn_end', 'turn_end-root-0', { turnId: '0' }),
    row('turn_start', 'turn_start-root-1', { turnId: '1' }),
    request('two', { responseId: 'shared', copilotUsageNanoAiu: 2e9 }, { parentSpanId: 'turn_start-root-1' }),
    tool(), root('next'), request('three', {}, { parentSpanId: 'next' })
  ]);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].turnId, 'root');
  assert.equal(result.turns[0].requests.length, 2);
  assert.deepEqual(result.turns[0].responseIds, ['shared']);
  assert.equal(result.turns[0].credits, 3);
  assert.equal(result.turns[0].analysis.totalAdded, 2);
  assert.equal(result.turns[0].analysis.totalRemoved, 1);
  assert.deepEqual(result.diagnostics, []);
  const serialized = JSON.stringify(result);
  for (const secret of ['PRIVATE', 'old secret', 'new secret', 'copilotUsageNanoAiu', 'explanation']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('duplicate spans replace snapshots, unknown and zero charges are distinct', () => {
  const result = parse([
    root(), request('one'), request('one', { copilotUsageNanoAiu: 2e9 }),
    request('zero', { copilotUsageNanoAiu: 0, cachedTokens: 80 }),
    request('unknown', { copilotUsageNanoAiu: undefined }),
    request('invalid', { copilotUsageNanoAiu: -1 }), tool(), tool()
  ]);
  const turn = result.turns[0];
  assert.equal(turn.requests.length, 4);
  assert.equal(turn.credits, 2);
  assert.equal(turn.unknownRequestCount, 2);
  assert.equal(turn.requests[1].credits, 0);
  assert.equal(turn.analysis.requestsDetail.length, 2);
  assert.equal(turn.analysis.toolCalls, 1);
  assert.equal(turn.analysis.files[0].edits, 1);
  assert.equal(turn.analysis.tiers.cacheRead, 80);
  assert.equal(turn.analysis.tiers.input, 320);
  assert.deepEqual(turn.analysis.tierCredits, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});

test('same response ID on distinct physical spans is not a duplicate charge', () => {
  const { turns } = parse([root(), request('a', { responseId: 'shared' }), request('b', { responseId: 'shared' })]);
  assert.equal(turns[0].requests.length, 2);
  assert.equal(turns[0].credits, 2);
  assert.deepEqual(turns[0].responseIds, ['shared']);
});

test('spanless records are diagnosed, not conflated with physical requests by response ID', () => {
  const { turns, diagnostics } = parse([root(), request('', { responseId: 'shared' }), request('', { responseId: 'shared' })]);
  assert.equal(turns[0].requests.length, 0);
  assert.equal(diagnostics.length, 2);
  const mixed = parse([root(), request('', { responseId: 'shared' }), request('physical', { responseId: 'shared' })]);
  assert.equal(mixed.turns[0].requests.length, 1);
  assert.equal(mixed.turns[0].requests[0].spanId, 'physical');
});

test('failed uncharged calls and error-valued tool results are not counted', () => {
  const { turns } = parse([root(), request('bad', { copilotUsageNanoAiu: undefined }, { status: 'error' }),
    tool('badTool', { status: 'error' }),
    tool('falseSuccess', { attrs: { args: JSON.stringify({ input: patch }), result: '{"success":false}' } }),
    tool('nestedError', { attrs: { args: JSON.stringify({ input: patch }), result: '{"node":{"children":[{"text":"Error: patch rejected"}]}}' } }),
    request('pending', { copilotUsageNanoAiu: undefined }, { status: 'running' })]);
  assert.equal(turns[0].requests.length, 0);
  assert.equal(turns[0].analysis.toolCalls, 0);
  assert.equal(turns[0].analysis.files.length, 0);
});

test('explicit recorded charges survive an unsuccessful model request', () => {
  const { turns } = parse([root(), request('charged-error', {}, { status: 'error' })]);
  assert.equal(turns[0].credits, 1);
});

test('a later partial snapshot does not erase an already recorded span charge', () => {
  const { turns } = parse([root(), request('a'), request('a', { copilotUsageNanoAiu: null })]);
  assert.equal(turns[0].credits, 1);
  assert.equal(turns[0].unknownRequestCount, 0);
});

test('malformed completed lines are diagnosed without leaking payload; final partial line is ignored', () => {
  const result = parseDebugLog(`${JSON.stringify(root())}\nPRIVATE INVALID CONTENT\n${JSON.stringify(request())}\n{"unfinished":`);
  assert.equal(result.turns[0].requests.length, 1);
  assert.equal(result.ignoredPartialLine, true);
  assert.deepEqual(result.diagnostics, ['Line 2: malformed JSON record ignored.']);
  assert.equal(parseDebugLog(`${JSON.stringify(root())}\n${JSON.stringify(request())}`).turns[0].requests.length, 1);
  assert.equal(parseDebugLog('{"unfinished":\n').diagnostics.length, 1);
});

test('sessions isolate repeated span IDs and cycles/unrooted calls fail closed', () => {
  const { turns, diagnostics } = parse([
    root(), request(), root('second'), row('generic', 'cycleA', {}, { parentSpanId: 'cycleB' }),
    row('generic', 'cycleB', {}, { parentSpanId: 'cycleA' }),
    request('cyclic', {}, { parentSpanId: 'cycleA' }), request('orphan', {}, { parentSpanId: 'missing' }),
    { ...root(), sid: 'other' }, request('request', {}, { sid: 'other' })
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns.reduce((sum, t) => sum + t.credits, 0), 2);
  assert.equal(diagnostics.length, 2);
});

test('patch add/update/move/delete counts handle CRLF and trailing newline', () => {
  const p = [
    '*** Begin Patch', '*** Add File: new.ts', '+a', '+', '+b',
    '*** Update File: old.ts', '*** Move to: moved.js', '@@', ' context', '-old', '+new', '@@', '+more',
    '*** Delete File: gone.ts', '*** End Patch', ''
  ].join('\r\n');
  const result = toolEditImpact('apply_patch', { input: p });
  assert.deepEqual(result.files.map(f => [f.path, f.added, f.removed]), [
    ['new.ts', 3, 0], ['moved.js', 2, 1], ['gone.ts', 0, 0]
  ]);
  assert.equal(result.files[0].created, true);
  assert.equal(result.files[1].ext, 'js');
  assert.match(result.diagnostics[0], /unknown/);
  assert.equal(toolEditImpact('apply_patch', { input: patch.replace('*** End Patch', '') }).files.length, 0);
});

test('replacement diff preserves whitespace, common middle and line ordering', () => {
  assert.deepEqual(countLineDiff('old\nmiddle\nold2\n', 'new\nmiddle\nnew2\n'), { added: 2, removed: 2 });
  assert.deepEqual(countLineDiff('a\nb\nc\n', 'c\nb\na\n'), { added: 2, removed: 2 });
  assert.deepEqual(countLineDiff('x\n', ' x\n'), { added: 1, removed: 1 });
  assert.deepEqual(countLineDiff('', 'a\n'), { added: 1, removed: 0 });
  assert.deepEqual(countLineDiff('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
  const middle = Array.from({ length: 5000 }, (_, i) => `${i}`).join('\n');
  assert.deepEqual(countLineDiff(`old\n${middle}\nold2`, `new\n${middle}\nnew2`), { added: 2, removed: 2 });
  const big = Array.from({ length: 3000 }, (_, i) => `${i}`).join('\n');
  assert.equal(countLineDiff(big, big.replace(/\d+/g, s => `other${s}`)), null);
});

test('bounded diff agrees with a small independent dynamic-programming reference', () => {
  let seed = 42;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 300; trial++) {
    const a = Array.from({ length: random() % 20 }, () => String(random() % 5));
    const b = Array.from({ length: random() % 20 }, () => String(random() % 5));
    const table = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      table[i][j] = a[i - 1] === b[j - 1] ? 1 + table[i - 1][j - 1] : Math.max(table[i - 1][j], table[i][j - 1]);
    }
    const common = table[a.length][b.length];
    assert.deepEqual(countLineDiff(a.join('\n'), b.join('\n')), { added: b.length - common, removed: a.length - common });
  }
});

test('shared helper supports legacy JSON/string-indexed arguments and debug exports', () => {
  const args = JSON.stringify({ filePath: 'f.ts', oldString: 'a\nb\nc', newString: 'x\nb\ny' });
  assert.equal(toolEditImpact('replace_string_in_file', { ...args }).files[0].added, 2);
  assert.equal(toolEditImpact('read_file', { filePath: 'f.ts' }).files.length, 0);
  assert.equal(toolEditImpact('create_file', { filePath: 'f.ts', content: 'a\n' }).files[0].added, 1);
  const result = parseDebugExport({ promptId: 'p', logs: [
    { metadata: { usage: { copilot_usage: { total_nano_aiu: 1e9 } } } },
    { kind: 'toolCall', tool: 'apply_patch', args: JSON.stringify({ input: patch }) }
  ] });
  assert.equal(result[0].analysis.totalAdded, 2);
  assert.equal(result[0].analysis.totalRemoved, 1);
  const failed = parseDebugExport({ promptId: 'p', logs: [
    { metadata: { usage: { copilot_usage: { total_nano_aiu: 1e9 } } } },
    { kind: 'toolCall', tool: 'apply_patch', args: JSON.stringify({ input: patch }), result: { success: false } }
  ] });
  assert.equal(failed[0].analysis.totalAdded, 0);
  assert.equal(failed[0].credits, 1);
});

test('exports expose unique model-response aliases without conflating prompt or request IDs', () => {
  const log = (responseId, credits) => ({ metadata: {
    responseId, ourRequestId: 'request-other', usage: { copilot_usage: { total_nano_aiu: credits * 1e9 } }
  } });
  const result = parseDebugExport({ promptId: 'prompt-distinct', logs: [
    log('response-shared', 1), log('response-shared', 2), log('response-zero', 0),
    { metadata: { usage: { responseId: 'usage-response', copilot_usage: { total_nano_aiu: 1e9 } } } },
    { metadata: { responseId: 'not-counted', ourRequestId: 'request-other' } }
  ] });
  assert.equal(result[0].promptId, 'prompt-distinct');
  assert.deepEqual(result[0].responseIds, ['response-shared', 'response-zero', 'usage-response']);
  assert.equal(result[0].credits, 4, 'shared linkage does not collapse distinct request costs');
  assert.equal(result[0].requests, 4);
  assert.equal(parseDebugExport({ promptId: 'no-ids', logs: [log(undefined, 1)] })[0].responseIds, undefined);
});
