// Settings checks; the memory, character and diag cases live with those pages.
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PERMISSIONS } from '../../src/mock/fixtures';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { routes as settingsRoutes } from '../../src/mock/settings';
import { diagView } from '../../src/pages/settings/diag';
import { SearchField, SecHead } from '../../src/ui';
import { SetNav, SetSearch } from '../../src/pages/settings/SetNav';
import { runtimeView, SettingsCtx, type RuntimeView, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { useSettingsModel } from '../../src/pages/settings/model';

const noop = () => {};

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('SearchField', () => {
  it('keeps the icon and the clear button inside one capsule', () => {
    const onChange = vi.fn();
    const { container } = render(<SearchField value="周报" label="搜索记忆" onChange={onChange} />);
    const field = container.querySelector('[data-stub="SearchField"]');
    expect(field).not.toBeNull();
    expect(field?.querySelector('[data-icon="search"]')).not.toBeNull();
    expect(field?.contains(screen.getByRole('textbox', { name: '搜索记忆' }))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('hides the clear button when empty and clears on Escape', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchField value="" label="搜索设置" onChange={onChange} />);
    expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull();
    rerender(<SearchField value="内核" label="搜索设置" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索设置' }), { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('is the settings search, apart from the group tabs', () => {
    const { container } = render(<SetSearch q="" onQ={noop} />);
    const field = container.querySelector('[data-stub="SearchField"]');
    expect(field?.contains(screen.getByRole('textbox', { name: '搜索设置' }))).toBe(true);
    cleanup();
    render(<SetNav group="kernel" searching={false} marks={{}} drafts={[]} onGroup={noop} />);
    expect(screen.getByRole('tablist', { name: '设置分组' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '搜索设置' })).toBeNull();
  });
});

describe('SecHead diag variant', () => {
  // The icon block is gone; diag heads are plain titles with a status dot.
  it('draws a status dot, no icon block', () => {
    const { container } = render(<SecHead variant="diag" title="进程" tone="ok" />);
    const head = container.querySelector('[data-stub="SecHead"]');
    expect(head?.getAttribute('data-variant')).toBe('diag');
    expect(head?.querySelector('[data-dot="ok"]')).not.toBeNull();
  });

});

async function loggedOutRuntime(): Promise<RuntimeView> {
  const r = settingsRoutes.find((x) => x.method === 'GET' && x.path === '/character/runtime');
  const res = await r!.handler({ method: 'GET', path: '/character/runtime', params: {}, query: new URLSearchParams('demo=logged-out'), body: null });
  return runtimeView(res.body as WireRuntimePublic);
}

function Harness({ children, runtime }: { children: ReactNode; runtime: RuntimeView }) {
  const model = useSettingsModel({}, { runtime: runtime.wire });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native: null,
    runtime,
    runtimeChecking: false,
    recheckRuntime: async () => runtime,
    models: null,
    diag: diagView(null),
    blacklist: null,
    scopes: null,
    runs: [],
    reload: noop,
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: noop,
    goPage: noop,
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

describe('settings kernel', () => {
  it('「改用 Pi」applies at once, like the desktop card, and shows the result', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    const runtime = await loggedOutRuntime();
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '改用 Pi' })[0]!));
    expect(request).toHaveBeenCalledWith('PUT', '/character/runtime', { backend: 'pi', runtime_source: 'bundled' });
    expect(screen.getByTestId('toast').textContent).toBe('已改用 Pi');
    expect(screen.queryByText(/未应用/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Pi/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/^未就绪/)).toBeNull();
  });

  it('names the failed re-check without reading as signed in', async () => {
    const runtime = await loggedOutRuntime();
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重新检测' })));
    expect(screen.getByTestId('toast').textContent).toBe('重新检测：Codex 仍未登录（停在「已登录」这一格）');
  });
});
