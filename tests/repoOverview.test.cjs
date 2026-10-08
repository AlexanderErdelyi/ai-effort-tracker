const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get() {} }) }, window: {} };
  return load.call(this, name, ...args);
};
const { buildRepoOverview, LEGACY_REPO_LABEL } = require('../out/analysis/repoOverview');
const { repoMatches, LEGACY_REPO, repoLabel } = require('../out/util/branchKey');
const F = require('../out/analysis/dashboardFilter');
const { collectCalls } = require('../out/analysis/usageInsights');

const A = 'github.com/acme/app', B = 'dev.azure.com/org/Big%20Project/_git/core';
const br = (branch, repoId, o = {}) => ({
  branch, repoId, name: branch.includes('::') ? branch.slice(branch.lastIndexOf('::') + 2) : branch, workItemId: null,
  humanCodingMs: 0, aiGeneratingMs: 0, reviewingMs: 0, linesHumanAdded: 0, linesHumanDeleted: 0,
  linesAiAdded: 0, linesAiDeleted: 0, estimatedCostUsd: 0, creditsTotal: 0, ...o,
});

test('repo totals are the sum of their branches; same-named branches stay apart', () => {
  const rows = buildRepoOverview([
    br(A + '::main', A, { humanCodingMs: 1000, aiGeneratingMs: 500, linesAiAdded: 10, creditsTotal: 2, estimatedCostUsd: 0.5 }),
    br(A + '::feature/x', A, { reviewingMs: 3000, linesHumanAdded: 4, creditsTotal: 1.5 }),
    br(B + '::main', B, { humanCodingMs: 200, creditsTotal: 9 }),
  ]);
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.repoId === A);
  assert.equal(a.branches.length, 2);
  assert.equal(a.activeMs, 4500);
  assert.equal(a.credits, 3.5);
  assert.equal(a.linesAiAdded, 10);
  assert.equal(a.linesHumanAdded, 4);
  assert.equal(a.costUsd, 0.5);
  for (const k of ['activeMs', 'humanMs', 'aiMs', 'reviewMs', 'credits', 'costUsd'])
    assert.equal(a[k], a.branches.reduce((s, b) => s + b[k], 0), k);
  assert.equal(a.label, 'app');
  const b = rows.find(r => r.repoId === B);
  assert.equal(b.branches.length, 1);
  assert.equal(b.label, 'core');
  assert.equal(rows[0].repoId, A, 'sorted by active time');
});

test('branches without a repository land in one legacy row, sorted last', () => {
  const rows = buildRepoOverview([
    br('old-branch', null, { humanCodingMs: 99999 }),
    br('main', null, { humanCodingMs: 5 }),
    br(A + '::main', A, { humanCodingMs: 1 }),
  ]);
  assert.deepEqual(rows.map(r => r.repoId), [A, LEGACY_REPO]);
  const leg = rows[1];
  assert.equal(leg.legacy, true);
  assert.equal(leg.label, LEGACY_REPO_LABEL);
  assert.deepEqual(leg.projects, []);
  assert.deepEqual(leg.branches.map(b => b.branch), ['old-branch', 'main']);
});

test('a project with several repos lists each, even without branches', () => {
  const projects = [{ id: 'p1', name: 'Shop', repos: [A, B] }, { id: 'p2', name: 'Other', repos: [B] }];
  const rows = buildRepoOverview([br(A + '::main', A, { humanCodingMs: 10 })], projects);
  assert.deepEqual(rows.map(r => r.repoId), [A, B]);
  assert.deepEqual(rows[0].projects, [{ id: 'p1', name: 'Shop' }]);
  assert.deepEqual(rows[1].projects.map(p => p.id), ['p1', 'p2']);
  assert.equal(rows[1].branches.length, 0);
  assert.equal(rows[1].activeMs, 0);
  const inc = buildRepoOverview([], [], { includeRepos: [B, ''] });
  assert.deepEqual(inc.map(r => r.repoId), [B]);
});

test('bad numbers never poison totals', () => {
  const rows = buildRepoOverview([br(A + '::main', A, { humanCodingMs: NaN, creditsTotal: undefined, linesAiAdded: 'x' })]);
  assert.equal(rows[0].activeMs, 0);
  assert.equal(rows[0].credits, 0);
  assert.equal(rows[0].linesAiAdded, 0);
  assert.equal(rows[0].label, 'app');
  assert.equal(typeof rows[0].label, 'string');
  assert.ok(Array.isArray(rows[0].branches));
});

test('repoLabel decodes URL-encoded repository names', () => {
  assert.equal(repoLabel('dev.azure.com/org/p/_git/vPool%20Logistics'), 'vPool Logistics');
  assert.equal(repoLabel('host/bad%E0'), 'bad%E0');
});

test('repoMatches: empty matches all, legacy matches repo-less keys, ids match exactly', () => {
  assert.equal(repoMatches(A + '::main', ''), true);
  assert.equal(repoMatches(undefined, ''), true);
  assert.equal(repoMatches(A + '::main', A), true);
  assert.equal(repoMatches(B + '::main', A), false);
  assert.equal(repoMatches('main', A), false);
  assert.equal(repoMatches('main', LEGACY_REPO), true);
  assert.equal(repoMatches(undefined, LEGACY_REPO), true);
  assert.equal(repoMatches(A + '::main', LEGACY_REPO), false);
});

test('dashboard filter carries repoId into scope checks', () => {
  assert.equal(F.normalizeFilter({ repoId: '  ' + A + ' ' }).repoId, A);
  assert.equal(F.normalizeFilter({ repoId: 42 }).repoId, '');
  const f = F.normalizeFilter({ repoId: A });
  assert.equal(F.isScoped(f), true);
  assert.equal(F.matchesScope({ projectId: null, workItemId: null, branch: A + '::main' }, f), true);
  assert.equal(F.matchesScope({ projectId: null, workItemId: null, branch: B + '::main' }, f), false);
  assert.equal(F.matchesScope({ projectId: null, workItemId: null, branch: 'main' }, F.normalizeFilter({ repoId: LEGACY_REPO })), true);
  assert.equal(F.isScoped(F.DEFAULT_FILTER), false);
});

test('usage insights filter calls by repository', () => {
  const now = Date.now();
  const entry = (branch, id) => ({
    id, ts: now - 1000, branch, workItemId: null, projectId: null,
    debugUsage: { sessionId: 's' + id, turnId: 't', requests: [{ spanId: 'x', ts: now - 1000, model: 'm', inputTokens: 1, outputTokens: 1, credits: 1 }] },
  });
  const data = { creditLedger: [entry(A + '::main', 1), entry(B + '::main', 2), entry('main', 3)] };
  assert.equal(collectCalls(data, {}, now).length, 3);
  assert.deepEqual(collectCalls(data, { repoId: A }, now).map(c => c.sessionId), ['s1']);
  assert.deepEqual(collectCalls(data, { repoId: LEGACY_REPO }, now).map(c => c.sessionId), ['s3']);
});
