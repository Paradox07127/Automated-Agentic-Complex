// 「设定」 placement table (sections.ts) and the shared row list (SettingRows).
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SCHEMA, demoNative } from '../../src/mock/settings';
import { CHAR_SECTIONS, isCharTab, placedTab, tabOf } from '../../src/pages/character/sections';
import { presentTabs, SettingRows } from '../../src/pages/character/SettingRows';
import type { CharTab } from '../../src/pages/character/sections';
import type { Native } from '../../src/pages/settings/native';

afterEach(cleanup);

const draw = (n: Native, tab: CharTab, dev = true) => render(<SettingRows n={n} tab={tab} dev={dev} set={vi.fn()} pending={new Set()} offline={false} />);
const shown = (text: string) => screen.queryAllByText(text).length > 0;

describe('sections', () => {
  it('has no repeated row or section id', () => {
    const rows = CHAR_SECTIONS.flatMap((s) => s.rows);
    expect(new Set(rows).size).toBe(rows.length);
    expect(new Set(CHAR_SECTIONS.map((s) => s.id)).size).toBe(CHAR_SECTIONS.length);
  });

  it('places every @character row of the demo schema', () => {
    for (const r of DEMO_SCHEMA.filter((r) => r.group === '@character')) expect(placedTab(r.id), r.id).not.toBeNull();
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
      render(<SettingRows n={n} tab="render" dev set={set} pending={new Set()} offline={false} />);
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
