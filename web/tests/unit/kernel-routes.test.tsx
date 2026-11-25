import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { runtimeView, SettingsCtx, type RuntimeView, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { ROUTES, runtimeBody } from '../../src/pages/settings/fields';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { useSettingsModel } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const AGENTS = {
  agents: [
    { id: 'claude-acp', name: 'Claude Agent', version: '0.5.0', source: 'local', command: ['/usr/local/bin/claude-agent-acp'], probe: null, native_backend: 'claude' },
    { id: 'goose', name: 'Goose', version: null, source: 'local', command: ['/usr/local/bin/goose', 'acp'], probe: null, native_backend: null },
    { id: 'gemini', name: 'Gemini CLI', version: '0.9.0', source: 'npx', command: ['npx', '@google/gemini-cli'], probe: null, native_backend: null },
  ],
  npx: true,
  uvx: false,
};

const runtime = (routes: Partial<WireRuntimePublic['routes']> = {}): RuntimeView =>
  runtimeView({
    ...WIRE_RUNTIME,
    routes: { ...WIRE_RUNTIME.routes, ...routes },
    available_backends: [...WIRE_RUNTIME.available_backends, { id: 'claude', title: 'Claude Code', available: true, reason: null }, { id: 'acp', title: 'ACP', available: true, reason: null }],
  });

let native: Native;

function Harness({ children, view }: { children: ReactNode; view: RuntimeView }) {
  const model = useSettingsModel({}, { native, runtime: view.wire });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime: view,
    runtimeChecking: false,
    recheckRuntime: async () => view,
    models: null,
    diag: diagView(null),
    blacklist: null,
    scopes: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage: () => {},
  };
  return <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>;
}

const pick = async (label: string, option: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: label })));
  await act(async () => fireEvent.click(within(screen.getByRole('listbox', { name: label })).getByRole('option', { name: option })));
};

beforeEach(async () => {
  window.agenticComplex = createFakeBridge({
    surface: 'main',
    still: true,
    routes: [
      { method: 'GET', path: '/character/acp/agents', handler: () => ({ status: 200, body: AGENTS }) },
      { method: 'PUT', path: '/character/runtime', handler: ({ body }) => ({ status: 200, body }) },
    ],
  });
  native = await demoNative(null);
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('settings › 角色内核 › 按用途指定', () => {
  it('lists every purpose on 跟随主内核 with its model and effort taken from the main kernel', async () => {
    render(
      <Harness view={runtime()}>
        <KernelGroup />
      </Harness>,
    );
    const grid = screen.getByRole('grid', { name: '按用途指定' });
    const rows = within(grid).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual(['对话', '后台任务', '主动判断', '屏幕理解', '记忆与日志', '电脑操作']);
    expect(rows).toHaveLength(ROUTES.length);
    for (const [i, r] of rows.entries()) {
      const name = r.querySelector('td')?.textContent;
      expect(within(r).getByRole('button', { name: `${name}的内核` }).textContent).toBe('跟随主内核');
      expect(within(r).queryByRole('textbox', { name: `${name}的模型` }), String(i)).toBeNull();
      expect(within(r).queryByRole('button', { name: `${name}的强度` })).toBeNull();
      expect(within(r).getAllByText('同主内核')).toHaveLength(2);
    }
    for (const gone of ['前台对话模型', '后台任务模型', '前台推理强度', '后台推理强度']) expect(screen.queryByText(gone)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '主动判断的内核' })));
    const options = within(screen.getByRole('listbox', { name: '主动判断的内核' })).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['跟随主内核', 'Codex', 'Pi', 'Claude Code', 'Goose']);
  });

  it('shows a saved route as its kernel, model and effort', () => {
    render(
      <Harness
        view={runtime({
          chat: { backend: 'codex', acp_agent: null, model: 'fast-model', effort: 'high', follows_main: false, ready: true, error: null },
          memory: { backend: 'acp', acp_agent: 'goose', model: null, effort: null, follows_main: false, ready: false, error: 'acp_auth_required' },
        })}
      >
        <KernelGroup />
      </Harness>,
    );
    expect(screen.getByRole('button', { name: '对话的内核' }).textContent).toBe('Codex');
    expect((screen.getByRole('textbox', { name: '对话的模型' }) as HTMLInputElement).value).toBe('fast-model');
    expect(screen.getByRole('button', { name: '对话的强度' }).textContent).toBe('高');
    expect(screen.getByRole('button', { name: '记忆与日志的内核' }).textContent).toBe('goose');
  });

  it('saves a picked kernel, model and effort as that purpose’s route and keeps the others', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    const chat = { backend: 'codex' as const, acp_agent: null, model: 'fast-model', effort: null };
    render(
      <Harness view={runtime({ chat: { ...chat, follows_main: false, ready: true, error: null } })}>
        <KernelGroup />
        <ApplyBar />
      </Harness>,
    );
    await act(async () => {});
    await pick('主动判断的内核', 'Claude Code');
    const input = screen.getByRole('textbox', { name: '主动判断的模型' });
    fireEvent.change(input, { target: { value: 'sonnet' } });
    await act(async () => fireEvent.blur(input));
    await pick('主动判断的强度', '高');
    await pick('记忆与日志的内核', 'Goose');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '应用' })));
    expect(request).toHaveBeenCalledWith('PUT', '/character/runtime', {
      routes: {
        chat,
        judge: { backend: 'claude', acp_agent: null, model: 'sonnet', effort: 'high' },
        memory: { backend: 'acp', acp_agent: 'goose', model: null, effort: null },
      },
    });
  });

  it('drops a route set back to 跟随主内核', () => {
    const view = runtime({ chat: { backend: 'claude', acp_agent: null, model: 'sonnet', effort: 'low', follows_main: false, ready: true, error: null } });
    expect(runtimeBody(view.wire, { route_chat: '' })).toEqual({ routes: {} });
    expect(runtimeBody(view.wire, { route_background: 'pi', route_background_effort: 'inherit' })).toEqual({
      routes: { chat: { backend: 'claude', acp_agent: null, model: 'sonnet', effort: 'low' }, background: { backend: 'pi', acp_agent: null, model: null, effort: 'inherit' } },
    });
    expect(runtimeBody(view.wire, { maxCost: 2 })).toEqual({ max_budget_usd: 2 });
  });
});
