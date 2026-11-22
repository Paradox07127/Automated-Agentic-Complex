import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { Capabilities } from '../../src/bridge/protocol';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { demoNative, routes } from '../../src/mock/settings';
import { runtimeView, SettingsCtx, useSettings, type RuntimeView, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { AboutGroup } from '../../src/pages/settings/groups/About';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { KeysGroup } from '../../src/pages/settings/groups/Keys';
import { ActGroup } from '../../src/pages/settings/groups/Act';
import { SeeGroup } from '../../src/pages/settings/groups/See';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel } from '../../src/pages/settings/model';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

function install(caps: Partial<Capabilities> = {}) {
  const bridge = createFakeBridge({ surface: 'main', still: true, capabilities: caps });
  window.agenticComplex = bridge;
  return bridge;
}

async function loggedOutRuntime(): Promise<RuntimeView> {
  const r = routes.find((x) => x.method === 'GET' && x.path === '/character/runtime');
  const res = await r!.handler({ method: 'GET', path: '/character/runtime', params: {}, query: new URLSearchParams('demo=logged-out'), body: null });
  return runtimeView(res.body as WireRuntimePublic);
}

let native: Native;
const DIAG = diagView(null);

/** The signed-out kernel's login command, set to a short one or to none (agentd sends null for a bundled runtime). */
const withLogin = (r: RuntimeView, cmd: string | null = 'codex login'): RuntimeView => ({ ...r, runtimes: r.runtimes.map((x) => (x.id === r.selected ? { ...x, login_command: cmd } : x)) });

function Harness({ children, runtime = null }: { children: ReactNode; runtime?: RuntimeView | null }) {
  const model = useSettingsModel({}, { native, runtime: runtime?.wire ?? null });
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
    models: null,
    diag: DIAG,
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
      {model.confirm && (
        <div role="dialog" aria-label={model.confirm.title}>
          <button onClick={() => void model.confirm?.onConfirm()}>{model.confirm.confirmLabel}</button>
        </div>
      )}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

beforeEach(async () => {
  install();
  native = await demoNative(null);
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('settings › 隐私', () => {
  it('renders coding-session consent on by default and saves its native setting after confirming deletion', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const consent = vi.spyOn(window.agenticComplex!.settings, 'confirmDestructive');
    render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    const toggle = screen.getByRole('switch', { name: '读会话里的工具输入输出' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(native.rows.agent_sessions).toMatchObject({ default: true, restart: 'backend', destructive: true });
    await act(async () => fireEvent.click(toggle));
    expect(screen.getByRole('dialog', { name: '关闭「读会话里的工具输入输出」并删除已收集的内容？' })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '关闭并删除' })));
    expect(consent).toHaveBeenCalledWith('agent_sessions');
    expect(save).toHaveBeenCalledWith({ agent_sessions: false });
    expect((await window.agenticComplex!.settings.read()).saved.agent_sessions).toBe(false);
  });

  it('asks before switching off「窗口文字」and deleting what it collected', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '窗口文字' })));
    expect(screen.getByRole('dialog', { name: '关闭「窗口文字」并删除已收集的内容？' }).textContent).toBe('关闭并删除');
    expect(save).not.toHaveBeenCalled();
  });

  it('writes a non-deleting switch at once', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(
      <Harness>
        <SeeGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '键鼠计数' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).toHaveBeenCalledWith({ keys: false });
  });
});

describe('settings › 声音 › 通知方式', () => {
  it('routes 提醒 like 完成: 出声 / 只出卡 / 不提示, saved under n_remind', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const row = screen.getByRole('radiogroup', { name: '提醒' });
    const companion = screen.getByRole('radiogroup', { name: '她会不会主动找你' }).closest('[data-row="speakWhen"]');
    expect(companion?.textContent).toContain('任务结果和你设的提醒照常送达');
    expect(within(row).getAllByRole('radio').map((r) => r.textContent)).toEqual(['出声', '只出卡', '不提示']);
    await act(async () => fireEvent.click(within(row).getByRole('radio', { name: '只出卡' })));
    expect(save).toHaveBeenCalledWith({ n_remind: 'card' });
  });
});

