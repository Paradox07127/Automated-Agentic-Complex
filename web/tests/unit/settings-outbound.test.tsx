// 设置: outbound matrix, bottom apply bar, kernel table, folded launch keys, Switch.
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PLUGINS } from '../../src/bridge/plugins.generated';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative, routes } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { runtimeView, SettingsCtx, type RuntimeView, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { AdvGroup } from '../../src/pages/settings/groups/Adv';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { PrivacyGroup } from '../../src/pages/settings/groups/Privacy';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import { searchSettings } from '../../src/pages/settings/registry';
import { SearchResults } from '../../src/pages/settings/SearchResults';
import { SetSection } from '../../src/pages/settings/SetSection';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

async function mockGet<T>(path: string): Promise<T> {
  const r = routes.find((x) => x.method === 'GET' && x.path === path);
  const res = await r!.handler({ method: 'GET', path, params: {}, query: new URLSearchParams(), body: null });
  return res.body as T;
}
const runtimeWire = () => mockGet<WireRuntimePublic>('/character/runtime');
const runtimeSnap = async (): Promise<RuntimeView> => runtimeView(await runtimeWire());

let native: Native;
let wire: WireRuntimePublic;
const DIAG = diagView(null);

function Harness({ children, init = {}, runtime = null, agentdOff = false, noRuntime = false }: { children: ReactNode; init?: ModelInit; runtime?: RuntimeView | null; agentdOff?: boolean; noRuntime?: boolean }) {
  const model = useSettingsModel(init, { native, runtime: noRuntime ? null : (runtime?.wire ?? wire) });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime,
    runtimeChecking: false,
    recheckRuntime: async () => runtime,
    models: null,
    diag: DIAG,
    blacklist: null,
    scopes: null,
    runs: [],
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

beforeEach(async () => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
  wire = await runtimeWire();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe(' 隐私: outbound matrix', () => {
  // The plate opens folded to one readout line; [展开] shows the charts and the table.
  const unfold = () => fireEvent.click(screen.getByRole('button', { name: '展开' }));

  it('opens folded to the readout line', () => {
    const { container } = render(
      <Harness>
        <PrivacyGroup />
      </Harness>,
    );
    const plate = screen.getByRole('region', { name: '外发总览' });
    expect(plate.textContent).toMatch(/允许送往云端的类型 [\d—] 项/);
    expect(container.querySelector('svg[aria-label^="外发流向"]')).toBeNull();
    expect(screen.getByRole('button', { name: '展开' }).getAttribute('aria-expanded')).toBe('false');
  });

  // The flow map is back as the plate's main chart; the table stays as 外发明细 under it.
  it('shows the flow map with the data type × destination table as its detail', () => {
    const { container } = render(
      <Harness>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(container.querySelector('svg[aria-label^="外发流向"]')).not.toBeNull();
    const grid = screen.getByRole('grid', { name: '外发' });
    const heads = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual(['数据类型', '本机', '云端']);
    const row = within(grid).getByRole('row', { name: /窗口文字/ });
    expect(Array.from(row.querySelectorAll('td'), (c) => c.textContent)).toEqual(['窗口文字 │ 仅焦点元素', '开', '开']);
    const web = within(grid).getByRole('row', { name: /网页正文/ });
    expect(Array.from(web.querySelectorAll('td'), (c) => c.textContent)).toEqual(['网页正文', '开', '开']);
  });

  // observation_interpret sends the collected text to the role kernel, a cloud model for Claude and Codex.
  const cloudCell = (name: RegExp) => within(screen.getByRole('grid', { name: '外发' })).getByRole('row', { name }).querySelectorAll('td')[2]?.textContent;

  it('marks 窗口文字 as going to the cloud when its switch, 屏幕感知 and a cloud kernel are on', () => {
    render(
      <Harness init={{ draft: { wintext: true } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(cloudCell(/窗口文字/)).toBe('开');
  });

  it('marks the cloud route off when the type switch or the plug-in owning it is off', () => {
    render(
      <Harness init={{ draft: { wintext: false, typing: true } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(cloudCell(/窗口文字/)).toBe('关');
    expect(cloudCell(/输入的文字/)).toBe('开');
    cleanup();
    pluginsOn(...PLUGINS.map((p) => p.id).filter((id) => id !== 'screen_awareness'));
    render(
      <Harness init={{ draft: { wintext: true, shot: true } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(cloudCell(/窗口文字/)).toBe('关');
    expect(cloudCell(/截图/)).toBe('开');
  });

  // privacy.py saved_consent: at focused only the focused element's text leaves, at window the whole window's.
  it('names the screen context level on the 窗口文字 row', () => {
    const typeCell = () => within(screen.getByRole('grid', { name: '外发' })).getByRole('row', { name: /窗口文字/ }).querySelectorAll('td')[0]?.textContent;
    render(
      <Harness init={{ draft: { wintext: true, grain: 'focused' } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(typeCell()).toBe('窗口文字 │ 仅焦点元素');
    cleanup();
    render(
      <Harness init={{ draft: { wintext: true, grain: 'window' } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(typeCell()).toBe('窗口文字 │ 整个窗口');
  });

  it('turns the 窗口文字 routes off at the status level, where agentd sends no window text', () => {
    render(
      <Harness init={{ draft: { wintext: true, observe: true, grain: 'status' } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    const row = within(screen.getByRole('grid', { name: '外发' })).getByRole('row', { name: /窗口文字/ });
    expect(Array.from(row.querySelectorAll('td'), (c) => c.textContent)).toEqual(['窗口文字 │ 仅读状态', '关', '关']);
  });

  it('marks the cloud route unread when the kernel was not read', () => {
    render(
      <Harness noRuntime init={{ draft: { wintext: true, observe: true } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(cloudCell(/窗口文字/)).toBe('未读到');
  });

  it('marks the cloud route off for Pi on a local service without a key', () => {
    render(
      <Harness init={{ draft: { wintext: true, observe: true, kernel: 'pi', acct: 'local_no_auth' } }}>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(cloudCell(/窗口文字/)).toBe('关');
  });

  it('names the role kernel under the cloud destination', () => {
    const svg = () => document.querySelector('svg[aria-label^="外发流向"]')!.textContent;
    render(
      <Harness>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(svg()).toContain('Codex');
    cleanup();
    render(
      <Harness noRuntime>
        <PrivacyGroup />
      </Harness>,
    );
    unfold();
    expect(svg()).toContain('角色内核');
  });

  // Boolean rows use the small 44×22 Toggle, not the wide segmented 「开 | 关」.
  it('uses the small Toggle for boolean settings', () => {
    render(
      <Harness>
        <PrivacyGroup />
      </Harness>,
    );
    const sw = screen.getByRole('switch', { name: '键鼠计数' });
    expect(sw.getAttribute('data-stub')).toBe('Toggle');
    expect(sw.getAttribute('data-size')).toBe('sm');
  });
});

describe(' section heads', () => {
  it('are plain neutral titles without the ornament', () => {
    const { container } = render(
      <Harness>
        <SetSection title="观察">x</SetSection>
      </Harness>,
    );
    expect(screen.getByRole('heading', { name: '观察' })).toBeTruthy();
    expect(container.textContent).toBe('观察x');
  });
});

describe(' bottom apply bar', () => {
  it('is absent without drafts', () => {
    const { container } = render(
      <Harness>
        <ApplyBar />
      </Harness>,
    );
    expect(container.textContent).toBe('');
  });

  it('counts drafts and reverts them', async () => {
    render(
      <Harness init={{ draft: { maxCost: 2, kernel: 'pi' } }}>
        <ApplyBar />
      </Harness>,
    );
    const bar = screen.getByRole('region', { name: '未应用的改动' });
    expect(bar.textContent).toContain('未应用 2 项');
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: '撤销' })));
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
  });

  it('applies every draft in one agentd write', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    render(
      <Harness init={{ draft: { maxCost: 2, kernel: 'pi' } }}>
        <ApplyBar />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '应用' })));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('PUT', '/character/runtime', expect.objectContaining({ max_budget_usd: 2, backend: 'pi' }));
    expect(screen.getByTestId('toast').textContent).toBe('已应用 2 项');
  });

  it('cannot apply while the backend is off, even from a group that stays writable', () => {
    render(
      <Harness init={{ draft: { maxCost: 2 } }} agentdOff>
        <ApplyBar />
      </Harness>,
    );
    expect(screen.getByRole('button', { name: '应用' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('offers a backend restart for saved changes that wait for it', () => {
    render(
      <Harness init={{ pending: ['web'] }}>
        <ApplyBar />
      </Harness>,
    );
    const bar = screen.getByRole('region', { name: '未应用的改动' });
    expect(bar.textContent).toContain('1 项重启后台服务后生效');
    expect(within(bar).getByRole('button', { name: '立即重启' })).toBeTruthy();
  });
});

describe(' 角色内核', () => {
  it('picks the kernel in a single-select table', async () => {
    const runtime = await runtimeSnap();
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    const grid = screen.getByRole('grid', { name: '内核' });
    const heads = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual(['', '名称', '版本', '来源', '登录', '状态']);
    expect(within(grid).getAllByRole('radio').length).toBe(runtime.runtimes.length);
  });

  it('shows the recovery chain for a picked kernel that is not ready', async () => {
    const snap = await runtimeSnap();
    const runtime = { ...snap, runtimes: snap.runtimes.map((r) => (r.id === 'pi' ? { ...r, available: false, reason: 'runtime_missing' } : r)) };
    const { container } = render(
      <Harness runtime={runtime} init={{ draft: { kernel: 'pi' } }}>
        <KernelGroup />
      </Harness>,
    );
    const chains = Array.from(container.querySelectorAll('[data-stub="KernelChain"]'), (c) => c.getAttribute('aria-label'));
    expect(chains).toEqual(['Pi 就绪链']);
  });

  it('has no backend issue numbers on screen', async () => {
    const runtime = await runtimeSnap();
    const { container } = render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    expect(container.textContent).not.toMatch(/需新增|#\d|SET-3|max_budget_usd|workspace_dir/);
  });
});

describe(' 高级', () => {
  it('shows no made-up launch values and sends the user to the config file', async () => {
    const action = vi.spyOn(window.agenticComplex!.app, 'action');
    const { container } = render(
      <Harness>
        <AdvGroup />
      </Harness>,
    );
    expect(container.textContent).not.toMatch(/tts_url|agentd_port|8787/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '打开配置文件' })));
    expect(action).toHaveBeenCalledWith('open_config');
  });
});

describe(' 搜索', () => {
  it('lists results without effect tags; only data deletion is marked', () => {
    const { container } = render(<SearchResults q="外发" results={searchSettings('外发')} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: /^外发总览/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/整组应用|⟳后台|⟳角色|立即/);
  });
});
