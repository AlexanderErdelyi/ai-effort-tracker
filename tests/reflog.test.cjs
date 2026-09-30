const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReflog, branchAt } = require('../out/util/reflog');

const LOG = [
  'HEAD@{1790786459}\tcheckout: moving from main to feature/#1819-job-queue-manager',
  'HEAD@{1790786318}\tpull: Fast-forward',
  'HEAD@{1790786296}\tcheckout: moving from UAT_Translation to main',
  'HEAD@{1790772906}\tcommit: chore: Translation Update de-DE',
  'HEAD@{1790772000}\tcheckout: moving from main to 2ae1e059aa',
  'HEAD@{1790771000}\trebase (finish): returning to refs/heads/UAT_Translation',
  'HEAD@{1790770000}\tBranch: renamed refs/heads/old to refs/heads/UAT_Translation',
  'garbage line'
].join('\n');

test('reflog parser finds branch switches oldest first', () => {
  const s = parseReflog(LOG);
  assert.deepEqual(s.map(x => x.to), ['UAT_Translation', 'UAT_Translation', undefined, 'main', 'feature/#1819-job-queue-manager']);
  assert.equal(s[0].from, 'old');
});

test('branchAt resolves the checked-out branch at a timestamp', () => {
  const s = parseReflog(LOG);
  assert.equal(branchAt(s, 1790786300 * 1000), 'main');
  assert.equal(branchAt(s, 1790786500 * 1000), 'feature/#1819-job-queue-manager');
  assert.equal(branchAt(s, 1790772500 * 1000), undefined, 'detached HEAD is unknown');
  assert.equal(branchAt(s, 1790760000 * 1000), 'old', 'before the first switch: its source branch');
  assert.equal(branchAt(s, 1790786296 * 1000 + 500), undefined, 'too close to a switch');
  assert.equal(branchAt([], Date.now()), undefined);
});
