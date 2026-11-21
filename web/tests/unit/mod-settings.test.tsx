// 角色页「外观 → mod 设置」: the current appearance's switches from agentd's mod-settings table by category, set through avatar.modSettings.set.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { CharacterEntry, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LOOKS, NOW } from '../../src/mock/fixtures';
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
      hours={null}
      charState={STATE_WITH_CAUSES}
      now={NOW}
      sparse={false}
      weapon={false}
      toast={toast}
      pane="look"
    />
  );
}

const mods = () => screen.getByRole('group', { name: 'mod 设置' });
/** The value a switch's menu shows, without the （默认） mark. */
const shown = (name: string) => within(mods()).getByRole('button', { name }).textContent?.replace('（默认）', '');
const choose = (name: string, value: string) => {
  fireEvent.click(within(mods()).getByRole('button', { name }));
  fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.replace('（默认）', '') === value)!);
};
const groups = () => within(mods()).getAllByRole('group').map((g) => g.getAttribute('aria-label'));

async function wear(appearance: string) {
  await bridge.avatar.setAppearance(appearance);
  render(<Op />);
  await screen.findByRole('group', { name: 'mod 设置' });
}

describe('角色页 · mod 设置', () => {
  it('draws one menu per switch of the current appearance, on its default, with the value names', async () => {
    await wear('imported_summer');
    expect(shown('裙长')).toBe('长');
    expect(shown('配色')).toBe('原色');
    fireEvent.click(within(mods()).getByRole('button', { name: '配色' }));
    expect(within(screen.getByRole('listbox', { name: '配色' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['原色（默认）', '黑', '白']);
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
    expect(screen.queryByText('mod 设置')).toBeNull();
  });

  it('sends the appearance\'s whole set once per pick', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_summer');
    choose('裙长', '短');
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_summer', values: { skirt: 1, color: 0 } });
    await waitFor(() => expect(shown('裙长')).toBe('短'));
    expect(await bridge.avatar.modSettings.get({ character: 'si' })).toEqual({ appearances: { imported_summer: { skirt: 1, color: 0 } } });
  });

  it('goes back to the old value and says why when the set fails', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockRejectedValueOnce({ code: 'failed', detail: 'invalid' });
    await wear('imported_summer');
    choose('配色', '黑');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '「配色」没有改成：角色没有接受，已改回「原色」');
    expect(shown('配色')).toBe('原色');
  });

  it('shows what the reply says when a value was adjusted', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockResolvedValueOnce({ values: { skirt: 0, color: 2 }, adjusted: [{ id: 'skirt', reason: 'defaulted' }] });
    await wear('imported_summer');
    choose('裙长', '短');
    expect(await screen.findByText('角色包里没有这个值，按默认值画')).toBeTruthy();
    expect(shown('裙长')).toBe('长');
    expect(shown('配色')).toBe('白');
  });
});

describe('角色页 · mod 设置分组', () => {
  it('groups by category as 衣服, 道具, 发型, 颜色, 其他, without an empty group', async () => {
    await wear('imported_field');
    expect(groups()).toEqual(['衣服', '道具', '发型', '颜色', '其他']);
    const names = (g: string) => Array.from(within(mods()).getByRole('group', { name: g }).querySelectorAll('[role="switch"], [aria-haspopup]')).map((c) => c.getAttribute('aria-label'));
    expect(names('衣服')).toEqual(['外套', '手套']);
    expect(names('其他')).toEqual(['glow']);
    cleanup();
    await wear('imported_summer');
    expect(groups()).toEqual(['衣服', '颜色']);
  });

  it('puts a category it does not know in 其他', async () => {
    const real = bridge.agentd.request.bind(bridge.agentd);
    const settings = [
      { id: 'cape', name: '披风', category: 'cape', default: 0, values: [{ value: 0, name: 'A' }, { value: 1, name: 'B' }] },
      { id: 'hat', name: '帽子', category: 'accessory', default: 0, values: [{ value: 0, name: 'A' }, { value: 1, name: 'B' }] },
    ] as unknown as ModSettingRow[];
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      path === '/characters/si/mod-settings'
        ? { status: 200, body: { character: 'si', package_sha256: 'a'.repeat(64), schema: 'endfield-mod-settings/v1', appearances: { imported_summer: { settings } } } }
        : real(method, path, body),
    );
    await wear('imported_summer');
    expect(groups()).toEqual(['道具', '其他']);
    expect(within(within(mods()).getByRole('group', { name: '其他' })).getByRole('button', { name: '披风' })).toBeTruthy();
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
});
