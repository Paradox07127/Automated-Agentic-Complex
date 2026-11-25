// 角色页「外观 → 模组设置」: the current appearance's switches from agentd's mod-settings table, one row each under its category, set through avatar.modSettings.set.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
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

const si: CharacterEntry = { id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [] };

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

const mods = () => screen.getByRole('group', { name: '模组设置' });
/** A setting's stepper: the row (the shared SRow) is a group of the same name around it. */
const control = (name: string, scope = mods()) => within(scope).getAllByRole('group', { name }).find((g) => g.getAttribute('data-stub') !== 'SRow')!;
/** The value a stepper shows, or its menu's caption. */
const shown = (name: string) => (control(name).querySelector('[data-value]') ?? control(name).querySelector('[aria-haspopup]'))?.textContent;
/** A 显示 / 隐藏 setting's 开 / 关 switch. */
const toggle = (name: string) => within(mods()).getByRole('switch', { name });
/** Is the switch on, which is the setting's 显示 value. */
const showing = (name: string) => toggle(name).getAttribute('aria-checked') === 'true';
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
  await screen.findByRole('group', { name: '模组设置' });
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
    expect(screen.queryByRole('group', { name: '模组设置' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '模组设置' })).toBeNull();
  });

  it('counts the switches on its tab and reads the table once', async () => {
    const read = vi.spyOn(bridge.agentd, 'request');
    await wear('imported_field');
    const tab = screen.getByRole('tab', { name: '模组设置' });
    expect(tab.textContent).toBe('模组设置6MOD CFG');
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    fireEvent.click(screen.getByRole('tab', { name: '模组设置' }));
    await screen.findByRole('group', { name: '模组设置' });
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

  it('changes nothing and offers a retry while the stored values cannot be read', async () => {
    const get = vi.spyOn(bridge.avatar.modSettings, 'get').mockRejectedValueOnce({ code: 'failed', detail: 'config.json' });
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await bridge.avatar.setAppearance('imported_summer');
    render(<Op />);
    fireEvent.click(await screen.findByRole('tab', { name: '模组设置' }));
    const bar = await screen.findByRole('alert');
    expect(bar.textContent).toContain('读取模组设置失败：角色渲染进程无响应');
    expect(arrow('裙长', '下一个').disabled).toBe(true);
    fireEvent.click(arrow('裙长', '下一个'));
    expect(set).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(bar).getByRole('button', { name: '重试' })));
    expect(get).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(arrow('裙长', '下一个').disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
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
    fireEvent.click(within(mods()).getByRole('button', { name: '裙摆：一' }));
    const list = screen.getByRole('listbox', { name: '裙摆' });
    // Each option leads with its place; the default one says so.
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['01一默认', '02二', '03三', '04四', '05五', '06六', '07七']);
    fireEvent.click(within(list).getByRole('option', { name: '五' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_summer', values: { skirt: 4, cuff: 0 } }));
    await waitFor(() => expect(shown('裙摆')).toBe('五'));
    expect(arrow('裙摆', '下一个').disabled).toBe(false);
  });

  it('goes back to the old value and says why when the set fails', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockRejectedValueOnce({ code: 'failed', detail: 'invalid' });
    await wear('imported_summer');
    fireEvent.click(arrow('配色', '下一个'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '「配色」未能更改：角色渲染进程拒绝了该设置，已还原为「原色」');
    expect(shown('配色')).toBe('原色');
  });

  it('shows what the reply says when a value was adjusted', async () => {
    vi.spyOn(bridge.avatar.modSettings, 'set').mockResolvedValueOnce({ values: { skirt: 0, color: 2 }, adjusted: [{ id: 'skirt', reason: 'defaulted' }] });
    await wear('imported_summer');
    fireEvent.click(arrow('裙长', '下一个'));
    expect(await screen.findByText('当前角色包未包含该配置值，已按默认值渲染')).toBeTruthy();
    expect(shown('裙长')).toBe('长');
    expect(shown('配色')).toBe('白');
  });

  it('marks a row whose value is not its default, with its default in words', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_field', values: { tint: 2 } });
    await wear('imported_field');
    expect(row('tint').hasAttribute('data-changed')).toBe(true);
    expect(row('tint').textContent).toContain('默认：Black');
    for (const id of ['glow', 'jacket', 'bag', 'ponytail', 'gloves']) expect(row(id).hasAttribute('data-changed')).toBe(false);
    fireEvent.click(arrow('Hair Color', '上一个'));
    await waitFor(() => expect(shown('Hair Color')).toBe('Red'));
    expect(row('tint').hasAttribute('data-changed')).toBe(true);
    fireEvent.click(arrow('Hair Color', '上一个'));
    await waitFor(() => expect(row('tint').hasAttribute('data-changed')).toBe(false));
    expect(row('tint').textContent).not.toContain('默认');
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
    expect(control('披风', within(mods()).getByRole('group', { name: '其他' }))).toBeTruthy();
  });

  it('draws a 显示 / 隐藏 setting as one switch, on exactly when the value is its 显示 value, whatever the value order', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_field');
    expect(showing('外套')).toBe(true);
    expect(showing('手套')).toBe(false);
    // 背包 lists 隐藏 first.
    expect(showing('背包')).toBe(true);
    expect(shown('Hair Color')).toBe('Black');
    fireEvent.click(toggle('手套'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ appearance: 'imported_field', values: expect.objectContaining({ gloves: 0 }) })));
    await waitFor(() => expect(showing('手套')).toBe(true));
    // Off on 背包 sends its 隐藏 value, which comes first.
    await waitFor(() => expect(toggle('背包').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(toggle('背包'));
    await waitFor(() => expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: 'imported_field', values: expect.objectContaining({ bag: 0 }) })));
    await waitFor(() => expect(showing('背包')).toBe(false));
  });

  it('恢复默认 on a group header puts only that group back on its defaults, in one set', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_field', values: { jacket: 1, gloves: 0, bag: 0, tint: 2, ponytail: 0, glow: 0 } });
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    const toast = vi.fn();
    await bridge.avatar.setAppearance('imported_field');
    render(<Op toast={toast} />);
    fireEvent.click(await screen.findByRole('tab', { name: '模组设置' }));
    await screen.findByRole('group', { name: '模组设置' });
    const reset = (group: string) => within(within(mods()).getByRole('group', { name: group })).getByRole('button', { name: '恢复默认' }) as HTMLButtonElement;
    expect(reset('发型').disabled).toBe(true);
    expect(reset('发型').title).toBe('已是默认');
    fireEvent.click(reset('衣服'));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_field', values: { glow: 0, tint: 2, jacket: 0, bag: 0, ponytail: 0, gloves: 1 } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('「衣服」已恢复默认'));
    expect(showing('外套')).toBe(true);
    expect(showing('背包')).toBe(false);
    expect(reset('衣服').disabled).toBe(true);
    expect(reset('道具').disabled).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
type SetReply = Awaited<ReturnType<AgenticComplexBridge['avatar']['modSettings']['set']>>;
const card = () => mods().querySelector('[data-mod-card]') as HTMLElement;
const sync = () => within(card()).getByRole('status').textContent;

describe('角色页 · 模组设置的外观卡', () => {
  it('names the appearance and its id, and says the preview matches, is applying, or went back', async () => {
    const reply = deferred<SetReply>();
    vi.spyOn(bridge.avatar.modSettings, 'set').mockReturnValueOnce(reply.promise).mockRejectedValueOnce({ code: 'failed' });
    await wear('imported_summer');
    expect(within(card()).getByRole('heading').textContent).toBe('夏装');
    expect(card().textContent).toContain('imported_summer');
    expect(sync()).toBe('设置与实时显示一致');
    fireEvent.click(arrow('裙长', '下一个'));
    expect(sync()).toBe('正在应用「裙长」…');
    // The row being applied says so; every control waits.
    expect(row('skirt').hasAttribute('data-busy')).toBe(true);
    expect(row('skirt').textContent).toContain('应用中');
    expect(arrow('配色', '下一个').disabled).toBe(true);
    await act(async () => reply.resolve({ values: { skirt: 1, color: 0 }, adjusted: [] }));
    expect(sync()).toBe('设置与实时显示一致');
    fireEvent.click(arrow('配色', '下一个'));
    await waitFor(() => expect(sync()).toBe('上次修改未生效，已恢复原值'));
  });

  it('全部恢复默认 sends every switch on its default in one set, and is off while all are', async () => {
    await bridge.avatar.modSettings.set({ character: 'si', appearance: 'imported_field', values: { jacket: 1, tint: 2, bag: 1, gloves: 1, ponytail: 0, glow: 0 } });
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_field');
    const all = within(card()).getByRole('button', { name: '全部恢复默认' }) as HTMLButtonElement;
    expect(all.disabled).toBe(false);
    fireEvent.click(all);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith({ character: 'si', appearance: 'imported_field', values: { glow: 0, tint: 0, jacket: 0, bag: 1, ponytail: 0, gloves: 1 } });
    await waitFor(() => expect(all.disabled).toBe(true));
  });

  it('jumps to a category from its chip, which counts its switches', async () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    await wear('imported_field');
    const chips = within(within(mods()).getByRole('group', { name: '跳到类别' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['衣服2', '道具1', '发型1', '颜色1', '其他1']);
    fireEvent.click(chips[3]!);
    expect(into).toHaveBeenCalledTimes(1);
    expect(into.mock.contexts[0]).toBe(within(mods()).getByRole('group', { name: '颜色' }));
    expect(chips[3]!.getAttribute('aria-current')).toBe('true');
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
});

describe('角色页 · 模组设置的对比、回滚和按键', () => {
  it('offers 对比 back to the value before the last change, and flips A / B on each press', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_summer');
    expect(within(row('skirt')).queryByRole('button', { name: /对比/ })).toBeNull();
    fireEvent.click(arrow('裙长', '下一个'));
    await waitFor(() => expect(shown('裙长')).toBe('短'));
    fireEvent.click(await within(row('skirt')).findByRole('button', { name: '对比「长」' }));
    await waitFor(() => expect(shown('裙长')).toBe('长'));
    fireEvent.click(await within(row('skirt')).findByRole('button', { name: '对比「短」' }));
    await waitFor(() => expect(shown('裙长')).toBe('短'));
    expect(set.mock.calls.map(([a]) => a.values.skirt)).toEqual([1, 0, 1]);
  });

  it('bars a failed change right under its row, and 再试一次 sends the same change again', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set').mockRejectedValueOnce({ code: 'failed' });
    await wear('imported_summer');
    fireEvent.click(arrow('配色', '下一个'));
    const alert = await screen.findByRole('alert');
    expect(row('color').hasAttribute('data-fail')).toBe(true);
    expect(row('color').nextElementSibling?.contains(alert)).toBe(true);
    // A change that did not land leaves no 对比 to the value it never left.
    expect(within(row('color')).queryByRole('button', { name: /对比/ })).toBeNull();
    fireEvent.click(within(row('color').nextElementSibling as HTMLElement).getByRole('button', { name: '再试一次' }));
    await waitFor(() => expect(shown('配色')).toBe('黑'));
    expect(set.mock.calls.map(([a]) => a.values.color)).toEqual([1, 1]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('↑↓ move between rows, ←→ change the row, Space flips 显示 / 隐藏, X goes back to the last value', async () => {
    const set = vi.spyOn(bridge.avatar.modSettings, 'set');
    await wear('imported_field');
    // The first row of the first group holds the Tab stop.
    expect(row('jacket').tabIndex).toBe(0);
    row('jacket').focus();
    fireEvent.keyDown(row('jacket'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('gloves'));
    fireEvent.keyDown(row('gloves'), { key: ' ' });
    await waitFor(() => expect(showing('手套')).toBe(true));
    fireEvent.keyDown(row('gloves'), { key: 'ArrowRight' });
    await waitFor(() => expect(showing('手套')).toBe(false));
    fireEvent.keyDown(row('gloves'), { key: 'x' });
    await waitFor(() => expect(showing('手套')).toBe(true));
    row('tint').focus();
    fireEvent.keyDown(row('tint'), { key: 'ArrowRight' });
    await waitFor(() => expect(shown('Hair Color')).toBe('Red'));
    expect(set.mock.calls.map(([a]) => [a.values.gloves, a.values.tint])).toEqual([
      [0, 0],
      [1, 0],
      [0, 0],
      [0, 1],
    ]);
  });
});

describe('角色页 · 模组设置表读不了', () => {
  it('says so on the imported appearances instead of dropping the tab without a word', async () => {
    vi.spyOn(bridge.agentd, 'request').mockRejectedValue(new AgentdCallError(409, 'http_409', undefined, { error: 'sha256 mismatch' }, 'sha256 mismatch'));
    await bridge.avatar.setAppearance('imported_field');
    render(<Op />);
    const looks = await screen.findByRole('group', { name: '外观' });
    await waitFor(() => expect(within(looks).getAllByText('无法读取设置表：安装后的文件已被修改')).toHaveLength(2));
    expect(screen.queryByRole('tab', { name: '模组设置' })).toBeNull();
    expect(within(looks).getByRole('button', { name: /日常/ }).textContent).not.toContain('设置表');
  });
});
