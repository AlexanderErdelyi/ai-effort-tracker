const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelPrices, listCost } = require('../out/util/modelCatalog');
const ln = require('../out/analysis/liveNudges');

const tier = (input, cacheRead, cacheWrite, output) =>
  ({ input_price: input, cache_read_price: cacheRead, cache_write_price: cacheWrite, output_price: output, max_prompt_tokens: 1000000 });
const prices = parseModelPrices(JSON.stringify([
  { id: 'opus', model_picker_enabled: true, billing: { token_prices: { default: tier(400, 20, 500, 2000) } } },
  { id: 'sonnet', model_picker_enabled: true, billing: { token_prices: { default: tier(200, 20, 250, 1000) } } },
  { id: 'mini', model_picker_enabled: true, billing: { token_prices: { default: tier(20, 2, 0, 80) } } }
]), 5);

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 1, 9);
const S = { ...ln.DEFAULT_NUDGE_SETTINGS, minGapMinutes: 0, contextTokens: 100000 };

function call(spanId, at, model, input, cached, output, extra = {}) {
  const credits = listCost(prices[model], { inputTokens: input, cachedTokens: cached, outputTokens: output });
  return { spanId, ts: T0 + at, durationMs: 1000, model, credits, inputTokens: input, cachedTokens: cached,
    outputTokens: output, agent: 'panel/editAgent', toolset: 'small', ...extra };
}
function entry(sessionId, turnId, requests, tools = [{ name: 'apply_patch', count: 1 }], files = [{ path: 'a.ts', added: 3 }]) {
  return { id: `${sessionId}-${turnId}`, ts: requests[0].ts, model: '', credits: requests.reduce((n, r) => n + r.credits, 0),
    source: 'auto', branch: 'b', debugUsage: { sessionId, turnId, requests, unpricedRequests: 0 },
    analysis: { files, totalAdded: 0, totalRemoved: 0, tools, toolCalls: 1, requestsDetail: [] } };
}
function data(creditLedger, toolsets = {}) {
  return { creditLedger, modelPrices: prices, toolsets: { small: { id: 'small', toolCount: 20 }, ...toolsets },
    branches: {}, workItems: {}, projects: {} };
}
/** Evaluate with the cursor just before `at` so only calls after it are new. */
function evalAt(d, at, state = ln.emptyNudgeState(), settings = S, sid = 's') {
  const st = { ...state, seen: { ...state.seen, [sid]: T0 + at } };
  const last = Math.max(...d.creditLedger.flatMap(e => e.debugUsage.requests.map(r => r.ts)));
  return ln.evaluateNudges(d, sid, st, settings, last + 1000);
}

test('model-switch fires when a switch re-sends a large context uncached', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 60000, 0, 500), call('b', MIN, 'opus', 62000, 60000, 500)]),
    entry('s', 't2', [call('c', 2 * MIN, 'sonnet', 64000, 0, 400)])
  ]);
  const { nudge, state } = evalAt(d, 1.5 * MIN);
  assert.equal(nudge.type, 'model-switch');
  assert.match(nudge.message, /opus to sonnet/);
  assert.ok(nudge.creditsAtStake > 0);
  assert.equal(state.seen.s, T0 + 2 * MIN);
  assert.equal(state.lastShown['s|model-switch'] > 0, true);
  // Below the configured minimum context it stays quiet.
  assert.equal(evalAt(d, 1.5 * MIN, undefined, { ...S, cacheMinTokens: 100000 }).nudge, null);
});

test('idle-cache fires after a pause expired the prompt cache', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'sonnet', 60000, 0, 500), call('b', MIN, 'sonnet', 62000, 60000, 500)]),
    entry('s', 't2', [call('c', 25 * MIN, 'sonnet', 64000, 0, 400)])
  ]);
  const { nudge } = evalAt(d, 2 * MIN);
  assert.equal(nudge.type, 'idle-cache');
  assert.match(nudge.title, /24-minute pause/);
  assert.equal(nudge.evidence.inputTokens, 64000);
});

