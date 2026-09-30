const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildHandoff, handoffFacts, buildHandoffPrompt } = require('../out/analysis/handoff');

const T = Date.UTC(2026, 0, 5, 10);
const row = (id, ts, extra = {}) => ({
  id, ts, model: 'claude-opus', credits: 10, source: 'auto', branch: 'feature/42-sso', workItemId: '42',
  debugUsage: { sessionId: 'S1', turnId: id, requests: [{ spanId: id, model: 'claude-opus', credits: 10, inputTokens: 1000, outputTokens: 50, ts }], unpricedRequests: 0 },
  ...extra
});

function data() {
  return {
    creditLedger: [
      row('t1', T, { analysis: { files: [{ path: 'C:\\repo\\src\\a.ts', ext: 'ts', added: 10, removed: 2, edits: 1 }], totalAdded: 10, totalRemoved: 2, tools: [], toolCalls: 0, requestsDetail: [], tiers: {}, tierCredits: {}, durationMs: 0 } }),
      row('t2', T + 60000, {
        debugUsage: { sessionId: 'S1', turnId: 't2', requests: [
          { spanId: 'a', model: 'claude-opus', credits: 5, inputTokens: 182000, outputTokens: 10, ts: T + 60000 },
          { spanId: 'b', model: 'gpt-mini', credits: 1, inputTokens: 999999, outputTokens: 10, ts: T + 61000, subagent: true }
        ], unpricedRequests: 0 },
        analysis: { files: [
          { path: 'C:/repo/src/a.ts', ext: 'ts', added: 5, removed: 1, edits: 2 },
          { path: 'C:\\repo\\README.md', ext: 'md', added: 40, removed: 0, edits: 1 },
          { path: 'D:\\other\\x.al', ext: 'al', added: 1, removed: 1, edits: 1 }
        ], totalAdded: 46, totalRemoved: 2, tools: [], toolCalls: 0, requestsDetail: [], tiers: {}, tierCredits: {}, durationMs: 0 }
      }),
      row('other', T, { debugUsage: { sessionId: 'S2', turnId: 'x', requests: [], unpricedRequests: 0 }, workItemId: '99' })
    ],
    toolsets: {}, modelPrices: {}, branches: {},
    workItems: { 42: { id: '42', title: 'Single sign-on', externalRef: 'AB#42', createdAt: T } },
    projects: {}
  };
}

test('handoff facts aggregate the session\u2019s work item, files (relative, merged) and last main-chat context', () => {
  const f = handoffFacts(data(), { sessionId: 'S1', workspaceRoot: 'C:\\repo\\', commits: ['abc1234 add sso', '  '], maxFiles: 2 });
  assert.equal(f.workItemId, '42');
  assert.equal(f.workItemTitle, 'Single sign-on');
  assert.equal(f.branch, 'feature/42-sso');
  assert.equal(f.turns, 2);
  assert.equal(f.credits, 20);
  assert.equal(f.contextTokens, 182000, 'subagent calls do not count as the chat context');
  assert.deepEqual(f.files, [
    { path: 'README.md', added: 40, removed: 0, edits: 1 },
    { path: 'src/a.ts', added: 15, removed: 3, edits: 3 }
  ]);
  assert.equal(f.moreFiles, 1);
  assert.deepEqual(f.commits, ['abc1234 add sso']);
});

test('handoff prompt lists the facts, clips excerpts and ends open for the next instruction', () => {
  const long = 'x'.repeat(1000);
  const h = buildHandoff(data(), { sessionId: 'S1', title: 'SSO  work', workspaceRoot: 'C:/repo', firstPrompt: 'Implement\nSSO', lastPrompt: long });
  const p = h.prompt;
  assert.match(p, /previous Copilot chat "SSO work" \(its context had grown to about 182K tokens\)/);
  assert.match(p, /- Work item: #42 Single sign-on \(AB#42\)/);
  assert.match(p, /- Branch: feature\/42-sso/);
  assert.match(p, /  - README\.md \(\+40\/-0\)/);
  assert.match(p, /- The chat started with: "Implement SSO"/);
  assert.ok(p.includes('x'.repeat(400) + '\u2026'));
  assert.ok(!p.includes('x'.repeat(401)));
  assert.ok(p.endsWith('continue with: '));
});

test('unknown sessions and no excerpts still give a usable prompt without prompt text', () => {
  const f = handoffFacts(data(), { sessionId: 'nope', branch: 'main' });
  assert.equal(f.turns, 0);
  assert.equal(f.workItemId, null);
  assert.equal(f.branch, 'main');
  const p = buildHandoffPrompt(f);
  assert.match(p, /^I'm continuing work from a previous Copilot chat\. Handoff summary:/);
  assert.ok(!p.includes('started with'));
  assert.equal(handoffFacts(data(), { sessionId: 'nope', branch: 'unknown' }).branch, null);
});
