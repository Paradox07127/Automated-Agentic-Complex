// The settings table (settings.ts ROWS over ITEMS): each web row has its item, and what the notify and avatar_click rows
// hold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteContent } from '../src/common/notify.ts';
import { current, parseChanges, planSave, Rejection, rowById, ROWS, type SettingValue, snapshot, validProxyUrl } from '../src/common/settings.ts';
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

test('代理 is a text row of 服务 that restarts the backend: empty, or an http(s) host and port with no credentials, path, query or fragment', () => {
  const row = rowById('proxy')!;
  assert.deepEqual([row.group, row.item.key, row.item.restart, row.item.control.kind, row.item.control.value], ['services', 'proxy_url', 'backend', 'text', '']);
  for (const [given, kept] of [['', ''], ['http://127.0.0.1:7890', 'http://127.0.0.1:7890'], ['https://Proxy.Corp:8443', 'https://proxy.corp:8443'],
    ['http://proxy.corp:8080/', 'http://proxy.corp:8080'], ['http://proxy.corp:80', 'http://proxy.corp']]) {
    assert.deepEqual(parseChanges({ proxy: given }, () => {}), { proxy_url: kept }, given);
  }
  for (const bad of ['socks5://127.0.0.1:1080', '127.0.0.1:7890', 'http://proxy:1/path', 'http://proxy:1?x=1', ' http://proxy:1', 'http://', 'http://pro xy:1',
    'http://a:b@h:8080', 'https://u:p@proxy.corp:8443', 'http://u@h:1', 'http://h\\p', 'http://h:1\\']) {
    assert.throws(() => parseChanges({ proxy: bad }, () => {}), (e: unknown) => e instanceof Rejection && /http:\/\/ 或 https:\/\//.test(e.message), bad);
  }
  assert.equal(validProxyUrl('http://h\\p'), false);
  assert.equal(current({ proxy_url: 'socks5://x:1' }, null).values.proxy_url, '');
  assert.equal(current({ proxy_url: 'http://x:1' }, null).values.proxy_url, 'http://x:1');
  assert.deepEqual((snapshot({ proxy_url: 'http://alice:s3cret@proxy.example:8080' }, null, true).saved as Record<string, unknown>).proxy, '');
});

test('a change of any avatar-restart row restarts the renderer; viewport only when where she may go changes', () => {
  for (const [key, value] of [['scene_mode', 'box'], ['scene_parallax', false], ['render_ssaa', false], ['speech_expressions', false]] as const) {
    const plan = planSave({}, null, { [key]: value });
    assert.ok(plan.effects.some((e) => e.kind === 'restartAvatar'), key);
    assert.equal(plan.restart, 'avatar', key);
  }
  assert.ok(!planSave({}, null, { viewport: 'fullscreen' }).effects.some((e) => e.kind === 'restartAvatar'));
  assert.equal(planSave({}, null, { viewport: 'window' }).restart, 'avatar');
});

test('a save that narrows window text or screenshot consent revokes them in agentd', () => {
  const revokes = (saved: Record<string, SettingValue>, changes: Record<string, SettingValue>) =>
    planSave(saved, null, changes).effects.filter((e) => e.kind === 'revoke');
  assert.deepEqual(revokes({ share_window_text: true, screen_context_level: 'focused' }, { screen_context_level: 'status' }),
    [{ kind: 'revoke', revoke: 'window_text', key: 'screen_context_level' }]);
  assert.deepEqual(revokes({ share_window_text: true, share_screenshots: true }, { share_window_text: false, share_screenshots: false }),
    [{ kind: 'revoke', revoke: 'window_text', key: 'share_window_text' }, { kind: 'revoke', revoke: 'screenshots', key: 'share_screenshots' }]);
  assert.deepEqual(revokes({ share_window_text: false }, { share_window_text: true, share_screenshots: true }), []);
});

test('a save that puts a global hot key on the page\'s palette shortcut is refused', () => {
  assert.deepEqual(planSave({}, null, { hotkey_quick_input: 'command+k' }), { write: {}, effects: [], restart: 'none', error: '⌘K 已被「命令面板」占用' });
  assert.deepEqual(planSave({}, null, { hotkey_look: 'control+k' }, 'windows'), { write: {}, effects: [], restart: 'none', error: 'Ctrl+K 已被「命令面板」占用' });
  assert.equal(planSave({}, null, { hotkey_look: 'control+k' }).error, undefined);
});

test('a stored hot key that is not a name shows the default, and the status quotes the stored value as it is', () => {
  const state = current({ hotkey_look: 1, hotkey_selection: 'nonsense+q' }, null);
  assert.equal(state.values.hotkey_look, 'control+option+l');
  assert.deepEqual(state.broken, { hk_look: '1', hk_sel: 'nonsense+q' });
});

test('idle_low_fps is off by default: she runs at the full frame rate while idle', () => {
  assert.equal(current({}, null).values.idle_low_fps, false);
});
