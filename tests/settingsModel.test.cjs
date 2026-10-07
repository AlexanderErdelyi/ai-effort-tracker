const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const m = require('../out/util/settingsModel');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const props = pkg.contributes.configuration.properties;
const descs = m.buildSettingDescriptors(props);
const byId = id => descs.find(d => d.id === id);

test('every contributed setting gets a descriptor in a named group', () => {
  assert.equal(descs.length, Object.keys(props).length);
  const other = descs.filter(d => d.group === 'Other').map(d => d.id);
  assert.deepEqual(other, [], `settings without a group: ${other.join(', ')}`);
  for (const d of descs) {
    assert.ok(d.label && !d.label.includes('.'), `label for ${d.id}`);
    assert.ok(m.SETTING_GROUPS.includes(d.group));
  }
  // sorted by group order
  const order = descs.map(d => m.SETTING_GROUPS.indexOf(d.group));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
});

test('kinds are picked from the schema', () => {
  assert.equal(byId('githubToken').kind, 'secret');
  assert.equal(byId('currency').kind, 'currency');
  assert.equal(byId('categoryRules.extensions').kind, 'map');
  assert.equal(byId('categoryRules.extensions').valueKind, 'enum');
  assert.equal(byId('corrections.keywordRules').kind, 'rules');
  assert.equal(byId('budget.thresholds').kind, 'list');
  assert.equal(byId('budget.thresholds').valueKind, 'number');
  assert.equal(byId('aiuRatesOverride').kind, 'json');
  assert.equal(byId('seniority').kind, 'enum');
  assert.equal(byId('baselineLocPerMinute').kind, 'number');
  assert.equal(byId('baselineLocPerMinute').unit, 'lines/min');
  assert.equal(byId('aiuRatesOverride').advanced, true);
  assert.equal(byId('seniority').advanced, false);
});

test('number validation accepts comma decimals and enforces limits', () => {
  const base = byId('baselineLocPerMinute');
  assert.deepEqual(m.validateSettingValue(base, '2,5'), { ok: true, value: 2.5 });
  assert.equal(m.validateSettingValue(base, 0).ok, false);
  assert.equal(m.validateSettingValue(base, '').ok, false);
  assert.equal(m.validateSettingValue(base, 'abc').ok, false);
  const intD = { kind: 'number', integer: true, min: 1, max: 28 };
  assert.match(m.validateSettingValue(intD, 2.5).error, /whole/);
  assert.match(m.validateSettingValue(intD, 29).error, /at most 28/);
  assert.deepEqual(m.validateSettingValue(intD, '28'), { ok: true, value: 28 });
});

test('enum, currency and string formats', () => {
  assert.equal(m.validateSettingValue(byId('seniority'), 'senior').ok, true);
  assert.equal(m.validateSettingValue(byId('seniority'), 'guru').ok, false);
  assert.deepEqual(m.validateSettingValue(byId('currency'), ' eur '), { ok: true, value: 'EUR' });
  assert.equal(m.validateSettingValue(byId('currency'), 'EURO').ok, false);
  const repo = byId('githubRepo');
  if (repo) {
    assert.equal(m.validateSettingValue(repo, 'octo/hello-world').ok, true);
    assert.equal(m.validateSettingValue(repo, 'not a repo').ok, false);
    assert.deepEqual(m.validateSettingValue(repo, ''), { ok: true, value: '' });
  }
  assert.equal(m.validateSettingValue(byId('githubToken'), 'ghp_x').ok, false);
});

test('maps: pairs, duplicates, enum values and numbers', () => {
  const ext = byId('categoryRules.extensions');
  const opt = ext.valueOptions[0];
  assert.deepEqual(m.validateSettingValue(ext, [['.al', opt], ['', '']]), { ok: true, value: { '.al': opt } });
  assert.match(m.validateSettingValue(ext, [['.al', opt], [' .al', opt]]).error, /twice/);
  assert.match(m.validateSettingValue(ext, [['.al', 'nope']]).error, /must be one of/);
  assert.match(m.validateSettingValue(ext, [['', opt]]).error, /needs a name/);
  const num = { kind: 'map', valueKind: 'number' };
  assert.deepEqual(m.validateSettingValue(num, { a: '1,5' }), { ok: true, value: { a: 1.5 } });
  assert.equal(m.validateSettingValue(num, { a: -1 }).ok, false);
});

test('lists and rules', () => {
  const th = byId('budget.thresholds');
  const r = m.validateSettingValue(th, ['50', '', '90']);
  assert.deepEqual(r, { ok: true, value: [50, 90] });
  assert.deepEqual(m.validateSettingValue({ kind: 'list', valueKind: 'string' }, ['a', ' a', '', 'b']), { ok: true, value: ['a', 'b'] });
  const rules = byId('corrections.keywordRules');
  assert.deepEqual(m.validateSettingValue(rules, [{ pattern: 'sort', category: 'ordering' }, { pattern: '', category: '' }]),
    { ok: true, value: [{ pattern: 'sort', category: 'ordering' }] });
  assert.match(m.validateSettingValue(rules, [{ pattern: '(', category: 'x' }]).error, /invalid pattern/);
  assert.match(m.validateSettingValue(rules, [{ pattern: 'x', category: '' }]).error, /both/);
});

test('json settings are parsed and shape-checked', () => {
  const a = byId('aiuRatesOverride');
  assert.equal(m.validateSettingValue(a, '{"gpt": {"inputNanoAiuPerToken": 2}}').ok, true);
  assert.match(m.validateSettingValue(a, '{bad').error, /Invalid JSON/);
  assert.match(m.validateSettingValue(a, '{"gpt": {"inputNanoAiuPerToken": -2}}').error, /at least 0/);
  assert.match(m.validateSettingValue(a, '[]').error, /object/);
});

test('seniority preset implies a baseline', () => {
  assert.deepEqual(m.impliedChanges('seniority', 'senior'), [{ id: 'baselineLocPerMinute', value: m.SENIORITY_PRESETS.senior }]);
  assert.deepEqual(m.impliedChanges('seniority', 'custom'), []);
  assert.deepEqual(m.impliedChanges('currency', 'EUR'), []);
});

test('setting states report overrides and never expose the secret', () => {
  const inspect = id => ({
    githubToken: { defaultValue: '', globalValue: 'ghp_secret', workspaceValue: 'ghp_ws' },
    currency: { defaultValue: 'USD', globalValue: 'EUR', workspaceValue: 'HUF' },
    seniority: { defaultValue: 'mid', workspaceFolderValue: 'senior' },
  }[id]);
  const st = m.settingStates(descs, inspect);
  const get = id => st.find(s => s.id === id);
  assert.equal(get('currency').value, 'HUF');
  assert.equal(get('currency').userValue, 'EUR');
  assert.equal(get('currency').overriddenBy, 'workspace');
  assert.equal(get('currency').overrideValue, 'HUF');
  assert.equal(get('seniority').overriddenBy, 'folder');
  assert.equal(get('seniority').isDefault, true);
  assert.equal(get('baselineLocPerMinute').overriddenBy, null);
  assert.ok(!JSON.stringify(st).includes('ghp_'), 'secret leaked');
});
