// C10's examples over this shell: the blacklist.json example as the attention heartbeat reads
// it, and the privacy keys of config.json that agentd reads with `--privacy-config`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { type AttentionWindow, hides, parseBlacklist } from '../src/common/attention.ts';
import { ROWS } from '../src/common/settings.ts';
import { BlacklistFile } from '../src/main/attention/blacklist.ts';

const EXAMPLES = resolve(import.meta.dirname, '../../../protocol/C10-shared-files/examples');

const window = (w: Partial<AttentionWindow>): AttentionWindow =>
  ({ app: null, bundleId: null, pid: null, windowId: null, title: null, urlHost: null, ...w });

test('the blacklist.json example: allow mode, and only its allowed bundle, app name and domain are read', () => {
  const rules = new BlacklistFile(resolve(EXAMPLES, 'blacklist.json')).rules();
  assert.equal(rules.mode, 'allow');
  assert.deepEqual([...rules.allowBundles], ['com.microsoft.VSCode']);
  assert.deepEqual([...rules.allowNames], ['terminal']);
  assert.deepEqual(rules.allowDomains, ['github.com']);
  assert.equal(rules.incognito, true);
  assert.ok(!hides(rules, window({ bundleId: 'com.microsoft.VSCode' }), []));
  assert.ok(!hides(rules, window({ app: 'Terminal', bundleId: 'com.apple.Terminal' }), []));
  assert.ok(!hides(rules, window({ app: 'Safari', bundleId: 'com.apple.Safari', urlHost: 'github.com' }), []));
  assert.ok(hides(rules, window({ app: 'Notes', bundleId: 'com.apple.Notes' }), []));
  assert.ok(hides(rules, window({ app: 'Code', bundleId: 'com.microsoft.VSCode', urlHost: 'example.com' }), []));
});

test('the blacklist.json example in deny mode: incognito on, and its bundle, app name, domain and title rules hide a window', () => {
  const example = JSON.parse(readFileSync(resolve(EXAMPLES, 'blacklist.json'), 'utf8')) as Record<string, unknown>;
  const rules = parseBlacklist({ ...example, mode: 'deny' });
  assert.equal(rules.mode, 'deny');
  assert.equal(rules.incognito, true);
  assert.ok(hides(rules, window({ bundleId: 'com.tencent.xinWeChat' }), []));
  assert.ok(hides(rules, window({ app: 'arknights: endfield' }), []));
  assert.ok(hides(rules, window({ urlHost: 'm.icbc.com.cn' }), []));
  assert.ok(hides(rules, window({ title: '工资条' }), []));
  assert.ok(!hides(rules, window({ app: 'Safari', bundleId: 'com.apple.Safari', title: '新闻', urlHost: 'github.com' }), []));
});

test('each privacy-config.json key is a settings row storing the example\'s type', () => {
  const example = JSON.parse(readFileSync(resolve(EXAMPLES, 'privacy-config.json'), 'utf8')) as Record<string, unknown>;
  const keys = Object.keys(example);
  assert.equal(keys.length, 8);
  for (const key of keys) {
    const row = ROWS.find((r) => r.item.key === key);
    assert.ok(row, key);
    const c = row.item.control, value = example[key];
    if (typeof value === 'boolean') assert.equal(c.kind, 'toggle', key);
    else {
      assert.ok(c.kind === 'choice' || c.kind === 'dropdown', key);
      assert.ok(c.options.some(([v]) => v === value), `${key}: ${String(value)}`);
    }
  }
});
