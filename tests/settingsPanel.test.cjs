const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const T = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const store = { 1: {}, 2: {}, 3: {} };
const updates = [];
let inputBoxValue;
const cfg = {
  get: id => store[3][id] ?? store[2][id] ?? store[1][id],
  inspect: id => ({ globalValue: store[1][id], workspaceValue: store[2][id], workspaceFolderValue: store[3][id] }),
  update: async (id, v, t) => { updates.push([id, v, t]); if (v === undefined) delete store[t][id]; else store[t][id] = v; },
};
const vscodeMock = {
  ConfigurationTarget: T,
  workspace: { getConfiguration: () => cfg, workspaceFolders: [{}] },
  window: { showInputBox: async () => inputBoxValue },
  commands: { executeCommand: async () => {} },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscodeMock : load.call(this, name, ...args); };
const { handleSettingsMessage } = require('../out/ui/settingsPanel');
const { GitHubService } = require('../out/services/githubService');

const secrets = new Map();
const context = {
  extension: { id: 'alexandererdelyi.ai-effort-tracker', packageJSON: require(path.join(__dirname, '..', 'package.json')) },
};
const gh = new GitHubService();
gh.useSecrets({ get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } });

async function send(m) {
  const posted = [];
  const handled = await handleSettingsMessage(m, context, gh, x => posted.push(x));
  return { handled, msg: posted[0] };
}

test('ignores other messages', async () => {
  assert.equal((await send({ type: 'health' })).handled, false);
});

test('settings payload lists all settings without secrets', async () => {
  store[1].githubToken = 'ghp_plain';
  const { msg } = await send({ type: 'settings' });
  assert.equal(msg.type, 'settingsData');
  assert.equal(msg.settings.length, Object.keys(context.extension.packageJSON.contributes.configuration.properties).length);
  assert.equal(msg.tokenSource, 'settings');
  assert.ok(!JSON.stringify(msg).includes('ghp_plain'));
});

test('setSetting validates, writes user settings and implied changes', async () => {
  updates.length = 0;
  let r = await send({ type: 'setSetting', key: 'seniority', value: 'senior' });
  assert.deepEqual(r.msg.result, { key: 'seniority', ok: true, also: ['baselineLocPerMinute'] });
  assert.deepEqual(updates, [['seniority', 'senior', T.Global], ['baselineLocPerMinute', 8, T.Global]]);
  r = await send({ type: 'setSetting', key: 'baselineLocPerMinute', value: '0' });
  assert.equal(r.msg.result.ok, false);
  assert.equal(store[1].baselineLocPerMinute, 8);
  r = await send({ type: 'setSetting', key: 'nope', value: 1 });
  assert.equal(r.msg.result.ok, false);
  r = await send({ type: 'setSetting', key: 'githubToken', value: 'x' });
  assert.equal(r.msg.result.ok, false);
});

test('reset and remove workspace override', async () => {
  store[2].currency = 'HUF';
  await send({ type: 'setSetting', key: 'currency', value: 'eur' });
  assert.equal(store[1].currency, 'EUR');
  let r = await send({ type: 'clearWorkspaceSetting', key: 'currency' });
  assert.equal(store[2].currency, undefined);
  assert.equal(r.msg.settings.find(s => s.id === 'currency').overriddenBy, null);
  r = await send({ type: 'resetSetting', key: 'currency' });
  assert.equal(store[1].currency, undefined);
  assert.equal(r.msg.settings.find(s => s.id === 'currency').isDefault, true);
});

test('token: move to secure storage, replace and remove', async () => {
  let r = await send({ type: 'moveTokenToSecure' });
  assert.equal(secrets.get(GitHubService.SECRET_KEY), 'ghp_plain');
  assert.equal(store[1].githubToken, undefined);
  assert.equal(r.msg.tokenSource, 'secure');
  inputBoxValue = undefined;
  await send({ type: 'setToken' });
  assert.equal(secrets.get(GitHubService.SECRET_KEY), 'ghp_plain');
  inputBoxValue = '  ghp_new  ';
  await send({ type: 'setToken' });
  assert.equal(secrets.get(GitHubService.SECRET_KEY), 'ghp_new');
  r = await send({ type: 'clearToken' });
  assert.equal(secrets.has(GitHubService.SECRET_KEY), false);
  assert.equal(r.msg.tokenSource, 'none');
});
