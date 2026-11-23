// Settings › AI: one tab for who answers, whose account and which model, under one 「AI 对话」 switch.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { runtimeView, SettingsCtx, useSettings, type RuntimeView, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { SettingsPage } from '../../src/pages/settings/Page';
import { groupOf, searchSettings } from '../../src/pages/settings/registry';
import type { WireModelSettings } from '../../src/pages/settings/wire';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

let native: Native;
let models: WireModelSettings;

function Harness({ children, runtime, init = {} }: { children: ReactNode; runtime: RuntimeView; init?: ModelInit }) {
  const model = useSettingsModel(init, { native, runtime: runtime.wire, models });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime,
    runtimeChecking: false,
    recheckRuntime: async () => runtime,
    models,
    diag: diagView(null),
    blacklist: null,
    scopes: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

const codex = () => runtimeView(WIRE_RUNTIME);
const piRuntime = () => runtimeView({ ...WIRE_RUNTIME, backend: 'pi', provider: 'anthropic', auth_source: 'api_key' } as WireRuntimePublic);
const row = (id: string) => document.querySelector(`[data-row="${id}"]`);
const click = (el: Element) => act(async () => void fireEvent.click(el));

beforeEach(async () => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
  models = (await window.agenticComplex.agentd.request<WireModelSettings>('GET', '/model/settings')).body as WireModelSettings;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('settings › AI › 用谁的账号', () => {
  it('shows only the picked kernel\'s credential section: Codex its 账号来源, Pi its provider and key', () => {
    render(
      <Harness runtime={codex()}>
        <KernelGroup />
      </Harness>,
    );
    expect(screen.getByRole('region', { name: '选择内核' })).toBeTruthy();
    const acct = screen.getByRole('region', { name: '账号 │ Codex' });
    expect(within(acct).getByRole('group', { name: '账号来源' })).toBeTruthy();
    for (const id of ['svc', 'apiBase', 'chatgpt', 'chatModel', 'think', 'mtest', 'piApproval', 'maxCost']) expect(row(id), id).toBeNull();
    expect(within(screen.getByRole('region', { name: '模型' })).getByRole('group', { name: '主会话模型' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pi 运行' })).toBeNull();
    cleanup();

    render(
      <Harness runtime={piRuntime()}>
        <KernelGroup />
      </Harness>,
    );
    const pi = screen.getByRole('region', { name: '账号 │ Pi' });
    expect(within(pi).getByRole('group', { name: '模型提供方' })).toBeTruthy();
    for (const id of ['acct', 'kernelLogin', 'mainModel']) expect(row(id), id).toBeNull();
    expect(within(screen.getByRole('region', { name: '模型' })).getByRole('group', { name: '模型' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Pi 运行' })).getByRole('group', { name: '写文件和运行命令前先问你' })).toBeTruthy();
  });

  it('follows a kernel picked but not applied yet', async () => {
    render(
      <Harness runtime={codex()}>
        <KernelGroup />
      </Harness>,
    );
    await click(screen.getByRole('radio', { name: 'Pi' }).closest('tr')!);
    expect(screen.getByRole('region', { name: '账号 │ Pi' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '账号 │ Codex' })).toBeNull();
  });
});

describe('settings › 内核 › 选择内核', () => {
  function Apply() {
    const { model } = useSettings();
    return <button onClick={() => void model.applyAll()}>应用</button>;
  }
  const puts = (request: { mock: { calls: unknown[][] } }) => request.mock.calls.filter((c) => c[0] === 'PUT' && c[1] === '/character/runtime').map((c) => c[2]);

  it('picks Codex or Claude Code that the running backend turned away for harness_bridge, and turns the plug-in on with it', async () => {
    // The default: harness_bridge off in config.json and in the running agentd, Pi with no connection.
    const off = (id: 'codex' | 'claude', title: string) => ({ id, title, available: false, reason: 'plugin_off' });
    const wire = {
      ...WIRE_RUNTIME,
      backend: 'pi',
      runtime_source: 'bundled',
      ready: false,
      error: 'pi_connection_missing',
      available_backends: [{ id: 'pi', title: 'Pi', available: true, reason: null }, off('codex', 'Codex'), off('claude', 'Claude Code')],
      installed_runtimes: [],
      selected_runtime: null,
    } as WireRuntimePublic;
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    for (const [name, backend] of [['Codex', 'codex'], ['Claude Code', 'claude']] as const) {
      render(
        <Harness runtime={runtimeView(wire)}>
          <KernelGroup />
          <Apply />
        </Harness>,
      );
      await click(screen.getByRole('radio', { name }).closest('tr')!);
      expect(save).toHaveBeenLastCalledWith({ 'plugins.harness_bridge': true });
      expect(screen.getByRole('radio', { name }).getAttribute('aria-checked'), name).toBe('true');
      await click(screen.getByRole('button', { name: '应用' }));
      expect(puts(request).at(-1), name).toMatchObject({ backend });
      cleanup();
    }
  });

  it('drops a Pi provider and 本机无需密钥 that Codex does not take when switching to it', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    // settings.py validate: Codex takes provider '' or 'openai' only, and local_no_auth only on Pi.
    for (const [wire, want] of [
      [piRuntime(), { backend: 'codex', provider: '' }],
      [runtimeView({ ...WIRE_RUNTIME, backend: 'pi', provider: 'compatible', auth_source: 'local_no_auth' } as WireRuntimePublic), { backend: 'codex', provider: '', auth_source: 'existing_login' }],
    ] as const) {
      render(
        <Harness runtime={wire}>
          <KernelGroup />
          <Apply />
        </Harness>,
      );
      await click(screen.getByRole('radio', { name: 'Codex' }).closest('tr')!);
      await click(screen.getByRole('button', { name: '应用' }));
      expect(puts(request).at(-1)).toMatchObject(want);
      cleanup();
    }
  });
});

describe('settings › AI › AI 对话', () => {
  it('writes light_ai alone for Pi and turns harness_bridge on with it for another kernel', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(
      <Harness runtime={piRuntime()}>
        <KernelGroup />
      </Harness>,
    );
    const sw = () => screen.getByRole('switch', { name: 'AI 对话' });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await click(sw());
    expect(save).toHaveBeenLastCalledWith({ 'plugins.light_ai': false });
    await click(sw());
    expect(save).toHaveBeenLastCalledWith({ 'plugins.light_ai': true });
    cleanup();
    save.mockClear();

    // The demo config has harness_bridge off: Codex cannot answer, so the switch reads off.
    render(
      <Harness runtime={codex()}>
        <KernelGroup />
      </Harness>,
    );
    expect(sw().getAttribute('aria-checked')).toBe('false');
    await click(sw());
    expect(save).toHaveBeenLastCalledWith({ 'plugins.harness_bridge': true });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await click(sw());
    expect(save).toHaveBeenLastCalledWith({ 'plugins.light_ai': false, 'plugins.harness_bridge': false });
  });
});

describe('settings › AI tab and old links', () => {
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

  it('has one 内核 tab, and group=model lands on it', async () => {
    await mount('&group=model');
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    expect(within(nav).getAllByRole('tab').map((t) => t.getAttribute('title'))).toEqual(['交流', '能力', '感知', '显示', '内核', '服务', '快捷键', '数据', '关于']);
    expect(within(nav).getByRole('tab', { name: /内核/ }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('region', { name: '选择内核' })).toBeTruthy();
  });

  it('keeps the row ids: search and 诊断 jumps land in AI or 服务', () => {
    for (const id of ['plugins.light_ai', 'plugins.harness_bridge', 'kernel', 'kcur', 'acct', 'kernelLogin', 'svc', 'apikey', 'chatModel', 'mainModel', 'piApproval']) expect(groupOf(id), id).toBe('kernel');
    for (const id of ['svc_tts', 'svc_motion', 'svc_llm', 'motionToken']) expect(groupOf(id), id).toBe('services');
    expect(searchSettings('模型提供方').map((r) => r.id)).toContain('svc');
    // The old name still finds the rows; no row or section is called that any more.
    expect(searchSettings('模型服务').map((r) => r.id)).toEqual(['svc', 'svc_llm']);
    expect(searchSettings('').concat(searchSettings('服务'), searchSettings('模型')).filter((r) => `${r.label}${r.section}`.includes('模型服务'))).toEqual([]);
    expect(searchSettings('AI 对话').map((r) => r.id)).toContain('plugins.light_ai');
  });
});
