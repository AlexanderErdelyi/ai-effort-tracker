const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseDebugLog } = require('../out/util/debugLog');
const { parseModelPrices, listCost, parseToolset, serverKeys, BUILTIN_SERVER } = require('../out/util/modelCatalog');
const ui = require('../out/analysis/usageInsights');
const { handle, promptExcerpts, decodeUsageData } = require('../out/mcp/server');

const tier = (input, cacheRead, cacheWrite, output, max) =>
  ({ input_price: input, cache_read_price: cacheRead, cache_write_price: cacheWrite, output_price: output, max_prompt_tokens: max });
const MODELS = JSON.stringify([
  { id: 'claude-opus-5.5', model_picker_enabled: true, billing: { token_prices: {
    default: tier(400, 20, 500, 2000, 200000), long_context: tier(400, 20, 500, 2000, 1000000) } } },
  { id: 'claude-sonnet-5.5', billing: { token_prices: { default: tier(200, 20, 250, 1000, 200000) } } },
  { id: 'cheap', billing: { token_prices: { default: tier(10, 1, 0, 40, 200000) } } },
  { id: 'free', billing: { token_prices: { default: tier(0, 0, 0, 0, 1000) } } }
]);
const prices = parseModelPrices(MODELS, 5);

test('model prices reproduce recorded Copilot charges', () => {
  assert.equal(prices.free, undefined);
  assert.equal(prices['claude-opus-5.5'].picker, true);
  assert.ok(Math.abs(listCost(prices['claude-opus-5.5'], { inputTokens: 70882, cachedTokens: 12814, outputTokens: 759 }) - 30.808) < 0.01);
  assert.ok(Math.abs(listCost(prices['claude-sonnet-5.5'], { inputTokens: 60954, cachedTokens: 13587, outputTokens: 348 }) - 12.461) < 0.01);
  // Without a cache-write price, uncached input uses the input price.
  assert.equal(listCost(prices.cheap, { inputTokens: 1e6, cachedTokens: 0, outputTokens: 0 }), 10);
  assert.deepEqual(parseModelPrices('not json', 1), {});
});

test('tool sets are content-free fingerprints grouped by MCP server', () => {
  const defs = [
    { type: 'function', name: 'read_file', description: 'SECRET DESCRIPTION', parameters: { type: 'object' } },
    ...['core_list_projects', 'wit_get_work_item', 'repo_list_branches'].map(n => ({ name: `mcp_azuredevops_m_${n}` })),
    ...['core_list_projects', 'wit_get_work_item', 'repo_list_branches'].map(n => ({ name: `mcp_azuredevops_2_${n}` })),
    { name: 'mcp_microsoft_lea_docs_search' }, { name: 'mcp_microsoft_lea_docs_fetch' }
  ];
  const info = parseToolset(JSON.stringify({ content: JSON.stringify(defs) }), 7);
  assert.equal(info.toolCount, defs.length);
  assert.equal(info.firstSeen, 7);
  assert.match(info.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(info.servers).sort(),
    [BUILTIN_SERVER, 'mcp:azuredevops_2', 'mcp:azuredevops_m', 'mcp:microsoft_lea'].sort());
  assert.equal(JSON.stringify(info).includes('SECRET'), false);
  assert.equal(parseToolset(JSON.stringify({ content: JSON.stringify(defs.slice().reverse()) }), 9).id, info.id);
  assert.equal(serverKeys(['mcp_azure_mcp_ser_storage', 'mcp_azure_mcp_ser_cosmos']).mcp_azure_mcp_ser_storage, 'mcp:azure_mcp_ser');
  assert.equal(parseToolset('[]', 1), undefined);
});

