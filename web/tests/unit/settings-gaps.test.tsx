// Settings that had no row: 简报时间 (agentd's brief hour) and 收工时间 (agentd's --ritual-report-time), each with its ⓘ and
// search entry; 恢复默认 takes 收工时间 back; the AI demos open the AI tab on Pi with a ChatGPT subscription.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { runtime } from '../../src/mock/runtime';
import { demos } from '../../src/pages/settings/demos';
import { SettingsPage } from '../../src/pages/settings/Page';
import { searchSettings } from '../../src/pages/settings/registry';
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

const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const click = (el: Element) => act(async () => void fireEvent.click(el));
const tip = (id: string) => row(id).querySelector('[role="tooltip"]')?.textContent ?? '';

describe('观察 › 每日简报 › 简报时间', () => {
  it('picks the hour agentd writes the briefs after, through POST /observation/briefs/settings', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    await mount('&group=privacy');
    const hour = await screen.findByRole('button', { name: '简报时间' });
    expect(hour.textContent).toContain('09:00');
    await click(hour);
    const list = screen.getByRole('listbox', { name: '简报时间' });
    expect(within(list).getAllByRole('option')).toHaveLength(24);
    await click(within(list).getByRole('option', { name: '21:00' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('POST', '/observation/briefs/settings', { hour: 21 }));
    await waitFor(() => expect(row('brief_daily').textContent).toContain('每天 21:00 后'));
  });

  it('has an ⓘ that says more than its line and is found by search', async () => {
    await mount('&group=privacy');
    await screen.findByRole('button', { name: '简报时间' });
    expect(tip('briefHour').length).toBeGreaterThan(20);
    expect(tip('briefHour')).not.toContain(row('briefHour').querySelector('[id$="-desc"]')?.textContent ?? '');
    expect(searchSettings('简报时间').map((r) => r.id)).toContain('briefHour');
    expect(searchSettings('几点').map((r) => r.id)).toContain('briefHour');
  });
});

describe('说话 › 主动开口 › 收工时间', () => {
  it('saves the time as a backend setting with the restart mark', async () => {
    await mount('&group=speak');
    const time = await screen.findByRole('button', { name: '收工时间' });
    expect(time.textContent).toContain('17:30');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    await click(time);
    await click(within(screen.getByRole('listbox', { name: '收工时间' })).getByRole('option', { name: '19:00' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ reportTime: '19:00' }));
    await waitFor(() => expect(row('reportTime').textContent).toContain('重启后台后生效'));
  });

  it('has an ⓘ and is found by search', async () => {
    await mount('&group=speak');
    await screen.findByRole('button', { name: '收工时间' });
    expect(tip('reportTime').length).toBeGreaterThan(20);
    expect(searchSettings('下班').map((r) => r.id)).toContain('reportTime');
    expect(searchSettings('收工').map((r) => r.id)).toContain('reportTime');
  });

  it('goes back to 17:30 with 恢复默认设置', async () => {
    await mount('&group=speak');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    await click(await screen.findByRole('button', { name: '收工时间' }));
    await click(within(screen.getByRole('listbox', { name: '收工时间' })).getByRole('option', { name: '19:00' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ reportTime: '19:00' }));
    cleanup();
    await mount('&group=data');
    await click(await screen.findByRole('button', { name: /恢复默认…/ }));
    await click(await screen.findByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ reportTime: '17:30' })));
  });
});

describe('服务 › 网络 › 代理', () => {
  it('saves an http(s) proxy on blur as a backend setting, and names what is wrong with another form instead', async () => {
    await mount('&group=services');
    const field = await screen.findByRole('textbox', { name: '代理' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    fireEvent.change(field, { target: { value: 'socks5://127.0.0.1:1080' } });
    await act(async () => void fireEvent.blur(field));
    expect(save).not.toHaveBeenCalled();
    expect(row('proxy').textContent).toContain('要以 http:// 或 https:// 开头');
    fireEvent.change(field, { target: { value: ' http://127.0.0.1:7890 ' } });
    await act(async () => void fireEvent.blur(field));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ proxy: 'http://127.0.0.1:7890' }));
    await waitFor(() => expect(row('proxy').textContent).toContain('重启后台后生效'));
    expect(row('proxy').textContent).not.toContain('要以 http://');
  });

  it('has an ⓘ, is found by search, and 恢复默认 leaves it', async () => {
    await mount('&group=services');
    await screen.findByRole('textbox', { name: '代理' });
    expect(tip('proxy').length).toBeGreaterThan(20);
    expect(searchSettings('代理').map((r) => r.id)).toContain('proxy');
    expect(searchSettings('proxy').map((r) => r.id)).toContain('proxy');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const field = screen.getByRole('textbox', { name: '代理' });
    fireEvent.change(field, { target: { value: 'http://127.0.0.1:7890' } });
    await act(async () => void fireEvent.blur(field));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ proxy: 'http://127.0.0.1:7890' }));
    cleanup();
    await mount('&group=data');
    await click(await screen.findByRole('button', { name: /恢复默认…/ }));
    await click(await screen.findByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1));
    for (const [changes] of save.mock.calls.slice(1)) expect(Object.keys(changes)).not.toContain('proxy');
  });
});

describe('AI demos', () => {
  it('open the AI tab, and demo=chatgpt runs Pi so the ChatGPT rows show', () => {
    expect(demos.filter((d) => d.params.group === 'model')).toEqual([]);
    for (const name of ['model', 'model-chatgpt', 'model-chatgpt-light']) expect(demos.find((d) => d.name === name)?.params.group, name).toBe('kernel');
    expect(runtime('chatgpt').backend).toBe('pi');
    expect(runtime('pi').backend).toBe('pi');
  });
});
