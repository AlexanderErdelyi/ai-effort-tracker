const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const T = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
let store, updates, inputs, picks, executed, infos;
beforeEach(() => {
  store = { 1: {}, 2: {}, 3: {} };
  updates = []; inputs = []; picks = []; executed = []; infos = [];
});
const cfg = {
  get: id => store[3][id] ?? store[2][id] ?? store[1][id],
  inspect: id => ({ globalValue: store[1][id], workspaceValue: store[2][id], workspaceFolderValue: store[3][id] }),
  update: async (id, v, t) => { updates.push([id, v, t]); if (v === undefined) delete store[t][id]; else store[t][id] = v; },
};
const vscodeMock = {
  ConfigurationTarget: T,
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Notification: 15 },
  workspace: { getConfiguration: () => cfg, workspaceFolders: [{ uri: { fsPath: '/src/My App' } }] },
  window: {
    showInputBox: async o => { const v = inputs.shift(); if (typeof v === 'function') return v(o); return v; },
    showQuickPick: async (items) => { const f = picks.shift(); return f ? f(items) : undefined; },
    showInformationMessage: async (m) => { infos.push(m); },
    showWarningMessage: async (m) => { infos.push(m); },
  },
  commands: { executeCommand: async (...a) => { executed.push(a); } },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscodeMock : load.call(this, name, ...args); };
const ui = require('../out/ui/setupWizard');

function fakeDeps({ projects = [], credits = [], repoId = 'org/app' } = {}) {
  const gs = new Map();
  const db = {
    projects,
    getAllProjects: () => db.projects,
    getAllWorkItems: () => [],
    getCreditEntries: () => credits,
    getAllBranchesSummaries: () => [],
    getProject: id => db.projects.find(p => p.id === id),
    upsertProject: ({ name }) => { const p = { id: 'p' + (db.projects.length + 1), name, repos: [] }; db.projects.push(p); return p; },
    linkRepoToProject: (id, repo) => { db.getProject(id).repos.push(repo); },
  };
  let token;
  const gh = { tokenSource: async () => (token ? 'secure' : 'none'), setSecretToken: async t => { token = t; } };
  let refreshed = 0;
  return {
    deps: {
      context: { extension: { id: 'alexandererdelyi.ai-effort-tracker' }, globalState: { get: k => gs.get(k), update: async (k, v) => { gs.set(k, v); } } },
      db, gh, getRepoId: async () => repoId, refresh: () => { refreshed++; },
    },
    gs, db, refreshed: () => refreshed,
  };
}

const ctx = () => Object.fromEntries(executed.filter(a => a[0] === 'setContext').map(a => [a[1], a[2]]));

test('rates step writes currency and rates globally; blank keeps a value', async () => {
  const { deps, gs } = fakeDeps();
  store[1].defaultHourlySellRate = 120;
  picks.push(items => items.find(i => i.label === 'EUR'));
  inputs.push(o => { assert.match(o.prompt, /EUR/); assert.equal(o.validateInput('-1') !== null, true); return '60'; }, '');
  assert.equal(await ui.runStep(deps, 'rates'), true);
  assert.deepEqual(updates, [['currency', 'EUR', T.Global], ['defaultHourlyCostRate', 60, T.Global]]);
  assert.equal(store[1].defaultHourlySellRate, 120);
  assert.deepEqual(gs.get('setup.completedSteps'), ['rates']);
  assert.equal(ctx()['aiEffortTracker.setup.ratesDone'], true);
  assert.equal(ctx()['aiEffortTracker.setup.creditsDone'], false);
});

test('cancelled step writes nothing and is not marked completed', async () => {
  const { deps, gs } = fakeDeps();
  picks.push(() => undefined);
  assert.equal(await ui.runStep(deps, 'rates'), false);
  assert.deepEqual(updates, []);
  assert.equal(gs.get('setup.completedSteps'), undefined);
});