test('parser captures optimization telemetry without prompt text', () => {
  const rows = [
    { type: 'user_message', sid: 's', spanId: 'root', ts: 1000, attrs: { content: 'PRIVATE PROMPT' } },
    { type: 'llm_request', sid: 's', spanId: 'r1', parentSpanId: 'root', ts: 2000, dur: 900, attrs: {
      model: 'claude-opus-5.5', inputTokens: 100, outputTokens: 10, cachedTokens: 40, ttft: 300, maxTokens: 64000,
      debugName: 'panel/editAgent', toolsFile: 'tools_0.json', copilotUsageNanoAiu: 1e9,
      requestOptions: JSON.stringify({ output_config: { effort: 'high' } }) } },
    { type: 'tool_call', sid: 's', spanId: 't1', parentSpanId: 'root', name: 'read_file', status: 'ok', dur: 5, attrs: {} },
    { type: 'tool_call', sid: 's', spanId: 't2', parentSpanId: 'root', name: 'run_in_terminal', status: 'error', dur: 7, attrs: { error: 'boom' } }
  ];
  const { turns } = parseDebugLog(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const [r] = turns[0].requests;
  assert.equal(r.ts, 2000);
  assert.equal(r.durationMs, 900);
  assert.equal(r.ttftMs, 300);
  assert.equal(r.agent, 'panel/editAgent');
  assert.equal(r.effort, 'high');
  assert.equal(r.maxTokens, 64000);
  assert.equal(r.toolsFile, 'tools_0.json');
  assert.equal(r.subagent, undefined);
  assert.equal(turns[0].analysis.toolCalls, 1);
  assert.equal(turns[0].analysis.failedToolCalls, 1);
  assert.equal(turns[0].analysis.tools.find(t => t.name === 'run_in_terminal').failed, 1);
  assert.equal(JSON.stringify(turns).includes('PRIVATE'), false);
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 1, 9);
function call(spanId, at, model, input, cached, output, extra = {}) {
  const credits = listCost(prices[model], { inputTokens: input, cachedTokens: cached, outputTokens: output });
  return { spanId, ts: T0 + at, durationMs: 1000, model, credits, inputTokens: input, cachedTokens: cached,
    outputTokens: output, agent: 'panel/editAgent', effort: 'high', toolset: 'ts1', ...extra };
}
function entry(sessionId, turnId, requests, extra = {}) {
  return { id: `${sessionId}-${turnId}`, ts: requests[0].ts, model: '', credits: requests.reduce((n, r) => n + r.credits, 0),
    source: 'auto', branch: 'feature/1', workItemId: 'WI-1', projectId: 'p1',
    debugUsage: { sessionId, turnId, requests, unpricedRequests: 0 },
    analysis: { files: [], totalAdded: 0, totalRemoved: 0, tools: [{ name: 'read_file', count: 2 }, { name: 'tool_search', count: 3 }],
      toolCalls: 5, requestsDetail: [] }, ...extra };
}
function fixture() {
  const toolset = parseToolset(JSON.stringify([
    { name: 'read_file' }, { name: 'tool_search' },
    ...['a_one', 'b_two', 'c_three'].flatMap(n => [{ name: `mcp_azuredevops_m_${n}` }, { name: `mcp_azuredevops_2_${n}` }]),
    { name: 'mcp_unused_srv_x_a' }, { name: 'mcp_unused_srv_x_b' }
  ]), T0);
  toolset.id = 'ts1';
  const edited = { files: [{ path: 'a.ts', ext: '.ts', added: 5, removed: 1, edits: 1 }], totalAdded: 5, totalRemoved: 1,
    tools: [{ name: 'apply_patch', count: 1 }, { name: 'run_in_terminal', count: 1, failed: 2 }, { name: 'mcp_azuredevops_m_a_one', count: 1 }],
    toolCalls: 3, failedToolCalls: 2, requestsDetail: [] };
  return {
    creditLedger: [
      entry('s1', 't1', [call('a', 0, 'claude-opus-5.5', 60000, 0, 500), call('b', MIN, 'claude-opus-5.5', 62000, 59000, 500)], { analysis: edited }),
      // Model switch within the same chat: full re-send.
      entry('s1', 't2', [call('c', 2 * MIN, 'claude-sonnet-5.5', 64000, 0, 400)]),
      // 20-minute pause: cache expired.
      entry('s1', 't3', [call('d', 23 * MIN, 'claude-sonnet-5.5', 66000, 0, 300)]),
      // Tool set changed mid-chat.
      entry('s1', 't4', [call('e', 24 * MIN, 'claude-sonnet-5.5', 67000, 0, 300, { toolset: 'ts2' })]),
      // A subagent has its own cold context, not a switch in the main chat.
      entry('s1', 't5', [call('["[\\"child\\",1]","x"]', 25 * MIN, 'cheap', 20000, 0, 100, { subagent: true })]),
      entry('s2', 'u1', [call('f', 60 * MIN, 'claude-opus-5.5', 30000, 0, 200)], { workItemId: 'WI-2', branch: 'main' })
    ],
    toolsets: { ts1: toolset, ts2: { ...toolset, id: 'ts2' } },
    modelPrices: prices,
    branches: {},
    workItems: { 'WI-1': { id: 'WI-1', title: 'Feature one', projectId: 'p1', estimate: null, externalRef: null, createdAt: 0 } },
    projects: { p1: { id: 'p1', name: 'Project', repos: [], createdAt: 0 } }
  };
}
const NOW = T0 + 2 * 3600_000;

test('cache breaks are classified per context stream with estimated waste', () => {
  const data = fixture();
  const breaks = ui.detectCacheBreaks(ui.collectCalls(data, {}, NOW), data.modelPrices);
  const causes = breaks.map(b => `${b.sessionId}:${b.cause}`);
  assert.deepEqual(causes, ['s1:new-context', 's1:model-switch', 's1:idle-expiry', 's1:toolset-change', 's1:new-context', 's2:new-context']);
  const sw = breaks.find(b => b.cause === 'model-switch');
  assert.equal(sw.previousModel, 'claude-opus-5.5');
  assert.ok(sw.wasted > 0 && sw.wasted < sw.credits);
  assert.equal(breaks[0].wasted, undefined);
  assert.ok(breaks.find(b => b.cause === 'idle-expiry').gapMinutes >= 20);
  assert.equal(breaks[4].subagent, true);
});

test('overview and findings summarize usage with filters', () => {
  const data = fixture();
  const ov = ui.usageOverview(data, {}, NOW);
  assert.equal(ov.totals.calls, 7);
  assert.equal(ov.totals.sessions, 2);
  assert.deepEqual(Object.keys(ov.byModel).sort(), ['cheap', 'claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.equal(ov.subagents.calls, 1);
  assert.equal(ov.cacheBreaks['model-switch'].count, 1);
  assert.equal(ov.tools.toolSearchCalls, 15);
  assert.deepEqual(ov.tools.duplicateServers.map(d => d.servers), [['mcp:azuredevops_2', 'mcp:azuredevops_m']]);
  assert.equal(ov.tools.servers.find(s => s.server === 'mcp:azuredevops_m').calls, 1);

  const ids = ui.optimizationFindings(data, {}, NOW).map(f => f.id);
  for (const id of ['model-switch-cache', 'idle-cache-expiry', 'unexplained-cache-miss', 'tool-bloat', 'tool-search-rounds', 'failed-tools', 'reasoning-effort', 'light-turns']) {
    assert.ok(ids.includes(id), `missing ${id}: ${ids}`);
  }
  const bloat = ui.optimizationFindings(data, {}, NOW).find(f => f.id === 'tool-bloat');
  assert.deepEqual(bloat.evidence.unusedServers.map(s => s.server), ['mcp:azuredevops_2', 'mcp:unused_srv_x']);

  const wi2 = ui.usageOverview(data, { workItemId: 'WI-2' }, NOW);
  assert.equal(wi2.totals.calls, 1);
  assert.equal(ui.usageOverview(data, { days: 1 }, T0 + 10 * 86400_000).totals.calls, 0);
  assert.deepEqual(ui.optimizationFindings(data, { days: 1 }, T0 + 10 * 86400_000), []);

  const items = ui.workItemUsage(data, {}, NOW);
  assert.equal(items[0].workItemId, 'WI-1');
  assert.equal(items[0].title, 'Feature one');
  assert.equal(items[0].project, 'Project');

  const sessions = ui.listSessions(data, {}, 10, NOW);
  assert.deepEqual(sessions.map(s => s.sessionId), ['s2', 's1']);
  assert.equal(sessions[1].avoidableCacheBreaks, 3);
  const detail = ui.sessionDetail(data, 's1');
  assert.equal(detail.turns.length, 5);
  assert.equal(detail.turns[0].filesEdited[0].path, 'a.ts');
  assert.equal(detail.turns[1].cacheBreaks[0].cause, 'model-switch');
  assert.equal(ui.sessionDetail(data, 'missing'), undefined);
});

test('rows captured before telemetry are analysed without timing', () => {
  const data = fixture();
  for (const e of data.creditLedger) for (const r of e.debugUsage.requests) { delete r.ts; delete r.toolset; delete r.effort; }
  const ov = ui.usageOverview(data, {}, NOW);
  assert.equal(ov.totals.calls, 7);
  assert.equal(ov.dataCoverage.withTimingPct, 0);
  assert.equal(ov.cacheBreaks['idle-expiry'], undefined);
});

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'effort-tracker.json');
  fs.writeFileSync(store, JSON.stringify({ schemaVersion: 11, ...fixture() }));
  const logs = path.join(dir, 'workspaceStorage', 'ws1', 'GitHub.copilot-chat', 'debug-logs', 's1');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'main.jsonl'), [
    { type: 'user_message', sid: 's1', spanId: 't1', ts: T0, attrs: { content: 'Explain   the\nbilling code ' + 'x'.repeat(2000) } },
    { type: 'user_message', sid: 's1', spanId: 't2', ts: T0, attrs: { content: 'Now fix it' } }
  ].map(r => JSON.stringify(r)).join('\n') + '\n{"partial');
  return { dir, store, storage: path.join(dir, 'workspaceStorage') };
}

