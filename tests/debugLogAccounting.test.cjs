const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
const messages = [];
const config = { captureDebugLogs: true };
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: key => config[key] }) },
    window: {
      showWarningMessage() {},
      createOutputChannel: () => ({
        info: message => messages.push(message),
        warn: message => messages.push(message),
        error: message => messages.push(message),
        dispose() {}
      })
    }
  };
  return load.call(this, name, ...args);
};
const { Database, migrateStore } = require('../out/store/database');
const { DebugLogUsageTracker } = require('../out/trackers/debugLogUsageTracker');
const { GitTracker } = require('../out/trackers/gitTracker');
const { parseChatAliases } = require('../out/util/chatAliases');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-debug-test-'));
  const db = new Database(dir);
  t.after(() => { db.flushSync(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}
function request(spanId, credits, responseId = 'response-one') {
  return { spanId, responseId, model: 'test-model', credits, inputTokens: 100, outputTokens: 10 };
}
function turn(requests, overrides = {}) {
  return {
    sessionId: 'session-one', turnId: 'root-one', timestamp: 1000, requests,
    analysis: {
      requestsDetail: requests.filter(r => r.credits !== null).map(r => ({
        model: r.model, promptTokens: r.inputTokens, completionTokens: r.outputTokens,
        credits: r.credits, durationMs: 0, tiers: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 }
      })),
      durationMs: 0, toolCalls: 1, totalAdded: 5, totalRemoved: 1,
      files: [{ path: 'code.al', ext: 'al', added: 5, removed: 1, edits: 1 }],
      tools: [{ name: 'apply_patch', count: 1 }],
      tiers: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      tierCredits: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    },
    ...overrides
  };
}

test('physical spans sharing a response ID charge once each, survive reload, and preserve attribution', t => {
  const { dir, db } = temporary(t);
  db.upsertWorkItem('1234', { title: 'Task' });
  db.setWorkItemForBranch('branch-a', '1234');
  const first = db.recordDebugUsage('branch-a', turn([request('a', 1.07223)]));
  const next = turn([request('a', 1.07223), request('b', 1.405715)]);
  db.recordDebugUsage('branch-b', next);
  db.recordDebugUsage('branch-b', next);
  const rows = db.getCreditEntries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.entry.id);
  assert.equal(rows[0].branch, 'branch-a');
  assert.equal(rows[0].workItemId, '1234');
  assert.equal(rows[0].ts, 1000);
  assert.equal(rows[0].credits, 2.477945);
  assert.equal(db.getSummaryForBranch('branch-a').linesAiAdded, 0, 'edit diagnostics never add editor churn');
  assert.equal(db.getSummaryForBranch('branch-a').effectiveLinesAi, 0, 'or effective effort');
  db.flushSync();
  const again = new Database(dir);
  again.recordDebugUsage('branch-b', next);
  again.flushSync();
  assert.equal(again.getCreditEntries().length, 1);
  assert.equal(again.getCreditsForWorkItem('1234').credits, 2.477945);
});

test('missing charges stay partial; zero is exact; shorter rereads cannot remove spend', t => {
  const { db } = temporary(t);
  db.recordDebugUsage('branch-a', turn([request('a', 0), request('b', null)]));
  let e = db.getCreditEntries()[0];
  assert.equal(e.exact, false);
  assert.equal(e.debugUsage.unpricedRequests, 1);
  db.recordDebugUsage('branch-a', turn([request('a', 0), request('b', 3)]));
  db.recordDebugUsage('branch-a', turn([request('a', 0)]));
  e = db.getCreditEntries()[0];
  assert.equal(e.credits, 3);
  assert.equal(e.exact, true);
  assert.equal(e.debugUsage.requests.length, 2);
});

