const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const load = Module._load;
const messages = [];
const config = {};
const workspace = { workspaceFolders: [], getConfiguration: () => ({ get: key => config[key] }) };
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    workspace,
    window: {
      createOutputChannel: () => ({
        info: m => messages.push(m), warn: m => messages.push(m), error: m => messages.push(m), dispose() {}
      })
    }
  };
  return load.call(this, name, ...args);
};
const { Database } = require('../out/store/database');
const { AgentHostUsageTracker } = require('../out/trackers/agentHostUsageTracker');
const { GitTracker } = require('../out/trackers/gitTracker');
const { sqlite } = require('../out/util/agentHost');
const { branchKey } = require('../out/util/branchKey');

const skip = !sqlite() && 'node:sqlite is not available';

function session(dir, folder, turns) {
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'session.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, event_id TEXT, checkpoint_ref TEXT);
    CREATE TABLE IF NOT EXISTS turn_usage (turn_id TEXT PRIMARY KEY, usage TEXT);
    CREATE TABLE IF NOT EXISTS session_metadata (key TEXT PRIMARY KEY, value TEXT);
    INSERT OR REPLACE INTO session_metadata VALUES ('copilot.workingDirectory', '${pathToFileURL(folder).href}');`);
  for (const [id, nano] of turns) {
    db.prepare('INSERT OR REPLACE INTO turns VALUES (?, NULL, NULL)').run(id);
    db.prepare('INSERT OR REPLACE INTO turn_usage VALUES (?, ?)').run(id, JSON.stringify({
      inputTokens: 100, outputTokens: 10, model: 'opus', _meta: { copilotUsage: { totalNanoAiu: nano } }
    }));
  }
  db.close();
}

test('Agent Host tracker records owned sessions once, on the checked-out branch', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aet-agent-tracker-'));
  const db = new Database(path.join(dir, 'store'));
  t.after(() => { db.flushSync(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  const git = cmd => cp.execSync(`git ${cmd}`, { cwd: repo, stdio: 'ignore' });
  git('init -q -b feature/#9-agent');
  git('-c user.email=a@b -c user.name=t commit -q --allow-empty -m init');
  workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: repo } }];

  const sessions = path.join(dir, 'Code', 'agentSessionData');
  session(path.join(sessions, 'owned'), path.join(repo, 'app'), [['request_1', 2e9], ['request_2', 0.5e9]]);
  session(path.join(sessions, 'foreign'), path.join(dir, 'elsewhere'), [['request_x', 9e9]]);
  fs.mkdirSync(path.join(sessions, 'empty'));

  let changes = 0;
  const tracker = new AgentHostUsageTracker(db, { scheme: 'file', fsPath: path.join(dir, 'Code', 'User', 'globalStorage', 'ext') }, () => changes++);
  t.after(() => tracker.dispose());
  await tracker.poll();

  const key = branchKey(await GitTracker.repoIdFor(repo), 'feature/#9-agent');
  let rows = db.getCreditEntries();
  assert.deepEqual(rows.map(r => [r.chatSessionId, r.debugUsage.turnId, r.branch, r.credits]).sort(),
    [['owned', 'request_1', key, 2], ['owned', 'request_2', key, 0.5]]);
  assert.equal(changes, 1);
  assert.deepEqual(tracker.lastChangedSessions, ['owned']);

  await tracker.poll();
  assert.equal(changes, 1, 'unchanged sessions are not re-read');

  session(path.join(sessions, 'owned'), path.join(repo, 'app'), [['request_3', 1e9]]);
  await new Promise(r => setTimeout(r, 20));
  await tracker.poll();
  rows = db.getCreditEntries();
  assert.equal(rows.length, 3);
  assert.equal(changes, 2, 'only the new turn is recorded');
  assert.ok(!messages.some(m => /Cannot capture|failed/.test(m)), messages.join('\n'));
});