test('context-growth fires once the main chat context passes the threshold', () => {
  const reqs = [];
  for (let i = 0; i < 8; i++) reqs.push(call(`r${i}`, i * MIN, 'sonnet', 40000 + i * 12000, i ? 39000 + (i - 1) * 12000 : 0, 300));
  const d = data([entry('s', 't1', reqs.slice(0, 7)), entry('s', 't2', reqs.slice(7))]);
  const { nudge } = evalAt(d, 4.5 * MIN);
  assert.equal(nudge.type, 'context-growth');
  assert.equal(nudge.evidence.contextTokens, 124000);
  assert.ok(nudge.evidence.latePerCall > nudge.evidence.earlyPerCall);
  // Subagent calls never count as the main chat's context.
  const sub = data([entry('s', 't1', reqs.slice(0, 3)), entry('s', 't2', [call('x', 7 * MIN, 'sonnet', 150000, 149000, 10, { subagent: true, spanId: 'x' })])]);
  assert.equal(evalAt(sub, 6.5 * MIN).nudge, null);
  // It fires again only when the context reaches the next doubling, not on every call.
  const shown = evalAt(d, 4.5 * MIN).state;
  const grown = data([...d.creditLedger, entry('s', 't3', [call('y', 8 * MIN, 'sonnet', 190000, 123000, 300)])]);
  assert.equal(evalAt(grown, 7.5 * MIN, shown).nudge, null);
  const doubled = data([...grown.creditLedger, entry('s', 't4', [call('z', 9 * MIN, 'sonnet', 205000, 189000, 300)])]);
  assert.equal(evalAt(doubled, 8.5 * MIN, shown).nudge.type, 'context-growth');
});

test('light-premium fires for consecutive read-only turns on a pricier model', () => {
  const read = [{ name: 'read_file', count: 2 }, { name: 'grep_search', count: 1 }];
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 8000, 0, 300)], read, []),
    entry('s', 't2', [call('b', MIN, 'opus', 9000, 7900, 300)], read, []),
    entry('s', 't3', [call('c', 2 * MIN, 'opus', 10000, 8900, 300)], read, [])
  ]);
  const { nudge } = evalAt(d, 1.5 * MIN);
  assert.equal(nudge.type, 'light-premium');
  assert.equal(nudge.evidence.alternatives[0].model, 'mini');
  assert.ok(nudge.creditsAtStake > 0);
  // An edit in the window, or too few turns, keeps it quiet.
  const edited = data([...d.creditLedger.slice(0, 2), entry('s', 't3', [call('c', 2 * MIN, 'opus', 10000, 8900, 300)])]);
  assert.equal(evalAt(edited, 1.5 * MIN).nudge, null);
  assert.equal(evalAt(d, 1.5 * MIN, undefined, { ...S, lightTurns: 4 }).nudge, null);
});

test('tool-bloat fires once per chat when many tools are offered', () => {
  const big = { id: 'big', toolCount: 140 };
  const d = data([
    entry('s', 't1', [call('a', 0, 'sonnet', 8000, 0, 100, { toolset: 'big' })]),
    entry('s', 't2', [call('b', 60 * MIN, 'sonnet', 9000, 7900, 100, { toolset: 'big' })])
  ], { big });
  const first = evalAt(d, -1);
  assert.equal(first.nudge.type, 'tool-bloat');
  assert.match(first.nudge.title, /140 tools/);
  const again = evalAt(d, 30 * MIN, first.state);
  assert.equal(again.nudge, null, 'never repeats in the same chat, even after the cooldown');
  // Nor in another chat the same day; the next day it may.
  const other = data([entry('o', 't1', [call('o', 70 * MIN, 'sonnet', 8000, 0, 100, { toolset: 'big' })])], { big });
  assert.equal(evalAt(other, 65 * MIN, first.state, S, 'o').nudge, null);
  const nextDay = data([entry('o', 't1', [call('o', 25 * 60 * MIN, 'sonnet', 8000, 0, 100, { toolset: 'big' })])], { big });
  assert.equal(evalAt(nextDay, 24 * 60 * MIN, first.state, S, 'o').nudge.type, 'tool-bloat');
  // tool_search calls are reported even with few tools.
  const searched = data([entry('s', 't1', [call('a', 0, 'sonnet', 8000, 0, 100)], [{ name: 'tool_search', count: 2 }])]);
  assert.match(evalAt(searched, -1).nudge.title, /searched for tools 2/);
});

