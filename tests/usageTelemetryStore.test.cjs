const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get() {} }) },
    window: { showWarningMessage() {} }
  };
  return load.call(this, name, ...args);
};
const { Database, migrateStore } = require('../out/store/database');
const { MAX_TOOLSETS } = require('../out/util/modelCatalog');

function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-telemetry-'));
  const dbs = [];
  t.after(() => {
    for (const db of dbs) {
      if (db.saveTimer) clearTimeout(db.saveTimer);
      if (db.refreshTimer) clearInterval(db.refreshTimer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => { const db = new Database(dir); dbs.push(db); return db; };
}

const toolset = (id, seen) => ({ id, firstSeen: seen, lastSeen: seen, toolCount: 1, chars: 10,
  servers: { 'mcp:x': { count: 1, chars: 10, tools: ['mcp_x_a'] } } });
const price = (input, at) => ({ default: { input, cacheRead: 1, cacheWrite: 0, output: 4 }, capturedAt: at });

test('telemetry catalog and request fields persist across reloads', t => {
  const factory = open(t);
  const db = factory();
  for (let i = 0; i < MAX_TOOLSETS + 5; i++) db.recordToolset(toolset(`t${i}`, 1000 + i));
  db.recordToolset({ ...toolset('t34', 999), lastSeen: 5000 });
  db.recordModelPrices({ m: price(10, 200) });
  db.recordModelPrices({ m: price(99, 100) });
  db.recordDebugUsage('main', {
    sessionId: 's', turnId: 'u', timestamp: 1000, analysis: { files: [], totalAdded: 0, totalRemoved: 0, tools: [], toolCalls: 0, requestsDetail: [] },
    requests: [{ spanId: 'r', model: 'm', credits: 2, inputTokens: 100, outputTokens: 5, cachedTokens: 50,
      ts: 1100, durationMs: 300, ttftMs: 90, agent: 'panel/editAgent', effort: 'high', maxTokens: 8000, toolset: 't34' }]
  });
  db.flushSync();

  const data = factory().getUsageData();
  assert.equal(Object.keys(data.toolsets).length, MAX_TOOLSETS);
  assert.equal(data.toolsets.t0, undefined);
  assert.equal(data.toolsets.t34.firstSeen, 999);
  assert.equal(data.toolsets.t34.lastSeen, 5000);
  assert.equal(data.modelPrices.m.default.input, 10);
  const [r] = data.creditLedger.find(e => e.debugUsage?.turnId === 'u').debugUsage.requests;
  assert.deepEqual({ ts: r.ts, agent: r.agent, effort: r.effort, toolset: r.toolset, ttftMs: r.ttftMs },
    { ts: 1100, agent: 'panel/editAgent', effort: 'high', toolset: 't34', ttftMs: 90 });
});

test('stores from older versions load with empty telemetry catalogs', () => {
  const migrated = migrateStore({ schemaVersion: 11, branches: {}, workItems: {}, creditLedger: [], projects: {} });
  assert.deepEqual(migrated.toolsets, {});
  assert.deepEqual(migrated.modelPrices, {});
  assert.deepEqual(migrateStore({ schemaVersion: 11, toolsets: [], modelPrices: 'x' }).toolsets, {});
});
