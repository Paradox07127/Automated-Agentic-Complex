// 角色页「外观 → 模组设置」: the current appearance's switches from agentd's mod-settings table, one row each under its category, set through avatar.modSettings.set.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { CharacterEntry, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import type { ModSettingRow } from '../../src/pages/character/modSettingsTable';
import { Operator } from '../../src/pages/character/Operator';

const noop = () => {};
let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
  vi.restoreAllMocks();
});

const si: CharacterEntry = { id: 'si', name: '示例乙', en: 'SI', active: true, appearances: CHARACTER_LOOKS.si ?? [] };

function Op({ toast = noop }: { toast?: (m: string) => void }) {
  return (
    <Operator
      roster={[si]}
      current="si"
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={toast}
      pane="look"
    />
  );
}

const mods = () => screen.getByRole('group', { name: 'mod 设置' });
const control = (name: string) => within(mods()).getByRole('group', { name });
/** The value a stepper shows, or its menu's caption without the （默认） mark. */
const shown = (name: string) => (control(name).querySelector('[data-mod-value]') ?? control(name).querySelector('[aria-haspopup]'))?.textContent?.replace('（默认）', '');
const arrow = (name: string, dir: '上一个' | '下一个') => within(mods()).getByRole('button', { name: `${name}：${dir}` }) as HTMLButtonElement;
const groups = () => Array.from(mods().querySelectorAll('[data-mod-group]')).map((g) => g.getAttribute('aria-label'));
const rowsOf = (group: string) => Array.from(within(mods()).getByRole('group', { name: group }).querySelectorAll('[data-mod-setting]')).map((r) => r.getAttribute('data-mod-setting'));
const row = (id: string) => mods().querySelector(`[data-mod-setting="${id}"]`) as HTMLElement;
const table = (settings: ModSettingRow[]) => {
  const real = bridge.agentd.request.bind(bridge.agentd);
  return vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
    path === '/characters/si/mod-settings'
      ? { status: 200, body: { character: 'si', package_sha256: 'a'.repeat(64), schema: 'endfield-mod-settings/v1', appearances: { imported_summer: { settings } } } }
      : real(method, path, body),
  );
};

async function wear(appearance: string) {
  await bridge.avatar.setAppearance(appearance);
  render(<Op />);
  // The 模组设置 tab shows up once the table names this appearance.
  fireEvent.click(await screen.findByRole('tab', { name: '模组设置' }));
  await screen.findByRole('group', { name: 'mod 设置' });
}

