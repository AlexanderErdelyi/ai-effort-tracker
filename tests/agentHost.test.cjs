const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { agentTurns, fileUriPath, parseAgentEvents, readAgentEvents, readAgentSession, sqlite } = require('../out/util/agentHost');
const { SessionTitleResolver } = require('../out/util/sessionTitles');

const skip = !sqlite() && 'node:sqlite is not available';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aet-agent-'));

function fixture(dir, { meta = {}, turns = [], usage = {}, edits = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE turns (id TEXT PRIMARY KEY, event_id TEXT, checkpoint_ref TEXT);
    CREATE TABLE turn_usage (turn_id TEXT PRIMARY KEY, usage TEXT);
    CREATE TABLE file_edits (turn_id TEXT, tool_call_id TEXT, file_path TEXT, edit_type TEXT, original_path TEXT,
      before_content BLOB, after_content BLOB, added_lines INTEGER, removed_lines INTEGER);
    CREATE TABLE session_metadata (key TEXT PRIMARY KEY, value TEXT);`);
  for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO session_metadata VALUES (?, ?)').run(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [id, eventId] of turns) db.prepare('INSERT INTO turns VALUES (?, ?, NULL)').run(id, eventId ?? null);
  for (const [id, u] of Object.entries(usage)) db.prepare('INSERT INTO turn_usage VALUES (?, ?)').run(id, JSON.stringify(u));
  for (const e of edits) db.prepare('INSERT INTO file_edits VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)')
    .run(e.turn, e.call, e.path, e.type ?? 'edit', 'SECRET BEFORE', 'SECRET AFTER', e.added, e.removed);
  db.close();
  return file;
}

const fullUsage = {
  inputTokens: 1000, outputTokens: 100, model: 'opus', cacheReadTokens: 500,
  _meta: {
    copilotUsage: { totalNanoAiu: 3e9 },
    directCopilotUsage: { totalNanoAiu: 1e9 },
    turnTokenTotals: [
      { model: 'opus', inputTokens: 1000, cachedTokens: 500, outputTokens: 100 },
      { model: 'mini', inputTokens: 400, cachedTokens: 0, outputTokens: 40 },
      { model: 'haiku', inputTokens: 400, cachedTokens: 0, outputTokens: 40 }
    ],
    directTurnTokenTotals: [{ model: 'opus', inputTokens: 1000, cachedTokens: 500, outputTokens: 100 }],
    'vscode.modelCall': { durationMs: 900, timeToFirstTokenMs: 321, model: 'opus' }
  }
};

const events = [
  { type: 'user.message', id: 'ev1', timestamp: '2026-01-02T10:00:00.000Z', data: { interactionId: 'i1', content: 'PROMPT ONE' } },
  { type: 'assistant.turn_start', timestamp: '2026-01-02T10:00:01.000Z', data: { turnId: '0', interactionId: 'i1' } },
  { type: 'tool.execution_start', timestamp: '2026-01-02T10:00:02.000Z', data: { toolCallId: 'c1', toolName: 'edit' } },
  { type: 'tool.execution_complete', timestamp: '2026-01-02T10:00:03.000Z', data: { toolCallId: 'c1', interactionId: 'i1', success: true } },
  { type: 'tool.execution_start', timestamp: '2026-01-02T10:00:03.000Z', data: { toolCallId: 'c2', toolName: 'powershell' } },
  { type: 'tool.execution_complete', timestamp: '2026-01-02T10:00:04.000Z', data: { toolCallId: 'c2', interactionId: 'i1', success: false } },
  { type: 'assistant.turn_end', timestamp: '2026-01-02T10:00:06.000Z', data: { turnId: '0' } },
  { type: 'assistant.turn_start', timestamp: '2026-01-02T10:00:10.000Z', data: { turnId: '1', interactionId: 'i1' } },
  { type: 'assistant.turn_end', timestamp: '2026-01-02T10:00:14.000Z', data: { turnId: '1' } },
  { type: 'user.message', id: 'ev2', timestamp: '2026-01-02T11:00:00.000Z', data: { interactionId: 'i2', content: 'PROMPT TWO' } }
].map(e => JSON.stringify(e)).join('\n') + '\n{"partial":';

test('events: turn start, round wall time, tool histogram and clipped prompts', () => {
  const { timings, messages } = parseAgentEvents(events, 'sid', 6);
  const t = timings.get('ev1');
  assert.equal(t.ts, Date.parse('2026-01-02T10:00:00.000Z'));
  assert.equal(t.roundsMs, 9000);
  assert.deepEqual([...t.tools], [['edit', { count: 1, failed: 0 }], ['powershell', { count: 0, failed: 1 }]]);
  assert.equal(timings.get('ev2').roundsMs, 0);
  assert.deepEqual(messages.map(m => [m.sessionId, m.text]), [['sid', 'PROMPT'], ['sid', 'PROMPT']]);
});

test('file URIs map to filesystem paths; other schemes are ignored', () => {
  if (process.platform === 'win32') assert.equal(fileUriPath('file:///c%3A/Repo/app'), 'c:\\Repo\\app');
  else assert.equal(fileUriPath('file:///home/me/repo'), '/home/me/repo');
  assert.equal(fileUriPath('vscode-remote://x/repo'), undefined);
});

test('session db: exact turn charge split into main agent and subagents', { skip }, () => {
  const dir = tmp();
  try {
    const file = fixture(path.join(dir, 'abc'), {
      meta: {
        customTitle: 'My chat',
        'copilot.workingDirectory': 'file:///c%3A/Repo/app',
        'copilot.workingDirectories': ['file:///c%3A/Repo/app', 'file:///c%3A/Repo'],
        'agentHost.git': { branchName: 'feature/#7-x' },
        defaultChatProviderData: { sdkSessionId: 'sdk-1' }
      },
      turns: [['request_a', 'ev1'], ['request_auto', null], ['request_running', null], ['request_plain', 'ev2']],
      usage: {
        request_a: fullUsage,
        request_auto: { model: 'auto', _meta: { autoModeResolved: true } },
        request_plain: { inputTokens: 50, outputTokens: 5, model: 'gpt', _meta: { copilotUsage: { totalNanoAiu: 0.5e9 } } }
      },
      edits: [
        { turn: 'request_a', call: 'c1', path: 'C:\\Repo\\app\\x.al', added: 3, removed: 1 },
        { turn: 'request_a', call: 'c3', path: 'C:\\Repo\\app\\x.al', added: 2, removed: 0 },
        { turn: 'request_a', call: 'c4', path: 'C:\\Repo\\docs\\new.md', type: 'create', added: 10, removed: 0 }
      ]
    });
    const s = readAgentSession(file);
    assert.equal(s.sessionId, 'abc');
    assert.equal(s.title, 'My chat');
    assert.equal(s.branch, 'feature/#7-x');
    assert.equal(s.sdkSessionId, 'sdk-1');
    assert.equal(s.folders.length, 2);
    assert.equal(s.turns.length, 4);

    const turns = agentTurns(s, parseAgentEvents(events, 'abc').timings, 42);
    assert.deepEqual(turns.map(t => t.turnId), ['request_a', 'request_plain'], 'running and token-less auto rows are skipped');
    const [a, plain] = turns;
    assert.equal(a.sessionId, 'abc');
    assert.equal(a.timestamp, Date.parse('2026-01-02T10:00:00.000Z'));
    assert.ok(Math.abs(a.credits - 3) < 1e-9, 'turn total stays exact');
    const main = a.requests.find(r => !r.subagent);
    assert.deepEqual([main.spanId, main.model, main.credits, main.cachedTokens, main.ttftMs, main.durationMs],
      ['request_a:opus', 'opus', 1, 500, 321, 9000]);
    const subs = a.requests.filter(r => r.subagent);
    assert.deepEqual(subs.map(r => r.spanId), ['request_a:sub:mini', 'request_a:sub:haiku']);
    assert.ok(Math.abs(subs[0].credits - 1) < 1e-9 && Math.abs(subs[1].credits - 1) < 1e-9);
    assert.deepEqual(a.requestAliases, ['request_a']);
    assert.equal(a.analysis.durationMs, 9000);
    assert.equal(a.analysis.toolCalls, 1);
    assert.equal(a.analysis.failedToolCalls, 1);
    assert.equal(a.analysis.requestsDetail.length, 3);
    assert.deepEqual(a.analysis.files.map(f => [f.ext, f.added, f.removed, f.edits, !!f.created]),
      [['al', 5, 1, 2, false], ['md', 10, 0, 1, true]]);
    assert.equal(a.analysis.totalAdded, 15);
    assert.ok(!JSON.stringify(turns).includes('SECRET'), 'file contents are never read');

    assert.equal(plain.timestamp, Date.parse('2026-01-02T11:00:00.000Z'));
    assert.deepEqual(plain.requests.map(r => [r.spanId, r.model, r.inputTokens, r.credits]), [['request_plain:gpt', 'gpt', 50, 0.5]]);

    const noEvents = agentTurns(s, new Map(), 42);
    assert.equal(noEvents[0].timestamp, 42, 'falls back to the db time without events');
    assert.equal(noEvents[0].analysis.toolCalls, 3, 'edit calls still counted without events');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session db without a turns table is not an agent session', { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'session.db');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE other (x INTEGER)');
    db.close();
    assert.equal(readAgentSession(file), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('events are read bounded and only for safe session ids', async () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'sdk-1'));
    fs.writeFileSync(path.join(dir, 'sdk-1', 'events.jsonl'), events);
    assert.equal(await readAgentEvents('sdk-1', dir), events);
    assert.equal(await readAgentEvents('sdk-1', dir, 10), undefined);
    assert.equal(await readAgentEvents('../sdk-1', dir), undefined);
    assert.equal(await readAgentEvents('missing', dir), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session titles fall back to the Agent Host chat title', { skip }, () => {
  const dir = tmp();
  try {
    const roots = path.join(dir, 'Code', 'User', 'workspaceStorage');
    fs.mkdirSync(roots, { recursive: true });
    fixture(path.join(dir, 'Code', 'agentSessionData', 'agent-1'), { meta: { customTitle: '  E-Rechnung   Anpassung ' } });
    const resolver = new SessionTitleResolver([roots], 12);
    assert.equal(resolver.title('agent-1'), 'E-Rechnung A…');
    assert.equal(resolver.title('nope'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
