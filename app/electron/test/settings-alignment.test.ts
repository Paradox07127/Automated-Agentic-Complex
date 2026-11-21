// The settings table (settings.ts ROWS over ITEMS): each web row has its item, and what the notify and avatar_click rows
// hold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteContent } from '../src/common/notify.ts';
import { current, rowById, ROWS } from '../src/common/settings.ts';
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

test('喝水提醒 is a row of its own: agentd\'s 90 minutes by default, 0 for off, and a stored number reads as its choice', () => {
  const row = rowById('water')!;
  assert.deepEqual([row.group, row.item.key, row.item.restart], ['speak', 'water_reminder_minutes', 'backend']);
  assert.equal(current({}, null).values.water_reminder_minutes, '90');
  assert.equal(current({ water_reminder_minutes: 0 }, null).values.water_reminder_minutes, '0');
  assert.equal(current({ water_reminder_minutes: 120 }, null).values.water_reminder_minutes, '120');
  // Not one of the choices, and not a number.
  assert.equal(current({ water_reminder_minutes: 7 }, null).values.water_reminder_minutes, '90');
  assert.equal(current({ water_reminder_minutes: '120' }, null).values.water_reminder_minutes, '90');
});

test('a stored hot key that is not a name shows the default, and the status quotes the stored value as it is', () => {
  const state = current({ hotkey_look: 1, hotkey_selection: 'nonsense+q' }, null);
  assert.equal(state.values.hotkey_look, 'control+option+l');
  assert.deepEqual(state.broken, { hk_look: '1', hk_sel: 'nonsense+q' });
});
