// A feature whose plug-in is off is not offered, and agentd's 409 plugin_off for it is no edit conflict and shows nothing.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { AgentdCallError } from '../../src/bridge/agentd';
import { PLUGINS, type PluginId } from '../../src/bridge/plugins.generated';
import { isConflict } from '../../src/pages/overview/errors';
import { OverviewPage } from '../../src/pages/overview/Page';
import { SchedulesPage } from '../../src/pages/schedules/Page';
import { failMessage } from '../../src/pages/tasks/actions';
import { getPlugins } from '../../src/shell/plugins';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  pluginsReset();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  localStorage.clear();
});

const pluginOff = () => new AgentdCallError(409, 'plugin_off', undefined, { error: 'plugin_off', plugin: 'coding_sessions' }, 'plugin_off');

/** As agentd through the shell: a route answers 409 plugin_off unless one of its plug-ins runs; `running` defaults to the page's switches. */
function asAgentd(running?: readonly PluginId[]) {
  const bridge = getBridge();
  const real = bridge.agentd.request.bind(bridge.agentd);
  const paths: string[] = [];
  vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
    const p = path.split('?')[0]!;
    paths.push(p);
    const owners = PLUGINS.filter((x) => (x.agentd.routes as readonly string[]).some((r) => p === r || p.startsWith(`${r}/`)));
    const on = (id: PluginId) => (running ? running.includes(id) || id === 'light_ai' : getPlugins()[id]);
    if (owners.length > 0 && !owners.some((x) => on(x.id))) return { status: 409, body: { error: 'plugin_off', plugin: owners[0]!.id }, error: { code: 'plugin_off' } } as never;
    return (await real(method, path, body)) as never;
  });
  return paths;
}

function mount(Page: ComponentType, search = '') {
  const root = createRootRoute({
    component: () => (
      <>
        <Page />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The reads a page starts on mount have answered. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 300)));

describe('409 plugin_off', () => {
  it('is no edit conflict: a write that gets it says nothing', () => {
    expect(failMessage(pluginOff())).toBeNull();
    expect(isConflict(pluginOff())).toBe(false);
    expect(failMessage(new AgentdCallError(409, 'stale_revision', undefined, null, ''))).toBe('已在别处更新');
  });
});

describe('工业简报 with 编码会话 off', () => {
  it('keeps 进行中 for 个人代理 with nothing about coding sessions and no 已在别处更新', async () => {
    pluginsOn('daily_brief', 'personal_agent');
    asAgentd();
    mount(OverviewPage);
    const run = await screen.findByRole('region', { name: '进行中' }, { timeout: 3000 });
    await settle();
    expect(within(run).queryByRole('alert')).toBeNull();
    expect(within(run).queryByText(/编码/)).toBeNull();
    expect(document.body.textContent).not.toContain('已在别处更新');
    expect(within(run).getByRole('button', { name: /^定时任务/ })).toBeTruthy();
  });

  it('drops 进行中, 定时任务 and their reads with 个人代理 off too, and the action band offers neither 派发任务 nor 屏幕识读', async () => {
    pluginsOn('daily_brief');
    const paths = asAgentd();
    mount(OverviewPage);
    await screen.findByRole('region', { name: '待处理' }, { timeout: 3000 });
    await settle();
    expect(screen.queryByRole('region', { name: '进行中' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^定时任务/ })).toBeNull();
    expect(paths).not.toContain('/schedules');
    const band = screen.getByRole('toolbar', { name: '常用操作' });
    expect(within(band).getAllByRole('button').map((b) => b.textContent?.replace(/[⌃⌥⌘].*$/, ''))).toEqual(['快速输入', '命令面板']);
    expect(document.body.textContent).not.toContain('已在别处更新');
  });

  it('offers 派发任务 and 屏幕识读 in the action band once 个人代理 and 屏幕识读 are on', async () => {
    pluginsOn('daily_brief', 'personal_agent', 'screen_reading');
    asAgentd();
    mount(OverviewPage);
    const band = await screen.findByRole('toolbar', { name: '常用操作' });
    expect(within(band).getAllByRole('button').map((b) => b.textContent?.replace(/[⌃⌥⌘].*$/, ''))).toEqual(['派发任务', '快速输入', '屏幕识读', '命令面板']);
  });

  it('shows no error in 进行中 while agentd still has 编码会话 and 个人代理 off after they were switched on', async () => {
    pluginsOn('daily_brief', 'personal_agent', 'coding_sessions');
    const paths = asAgentd(['daily_brief']);
    mount(OverviewPage);
    const run = await screen.findByRole('region', { name: '进行中' }, { timeout: 3000 });
    await settle();
    expect(paths).toContain('/sessions');
    expect(within(run).queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('已在别处更新');
  });
});

describe('定时任务 while agentd still has 个人代理 off', () => {
  it('shows no list, no error and nothing to create', async () => {
    pluginsOn('personal_agent');
    asAgentd([]);
    mount(SchedulesPage);
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('已在别处更新');
    expect(screen.queryByRole('button', { name: '新建定时任务' })).toBeNull();
    expect(screen.queryByRole('list', { name: '定时任务列表' })).toBeNull();
  });
});
