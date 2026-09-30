const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelPrices, listCost, parseToolset, BUILTIN_SERVER } = require('../out/util/modelCatalog');
const { modelEfficiency, toolProfile, defaultClassifier, QA_TASK } = require('../out/analysis/efficiency');
const { sanitizeRules, categorizeWith } = require('../out/util/categoryRules');

const tier = (input, cacheRead, cacheWrite, output) =>
  ({ input_price: input, cache_read_price: cacheRead, cache_write_price: cacheWrite, output_price: output, max_prompt_tokens: 200000 });
const prices = parseModelPrices(JSON.stringify([
  { id: 'big', billing: { token_prices: { default: tier(400, 20, 500, 2000) } } },
  { id: 'small', billing: { token_prices: { default: tier(20, 2, 25, 100) } } }
]), 5);

const T0 = Date.UTC(2026, 8, 1, 9);
const NOW = T0 + 24 * 3600_000;
let seq = 0;
function turn(model, files, extra = {}) {
  const i = seq++;
  const credits = listCost(prices[model], { inputTokens: 20000, cachedTokens: 10000, outputTokens: 500 });
  const req = { spanId: `r${i}`, ts: T0 + i * 60_000, durationMs: 1000, model, credits, inputTokens: 20000, cachedTokens: 10000,
    outputTokens: 500, agent: 'panel/editAgent', toolset: 'ts1' };
  const added = files.reduce((n, f) => n + f.added, 0);
  return { id: `t${i}`, ts: req.ts, model: '', credits, source: 'auto', branch: 'b', workItemId: 'WI-1', projectId: 'p1',
    debugUsage: { sessionId: 's', turnId: `t${i}`, requests: [req], unpricedRequests: 0 },
    analysis: { files, totalAdded: added, totalRemoved: 0, tools: extra.tools ?? [{ name: 'read_file', count: 1 }], toolCalls: 1, requestsDetail: [] } };
}
const code = n => [{ path: 'src/a.al', ext: '.al', added: n, removed: 0, edits: 1 }];
const docs = n => [{ path: 'README.md', ext: '.md', added: n, removed: 0, edits: 1, category: 'documentation' }];

function fixture(turns) {
  const toolset = parseToolset(JSON.stringify([
    { name: 'read_file', description: 'x'.repeat(400) },
    { name: 'mcp_used_srv_a_one', description: 'y'.repeat(400) }, { name: 'mcp_used_srv_a_two' },
    { name: 'mcp_idle_srv_b_one', description: 'z'.repeat(4000) }, { name: 'mcp_idle_srv_b_two', description: 'z'.repeat(4000) }
  ]), T0);
  toolset.id = 'ts1';
  return { creditLedger: turns, toolsets: { ts1: toolset }, modelPrices: prices, branches: {}, workItems: {}, projects: {} };
}

test('model efficiency groups turns by main model and task type and recommends the cheapest', () => {
  seq = 0;
  const turns = [];
  for (let i = 0; i < 6; i++) turns.push(turn('big', code(50)));
  for (let i = 0; i < 5; i++) turns.push(turn('small', code(50)));
  for (let i = 0; i < 5; i++) turns.push(turn('big', []));
  turns.push(turn('small', docs(10)));
  const data = fixture(turns);
  const ef = modelEfficiency(data, { days: 30 }, defaultClassifier(), NOW);
  assert.equal(ef.turns, 17);
  assert.deepEqual(ef.tasks.sort(), ['documentation', 'programming', QA_TASK].sort());
  const cell = (m, t) => ef.cells.find(c => c.model === m && c.task === t);
  assert.equal(cell('big', 'programming').turns, 6);
  assert.equal(cell('big', 'programming').lines, 300);
  assert.equal(cell('big', QA_TASK).creditsPer100Lines, null);
  assert.equal(cell('small', 'documentation').smallSample, true);
  const rec = ef.recommendations.find(r => r.task === 'programming');
  assert.equal(rec.mostUsed, 'big');
  assert.equal(rec.cheapest, 'small');
  assert.equal(rec.metric, 'creditsPer100Lines');
  assert.ok(rec.potentialSavings > 0);
  // Q&A has only one model: nothing to switch to.
  const qa = ef.recommendations.find(r => r.task === QA_TASK);
  assert.equal(qa.metric, 'creditsPerTurn');
  assert.equal(qa.potentialSavings, 0);
  assert.equal(ef.taskLabels[QA_TASK].length > 0, true);
});

test('user category rules decide the task type for files without a stored category', () => {
  seq = 0;
  const rules = sanitizeRules({ extensions: {}, folders: { 'specs/**': 'specification' } });
  assert.equal(categorizeWith('specs/x.al', rules), 'specification');
  const data = fixture([turn('big', [{ path: 'specs/x.al', ext: '.al', added: 5, removed: 0, edits: 1 }])]);
  assert.deepEqual(modelEfficiency(data, {}, defaultClassifier(rules), NOW).tasks, ['specification']);
  assert.deepEqual(modelEfficiency(data, {}, defaultClassifier(), NOW).tasks, ['programming']);
});

test('tool profile keeps used servers, disables idle ones and estimates the savings', () => {
  seq = 0;
  const turns = [
    turn('big', [], { tools: [{ name: 'mcp_used_srv_a_one', count: 3 }, { name: 'read_file', count: 1 }] }),
    turn('big', [], { tools: [{ name: 'read_file', count: 2 }] })
  ];
  const tp = toolProfile(fixture(turns), { days: 30 }, NOW);
  const byName = Object.fromEntries(tp.servers.map(s => [s.server, s]));
  assert.equal(byName[BUILTIN_SERVER].recommendation, 'keep');
  assert.equal(byName['mcp:used_srv_a'].recommendation, 'keep');
  assert.deepEqual(byName['mcp:used_srv_a'].usedTools, ['mcp_used_srv_a_one']);
  assert.equal(byName['mcp:idle_srv_b'].recommendation, 'disable');
  assert.equal(byName['mcp:idle_srv_b'].calls, 0);
  assert.deepEqual(tp.disable, ['mcp:idle_srv_b']);
  assert.ok(tp.tokensSavedPerRequest >= 2000);
  assert.ok(tp.estimatedCreditsSaved > 0);
  assert.equal(tp.requests, 2);
});