test('mutes, cooldowns and the global gap are honoured; the cursor always advances', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 60000, 0, 500)]),
    entry('s', 't2', [call('c', 2 * MIN, 'sonnet', 64000, 0, 400)]),
    entry('s', 't3', [call('d', 3 * MIN, 'opus', 66000, 0, 400)])
  ]);
  const muted = evalAt(d, MIN, { ...ln.emptyNudgeState(), mutedSessions: ['s'] });
  assert.equal(muted.nudge, null);
  assert.equal(muted.state.seen.s, T0 + 3 * MIN);
  assert.equal(evalAt(d, MIN, { ...ln.emptyNudgeState(), mutedTypes: ['model-switch'] }).nudge, null);
  assert.equal(evalAt(d, MIN, undefined, { ...S, types: { ...S.types, 'model-switch': false } }).nudge, null);
  assert.equal(evalAt(d, MIN, undefined, { ...S, enabled: false }).nudge, null);

  const first = evalAt(d, MIN);
  assert.equal(first.nudge.type, 'model-switch');
  // Same type for the same chat within the cooldown: quiet.
  assert.equal(evalAt(d, 2.5 * MIN, first.state).nudge, null);
  // Past the cooldown it may fire again.
  const later = { ...first.state, lastShown: { 's|model-switch': T0 - 60 * MIN }, lastAny: 0 };
  assert.equal(evalAt(d, 2.5 * MIN, later).nudge.type, 'model-switch');
  // Global minimum gap between any two nudges.
  const gap = { ...S, minGapMinutes: 5 };
  assert.equal(evalAt(d, 2.5 * MIN, { ...ln.emptyNudgeState(), lastAny: T0 + 3 * MIN }, gap).nudge, null);
  // Nothing new since the cursor: quiet.
  assert.equal(evalAt(d, 3 * MIN).nudge, null);
});

test('on first sight only recent calls are new, so history never nudges', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 60000, 0, 500)]),
    entry('s', 't2', [call('c', 2 * MIN, 'sonnet', 64000, 0, 400)])
  ]);
  const late = ln.evaluateNudges(d, 's', ln.emptyNudgeState(), S, T0 + 60 * MIN);
  assert.equal(late.nudge, null);
  assert.equal(late.state.seen.s, T0 + 2 * MIN);
  const soon = ln.evaluateNudges(d, 's', ln.emptyNudgeState(), S, T0 + 3 * MIN);
  assert.equal(soon.nudge.type, 'model-switch');
  assert.equal(ln.evaluateNudges(d, 'other', ln.emptyNudgeState(), S, T0 + 3 * MIN).nudge, null);
});

test('several triggers yield only the highest-priority nudge', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 90000, 0, 500, { toolset: 'big' })]),
    entry('s', 't2', [call('c', 2 * MIN, 'sonnet', 120000, 0, 400, { toolset: 'big' })])
  ], { big: { id: 'big', toolCount: 150 } });
  const all = ln.detectNudges(d, 's', T0 + MIN, S, T0 + 3 * MIN).map(n => n.type);
  assert.deepEqual(all, ['model-switch', 'context-growth', 'tool-bloat']);
  assert.equal(evalAt(d, MIN).nudge.type, 'model-switch');
});

test('live chat status and label summarise the running chat', () => {
  const d = data([
    entry('s', 't1', [call('a', 0, 'opus', 60000, 0, 500), call('b', MIN, 'opus', 62000, 60000, 500)]),
    entry('s', 't2', [call('c', 2 * MIN, 'opus', 64000, 62000, 400), call('x', 3 * MIN, 'mini', 1000, 0, 10, { agent: 'title' })])
  ]);
  const chat = ln.liveChatStatus(d, 's', T0 + 4 * MIN);
  assert.equal(chat.turns, 2);
  assert.equal(chat.calls, 4);
  assert.equal(chat.model, 'opus', 'utility streams are not the main chat');
  assert.equal(chat.contextTokens, 64000);
  assert.equal(chat.cacheHitPct, 97);
  const total = d.creditLedger.reduce((n, e) => n + e.credits, 0);
  assert.equal(chat.credits, Math.round(total * 10) / 10);
  assert.match(ln.liveChatLabel(chat), /^chat \d+ cr \u00b7 [\d.]+\/call$/);
  assert.equal(ln.liveChatStatus(d, 'none'), null);
  assert.equal(ln.latestSession(d, T0 + 10 * MIN), 's');
  assert.equal(ln.latestSession(d, T0 + 90 * MIN), null);
});

test('persisted state is sanitised and pruned', () => {
  const s = ln.normalizeNudgeState({ mutedTypes: ['model-switch', 'bogus'], mutedSessions: ['a', 5], lastShown: { 'a|x': 5, bad: 'x' },
    lastAny: 'no', seen: { a: NaN, b: 10 } });
  assert.deepEqual(s, { mutedTypes: ['model-switch'], mutedSessions: ['a'], lastShown: { 'a|x': 5 }, lastAny: 0, seen: { b: 10 } });
  assert.deepEqual(ln.normalizeNudgeState(null), ln.emptyNudgeState());
  const now = T0;
  const pruned = ln.pruneNudgeState({ ...ln.emptyNudgeState(), lastShown: { old: now - 8 * 86400000, recent: now - 1000 }, seen: { old: 1 } }, now);
  assert.deepEqual(pruned.lastShown, { recent: now - 1000 });
  assert.deepEqual(pruned.seen, {});
});