describe('角色页 · 模组设置', () => {
  it('draws a ◀ value ▶ stepper per switch of the current appearance, on its default, with the value names', async () => {
    await wear('imported_summer');
    expect(shown('裙长')).toBe('长');
    expect(shown('配色')).toBe('原色');
    expect(within(mods()).queryByRole('button', { name: '配色' })).toBeNull();
  });

  it('shows the stored value', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_summer', values: { skirt: 1, color: 2 } });
    await wear('imported_summer');
    expect(shown('裙长')).toBe('短');
    expect(shown('配色')).toBe('白');
  });

  it('has no section for an appearance without a table', async () => {
    const read = vi.spyOn(bridge.agentd, 'request');
    render(<Op />);
    await waitFor(() => expect(read).toHaveBeenCalledWith('GET', '/characters/si/mod-settings', undefined));
    await Promise.all(read.mock.results.map((r) => r.value));
    expect(screen.queryByRole('group', { name: 'mod 设置' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '模组设置' })).toBeNull();
  });

  it('counts the switches on its tab and reads the table once', async () => {
    const read = vi.spyOn(bridge.agentd, 'request');
    await wear('imported_field');
    const tab = screen.getByRole('tab', { name: '模组设置' });
    expect(tab.textContent).toBe('模组设置6');
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    fireEvent.click(screen.getByRole('tab', { name: '模组设置' }));
    await screen.findByRole('group', { name: 'mod 设置' });
    await Promise.all(read.mock.results.map((r) => r.value));
    expect(read.mock.calls.filter(([, path]) => path === '/characters/si/mod-settings')).toHaveLength(1);
  });

  it('sends the appearance\'s whole set once per step', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_summer');
    fireEvent.click(arrow('裙长', '下一个'));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_summer', values: { skirt: 1, color: 0 } });
    await waitFor(() => expect(shown('裙长')).toBe('短'));
    expect(await bridge.avatar.modSettings.get({ character: 'si' })).toEqual({ appearances: { imported_summer: { skirt: 1, color: 0 } } });
  });

  it('steps through the values in order and stops at both ends', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_field');
    expect(shown('Hair Color')).toBe('Black');
    expect(arrow('Hair Color', '上一个').disabled).toBe(true);
    fireEvent.click(arrow('Hair Color', '下一个'));
    await waitFor(() => expect(shown('Hair Color')).toBe('Red'));
    await waitFor(() => expect(arrow('Hair Color', '下一个').disabled).toBe(false));
    fireEvent.click(arrow('Hair Color', '下一个'));
    await waitFor(() => expect(shown('Hair Color')).toBe('Silver'));
    await waitFor(() => expect(arrow('Hair Color', '上一个').disabled).toBe(false));
    expect(arrow('Hair Color', '下一个').disabled).toBe(true);
    fireEvent.click(arrow('Hair Color', '下一个'));
    expect(set).toHaveBeenCalledTimes(2);
    fireEvent.click(arrow('Hair Color', '上一个'));
    await waitFor(() => expect(shown('Hair Color')).toBe('Red'));
    expect(set.mock.calls.map(([a]) => a.values.tint)).toEqual([1, 2, 1]);
  });

  it('opens the menu of all values from the value when there are more than six', async () => {
    const values = ['一', '二', '三', '四', '五', '六', '七'].map((name, value) => ({ value, name }));
    table([
      { id: 'skirt', name: '裙摆', category: 'clothing', default: 0, values },
      { id: 'cuff', name: '袖口', category: 'clothing', default: 0, values: values.slice(0, 6) },
    ]);
    // The fake bridge holds the mock table, which lacks these switches.
    const set = vi.spyOn(bridge.avatar.modSettings, 'set').mockImplementation(async ({ values }) => ({ values, adjusted: [] }));
    await wear('imported_summer');
    expect(within(mods()).queryByRole('button', { name: '袖口' })).toBeNull();
    expect(shown('袖口')).toBe('一');
    fireEvent.click(within(mods()).getByRole('button', { name: '裙摆' }));
    const list = screen.getByRole('listbox', { name: '裙摆' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['一（默认）', '二', '三', '四', '五', '六', '七']);
    fireEvent.click(within(list).getByRole('option', { name: '五' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_summer', values: { skirt: 4, cuff: 0 } }));
    await waitFor(() => expect(shown('裙摆')).toBe('五'));
    expect(arrow('裙摆', '下一个').disabled).toBe(false);
  });

  it('goes back to the old value and says why when the set fails', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockRejectedValueOnce({ code: 'failed', detail: 'invalid' });
    await wear('imported_summer');
    fireEvent.click(arrow('配色', '下一个'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '「配色」没有改成：角色没有接受，已改回「原色」');
    expect(shown('配色')).toBe('原色');
  });

  it('shows what the reply says when a value was adjusted', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockResolvedValueOnce({ values: { skirt: 0, color: 2 }, adjusted: [{ id: 'skirt', reason: 'defaulted' }] });
    await wear('imported_summer');
    fireEvent.click(arrow('裙长', '下一个'));
    expect(await screen.findByText('角色包里没有这个值，按默认值画')).toBeTruthy();
    expect(shown('裙长')).toBe('长');
    expect(shown('配色')).toBe('白');
  });

  it('marks a row whose value is not its default', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_field', values: { tint: 2 } });
    await wear('imported_field');
    expect(within(row('tint')).getByTitle('已改')).toBeTruthy();
    expect(row('tint').hasAttribute('data-changed')).toBe(true);
    for (const id of ['glow', 'jacket', 'bag', 'ponytail', 'gloves']) expect(within(row(id)).queryByTitle('已改')).toBeNull();
    fireEvent.click(arrow('Hair Color', '上一个'));
    await waitFor(() => expect(within(row('tint')).getByTitle('已改')).toBeTruthy());
    fireEvent.click(arrow('Hair Color', '上一个'));
    await waitFor(() => expect(within(row('tint')).queryByTitle('已改')).toBeNull());
  });
});

