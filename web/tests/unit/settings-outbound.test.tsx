// 设置: the outbound plate, bottom apply bar, kernel table, folded launch keys, the 开 | 关 switch.
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
import { AboutGroup } from '../../src/pages/settings/groups/About';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { SeeGroup } from '../../src/pages/settings/groups/See';
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
  // A restart a test left waiting stays in localStorage.
  localStorage.clear();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
  wire = await runtimeWire();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe(' 观察: 外发总览', () => {
  const plate = () => screen.getByRole('region', { name: '外发总览' });
  // Each type sent out now is a chip that jumps to its switch; with none, one chip says 没有 or 未读到.
  const out = () => within(plate()).queryAllByRole('button').map((b) => b.textContent);

  it('is one line: the types that leave, where to and the redaction state, without a flow map, a table or 展开', () => {
    const { container } = render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    expect(plate().textContent).toMatch(/^会离开这台电脑的/);
    expect(out()).toEqual(['截图', '窗口文字（仅焦点元素）', '网页正文', '编码会话']);
    expect(plate().textContent).toContain('→ Codex │ 发出前遮蔽 开');
    expect(container.querySelector('svg[aria-label^="外发流向"]')).toBeNull();
    expect(screen.queryByRole('grid', { name: '外发' })).toBeNull();
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull();
  });

  // observation_interpret sends the collected text to the role kernel, a cloud model for Claude and Codex.
  it('lists 窗口文字 as going out when its switch, 屏幕感知 and a cloud kernel are on', () => {
    render(
      <Harness init={{ draft: { wintext: true } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out()).toContain('窗口文字（仅焦点元素）');
  });

  it('leaves a type out when its switch or the plug-in owning it is off', () => {
    render(
      <Harness init={{ draft: { wintext: false, typing: true } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out().some((t) => t?.startsWith('窗口文字'))).toBe(false);
    expect(out()).toContain('输入的文字');
    cleanup();
    pluginsOn(...PLUGINS.map((p) => p.id).filter((id) => id !== 'screen_awareness'));
    render(
      <Harness init={{ draft: { wintext: true, shot: true } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out().some((t) => t?.startsWith('窗口文字'))).toBe(false);
    expect(out()).toContain('截图');
  });

  // privacy.py saved_consent: at focused only the focused element's text leaves, at window the whole window's.
  it('names the screen context level on 窗口文字', () => {
    render(
      <Harness init={{ draft: { wintext: true, grain: 'focused' } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out()).toContain('窗口文字（仅焦点元素）');
    cleanup();
    render(
      <Harness init={{ draft: { wintext: true, grain: 'window' } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out()).toContain('窗口文字（整个窗口）');
  });

  it('leaves 窗口文字 out at the status level, where agentd sends no window text', () => {
    render(
      <Harness init={{ draft: { wintext: true, observe: true, grain: 'status' } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out().some((t) => t?.startsWith('窗口文字'))).toBe(false);
  });

  it('reads 未读到 when the kernel was not read', () => {
    render(
      <Harness noRuntime init={{ draft: { wintext: true, observe: true } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out()).toEqual([]);
    expect(plate().textContent).toContain('未读到');
  });

  it('sends nothing for Pi on a local service without a key', () => {
    render(
      <Harness init={{ draft: { wintext: true, observe: true, kernel: 'pi', acct: 'local_no_auth' } }}>
        <SeeGroup />
      </Harness>,
    );
    expect(out()).toEqual([]);
    expect(plate().textContent).toContain('没有');
  });

  it('names the role kernel as the destination', () => {
    render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    expect(plate().textContent).toContain('→ Codex');
    cleanup();
    render(
      <Harness noRuntime>
        <SeeGroup />
      </Harness>,
    );
    expect(plate().textContent).toContain('→ 角色内核');
  });

  // Boolean rows use the game's 开 | 关 switch: one control, a click flips it.
  it('uses one 开 | 关 switch for boolean settings', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    const sw = screen.getByRole('switch', { name: '键鼠计数' });
    // The shared Switch draws its two words from data-t, so they stay out of the accessible name.
    expect([...sw.querySelectorAll('[data-t]')].map((e) => e.getAttribute('data-t'))).toEqual(['开', '关']);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(sw));
    expect(save).toHaveBeenCalledWith({ keys: false });
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
  it('says how changes take effect without drafts', () => {
    render(
      <Harness>
        <ApplyBar />
      </Harness>,
    );
    const bar = screen.getByRole('region', { name: '改动怎么生效' });
    expect(bar.textContent).toBe('改动立即生效 │ 每次改动后几秒内可在提示里撤销');
    expect(within(bar).queryAllByRole('button')).toEqual([]);
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
    expect(within(bar).getByRole('button', { name: '立即重启后台' })).toBeTruthy();
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
    expect(heads).toEqual(['', '内核', '版本', '来源', '登录', '状态']);
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

describe(' 关于 › 排障', () => {
  it('shows no made-up launch values and sends the user to the config file', async () => {
    const action = vi.spyOn(window.agenticComplex!.app, 'action');
    const { container } = render(
      <Harness>
        <AboutGroup />
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
    expect(screen.getByRole('button', { name: /^会离开这台电脑的/ })).toBeTruthy();
    expect(container.textContent).not.toMatch(/整组应用|⟳后台|⟳角色|立即/);
  });
});