test('reconcile only identified overlapping estimates; manual and unrelated entries remain', t => {
  const { db } = temporary(t);
  db.recordAutoChatUsage('original', 'test-model', 50, { requestId: 'request-one' });
  db.recordAutoChatUsage('original', 'test-model', 90, { requestId: 'unrelated' });
  db.recordCredits('original', 'test-model', 7, 'manual');
  db.recordDebugUsage('new-branch', turn([request('a', 2)], { requestAliases: ['request-one'] }));
  const e = db.getCreditEntries().find(e => e.debugUsage);
  assert.equal(e.branch, 'original');
  assert.equal(e.credits, 2);
  assert.equal(db.getCreditEntries().length, 3);
  db.recordAutoChatUsage('original', 'test-model', 50, { requestId: 'request-one' });
  assert.equal(db.getCreditEntries().length, 3);
});

test('imports before/after live logs reconcile and retain more complete export amounts', t => {
  const { db } = temporary(t);
  db.recordImportedUsage('original', 'test-model', 5, {
    promptId: 'prompt-one', responseIds: ['response-one'], analysis: turn([request('a', 5)]).analysis
  });
  db.recordDebugUsage('new-branch', turn([request('a', 2)]));
  assert.equal(db.getCreditEntries().length, 1);
  assert.equal(db.getCreditEntries()[0].credits, 5);
  db.recordImportedUsage('new-branch', 'test-model', 6, {
    promptId: 'prompt-one', responseIds: ['response-one'], requests: 2
  });
  assert.equal(db.getCreditEntries().length, 1);
  db.recordDebugUsage('new-branch', turn([request('a', 2), request('b', 4)]));
  assert.equal(db.getCreditEntries()[0].credits, 6);
  assert.equal(db.getCreditEntries()[0].branch, 'original');
});

test('purging estimates never removes recorded debug usage or manual credits', t => {
  const { db } = temporary(t);
  db.recordDebugUsage('a', turn([request('a', 2)]));
  db.recordCredits('a', 'model', 1);
  db.purgeAutoLedger();
  assert.equal(db.getCreditEntries().length, 2);
});

test('invalid usage is rejected before inserting any ledger row', t => {
  const { db } = temporary(t);
  assert.throws(() => db.recordDebugUsage('a', turn([request('a', NaN)])), /Invalid/);
  assert.equal(db.getCreditEntries().length, 0);
});

test('manual corrections survive subsequent automatic updates', t => {
  const { db } = temporary(t);
  const { entry } = db.recordDebugUsage('a', turn([request('a', 2)]));
  db.updateLedgerEntry(entry.id, { credits: 4, note: 'corrected' });
  db.recordDebugUsage('a', turn([request('a', 2), request('b', 3)]));
  assert.equal(entry.credits, 4);
  assert.equal(entry.note, 'corrected');
  assert.equal(entry.debugUsage.requests.length, 2);
  assert.equal(entry.debugUsage.creditsOverridden, true);
});

test('ambiguous cross-turn export overlap is rejected without changing totals', t => {
  const { db } = temporary(t);
  db.recordImportedUsage('a', 'model', 10, { promptId: 'p', responseIds: ['one', 'two'] });
  assert.throws(() => db.recordDebugUsage('a', turn([request('a', 2, 'one')])), /partially/);
  assert.equal(db.getCreditEntries().length, 1);
  assert.equal(db.getCreditEntries()[0].credits, 10);
});

test('chat aliases replay snapshots, appends and nested metadata patches without retaining content', () => {
  const rows = [
    { kind: 0, v: { requests: [{ requestId: 'request-1', prompt: 'SECRET',
      result: { metadata: { responseId: 'model-1' } } }] } },
    { kind: 2, k: ['requests'], v: [{ requestId: 'request-2', responseId: 'ui-2' }] },
    { kind: 1, k: ['requests', 1, 'result', 'metadata'], v: { responseId: 'model-2' } },
    { kind: 1, k: ['requests', 1, 'result'], v: {} },
    { kind: 2, k: ['requests'], v: [{ requestId: 'request-3' }] },
    { kind: 1, k: ['requests', 2, 'result', 'metadata', 'responseId'], v: 'model-3' }
  ];
  const aliases = parseChatAliases(rows.map(JSON.stringify).join('\n'));
  assert.deepEqual(aliases.get('model-1'), ['request-1']);
  assert.deepEqual(aliases.get('model-2'), ['request-2', 'ui-2']);
  assert.deepEqual(aliases.get('model-3'), ['request-3']);
  assert.equal(JSON.stringify([...aliases]).includes('SECRET'), false);
  assert.throws(() => parseChatAliases('invalid\n'), /Malformed/);
});