test('credits step pre-fills from the chosen plan', async () => {
  const { deps } = fakeDeps();
  picks.push(items => items.find(i => i.planId === 'pro-plus'));
  const seen = [];
  inputs.push(o => { seen.push(o.value); return o.value; }, o => { seen.push(o.value); return '15'; }, o => { seen.push(o.value); return o.value; });
  assert.equal(await ui.runStep(deps, 'credits'), true);
  assert.deepEqual(seen, ['3900', '1', '0.01']);
  assert.equal(store[1]['credits.monthlyBudget'], 3900);
  assert.equal(store[1]['credits.renewalDay'], 15);
  assert.equal(store[1].creditCostPerUnit, 0.01);
});

test('project step creates a project named after the folder and links the repo', async () => {
  const { deps, db } = fakeDeps();
  inputs.push(o => { assert.equal(o.value, 'My App'); return o.value; });
  assert.equal(await ui.runStep(deps, 'project'), true);
  assert.deepEqual(db.projects, [{ id: 'p1', name: 'My App', repos: ['org/app'] }]);
  assert.equal(ctx()['aiEffortTracker.setup.projectDone'], true);
});

test('project step can link an existing project', async () => {
  const { deps, db } = fakeDeps({ projects: [{ id: 'x', name: 'Customer', repos: [] }] });
  picks.push(items => items.find(i => i.id === 'x'));
  assert.equal(await ui.runStep(deps, 'project'), true);
  assert.deepEqual(db.projects[0].repos, ['org/app']);
});

test('token step stores in secure storage; blank skips', async () => {
  const { deps } = fakeDeps();
  inputs.push('');
  assert.equal(await ui.runStep(deps, 'token'), false);
  inputs.push(o => { assert.equal(o.password, true); return ' ghp_x '; });
  assert.equal(await ui.runStep(deps, 'token'), true);
  assert.equal(await deps.gh.tokenSource(), 'secure');
  assert.equal(ctx()['aiEffortTracker.setup.tokenDone'], true);
});

test('delegated steps run the existing commands', async () => {
  const { deps } = fakeDeps();
  await ui.runStep(deps, 'restore');
  await ui.runStep(deps, 'profile');
  const cmds = executed.map(a => a[0]);
  assert.ok(cmds.includes('aiEffortTracker.restoreBackup'));
  assert.ok(cmds.includes('aiEffortTracker.setDeveloperProfile'));
});

test('walkthrough opens once on a fresh install only', async () => {
  const fresh = fakeDeps();
  await ui.maybeShowWalkthrough(fresh.deps);
  await ui.maybeShowWalkthrough(fresh.deps);
  const opens = executed.filter(a => a[0] === 'workbench.action.openWalkthrough');
  assert.deepEqual(opens, [['workbench.action.openWalkthrough', 'alexandererdelyi.ai-effort-tracker#aiEffortTracker.setup', false]]);

  executed = [];
  const used = fakeDeps({ credits: [{ id: 'c' }] });
  await ui.maybeShowWalkthrough(used.deps);
  assert.equal(executed.length, 0);
  assert.equal(used.gs.get('setup.walkthroughShown'), true);
});

test('walkthrough ids in package.json match the steps and commands', () => {
  const pkg = require('../package.json');
  const fs = require('node:fs');
  const path = require('node:path');
  const wt = pkg.contributes.walkthroughs.find(w => w.id === ui.WALKTHROUGH_ID);
  assert.ok(wt);
  const commands = new Set(pkg.contributes.commands.map(c => c.command));
  const { SETUP_STEPS } = require('../out/util/setupWizard');
  for (const s of SETUP_STEPS) {
    assert.ok(commands.has(s.command), s.command);
    const step = wt.steps.find(x => x.id === s.id);
    assert.ok(step, s.id);
    assert.ok(step.completionEvents.includes(`onContext:aiEffortTracker.setup.${s.id}Done`), s.id);
  }
  for (const step of wt.steps) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', step.media.markdown)), step.media.markdown);
    for (const m of step.description.matchAll(/command:([\w.]+)/g)) assert.ok(commands.has(m[1]), m[1]);
  }
});