test('prompt excerpts are flattened and truncated', t => {
  const { storage } = tempEnv(t);
  const excerpts = promptExcerpts(path.join(storage, 'ws1', 'GitHub.copilot-chat', 'debug-logs', 's1', 'main.jsonl'), 60);
  assert.equal(excerpts.get('t2'), 'Now fix it');
  assert.ok(excerpts.get('t1').startsWith('Explain the billing code x'));
  assert.equal(excerpts.get('t1').length, 61);
  assert.deepEqual(decodeUsageData('{}').creditLedger, []);
  assert.throws(() => decodeUsageData('null'));
});

test('JSON-RPC handler negotiates protocol and rejects unknown input', () => {
  const init = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }).result.protocolVersion, '2025-06-18');
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(handle({ jsonrpc: '2.0', id: 3, method: 'nope' }).error.code, -32601);
  assert.equal(handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }).error.code, -32602);
  const tools = handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }).result.tools;
  assert.deepEqual(tools.map(x => x.name), ['usage_overview', 'optimization_findings', 'list_work_items', 'list_sessions', 'session_detail']);
  assert.ok(tools.every(x => x.annotations.readOnlyHint));
});

test('stdio MCP server answers tool calls from a read-only store', async t => {
  const { store, storage } = tempEnv(t);
  const before = fs.readFileSync(store, 'utf8');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'out', 'mcp', 'server.js')], {
    env: { ...process.env, AET_STORE_PATH: store, AET_WORKSPACE_STORAGE: storage, AET_VERSION: '9.9.9' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  t.after(() => child.kill());
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const toolCall = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return { ...res.result, json: res.result.isError ? undefined : JSON.parse(res.result.content[0].text) };
  };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.version, '9.9.9');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('garbage\n');

  const overview = await toolCall('usage_overview', { from: new Date(T0 - MIN).toISOString(), to: new Date(NOW).toISOString() });
  assert.equal(overview.json.totals.calls, 7);
  const findings = await toolCall('optimization_findings', { from: new Date(T0 - MIN).toISOString(), to: new Date(NOW).toISOString() });
  assert.ok(findings.json.findings.some(f => f.id === 'model-switch-cache'));
  const detail = await toolCall('session_detail', { sessionId: 's1', includePrompts: true, promptChars: 50 });
  assert.equal(detail.json.turns[1].prompt, 'Now fix it');
  assert.equal(detail.json.turns[2].prompt, null);
  const plain = await toolCall('session_detail', { sessionId: 's1' });
  assert.equal(plain.json.turns[0].prompt, undefined);
  const noLog = await toolCall('session_detail', { sessionId: 's2', includePrompts: true });
  assert.match(noLog.json.promptsNote, /no longer exists/);
  const bad = await toolCall('usage_overview', { from: 'yesterday-ish' });
  assert.equal(bad.isError, true);
  const missing = await toolCall('session_detail', { sessionId: 'nope' });
  assert.equal(missing.isError, true);
  assert.equal(fs.readFileSync(store, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(store)).sort(), ['effort-tracker.json', 'workspaceStorage']);
});
