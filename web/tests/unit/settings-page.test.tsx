// Settings page (prototype-v3/pages/settings.*): outbound plate, gate plate, page keys, wording, sparse and error demos.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { oldWordHits } from '../../scripts/check-copy.mjs';
import { createFakeBridge } from '../../src/bridge/fake';
import { SettingsPage } from '../../src/pages/settings/Page';
import { PAGE_KEYS } from '../../src/pages/settings/groups/Keys';
import { pageRoutes } from '../../src/shell/registry';
import { SETTING_GROUPS } from '../../src/pages/settings/groups';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function mount(search: string) {
  await pluginsSaved();
  const root = createRootRoute({ component: SettingsPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe(' 观察: 外发总览 plate', () => {
  it('is one line: what leaves this computer, where it goes, and whether it is masked first', async () => {
    await mount('&group=privacy');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    expect(plate.textContent).toContain('会离开这台电脑的');
    expect(plate.textContent).toMatch(/→ .+ │ 发出前遮蔽 (开|关|—)/);
    expect(within(plate).queryByRole('img')).toBeNull();
    expect(within(plate).queryByRole('grid')).toBeNull();
  });

  it('counts no screenshots of its own: its link lands on 每日简报 › 时间', async () => {
    await mount('&group=privacy');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    window.location.hash = '';
    fireEvent.click(within(plate).getByRole('button', { name: /在每日简报看今天的截图/ }));
    expect(window.location.hash).toBe('#/overview?tab=tm');
  });

  it('a type in the plate opens its setting row', async () => {
    await mount('&group=privacy');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    const chip = within(plate).getAllByRole('button', { name: /截图|窗口文字|网页|输入|操作/ })[0]!;
    await act(async () => fireEvent.click(chip));
    await waitFor(() => expect(document.querySelector('[data-row][class*="hl"]')).not.toBeNull());
  });
});

describe(' 说话: no gate chart', () => {
  it('the gate chart lives on the diag page, not here', async () => {
    await mount('&group=speak');
    expect(await screen.findByRole('radiogroup', { name: '主动开口' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '今日发言闸门' })).toBeNull();
    expect(document.querySelector('[data-row="gate"]')).toBeNull();
  });
});

describe(' 说话: a row under 主动 while 主动 is not chosen', () => {
  it('a deep link to 免打扰时段 lands on 会不会主动找你, the row that brings it back', async () => {
    const seen: Element[] = [];
    const prev = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    try {
      await mount('&group=speak&item=quiet_hours');
      const when = (await screen.findByRole('radiogroup', { name: '主动开口' })).closest('[data-row="speakWhen"]') as HTMLElement;
      if (document.querySelector('[data-row="quiet_hours"]')) return;
      await waitFor(() => expect(when.className).toMatch(/hl/));
      expect(seen).toContain(document.getElementById('set-speakWhen'));
    } finally {
      Element.prototype.scrollIntoView = prev;
    }
  });

  it('the dropdown-open demo opens a row select that is always there', async () => {
    await mount('&group=speak&demo=dropdown-open');
    expect(await screen.findByRole('listbox')).toBeTruthy();
  });
});

describe(' states and navigation', () => {
  it('error: a config.json group says the read failed and stays read-only; agentd groups are unaffected', async () => {
    await mount('&state=error&group=privacy');
    // Shown once above the group; disabled switches keep it as their hidden description.
    expect((await screen.findAllByText('读取设置失败，这一组暂不能修改')).filter((el) => !el.closest('[hidden]'))).toHaveLength(1);
    expect(screen.getByRole('region', { name: '外发总览' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '操作时间线' }).getAttribute('aria-disabled')).toBe('true');
    cleanup();
    await mount('&state=error&group=kernel');
    expect(await screen.findByRole('region', { name: '当前内核' })).toBeTruthy();
    expect(screen.queryByText(/读取设置失败/)).toBeNull();
  });

  it('loading: only a config.json group waits for it', async () => {
    await mount('&state=loading&group=privacy');
    await waitFor(() => expect(document.querySelector('[data-stub="Region"][data-state="loading"]')).not.toBeNull());
    expect(screen.queryByRole('region', { name: '外发总览' })).toBeNull();
    cleanup();
    await mount('&state=loading&group=kernel');
    expect(await screen.findByRole('region', { name: '当前内核' })).toBeTruthy();
  });

  it('opens on 交流, marks the open group and switches group from the tabs', async () => {
    await mount('');
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    expect(within(nav).getByRole('tab', { name: /交流/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(nav).getAllByRole('tab').map((t) => t.textContent?.replace(/[^一-龥A-Z]/g, '').slice(0, 3))).toEqual(['交流', '能力', '感知', '显示', '内核', '服务', '快捷键', '数据', '关于']);
    await act(async () => fireEvent.click(within(nav).getByRole('tab', { name: /感知/ })));
    expect(await screen.findByRole('region', { name: '外发总览' })).toBeTruthy();
  });

  it('heads each section with the shared SecHead and no second title row under the tabs; no ⓘ repeats the tab\'s line', async () => {
    await mount('&group=data');
    const sec = await screen.findByRole('region', { name: '保留' });
    const head = sec.querySelector(':scope > [data-stub="SecHead"]') as HTMLElement;
    expect(head.querySelector('h3')?.textContent).toBe('保留');
    expect(head.querySelector('[data-stub="InfoTip"]')).toBeNull();
    expect(screen.queryByRole('heading', { name: '数据' })).toBeNull();
    cleanup();
    await mount('&group=keys');
    const keys = (await screen.findByRole('region', { name: '全局快捷键' })).querySelector(':scope > [data-stub="SecHead"]') as HTMLElement;
    // SecHead `info`: the ⓘ follows the title, not the rule's right end.
    expect(keys.querySelector('h3')?.nextElementSibling?.getAttribute('data-stub')).toBe('InfoTip');
    const tips = () => [...document.querySelectorAll('[role="tooltip"]')].map((t) => t.textContent ?? '');
    for (const g of SETTING_GROUPS) expect(tips().filter((t) => t.includes(g.desc)), g.id).toEqual([]);
  });

  it('draws no › on a row whose control is a button', async () => {
    await mount('&group=data');
    await screen.findByText('清空活动记录');
    for (const id of ['delrecent', 'delact', 'delall', 'archive']) expect(document.querySelector(`[data-row="${id}"]`)?.hasAttribute('data-opens')).toBe(false);
    expect(document.querySelectorAll('[data-opens]')).toHaveLength(0);
  });
});

describe(' 快捷键', () => {
  it('lists the main-window page keys exactly as the sidebar routes', () => {
    const keyed = pageRoutes.filter((r) => /^⌘(\d|,)$/.test(r.hotkey ?? ''));
    expect(PAGE_KEYS.map(([id, title, key]) => [id, title, key])).toEqual(keyed.map((r) => [r.id, r.title, r.hotkey]));
    expect(PAGE_KEYS.map(([, , k]) => k)).toEqual(['⌘0', '⌘1', '⌘2', '⌘3', '⌘4', '⌘,']);
  });

  it('uses the current action names', async () => {
    await mount('&group=keys');
    expect(await screen.findByText('屏幕识读')).toBeTruthy();
    expect(screen.getByText('快速输入')).toBeTruthy();
    expect(document.querySelector('#set-hk_page_overview')?.textContent).toBe('⌘1每日简报');
    expect(document.querySelector('#set-hk_page_memory')?.textContent).toContain('⌘3');
  });

  it('shows which hotkey is recording and restores its button when recording is cancelled', async () => {
    const fake = createFakeBridge({ surface: 'main', still: true });
    let cancel: (value: null) => void = () => {};
    const result = new Promise<null>((resolve) => { cancel = resolve; });
    window.agenticComplex = { ...fake, capabilities: { ...fake.capabilities, hotkeys: true }, settings: { ...fake.settings, recordHotkey: () => result } };
    await mount('&group=keys');
    const first = await screen.findAllByRole('button', { name: '更改' });
    fireEvent.click(first[0]!);
    await screen.findByText('按下新快捷键，Esc 取消');
    expect(first[0]!.getAttribute('aria-busy')).toBe('true');
    expect(first[1]!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => cancel(null));
    expect(first[0]!.textContent).toContain('更改');
    expect(first[1]!.hasAttribute('aria-disabled')).toBe(false);
  });
});

describe(' wording', () => {
  it('has no replaced word anywhere on the settings page', () => {
    const dir = join(__dirname, '../../src/pages/settings');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const hits = walk(dir)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .flatMap((f) => oldWordHits(f, readFileSync(f, 'utf8')).map((h) => `${f.slice(dir.length + 1)}:${h}`));
    expect(hits).toEqual([]);
  });
});
