// The settings page on each shell: the Windows shell's capability bits and permission reads hide what Windows has not got
// and name no macOS; the macOS shell keeps every row and its wording.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { SettingsPage } from '../../src/pages/settings/Page';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  delete window.agenticComplex;
});

const MAC_ONLY = ['screenRecording', 'accessibility', 'inputMonitoring', 'automation'];

/** The bridge the Windows shell hands the main window: its capability bits, platform and `permissions.status` answer. */
function installWindows() {
  const fake = createFakeBridge({ surface: 'main', still: true, capabilities: { runInTerminal: false } });
  window.agenticComplex = {
    ...fake,
    platform: 'windows',
    app: { ...fake.app, info: async () => ({ ...(await fake.app.info()), os: 'Windows 10.0.26100' }) },
    permissions: { ...fake.permissions, status: async () => ({ microphone: 'granted' as const }) },
  };
}

async function mount(search: string) {
  const root = createRootRoute({ component: SettingsPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-row="${id}"]`);

describe('settings on the Windows shell', () => {
  beforeEach(installWindows);

  it('lists only the permissions the shell reads', async () => {
    await mount('&group=perm');
    await waitFor(() => expect(row('microphone')?.textContent).toContain('已允许'));
    for (const id of [...MAC_ONLY, 'notifications']) expect(row(id), id).toBeNull();
    for (const label of ['屏幕录制', '辅助功能', '输入监控', '自动化']) expect(screen.queryByText(label), label).toBeNull();
  });

  /** Each group with a text that shows once its reads are in. */
  const LOADED: Array<[group: string, id: string, text: string]> = [
    ['speak', 'sysnotify', '通知'],
    ['keys', 'hk_quick', '⌃Space'],
    ['perm', 'microphone', '已允许'],
    ['about', 'sys', 'Windows 10.0.26100'],
  ];
  it.each(LOADED)('names no macOS in %s', async (group, id, text) => {
    await mount(`&group=${group}`);
    await waitFor(() => expect(row(id)?.textContent).toContain(text));
    expect(document.body.textContent).not.toContain('macOS');
  });

  it('calls the system notification switch a Windows one and the ⌃Space clash the system\'s', async () => {
    await mount('&group=speak');
    expect(await screen.findByRole('switch', { name: '改用 Windows 通知' })).toBeTruthy();
    cleanup();
    await mount('&group=keys');
    expect(await screen.findByText('与系统「切换输入法」冲突，建议改为 ⌃⌥Space')).toBeTruthy();
  });

  it('finds no hidden permission and no macOS row in search', async () => {
    await mount('&q=系统权限');
    expect((await screen.findByRole('list', { name: /^搜索结果/ })).textContent).toContain('麦克风与语音识别');
    expect(screen.getByRole('list', { name: '搜索结果 1 项' })).toBeTruthy();
    cleanup();
    await mount('&q=通知');
    const found = await screen.findByRole('list', { name: /^搜索结果/ });
    expect(found.textContent).toContain('改用 Windows 通知');
    expect(found.textContent).not.toContain('macOS');
    cleanup();
    await mount('&q=macOS');
    expect(await screen.findByText('没有找到「macOS」')).toBeTruthy();
  });
});

describe('settings on the macOS shell', () => {
  beforeEach(() => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  });

  it('keeps every permission row and the macOS wording', async () => {
    await mount('&group=perm');
    expect(await screen.findByText('屏幕录制')).toBeTruthy();
    for (const id of [...MAC_ONLY, 'microphone', 'notifications']) expect(row(id), id).not.toBeNull();
    cleanup();
    await mount('&group=speak');
    expect(await screen.findByRole('switch', { name: '改用 macOS 通知' })).toBeTruthy();
    cleanup();
    await mount('&group=keys');
    expect(await screen.findByText('与 macOS「切换输入法」冲突，建议改为 ⌃⌥Space')).toBeTruthy();
    cleanup();
    await mount('&q=系统权限');
    expect(await screen.findByRole('list', { name: '搜索结果 6 项' })).toBeTruthy();
  });
});