describe('settings › 快捷键', () => {
  it('lists 读取选中文字 at ⌃⌥S, checks a new combo, and 清除 saves "" under hk_sel', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'recordHotkey').mockResolvedValue('⌃⌥J');
    const check = vi.spyOn(window.agenticComplex!.settings, 'validateHotkey');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const { container } = render(
      <Harness>
        <KeysGroup />
      </Harness>,
    );
    const row = container.querySelector('[data-row="hk_sel"]') as HTMLElement;
    expect(row.textContent).toContain('读取选中文字');
    expect(row.textContent).toContain('⌃⌥S');
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: '更改' })));
    expect(check).toHaveBeenCalledWith('hk_sel', '⌃⌥J');
    expect(save).toHaveBeenLastCalledWith({ hk_sel: '⌃⌥J' });
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: '清除' })));
    expect(save).toHaveBeenLastCalledWith({ hk_sel: '' });
  });
});

describe('settings › 能做 › 系统权限', () => {
  // The section is one summary line until 去开 unfolds a row per permission.
  const unfold = () => act(async () => fireEvent.click(within(document.querySelector('[data-row="perms"]') as HTMLElement).getByRole('button', { name: '去开' })));

  it('opens system settings through the bridge and offers a re-check', async () => {
    const request = vi.spyOn(window.agenticComplex!.permissions, 'openSettings');
    render(
      <Harness>
        <ActGroup />
      </Harness>,
    );
    await unfold();
    const open = screen.getByRole('button', { name: '去系统设置' });
    await act(async () => fireEvent.click(open));
    expect(request).toHaveBeenCalledWith('automation');
    expect(screen.getByTestId('toast').textContent).toContain('自动化');
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy();
  });

  it('disables「去系统设置」when the shell cannot open system settings', async () => {
    install({ systemSettings: false });
    render(
      <Harness>
        <ActGroup />
      </Harness>,
    );
    await unfold();
    expect(screen.getByRole('button', { name: '去系统设置' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('settings › 启动与关于', () => {
  it('gives 登录时启动 the switch only, also when the shell reports the login item did not take', () => {
    native = { ...native, statuses: { ...native.statuses, login: '系统没有允许登录项' } };
    const { container } = render(
      <Harness>
        <AboutGroup />
      </Harness>,
    );
    const row = container.querySelector('[data-row="login"]') as HTMLElement;
    expect(within(row).getByRole('switch', { name: '开机登录后启动' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '去系统设置' })).toBeNull();
  });

  it('asks before 重新运行首次设置 opens the setup window', async () => {
    const action = vi.spyOn(window.agenticComplex!.app, 'action');
    const { container } = render(
      <Harness>
        <AboutGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(within(container.querySelector('[data-row="onb"]') as HTMLElement).getByRole('button', { name: '开始' })));
    expect(action).not.toHaveBeenCalledWith('open_onboarding');
    const dialog = screen.getByRole('dialog', { name: '重新运行首次设置？' });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: '开始' })));
    expect(action).toHaveBeenCalledWith('open_onboarding');
  });
});

describe('settings › 角色内核', () => {
  it('shows no login command when agentd names none', async () => {
    render(
      <Harness runtime={withLogin(await loggedOutRuntime(), null)}>
        <KernelGroup />
      </Harness>,
    );
    expect(screen.queryByRole('button', { name: '在终端运行' })).toBeNull();
    expect(screen.queryByText('codex login')).toBeNull();
  });

  it('runs the login command in a terminal when the shell can', async () => {
    const run = vi.spyOn(window.agenticComplex!.open, 'runInTerminal');
    const runtime = withLogin(await loggedOutRuntime());
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '在终端运行' })[0]!));
    expect(run).toHaveBeenCalledWith('codex login');
  });

  it('shows the login command with copy and run-in-terminal, and falls back to copying', async () => {
    install({ runInTerminal: false });
    const write = vi.spyOn(window.agenticComplex!.clipboard, 'writeText');
    const runtime = withLogin(await loggedOutRuntime());
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
      </Harness>,
    );
    expect(screen.getAllByText('codex login').length).toBeGreaterThan(0);
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '在终端运行' })[0]!));
    expect(write).toHaveBeenCalledWith('codex login');
    expect(screen.getAllByRole('button', { name: '改用 Pi' }).length).toBeGreaterThan(0);
  });

  it('leaves the executable to auto-detect for a newly picked kernel and keeps the saved one for its own', async () => {
    const codex = WIRE_RUNTIME.selected_runtime!;
    const claude = { ...codex, backend: 'claude' as const, path: '/opt/homebrew/bin/claude', login_command: null };
    const runtime = runtimeView({
      ...WIRE_RUNTIME,
      executable: '/opt/homebrew/bin/codex',
      available_backends: [...WIRE_RUNTIME.available_backends, { id: 'claude', title: 'Claude Code', available: true, reason: null }],
      installed_runtimes: [codex, claude],
    });
    vi.spyOn(window.agenticComplex!.files, 'pickFile').mockResolvedValue({ handle: 'h1', displayName: '/usr/local/bin/codex' });
    function Draft() {
      return <output data-testid="draft">{JSON.stringify(useSettings().model.draft)}</output>;
    }
    render(
      <Harness runtime={runtime}>
        <KernelGroup />
        <Draft />
      </Harness>,
    );
    const exe = () => screen.getByText('可执行文件').closest('[data-row]')!.querySelector('code')!.textContent;
    const draft = () => JSON.parse(screen.getByTestId('draft').textContent ?? '{}') as Record<string, unknown>;
    const row = (name: string) => screen.getByRole('radio', { name }).closest('tr')!;
    expect(exe()).toBe('/opt/homebrew/bin/codex');
    // 工作区 has its own 选择… under the band too.
    await act(async () => fireEvent.click(within(screen.getByText('可执行文件').closest('[data-row]') as HTMLElement).getByRole('button', { name: '选择…' })));
    expect(draft()).toEqual({ exe: '/usr/local/bin/codex' });
    await act(async () => fireEvent.click(row('Claude Code')));
    expect(draft()).toEqual({ kernel: 'claude' });
    expect(exe()).toBe('自动检测');
    await act(async () => fireEvent.click(row('Codex')));
    expect(draft()).toEqual({});
    expect(exe()).toBe('/opt/homebrew/bin/codex');
  });
});

