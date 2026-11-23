// The settings table (settings.ts ROWS over ITEMS): each web row has its item, and what the notify and avatar_click rows
// hold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteContent } from '../src/common/notify.ts';
import { current, parseChanges, Rejection, rowById, ROWS } from '../src/common/settings.ts';
import type { AnnounceKind } from '../src/common/stack-source.ts';

test('every web row has an item, each web id and each config key once', () => {
  for (const row of ROWS) assert.ok(row.item, row.id);
  assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length);
  assert.equal(new Set(ROWS.map((r) => r.item.key)).size, ROWS.length);
  assert.equal(rowById('hk_look')?.item.key, 'hotkey_look');
});

test('every notify kind\'s key is a hot setting with a web row; notify_reminder defaults to sound', () => {
  for (const kind of ['done', 'waiting', 'error', 'brief', 'reminder'] as AnnounceKind[]) {
    const key = noteContent({ id: 'n', kind, text: '', sound: false, sessionId: null, traceId: null, commitmentId: null }).groupId;
    const row = ROWS.find((r) => r.item.key === key);
    assert.ok(row, key);
    assert.equal(row.item.restart, 'none', key);
  }
  assert.equal(rowById('n_remind')?.item.key, 'notify_reminder');
  assert.equal(rowById('n_remind')?.item.control.value, 'sound');
});

test('avatar_click: a hot choice of 角色互动 and 打开快速输入 on the character page, interact by default', () => {
  const row = rowById('avatar_click');
  assert.ok(row);
  assert.equal(row.item.key, 'avatar_click');
  assert.equal(row.group, '@character');
  assert.equal(row.item.restart, 'none');
  assert.deepEqual(row.item.control, { kind: 'choice', options: [['interact', '角色互动'], ['quick_input', '打开快速输入']], value: 'interact' });
});

test('break, water and report time are agentd\'s fixed values, not settings', () => {
  for (const id of ['rest', 'water', 'reportTime']) assert.equal(rowById(id), undefined, id);
  for (const key of ['break_reminder_minutes', 'water_reminder_minutes', 'ritual_report_time']) {
    assert.ok(!ROWS.some((r) => r.item.key === key), key);
  }
});

test('代理 is a text row of 服务 that restarts the backend: empty, or an http(s) address with no path, query or fragment', () => {
  const row = rowById('proxy')!;
  assert.deepEqual([row.group, row.item.key, row.item.restart, row.item.control.kind, row.item.control.value], ['services', 'proxy_url', 'backend', 'text', '']);
  for (const ok of ['', 'http://127.0.0.1:7890', 'https://u:p@proxy.corp:8443', 'http://proxy.corp:8080/']) {
    assert.deepEqual(parseChanges({ proxy: ok }, () => {}), { proxy_url: ok }, ok);
  }
  for (const bad of ['socks5://127.0.0.1:1080', '127.0.0.1:7890', 'http://proxy:1/path', 'http://proxy:1?x=1', ' http://proxy:1', 'http://', 'http://pro xy:1']) {
    assert.throws(() => parseChanges({ proxy: bad }, () => {}), (e: unknown) => e instanceof Rejection && /http:\/\/ 或 https:\/\//.test(e.message), bad);
  }
  assert.equal(current({ proxy_url: 'socks5://x:1' }, null).values.proxy_url, '');
  assert.equal(current({ proxy_url: 'http://x:1' }, null).values.proxy_url, 'http://x:1');
});

test('a stored hot key that is not a name shows the default, and the status quotes the stored value as it is', () => {
  const state = current({ hotkey_look: 1, hotkey_selection: 'nonsense+q' }, null);
  assert.equal(state.values.hotkey_look, 'control+option+l');
  assert.deepEqual(state.broken, { hk_look: '1', hk_sel: 'nonsense+q' });
});
