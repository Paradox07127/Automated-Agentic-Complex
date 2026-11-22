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
import { daySpan } from '../../src/pages/settings/diag';
import { pageRoutes } from '../../src/shell/registry';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function mount(search: string) {
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

describe(' 隐私: 外发总览 plate', () => {
  it('opens as a panel of the way to 每日简报, one figure and one fold, so the first setting row is on the first screen', async () => {
    await mount('');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    expect(plate.textContent).toMatch(/^外发总览当前配置的传输范围在每日简报看今天的截图允许送往云端的类型 \d 项展开$/);
    expect(within(plate).getAllByRole('button')).toHaveLength(2);
    expect(within(plate).queryByRole('img')).toBeNull();
    expect(screen.getByRole('button', { name: '暂停 1 小时' })).toBeTruthy();
  });

  it('counts no screenshots of its own: its button lands on 每日简报', async () => {
    await mount('');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    window.location.hash = '';
    fireEvent.click(within(plate).getByRole('button', { name: '在每日简报看今天的截图' }));
    expect(window.location.hash).toMatch(/^#\/overview\?/);
  });

  it('draws the flow map and the route table under [展开], and no screenshot chart', async () => {
    await mount('');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    await act(async () => fireEvent.click(within(plate).getByRole('button', { name: '展开' })));
    expect(await within(plate).findByRole('img', { name: /^外发流向：/ })).toBeTruthy();
    expect(within(plate).getAllByRole('img')).toHaveLength(1);
    expect(within(plate).getByRole('grid', { name: '外发' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '附上截图' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '固定规则' })).toBeTruthy();
  });

  it('a route in the flow map opens its setting row', async () => {
    await mount('');
    const plate = await screen.findByRole('region', { name: '外发总览' });
    await act(async () => fireEvent.click(within(plate).getByRole('button', { name: '展开' })));
    const route = plate.querySelector('svg g[data-on] path');
    expect(route).not.toBeNull();
    await act(async () => fireEvent.click(route!));
    expect(document.querySelector('[data-row="shot"] [data-stub="SRow"], #set-shot')).not.toBeNull();
  });

  it('spans the day from 08:00 to 23:00 unless an event is earlier', () => {
    const now = new Date(2026, 9, 29, 14, 32).getTime();
    const h = (x: number) => new Date(2026, 9, 29, x).getTime();
    expect(daySpan([], now)).toEqual([h(8), h(23)]);
    expect(daySpan([{ t: new Date(2026, 9, 29, 6, 40).getTime() }], now)).toEqual([h(6), h(23)]);
  });
});

describe(' 说话与通知: 今日发言闸门', () => {
  it('draws the gate as a cumulative step with blocked marks and the cooldowns', async () => {
    await mount('&group=speak');
    const gate = await screen.findByRole('region', { name: '今日发言闸门' });
    expect(await within(gate).findByRole('img', { name: '今日主动发言：已用 6 次，上限 12，已拦截 3 次' })).toBeTruthy();
    expect(within(gate).getByRole('list', { name: '冷却' }).textContent).toContain('主动发言冷却 3 分');
    expect(screen.getByRole('radiogroup', { name: '她什么时候开口' })).toBeTruthy();
    expect(screen.getByText('待批准')).toBeTruthy();
  });

  it('sparse: one spoken line, nothing blocked', async () => {
    await mount('&group=speak&demo=sparse');
    const gate = await screen.findByRole('region', { name: '今日发言闸门' });
    expect(await within(gate).findByRole('img', { name: '今日主动发言：已用 1 次，上限 12' })).toBeTruthy();
  });

  it('is a developer row: absent while 开发者模式 is off', async () => {
    localStorage.setItem('ef.devMode', '0');
    try {
      await mount('&group=speak');
      expect(await screen.findByRole('radiogroup', { name: '她什么时候开口' })).toBeTruthy();
      await waitFor(() => expect(document.querySelector('[data-row="tts"]')).not.toBeNull());
      expect(screen.queryByRole('region', { name: '今日发言闸门' })).toBeNull();
      expect(document.querySelector('[data-row="gate"]')).toBeNull();
    } finally {
      localStorage.removeItem('ef.devMode');
    }
  });
});

describe(' 说话与通知: a row under 主动 while 主动 is not chosen', () => {
  it('a deep link to 主动程度 lands on 她什么时候开口, the row that brings it back', async () => {
    const seen: Element[] = [];
    const prev = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this);
    };
    try {
      await mount('&group=speak&item=proactive');
      const when = (await screen.findByRole('radiogroup', { name: '她什么时候开口' })).closest('[data-row="speakWhen"]') as HTMLElement;
      await waitFor(() => expect(when.className).toMatch(/hl/));
      expect(document.querySelector('[data-row="proactive"]')).toBeNull();
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
    await mount('&state=error');
    // Shown once above the group; disabled switches keep it as their hidden description.
    expect((await screen.findAllByText('读取设置失败，这一组暂不能修改')).filter((el) => !el.closest('[hidden]'))).toHaveLength(1);
    expect(screen.getByRole('region', { name: '外发总览' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '键鼠计数' }).getAttribute('aria-disabled')).toBe('true');
    cleanup();
    await mount('&state=error&group=kernel');
    expect(await screen.findByRole('heading', { name: '选择内核' })).toBeTruthy();
    expect(screen.queryByText(/读取设置失败/)).toBeNull();
  });

  it('loading: only a config.json group waits for it', async () => {
    await mount('&state=loading');
    await waitFor(() => expect(document.querySelector('[data-stub="Region"][data-state="loading"]')).not.toBeNull());
    expect(screen.queryByRole('region', { name: '外发总览' })).toBeNull();
    cleanup();
    await mount('&state=loading&group=kernel');
    expect(await screen.findByRole('heading', { name: '选择内核' })).toBeTruthy();
  });

  it('marks the open group and switches group from the column', async () => {
    await mount('');
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    expect(within(nav).getByRole('tab', { name: /隐私/ }).getAttribute('aria-selected')).toBe('true');
    await act(async () => fireEvent.click(within(nav).getByRole('tab', { name: /说话与通知/ })));
    expect(await screen.findByRole('heading', { name: '声音' })).toBeTruthy();
  });

  it('heads each section with a group title', async () => {
    await mount('');
    const sec = await screen.findByRole('region', { name: '读取范围' });
    expect(sec.querySelector(':scope > div > h3')?.textContent).toBe('读取范围');
    expect(sec.querySelector(':scope > [data-stub="SecHead"]')).toBeNull();
  });

  it('draws no › on a row whose control is a button', async () => {
    await mount('&group=data');
    await screen.findByText('清空活动记录…');
    for (const id of ['delrecent', 'delact', 'delall', 'archive']) expect(document.querySelector(`[data-row="${id}"]`)?.hasAttribute('data-opens')).toBe(false);
    cleanup();
    await mount('');
    await screen.findByRole('button', { name: '暂停 1 小时' });
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
    expect(screen.getByText('切换到「工业简报」')).toBeTruthy();
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
      .flatMap((f) => oldWordHits(f, readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