describe('settings › 角色内核 › ACP', () => {
  const AGENTS = {
    agents: [
      { id: 'gemini', name: 'Gemini CLI', version: '0.9.0', source: 'npx', command: ['npx', '@google/gemini-cli'], probe: null, native_backend: null },
      { id: 'claude-acp', name: 'Claude Agent', version: '0.5.0', source: 'local', command: ['/usr/local/bin/claude-agent-acp'],
        probe: { ok: true, agent_info: { name: 'claude-agent-acp', version: '0.5.0' }, auth_methods: [], error: null }, native_backend: 'claude' },
      { id: 'fast-agent', name: 'fast-agent', version: '0.3.0', source: 'uvx', command: ['uvx', 'fast-agent-acp'], probe: null, native_backend: null },
      { id: 'goose', name: 'Goose', version: null, source: 'local', command: ['/usr/local/bin/goose', 'acp'],
        probe: { ok: false, agent_info: null, auth_methods: [{ id: 'oauth', name: 'Sign in with Block' }], error: 'auth_required' }, native_backend: null },
    ],
    npx: false,
    uvx: true,
  };
  let refresh: Array<string | null> = [];
  const acp = (extra: Partial<WireRuntimePublic> = {}) =>
    runtimeView({
      ...WIRE_RUNTIME,
      backend: 'acp',
      acp_agent: null,
      acp_launcher: 'local',
      ready: true,
      selected_runtime: null,
      available_backends: [...WIRE_RUNTIME.available_backends, { id: 'acp', title: 'ACP', available: true, reason: null }],
      ...extra,
    });
  function Draft() {
    return <output data-testid="draft">{JSON.stringify(useSettings().model.draft)}</output>;
  }
  const draft = () => JSON.parse(screen.getByTestId('draft').textContent ?? '{}') as Record<string, unknown>;

  beforeEach(() => {
    refresh = [];
    window.agenticComplex = createFakeBridge({
      surface: 'main',
      still: true,
      routes: [{ method: 'GET', path: '/character/acp/agents', handler: ({ query }) => (refresh.push(query.get('refresh')), { status: 200, body: AGENTS }) }],
    });
  });

  it('lists local agents first, keeps npx rows unpickable without npx, and drafts the picked agent and launcher', async () => {
    render(
      <Harness runtime={acp()}>
        <KernelGroup />
        <Draft />
      </Harness>,
    );
    const grid = await screen.findByRole('grid', { name: 'ACP 智能体' });
    const rows = within(grid).getAllByRole('row').slice(1);
    const names = (rs: HTMLElement[]) => rs.map((r) => r.querySelector('td:nth-child(2)')?.textContent);
    expect(names(rows)).toEqual(['Claude Agent', 'Goose']);
    expect(rows[1]!.textContent).toContain('Sign in with Block');
    expect(screen.queryByRole('grid', { name: '更多（需下载）' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '更多（需下载）' })));
    const more = within(screen.getByRole('grid', { name: '更多（需下载）' })).getAllByRole('row').slice(1);
    expect(names(more)).toEqual(['Gemini CLI', 'fast-agent']);
    expect(within(more[0]!).getByRole('button', { name: '下载并运行' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(more[0]!));
    expect(draft()).toEqual({});
    await act(async () => fireEvent.click(within(more[1]!).getByRole('button', { name: '下载并运行' })));
    expect(draft()).toEqual({ acpAgent: 'fast-agent', acpLauncher: 'uvx' });
    await act(async () => fireEvent.click(rows[1]!));
    expect(draft()).toEqual({ acpAgent: 'goose' });
    expect(screen.queryByRole('radiogroup', { name: 'ACP 权限' })).toBeNull();
    for (const row of ['账号来源', '服务提供方', '运行来源', '可执行文件']) expect(screen.queryByText(row)).toBeNull();
    const kernelRow = screen.getByRole('radio', { name: 'ACP' }).closest('tr')!;
    expect(kernelRow.textContent).toContain('已就绪');
  });

  it('offers the native kernel instead of the Claude bridge, and installs an npx agent', async () => {
    const installs: unknown[] = [];
    window.agenticComplex = createFakeBridge({
      surface: 'main',
      still: true,
      routes: [
        { method: 'GET', path: '/character/acp/agents', handler: () => ({ status: 200, body: AGENTS }) },
        {
          method: 'POST',
          path: '/character/acp/install',
          handler: ({ body }) => (installs.push(body), { status: 200, body: { ok: true, agent_id: 'gemini', command: ['/opt/homebrew/bin/npm', 'install', '-g', '@google/gemini-cli@0.9.0'], exit: 0, output_tail: 'added 1 package' } }),
        },
      ],
    });
    const request = vi.spyOn(window.agenticComplex.agentd, 'request');
    const backends: WireRuntimePublic['available_backends'] = [
      ...WIRE_RUNTIME.available_backends,
      { id: 'acp', title: 'ACP', available: true, reason: null },
      { id: 'claude', title: 'Claude Code', available: true, reason: null },
    ];
    render(
      <Harness runtime={acp({ available_backends: backends })}>
        <KernelGroup />
        <Draft />
      </Harness>,
    );
    const grid = await screen.findByRole('grid', { name: 'ACP 智能体' });
    const [claude] = within(grid).getAllByRole('row').slice(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '更多（需下载）' })));
    const [gemini, fast] = within(screen.getByRole('grid', { name: '更多（需下载）' })).getAllByRole('row').slice(1);
    expect(within(claude!).getByText('用直连')).toBeTruthy();
    expect(within(claude!).getByRole('radio').getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(claude!));
    expect(draft()).toEqual({});
    expect(within(fast!).getByRole('button', { name: '安装' })).toBeTruthy();
    await act(async () => fireEvent.click(within(gemini!).getByRole('button', { name: '安装' })));
    expect(installs).toEqual([{ agent_id: 'gemini' }]);
    expect(screen.getByTestId('toast').textContent).toBe('已安装 Gemini CLI');
    expect(draft()).toEqual({});
    await act(async () => fireEvent.click(within(claude!).getByRole('button', { name: '改用 Claude Code' })));
    expect(request).toHaveBeenCalledWith('PUT', '/character/runtime', expect.objectContaining({ backend: 'claude' }));
  });

  it('keeps a saved Claude bridge pickable and names a failed install', async () => {
    window.agenticComplex = createFakeBridge({
      surface: 'main',
      still: true,
      routes: [
        { method: 'GET', path: '/character/acp/agents', handler: () => ({ status: 200, body: AGENTS }) },
        { method: 'POST', path: '/character/acp/install', handler: () => ({ status: 400, body: { error: 'acp_installer_missing' } }) },
      ],
    });
    render(
      <Harness runtime={acp({ acp_agent: 'claude-acp' })}>
        <KernelGroup />
      </Harness>,
    );
    const grid = await screen.findByRole('grid', { name: 'ACP 智能体' });
    const [claude] = within(grid).getAllByRole('row').slice(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '更多（需下载）' })));
    const [gemini] = within(screen.getByRole('grid', { name: '更多（需下载）' })).getAllByRole('row').slice(1);
    expect(within(claude!).getByRole('radio').getAttribute('aria-checked')).toBe('true');
    expect(within(claude!).getByRole('radio').getAttribute('aria-disabled')).toBeNull();
    expect(within(claude!).getByText('用直连')).toBeTruthy();
    await act(async () => fireEvent.click(within(gemini!).getByRole('button', { name: '安装' })));
    expect(screen.getByTestId('toast').textContent).toBe('安装 Gemini CLI 失败：本机没有 npm 或 uv');
  });

  it('re-checks the local agents with refresh=1', async () => {
    render(
      <Harness runtime={acp()}>
        <KernelGroup />
      </Harness>,
    );
    await screen.findAllByText('Claude Agent');
    await act(async () => fireEvent.click(within(screen.getByRole('region', { name: 'ACP 智能体' })).getByRole('button', { name: '重新检测' })));
    expect(refresh).toEqual([null, '1']);
  });

  it('tells a signed-out Claude agent to log in from the terminal, and names the sign-in of any other', async () => {
    const run = vi.spyOn(window.agenticComplex!.open, 'runInTerminal');
    const { unmount } = render(
      <Harness runtime={acp({ acp_agent: 'claude-acp', ready: false, error: 'acp_auth_required' })}>
        <KernelGroup />
      </Harness>,
    );
    expect(screen.getByText('在终端运行 claude 并输入 /login')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '在终端运行' })));
    expect(run).toHaveBeenCalledWith('claude');
    unmount();
    render(
      <Harness runtime={acp({ acp_agent: 'goose', ready: false, error: 'acp_auth_required' })}>
        <KernelGroup />
      </Harness>,
    );
    await screen.findByText('Goose');
    expect(screen.queryByText('在终端运行 claude 并输入 /login')).toBeNull();
    expect(screen.getAllByText(/Sign in with Block/).length).toBe(2);
  });
});
