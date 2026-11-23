// 设置 › 显示: a go key per 角色 › 设定 display section and the two desktop display switches; the ⓘ say more than the line beside them.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { SettingsPage } from '../../src/pages/settings/Page';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

beforeEach(() => {
  pluginsOn();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  pluginsReset();
  delete window.agenticComplex;
  window.location.hash = '';
});

async function mount(search: string) {
  await pluginsSaved();
  const router = createRouter({ routeTree: createRootRoute({ component: SettingsPage }), history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement | null;

function hashQuery(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
}

describe('设置 › 显示', () => {
  it('sends each display section to its 角色 › 设定 tab and row', async () => {
    await mount('&group=display');
    const sec = await screen.findByRole('region', { name: '角色设定' });
    expect([...sec.querySelectorAll('[data-row]')].map((r) => r.querySelector('[id$="-title"]')?.textContent)).toEqual(['画面', '镜头', '性能', '场景']);
    for (const [id, tab, at] of [
      ['disp_render', 'render', 'rnd.lightYaw'],
      ['disp_camera', 'render', 'rnd.cam'],
      ['disp_perf', 'render', 'rnd.fps'],
      ['disp_scene', 'scene', 'scn.mode'],
    ] as const) {
      await act(async () => fireEvent.click(within(row(id)!).getByRole('button', { name: /前往/ })));
      expect(window.location.hash.startsWith('#/character?'), id).toBe(true);
      expect([hashQuery().get('tab'), hashQuery().get('row')], id).toEqual([tab, at]);
    }
  });

  it('holds the recording and switch-title switches, which 交流 no longer has', async () => {
    await mount('&group=display');
    expect(await screen.findByRole('switch', { name: '录屏和共享屏幕时隐藏角色' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '切换角色时的雷霆大字' })).toBeTruthy();
    cleanup();
    await mount('&group=speak');
    await screen.findByRole('region', { name: '通知方式' });
    expect(row('capHide')).toBeNull();
    expect(row('switchTitle')).toBeNull();
  });
});

describe('settings ⓘ', () => {
  it('gives each capability band an ⓘ that is not its 做 / 要 / 花 line again', async () => {
    await mount('&group=perm');
    await screen.findByRole('region', { name: '功能' });
    const bands = [...document.querySelectorAll('[role="group"][data-row^="plugins."]')];
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) {
      const tip = b.querySelector('[role="tooltip"]')?.textContent ?? '';
      expect(tip, b.getAttribute('data-row') ?? '').not.toMatch(/^做什么：/);
      expect(tip.length, b.getAttribute('data-row') ?? '').toBeGreaterThan(20);
    }
  });
});
