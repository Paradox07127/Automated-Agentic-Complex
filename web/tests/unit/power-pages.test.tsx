// 设置页和角色页的未接入：语音服务、后台、本机助手、桌面角色断开时，区块照常出现，顶上一块未接入状态，按钮去设置那一行或重启。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { Capabilities } from '../../src/bridge';
import { CharacterPage } from '../../src/pages/character/Page';
import { SettingsPage } from '../../src/pages/settings/Page';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
  vi.restoreAllMocks();
});

function install(caps: Partial<Capabilities> = {}) {
  const fake = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = { ...fake, capabilities: { ...fake.capabilities, ...caps } };
  return window.agenticComplex;
}

async function mount(page: string, component: RouteComponent, search: string) {
  window.location.hash = `#/${page}?still=1${search}`;
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const settings = async (search: string) => {
  await pluginsSaved();
  await mount('settings', SettingsPage, search);
};
const row = (id: string) => document.querySelector(`[data-row="${id}"]`);
const power = (el: Element | null) => el?.closest('[data-stub="PowerState"]') as HTMLElement | null;
const click = (el: Element) => act(async () => void fireEvent.click(el));

describe('设置 · 未接入', () => {
  it('puts the voice row under 未接入 while the voice service is unreachable, and leads to 服务 › 语音服务', async () => {
    install();
    await settings('&group=speak');
    await waitFor(() => expect(row('tts')?.textContent).toContain('远端不通'));
    const block = power(row('tts'));
    expect(block?.dataset.state).toBe('unlinked');
    expect(block?.dataset.mode).toBe('block');
    await click(within(block!).getByRole('button', { name: '前往配置' }));
    await waitFor(() => expect(row('svc_tts')).not.toBeNull());
  });

  it('puts the kernel group under 未接入 while the backend is gone, and restarts it from there', async () => {
    const bridge = install();
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    await settings('&group=kernel&demo=agentdoff');
    const block = await waitFor(() => {
      const b = document.querySelector('[data-group="kernel"] [data-stub="PowerState"]') as HTMLElement | null;
      expect(b).not.toBeNull();
      return b!;
    });
    expect(block.dataset.state).toBe('unlinked');
    await click(within(block).getByRole('button', { name: '重启后台服务' }));
    expect(restart).toHaveBeenCalledWith('agentd');
  });

  it('keeps a row whose helper ops are missing, under 未接入 that leads to 系统权限', async () => {
    install({ helperWindowText: false, helperPushToTalk: false });
    await settings('&group=privacy');
    await waitFor(() => expect(row('wintext')).not.toBeNull());
    const block = power(row('wintext'));
    expect(block?.dataset.state).toBe('unlinked');
    expect(power(row('web'))).toBeNull();
    await click(within(block!).getByRole('button', { name: '查看系统权限' }));
    await waitFor(() => expect(row('perms')).not.toBeNull());
  });
});

describe('角色 · 未接入', () => {
  it('draws 未接入 with 重启角色 over the stage while she is not running', async () => {
    const bridge = install();
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    await mount('character', CharacterPage, '&demo=offline&pane=motion');
    const block = await waitFor(() => {
      const b = document.querySelector('[data-preview-stage] [data-stub="PowerState"]') as HTMLElement | null;
      expect(b).not.toBeNull();
      return b!;
    });
    expect(block.dataset.state).toBe('unlinked');
    expect(block.textContent).toContain('角色进程未运行');
    await click(within(block).getByRole('button', { name: '重启角色进程' }));
    expect(restart).toHaveBeenCalledWith('avatar');
  });

  it('puts 设定 under 未接入 with 重启角色 while she is not running', async () => {
    const bridge = install();
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    await mount('character', CharacterPage, '&demo=offline&tab=render');
    const set = await screen.findByText('Diff from default');
    const block = power(set);
    expect(block?.dataset.mode).toBe('block');
    await click(within(block!).getByRole('button', { name: '重启角色进程' }));
    expect(restart).toHaveBeenCalledWith('avatar');
  });

  it('puts 导入 under 未接入 while she is not running', async () => {
    install();
    await mount('character', CharacterPage, '&demo=offline&pane=import');
    const key = await screen.findByRole('button', { name: /导入动作/ });
    expect(power(key)?.dataset.state).toBe('unlinked');
  });

  it('keeps 动作表, 编排 and 导入 without an avatar host, each under 未接入', async () => {
    install({ avatar: false });
    await mount('character', CharacterPage, '&pane=motion');
    const panel = await screen.findByRole('region', { name: '动作开关' });
    expect(power(panel.firstElementChild)?.dataset.state).toBe('unlinked');
    expect(screen.queryByText(/桌面角色没有接入/)).toBeNull();
    expect(screen.getByRole('tab', { name: /编排/ })).toBeTruthy();
    cleanup();
    await mount('character', CharacterPage, '&pane=import');
    expect(power(await screen.findByRole('button', { name: /导入动作/ }))?.dataset.state).toBe('unlinked');
  });

  it('says the backend is gone in 未接入 with 重启后台', async () => {
    const bridge = install();
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    await mount('character', CharacterPage, '&demo=disconnected');
    const block = await waitFor(() => {
      const b = document.querySelector('[data-page="character"] [data-stub="PowerState"]') as HTMLElement | null;
      expect(b).not.toBeNull();
      return b!;
    });
    expect(block.dataset.state).toBe('unlinked');
    await click(within(block).getByRole('button', { name: '重启后台服务' }));
    expect(restart).toHaveBeenCalledWith('agentd');
  });
});
