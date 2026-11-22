// 「设定」 placement table (sections.ts) and the shared row list (SettingRows).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SCHEMA, demoNative } from '../../src/mock/settings';
import { CHAR_SECTIONS, isCharTab, PHOTO_ONLY_ROWS, placedTab, tabOf } from '../../src/pages/character/sections';
import { presentTabs, SettingRows } from '../../src/pages/character/SettingRows';
import type { CharTab } from '../../src/pages/character/sections';
import type { Native } from '../../src/pages/settings/native';

afterEach(cleanup);

const draw = (n: Native, tab: CharTab, dev = true, over: Partial<Parameters<typeof SettingRows>[0]> = {}) =>
  render(<SettingRows n={n} tab={tab} dev={dev} set={vi.fn()} setMany={vi.fn()} pending={new Set()} failed={{}} offline={false} {...over} />);

/** Web ids of the settings the preview takes: supervisor.ts lookArguments' config keys through settings.ts's id table. */
function previewIds(): Set<string> {
  const electron = resolve(__dirname, '../../../app/electron/src');
  const sup = readFileSync(resolve(electron, 'main/renderer/supervisor.ts'), 'utf8');
  const body = sup.slice(sup.indexOf('export function lookArguments'), sup.indexOf('export function renderArguments'));
  const keys = new Set([...body.matchAll(/(?:flag|option)\('(\w+)'/g)].map((m) => m[1]));
  const table = readFileSync(resolve(electron, 'common/settings.ts'), 'utf8');
  return new Set([...table.matchAll(/\['([\w.]+)', (?:'@character', )?'(\w+)'\]/g)].filter((m) => keys.has(m[2])).map((m) => m[1]!));
}
const shown = (text: string) => screen.queryAllByText(text).length > 0;

describe('sections', () => {
  it('has no repeated row or section id', () => {
    const rows = CHAR_SECTIONS.flatMap((s) => s.rows);
    expect(new Set(rows).size).toBe(rows.length);
    expect(new Set(CHAR_SECTIONS.map((s) => s.id)).size).toBe(CHAR_SECTIONS.length);
  });

  it('places every @character row of the demo schema on a 设定 page or in 拍照', () => {
    for (const r of DEMO_SCHEMA.filter((r) => r.group === '@character')) expect(placedTab(r.id) !== null || PHOTO_ONLY_ROWS.has(r.id), r.id).toBe(true);
  });

  it('marks 仅桌面 exactly the 画面 sections the preview does not take (rnd.closeup goes to the desktop by host link)', () => {
    const look = previewIds();
    expect(look.has('rnd.lightYaw') && look.has('rnd.dof') && look.has('rnd.filter')).toBe(true);
    for (const s of CHAR_SECTIONS.filter((x) => x.tab === 'render'))
      for (const id of s.rows) expect([id, look.has(id)], s.title).toEqual([id, !s.desktopOnly]);
  });

  it('falls back on the id prefix', () => {
    expect(tabOf('rnd.outline')).toBe('render');
    expect(tabOf('beh.sit')).toBe('behavior');
    expect(tabOf('avatar_click')).toBe('behavior');
    expect(tabOf('rnd.newThing')).toBe('render');
    expect(tabOf('scn.x')).toBe('scene');
    expect(tabOf('zzz')).toBe('behavior');
    expect(placedTab('rnd.newThing')).toBeNull();
    expect(isCharTab('render')).toBe(true);
    expect(isCharTab('look')).toBe(false);
    expect(isCharTab('tune')).toBe(false);
  });
});

describe('SettingRows', () => {
  it('leaves rnd.filter to 拍照, also out of 其他', async () => {
    draw(await demoNative(null), 'render');
    expect(shown('滤镜')).toBe(false);
    expect(screen.queryByRole('region', { name: '其他' })).toBeNull();
  });

  it('draws 主光水平 and 主光俯仰 as one 3×3 pad that saves both values in one go, the default cell hollow', async () => {
    const n = await demoNative(null);
    const setMany = vi.fn();
    draw(n, 'render', true, { setMany });
    expect(shown('主光水平微调')).toBe(false);
    const pad = screen.getByRole('radiogroup', { name: '主光方向' });
    const cells = within(pad).getAllByRole('radio');
    expect(cells.map((c) => c.getAttribute('aria-label'))).toEqual([
      '左偏 15°，抬高 10°', '原作，抬高 10°', '右偏 15°，抬高 10°',
      '左偏 15°，原作', '原作，原作', '右偏 15°，原作',
      '左偏 15°，降低 10°', '原作，降低 10°', '右偏 15°，降低 10°',
    ]);
    expect(cells[4]!.getAttribute('aria-checked')).toBe('true');
    expect(cells[4]!.hasAttribute('data-default')).toBe(true);
    fireEvent.keyDown(cells[4]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[1]);
    expect(setMany).not.toHaveBeenCalled();
    fireEvent.click(cells[2]!);
    expect(setMany).toHaveBeenCalledWith({ 'rnd.lightYaw': '15', 'rnd.lightPitch': '10' });
  });

  it('marks a changed row: ↺ puts that row back, the second line names the default; an unchanged row keeps its description', async () => {
    const n = await demoNative(null);
    const set = vi.fn();
    draw({ ...n, saved: { ...n.saved, 'rnd.lightStrength': '1.25', 'rnd.lightPitch': '10' } }, 'render', true, { set });
    const strength = document.getElementById('set-rnd.lightStrength')!;
    expect(strength.hasAttribute('data-changed')).toBe(true);
    expect(within(strength).getByText('默认：原作 · 100 %')).toBeTruthy();
    expect(within(within(strength).getByRole('radiogroup', { name: '主光强度' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['50', '75', '100', '125', '150']);
    fireEvent.click(within(strength).getByRole('button', { name: '恢复「主光强度」的默认' }));
    expect(set).toHaveBeenCalledWith('rnd.lightStrength', '1');
    expect(within(document.getElementById('set-rnd.lightYaw')!).getByText('默认：原作（正中）')).toBeTruthy();
    const dof = document.getElementById('set-rnd.dof')!;
    expect(dof.hasAttribute('data-changed')).toBe(false);
    expect(within(dof).queryByRole('button', { name: /恢复/ })).toBeNull();
    expect(within(dof).getByText('镜头处于近景时虚化她身上离焦的部分；全身景别下看不出')).toBeTruthy();
  });

  it('tags a row that brings her back with ⟳ 角色, and writes a failed save on its row', async () => {
    const n = await demoNative(null);
    draw(n, 'behavior', true, { pending: new Set(['beh.face']), failed: { 'beh.sit': '没有保存「坐在窗口顶上」：原生设置服务没有响应' } });
    expect(within(document.getElementById('set-beh.physics')!).getByText('角色')).toBeTruthy();
    expect(within(document.getElementById('set-beh.face')!).getByText('│ 重启后生效')).toBeTruthy();
    expect(within(document.getElementById('set-beh.sit')!).getByText('没有保存「坐在窗口顶上」：原生设置服务没有响应')).toBeTruthy();
  });

  it('shows developer-only rows only in developer mode', async () => {
    const n = await demoNative(null);
    draw(n, 'render', true);
    expect(shown('原作镜头预设')).toBe(true);
    expect(shown('角色边界')).toBe(true);
    expect(shown('2× SSAA')).toBe(true);
    cleanup();
    draw(n, 'render', false);
    expect(shown('角色边界')).toBe(true);
    expect(shown('2× SSAA')).toBe(false);
  });

  it('draws no row the schema lacks', async () => {
    const n = await demoNative(null);
    const { ['rnd.outline']: _gone, ...rows } = n.rows;
    draw({ ...n, rows }, 'render');
    expect(shown('角色边界')).toBe(false);
  });

  it('puts an unplaced @character row under 其他', async () => {
    const n = await demoNative(null);
    const rows = { ...n.rows, 'rnd.zz': { id: 'rnd.zz', group: '@character', label: '测试行', kind: 'toggle' as const, default: false, restart: 'none' as const } };
    draw({ ...n, rows }, 'render');
    expect(within(screen.getByRole('region', { name: '其他' })).getAllByText('测试行').length).toBeGreaterThan(0);
  });

  it('leaves speak rows on their own page', async () => {
    draw(await demoNative(null), 'behavior');
    expect(shown('坐在窗口顶上')).toBe(true);
    expect(shown('点击角色')).toBe(true);
    expect(shown('语音合成来源')).toBe(false);
  });

  it('draws slider rows in their format and sends at most one change per 1/30 s', async () => {
    const n = await demoNative(null);
    const set = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SettingRows n={n} tab="render" dev set={set} setMany={vi.fn()} pending={new Set()} failed={{}} offline={false} />);
      const yaw = screen.getByRole('slider', { name: '水平朝向' }) as HTMLInputElement;
      expect([yaw.min, yaw.max, yaw.step, yaw.value]).toEqual(['-180', '180', '0.5', '0']);
      for (const v of ['10', '20', '30.5']) fireEvent.change(yaw, { target: { value: v } });
      expect(set.mock.calls).toEqual([['rnd.yaw', 10, false]]);
      expect(yaw.value).toBe('30.5');
      expect(screen.getByRole('button', { name: '水平朝向：30.5°，点击输入' })).toBeTruthy();
      vi.advanceTimersByTime(40);
      expect(set.mock.calls).toEqual([['rnd.yaw', 10, false], ['rnd.yaw', 30.5, false]]);
      const zoom = screen.getByRole('slider', { name: '镜头缩放' }) as HTMLInputElement;
      expect([zoom.min, zoom.max, zoom.step, zoom.value]).toEqual(['100', '400', '5', '100']);
      fireEvent.change(zoom, { target: { value: '250' } });
      expect(set).toHaveBeenLastCalledWith('rnd.zoom', 2.5, false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the pages that have a row', async () => {
    expect(presentTabs(await demoNative(null), true)).toEqual(['behavior', 'render', 'scene']);
  });
});