describe('角色页 · 模组设置分组', () => {
  it('groups by category as 衣服, 道具, 发型, 颜色, 其他, without an empty group', async () => {
    await wear('imported_field');
    expect(groups()).toEqual(['衣服', '道具', '发型', '颜色', '其他']);
    expect(rowsOf('衣服')).toEqual(['jacket', 'gloves']);
    expect(rowsOf('其他')).toEqual(['glow']);
    cleanup();
    await wear('imported_summer');
    expect(groups()).toEqual(['衣服', '颜色']);
  });

  it('puts a category it does not know in 其他', async () => {
    table([
      { id: 'cape', name: '披风', category: 'cape', default: 0, values: [{ value: 0, name: 'A' }, { value: 1, name: 'B' }] },
      { id: 'hat', name: '帽子', category: 'accessory', default: 0, values: [{ value: 0, name: 'A' }, { value: 1, name: 'B' }] },
    ] as unknown as ModSettingRow[]);
    await wear('imported_summer');
    expect(groups()).toEqual(['道具', '其他']);
    expect(within(within(mods()).getByRole('group', { name: '其他' })).getByRole('group', { name: '披风' })).toBeTruthy();
  });

  it('draws a 显示 / 隐藏 switch as a toggle that is on while shown', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_field');
    const toggle = (name: string) => within(mods()).getByRole('switch', { name });
    expect(toggle('外套').getAttribute('aria-checked')).toBe('true');
    expect(toggle('手套').getAttribute('aria-checked')).toBe('false');
    expect(toggle('背包').getAttribute('aria-checked')).toBe('true');
    expect(shown('Hair Color')).toBe('Black');
    fireEvent.click(toggle('手套'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ appearance: 'imported_field', values: expect.objectContaining({ gloves: 0 }) })));
    await waitFor(() => expect(toggle('手套').getAttribute('aria-checked')).toBe('true'));
  });

  it('恢复默认 on a group header puts only that group back on its defaults, in one set', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_field', values: { jacket: 1, gloves: 0, bag: 0, tint: 2, ponytail: 0, glow: 0 } });
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    const toast = vi.fn();
    await bridge.avatar.setAppearance('imported_field');
    render(<Op toast={toast} />);
    fireEvent.click(await screen.findByRole('tab', { name: '模组设置' }));
    await screen.findByRole('group', { name: 'mod 设置' });
    const reset = (group: string) => within(within(mods()).getByRole('group', { name: group })).getByRole('button', { name: '恢复默认' });
    expect(reset('发型').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(reset('衣服'));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_field', values: { glow: 0, tint: 2, jacket: 0, bag: 0, ponytail: 0, gloves: 1 } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('「衣服」已恢复默认'));
    expect(within(mods()).getByRole('switch', { name: '外套' }).getAttribute('aria-checked')).toBe('true');
    expect(within(mods()).getByRole('switch', { name: '背包' }).getAttribute('aria-checked')).toBe('false');
    expect(reset('衣服').getAttribute('aria-disabled')).toBe('true');
    expect(reset('道具').getAttribute('aria-disabled')).not.toBe('true');
  });
});