test('optional debug metadata survives migration without source snapshots', t => {
  const { dir, db } = temporary(t);
  db.recordDebugUsage('a', turn([request('a', 2)]));
  db.flushSync();
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'effort-tracker.json'), 'utf8'));
  const migrated = migrateStore(disk);
  assert.equal(migrated.creditLedger[0].debugUsage.requests[0].credits, 2);
  assert.equal(JSON.stringify(migrated).includes('inputMessages'), false);
  assert.deepEqual(migrateStore(migrated), migrated);
});

function writeLog(file, ts, credits = 1) {
  const base = { sid: 'session-one', dur: 0, status: 'ok' };
  const rows = [
    { ...base, ts, type: 'user_message', spanId: 'root-one', attrs: {} },
    { ...base, ts: ts + 1, type: 'llm_request', spanId: 'call-one', parentSpanId: 'root-one',
      attrs: { model: 'test-model', responseId: 'response-one', inputTokens: 100,
        outputTokens: 10, copilotUsageNanoAiu: credits * 1e9 } }
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('workspace scan skips old unsynced history, explicit import binds branch, future polls are idempotent', async t => {
  const { dir, db } = temporary(t);
  const ws = path.join(dir, 'workspace');
  const root = path.join(ws, 'GitHub.copilot-chat', 'debug-logs', 'session-one');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'main.jsonl');
  writeLog(file, 1000);
  GitTracker.getCurrentBranch = async () => 'branch-a';
  const tracker = new DebugLogUsageTracker(db, { scheme: 'file', fsPath: path.join(ws, 'tracker') }, () => {});
  t.after(() => tracker.dispose());
  await tracker.poll();
  assert.equal(db.getCreditEntries().length, 0);
  const sessions = await tracker.sessions();
  const result = await tracker.importSession(sessions[0], 'historical-branch');
  assert.equal(result.credits, 1);
  writeLog(file, 1000, 2);
  GitTracker.getCurrentBranch = async () => 'branch-b';
  await tracker.poll();
  assert.equal(db.getCreditEntries().length, 1);
  assert.equal(db.getCreditEntries()[0].credits, 2);
  assert.equal(db.getCreditEntries()[0].branch, 'historical-branch');
  tracker.dispose();
  const restarted = new DebugLogUsageTracker(db, { scheme: 'file', fsPath: path.join(ws, 'tracker') }, () => {});
  t.after(() => restarted.dispose());
  writeLog(file, 1000, 3);
  await restarted.poll();
  assert.equal(db.getCreditEntries()[0].credits, 3);
  assert.equal(db.getCreditEntries()[0].branch, 'historical-branch');
});

test('live capture freezes new-turn attribution and parks an ambiguous branch switch', async t => {
  const { dir, db } = temporary(t);
  const ws = path.join(dir, 'workspace');
  const logs = path.join(ws, 'GitHub.copilot-chat', 'debug-logs');
  const root = path.join(logs, 'session-one');
  fs.mkdirSync(root, { recursive: true });
  const tracker = new DebugLogUsageTracker(db, { scheme: 'file', fsPath: path.join(ws, 'tracker') }, () => {});
  t.after(() => tracker.dispose());
  GitTracker.getCurrentBranch = async () => 'branch-a';
  await tracker.poll();
  writeLog(path.join(root, 'main.jsonl'), Date.now() + 100, 1);
  await tracker.poll();
  assert.equal(db.getCreditEntries()[0].branch, 'branch-a');
  const other = path.join(logs, 'session-two');
  fs.mkdirSync(other);
  writeLog(path.join(other, 'main.jsonl'), Date.now() + 100, 3);
  const text = fs.readFileSync(path.join(other, 'main.jsonl'), 'utf8').replaceAll('session-one', 'session-two');
  fs.writeFileSync(path.join(other, 'main.jsonl'), text);
  GitTracker.getCurrentBranch = async () => 'branch-b';
  await tracker.poll();
  assert.equal(db.getCreditEntries().find(e => e.debugUsage.sessionId === 'session-two').branch, 'unknown');
  assert.equal(db.getCreditEntries().find(e => e.debugUsage.sessionId === 'session-one').branch, 'branch-a');
});

test('child-only log updates repair an existing parent row, preserving branch and deduplication', async t => {
  const { dir, db } = temporary(t);
  const ws = path.join(dir, 'workspace');
  const root = path.join(ws, 'GitHub.copilot-chat', 'debug-logs', 'session-one');
  fs.mkdirSync(root, { recursive: true });
  const main = path.join(root, 'main.jsonl');
  writeLog(main, 1000, 2.395285);
  fs.appendFileSync(main, JSON.stringify({
    sid: 'session-one', ts: 1001, type: 'tool_call', name: 'runSubagent', status: 'ok',
    spanId: 'invoke', parentSpanId: 'root-one', attrs: {}
  }) + '\n');
  db.recordDebugUsage('original-branch', turn([request('call-one', 2.395285)]));
  const id = db.getCreditEntries()[0].id;
  const tracker = new DebugLogUsageTracker(db, { scheme: 'file', fsPath: path.join(ws, 'tracker') }, () => {});
  t.after(() => tracker.dispose());
  GitTracker.getCurrentBranch = async () => 'different-branch';
  await tracker.poll();
  const child = path.join(root, 'runSubagent-Explore-child.jsonl');
  const writeChild = credits => fs.writeFileSync(child, [
    { type: 'session_start', spanId: 'start', attrs: { parentSessionId: 'session-one' } },
    { type: 'user_message', spanId: 'root-child', parentSpanId: 'invoke', attrs: {} },
    { type: 'llm_request', spanId: 'call-one', parentSpanId: 'root-child',
      attrs: { model: 'child-model', inputTokens: 10, outputTokens: 1, copilotUsageNanoAiu: credits * 1e9 } }
  ].map(r => JSON.stringify({ ...r, sid: 'child', ts: 1002, status: 'ok' })).join('\n') + '\n');
  writeChild(10);
  await tracker.poll();
  writeChild(20.224035);
  await tracker.poll();
  await tracker.poll();
  assert.equal(db.getCreditEntries().length, 1);
  const entry = db.getCreditEntries()[0];
  assert.equal(entry.credits.toFixed(6), '22.619320');
  assert.equal(entry.id, id);
  assert.equal(entry.branch, 'original-branch');
  assert.equal(entry.debugUsage.requests.length, 2);
  const imported = await tracker.importSession((await tracker.sessions())[0], 'another-branch');
  assert.equal(imported.credits.toFixed(6), '22.619320');
  assert.equal(db.getCreditEntries().length, 1);
  assert.equal(entry.branch, 'original-branch');
});

test('dashboard script parses and debug detail shows partial usage without fabricated tier pricing', t => {
  const { db } = temporary(t);
  const { entry } = db.recordDebugUsage('a', turn([request('a', 2), request('b', null)]));
  entry.model = '</script><script>injected</script>';
  const { renderDashboardHtml } = require('../out/ui/dashboard');
  const html = renderDashboardHtml([], 'a', 'test', null, undefined, undefined, null, [], [], [entry]);
  assert.equal(html.includes(entry.model), false);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('toggleLedgerDetail'));
  const vm = require('node:vm');
  new vm.Script(script);
  const start = script.indexOf('function ledBase(');
  const end = script.indexOf('var detailSubTab=', start);
  let detail;
  const context = {
    LEDGER: [entry], CAT: {}, esc: s => String(s).replaceAll('<', '&lt;'), fmt: String,
    document: {
      getElementById: id => id === 'led-' + entry.id ? { parentNode: { appendChild: tr => { detail = tr.innerHTML; } } } : null,
      createElement: () => ({})
    }
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  context.toggleLedgerDetail(entry.id);
  assert.match(detail, /Incomplete request detail/);
  assert.match(detail, /2\.000000/);
  assert.doesNotMatch(detail, /10× cheaper|credits \/ net line|Balanced input\/output/);
  assert.match(detail, /not added again/);
});
