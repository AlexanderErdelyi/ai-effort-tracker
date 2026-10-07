const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SETUP_STEPS, COPILOT_PLANS, SETUP_SETTING_KEYS, setupStatus, setupStepState, remainingSteps,
  planCreditCost, proposeCategoryRules, mergeRules,
} = require('../out/util/setupWizard');

const empty = { configured: [], projectCount: 0, repoLinked: false, tokenSource: 'none', completed: [], hasData: false };

test('fresh install: required steps todo, optional ones optional', () => {
  const st = setupStatus(empty);
  assert.equal(st.restore, 'optional');
  assert.equal(st.token, 'optional');
  for (const id of ['profile', 'rates', 'credits', 'categories', 'project']) assert.equal(st[id], 'todo', id);
  assert.deepEqual(remainingSteps(empty), ['profile', 'rates', 'credits', 'categories', 'project']);
  assert.ok(SETUP_STEPS.every(s => s.command.startsWith('aiEffortTracker.')));
});

test('status follows configured settings, projects, token and completed steps', () => {
  const s = {
    ...empty,
    configured: ['seniority', 'defaultHourlySellRate', 'credits.monthlyBudget'],
    repoId: 'org/repo', repoLinked: true, projectCount: 1, tokenSource: 'secure',
    completed: ['categories'], hasData: true,
  };
  const st = setupStatus(s);
  for (const id of SETUP_STEPS.map(x => x.id)) assert.equal(st[id], 'done', id);
  assert.deepEqual(remainingSteps(s), []);
});

test('project step: repo must be linked when a repo is open; any project otherwise', () => {
  assert.equal(setupStepState('project', { ...empty, repoId: 'r', projectCount: 2, repoLinked: false }), 'todo');
  assert.equal(setupStepState('project', { ...empty, projectCount: 1 }), 'done');
  assert.ok(SETUP_SETTING_KEYS.includes('categoryRules.folders'));
});

test('plan presets and implied credit cost', () => {
  const pro = COPILOT_PLANS.find(p => p.id === 'pro');
  assert.equal(pro.credits, 1000);
  assert.equal(planCreditCost(pro), 0.01);
  assert.equal(planCreditCost(COPILOT_PLANS.find(p => p.id === 'free')), undefined);
  assert.ok(COPILOT_PLANS.filter(p => p.credits).every(p => planCreditCost(p) > 0));
});

test('proposes unknown extensions with hints and skips binaries and known types', () => {
  const files = [
    'src/app.vue', 'src/b.vue', 'src/c.ts', 'logo.png', 'notes.xyz', 'README.md', 'reports/r.rdlc',
  ];
  const p = proposeCategoryRules(files, { extensions: {}, folders: {} });
  assert.deepEqual(p.extensions.map(e => [e.ext, e.count, e.suggested]), [
    ['vue', 2, 'programming'], ['rdlc', 1, 'programming'], ['xyz', 1, undefined],
  ]);
  assert.equal(p.scanned, files.length);
  // A user extension rule hides the proposal.
  const q = proposeCategoryRules(files, { extensions: { vue: 'documentation' }, folders: {} });
  assert.ok(!q.extensions.some(e => e.ext === 'vue'));
});

test('proposes folders only when files would change category', () => {
  const files = [
    'docs/guide.md', 'docs/api.ts', 'docs/img.png',
    'infra/main.tf', 'infra/vars.json',
    'Translations/app.de.json', 'Translations/app.fr.json',
    'src/features/login.ts',
    'tools\\deploy\\run.ps1',
  ];
  const p = proposeCategoryRules(files, { extensions: {}, folders: {} });
  const byFolder = Object.fromEntries(p.folders.map(f => [f.folder, f]));
  assert.deepEqual([byFolder.Translations.count, byFolder.Translations.total, byFolder.Translations.suggested], [2, 2, 'translation']);
  assert.deepEqual([byFolder.docs.count, byFolder.docs.total], [1, 2]);
  assert.deepEqual([byFolder.infra.count, byFolder.infra.suggested], [1, 'deployment']);
  assert.equal(byFolder['tools/deploy'].suggested, 'deployment');
  assert.ok(!byFolder['src/features']);
  // Existing folder rules (by name or sub-path) are not proposed again.
  const q = proposeCategoryRules(files, { extensions: {}, folders: { translations: 'translation', 'tools/deploy': 'deployment' } });
  assert.ok(!q.folders.some(f => f.folder === 'Translations' || f.folder === 'tools/deploy'));
});

test('mergeRules keeps user entries and adds accepted ones', () => {
  const m = mergeRules({ extensions: { al: 'programming' }, folders: { docs: 'documentation' } },
    { extensions: { vue: 'programming' }, folders: { infra: 'deployment' } });
  assert.deepEqual(m, { extensions: { al: 'programming', vue: 'programming' }, folders: { docs: 'documentation', infra: 'deployment' } });
  assert.deepEqual(mergeRules({}, {}), { extensions: {}, folders: {} });
});
