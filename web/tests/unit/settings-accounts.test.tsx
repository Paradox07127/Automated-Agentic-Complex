// Settings and permissions: accounts, readiness reasons, live state, read-only rows, restart notice, reset wording, hooks, permission rows.
import { useMemo, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS, WIRE_DIAG_BUDGET, WIRE_DIAG_CONNECTIONS, WIRE_DIAG_GATE, WIRE_DIAG_HOOKS, WIRE_OBSERVATION } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { runtimeView, SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { DataGroup } from '../../src/pages/settings/groups/Data';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { PiSections } from '../../src/pages/settings/groups/Model';
import { ActGroup } from '../../src/pages/settings/groups/Act';
import { SeeGroup } from '../../src/pages/settings/groups/See';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { usePerms } from '../../src/pages/settings/perms';
import { GROUP_LABEL } from '../../src/pages/settings/registry';
import type { WireDiagSlice, WireModelSettings } from '../../src/pages/settings/wire';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

type Loaded = { native: Native; runtime: WireRuntimePublic; models: WireModelSettings | null; diag: WireDiagSlice };

const DIAG: WireDiagSlice = { gate: WIRE_DIAG_GATE, budget: WIRE_DIAG_BUDGET, hooks: WIRE_DIAG_HOOKS, connections: WIRE_DIAG_CONNECTIONS, observation: WIRE_OBSERVATION };

async function load(): Promise<Loaded> {
  const get = async <T,>(p: string) => (await window.agenticComplex!.agentd.request<T>('GET', p)).body as T;
  return {
    native: await demoNative(null),
    runtime: await get<WireRuntimePublic>('/character/runtime'),
    models: await get<WireModelSettings>('/model/settings'),
    diag: DIAG,
  };
}

type Opts = { init?: ModelInit; agentdOff?: boolean; goRow?: (id: string) => void };

function Harness({ d, o = {}, children }: { d: Loaded; o?: Opts; children: ReactNode }) {
  const view = useMemo(() => diagView(d.diag), [d.diag]);
  const model = useSettingsModel(o.init ?? {}, { native: d.native, runtime: d.runtime, models: d.models, agentdStartedAt: view.agentdStartedAt });
  const runtime = runtimeView(d.runtime);
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: o.agentdOff ?? false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native: d.native,
    runtime,
    runtimeChecking: false,
    recheckRuntime: async () => runtime,
    models: d.models,
    diag: view,
    blacklist: null,
    scopes: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'granted',
    goRow: o.goRow ?? (() => {}),
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.confirm && (
        <div role="dialog" aria-label={model.confirm.title}>
          <p>{model.confirm.warning}</p>
          {model.confirm.list?.map((x) => <p key={x}>{x}</p>)}
          <p>{model.confirm.note}</p>
          <button type="button" onClick={() => void model.confirm?.onConfirm()}>
            {model.confirm.confirmLabel}
          </button>
        </div>
      )}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
    </SettingsCtx.Provider>
  );
}

let d: Loaded;
let request: MockInstance<AgenticComplexBridge['agentd']['request']>;
beforeEach(async () => {
  localStorage.clear();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  d = await load();
  request = vi.spyOn(window.agenticComplex.agentd, 'request');
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const click = (el: Element) => act(async () => void fireEvent.click(el));
const sent = (method: string, path: string) => request.mock.calls.filter((c) => c[0] === method && c[1] === path).map((c) => c[2]);

describe('账号', () => {
  it("names the page for pi and lists the seven services, Pi's catalog providers by name in place of 其他（Pi 目录）", async () => {
    expect(GROUP_LABEL.kernel).toBe('内核');
    render(<Harness d={d}><PiSections /></Harness>);
    await click(screen.getByRole('button', { name: '模型提供方' }));
    const options = within(screen.getByRole('listbox', { name: '模型提供方' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Anthropic API', 'DeepSeek', 'Grok / xAI', 'OpenAI API', '兼容 API', 'ChatGPT 订阅', 'Groq（Pi 目录）', 'OpenRouter（Pi 目录）']);
  });

  it('has no vision model, auto or local login rows', async () => {
    render(<Harness d={d}><PiSections /></Harness>);
    expect(screen.queryByText('看图模型')).toBeNull();
    for (const row of ['visProv', 'visModel', 'claudeExe', 'codexExe', 'maxLen']) expect(document.querySelector(`[data-row="${row}"]`)).toBeNull();
    expect(screen.queryByText(/Claude 登录|Codex 登录|自动/)).toBeNull();
    expect(screen.getByRole('textbox', { name: '默认模型' })).toBeTruthy();
    // A saved key reads 已保存 until 替换 opens the field.
    const key = within(document.querySelector('[data-row="apikey"]') as HTMLElement);
    expect(key.getByText('已保存')).toBeTruthy();
    expect(key.getByRole('button', { name: '移除' })).toBeTruthy();
    await click(key.getByRole('button', { name: '替换' }));
    expect(screen.getByLabelText('API Key', { selector: 'input' })).toBeTruthy();
  });

  it("offers the DeepSeek models of Pi's catalog and a key with no editable endpoint", async () => {
    const flash = { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', context_window: 1000000, max_tokens: 384000, input: ['text', 'image'], reasoning: true, thinking_levels: ['off', 'low', 'high', 'max'], priced: true };
    request.mockResolvedValueOnce({ status: 200, body: { providers: [], models: [flash] } } as never);
    render(<Harness d={{ ...d, models: { ...d.models!, provider: 'deepseek' as const } }}><PiSections /></Harness>);
    await act(async () => {});
    expect(sent('POST', '/model/catalog')).toEqual([{}]);
    expect(screen.getByLabelText('API Key', { selector: 'input' })).toBeTruthy();
    expect(screen.queryByLabelText('API 地址', { selector: 'input' })).toBeNull();
    await click(screen.getByRole('button', { name: '默认模型' }));
    expect(screen.getByRole('option', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
  });
});

describe('ChatGPT accounts', () => {
  const gpt: WireModelSettings['chatgpt'] = {
    active: 'p1',
    pending: false,
    error: null,
    profiles: [
      { id: 'p1', label: '连接 1', email: 'lin@example.com', connected: true, sharing: true },
      { id: 'p2', label: '连接 2', email: 'work@example.com', connected: true, sharing: false },
      { id: 'p3', label: '连接 3', email: '', connected: false, sharing: false },
    ],
  };

  it('lists every saved account and selects, reconnects or logs out a given one', async () => {
    const models = { ...d.models!, provider: 'chatgpt' as const, chatgpt: gpt };
    render(<Harness d={{ ...d, models }}><PiSections /></Harness>);
    const list = screen.getByRole('list', { name: 'ChatGPT 账号' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('lin@example.com'), expect.stringContaining('work@example.com'), expect.stringContaining('连接 3')]);
    expect(items[0]!.textContent).toContain('使用中');
    await click(within(items[1]!).getByRole('button', { name: '使用' }));
    expect(sent('POST', '/model/chatgpt/select')).toEqual([{ profile_id: 'p2' }]);
    await click(within(items[2]!).getByRole('button', { name: '重新连接' }));
    expect(sent('POST', '/model/chatgpt/start')).toEqual([{ profile_id: 'p3' }]);
    await click(within(items[1]!).getByRole('button', { name: '退出' }));
    expect(sent('POST', '/model/chatgpt/logout')).toEqual([{ profile_id: 'p2' }]);
  });

  it('does not say an account that was logged out is in use', () => {
    const out = { ...gpt, profiles: gpt.profiles.map((p) => (p.id === 'p1' ? { ...p, connected: false } : p)) };
    render(<Harness d={{ ...d, models: { ...d.models!, provider: 'chatgpt' as const, chatgpt: out } }}><PiSections /></Harness>);
    expect(document.querySelector('[data-row="chatgpt"]')!.textContent).not.toContain('正在用');
  });

  it('adds a new account with a bare start', async () => {
    const models = { ...d.models!, provider: 'chatgpt' as const, chatgpt: gpt };
    render(<Harness d={{ ...d, models }}><PiSections /></Harness>);
    await click(screen.getByRole('button', { name: '添加账号' }));
    expect(sent('POST', '/model/chatgpt/start')).toEqual([{}]);
  });
});

describe('kernel readiness reasons', () => {
  const unready = (backend: string, error: string): WireRuntimePublic => ({ ...d.runtime, backend: backend as WireRuntimePublic['backend'], ready: false, error });

  it('names a missing API key and links to the row that fixes it', async () => {
    const goRow = vi.fn();
    render(<Harness d={{ ...d, runtime: { ...unready('codex', 'missing_provider_api_key'), auth_source: 'api_key' } }} o={{ goRow }}><KernelGroup /></Harness>);
    expect(screen.getByText('未就绪：还没有保存这个服务的 API Key')).toBeTruthy();
    await click(screen.getByRole('button', { name: '去填写 API Key' }));
    expect(goRow).toHaveBeenCalledWith('apikey');
  });

  it('says what Pi still needs instead of a missing executable', () => {
    render(<Harness d={{ ...d, runtime: unready('pi', 'pi_provider_model_required') }}><KernelGroup /></Harness>);
    expect(screen.getByText('未就绪：Pi 要写明服务提供方和模型')).toBeTruthy();
    expect(screen.queryByText(/没找到可执行文件/)).toBeNull();
  });

  it('an unknown code reads as a plain sentence; the code stays off screen', () => {
    render(<Harness d={{ ...d, runtime: unready('codex', 'brand_new_reason') }}><KernelGroup /></Harness>);
    expect(screen.getByText('未就绪：后台报告这个内核还不能用')).toBeTruthy();
    expect(document.body.textContent).not.toContain('brand_new_reason');
  });
});

describe('mute row', () => {
  it('promises no menu toggle and shows that the backend is muted now', () => {
    render(<Harness d={{ ...d, diag: { ...DIAG, mouth_voice: { mouth: 'idle', voice: null, muted: true, avatar_visible: true, speech_failed: null } } }}><SpeakGroup /></Harness>);
    const row = document.querySelector('[data-row="mute"]')!;
    expect(row.textContent).not.toContain('菜单');
    expect(row.textContent).toContain('后台现在静音');
  });
});

describe('restart notice', () => {
  it('keeps the restart notice after leaving the page', async () => {
    const first = render(<Harness d={d}><ActGroup /><ApplyBar /></Harness>);
    await click(screen.getByRole('switch', { name: '外部智能体接入' }));
    first.unmount();
    render(<Harness d={d}><ApplyBar /></Harness>);
    expect(screen.getByRole('region', { name: '未应用的改动' }).textContent).toContain('1 项重启后台服务后生效');
  });

  it('drops the notice once agentd started after the change', async () => {
    const first = render(<Harness d={d}><ActGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '外部智能体接入' }));
    first.unmount();
    const later = { ...DIAG, connections: { ...WIRE_DIAG_CONNECTIONS, agentd: { ...WIRE_DIAG_CONNECTIONS.agentd, started_at: '2099-01-01T00:00:00Z' } } };
    render(<Harness d={{ ...d, diag: later }}><ApplyBar /></Harness>);
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
    expect(screen.queryByText(/重启后台服务后生效/)).toBeNull();
  });

  it('reports a failed restart and keeps the notice', async () => {
    vi.spyOn(window.agenticComplex!.supervisor, 'restart').mockRejectedValue({ code: 'not_implemented' });
    render(<Harness d={d} o={{ init: { pending: ['mute'] } }}><ApplyBar /></Harness>);
    await click(screen.getByRole('button', { name: '立即重启后台' }));
    expect(screen.getByTestId('toast').textContent).toBe('没能重启后台服务：桌面端没有响应');
    expect(screen.getByRole('button', { name: '立即重启后台' }).getAttribute('aria-busy')).not.toBe('true');
    expect(screen.getByRole('region', { name: '未应用的改动' }).textContent).toContain('1 项重启后台服务后生效');
  });
});

describe('恢复默认 wording', () => {
  it('names the switches the reset turns on', async () => {
    const off = { ...d, native: { ...d.native, saved: { ...d.native.saved, keys: false } } };
    render(<Harness d={off}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '恢复默认…' }));
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('会打开：键鼠计数');
    expect(text).not.toContain('读取类的开关都会关掉');
  });
});

describe('coding-tool hooks', () => {
  it('shows the install steps for a tool that is not hooked up and runs them in a terminal', async () => {
    const run = vi.spyOn(window.agenticComplex!.open, 'runInTerminal');
    const hooks = { claude: { installed: true, last_at: WIRE_DIAG_HOOKS.claude.last_at }, codex: { installed: false, last_at: null } };
    render(<Harness d={{ ...d, diag: { ...DIAG, hooks } }}><SeeGroup /></Harness>);
    const steps = within(document.querySelector('[data-row="hooks2"]') as HTMLElement).getByRole('list', { name: 'Codex 接入步骤' });
    expect(within(steps).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      expect.stringContaining('先看会改什么'),
      expect.stringContaining('确认改动后执行'),
      expect.stringContaining('/hooks'),
    ]);
    // The capsule is disabled by aria-disabled until the app's installer steps are read.
    await waitFor(() => expect(within(steps).getAllByRole('button', { name: '在终端运行' })[0]!.getAttribute('aria-disabled')).toBeNull());
    await click(within(steps).getAllByRole('button', { name: '在终端运行' })[0]!);
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/install_hooks\.py' --hook-script '\/path\/to\/support\/bin\/agentic-complex-hook' --dry-run --target codex$/));
    expect(document.querySelector('[data-row="hooks"]')!.querySelector('[aria-label="Claude Code 接入步骤"]')).toBeNull();
  });

  it('shows the install steps after unbinding, while agentd still remembers the last event', () => {
    const hooks = { claude: { installed: false, last_at: WIRE_DIAG_HOOKS.claude.last_at }, codex: { installed: true, last_at: null } };
    render(<Harness d={{ ...d, diag: { ...DIAG, hooks } }}><SeeGroup /></Harness>);
    expect(document.querySelector('[data-row="hooks"]')!.textContent).toContain('未接入');
    expect(within(document.querySelector('[data-row="hooks"]') as HTMLElement).getByRole('list', { name: 'Claude Code 接入步骤' })).toBeTruthy();
  });
});

describe('permission rows', () => {
  // 系统权限 is one summary line and a fold of the rows, which opens by itself while one is missing.
  const openPerms = async () => expect(screen.getByRole('button', { name: /^各项权限/ }).getAttribute('aria-expanded')).toBe('true');

  it('starts as 读取中 rather than made-up states, and lists Input Monitoring', async () => {
    let answer!: (s: Awaited<ReturnType<AgenticComplexBridge['permissions']['status']>>) => void;
    vi.spyOn(window.agenticComplex!.permissions, 'status').mockReturnValue(new Promise((r) => (answer = r)));
    const { result } = renderHook(() => usePerms(window.agenticComplex!));
    expect(result.current.perms.map((p) => p.state)).toEqual(result.current.perms.map(() => 'loading'));
    expect(result.current.perms.find((p) => p.kind === 'inputMonitoring')?.label).toBe('输入监控');
    await act(async () => answer({ accessibility: 'granted', screenRecording: 'denied', microphone: 'notDetermined', automation: 'denied', inputMonitoring: 'granted', notifications: 'granted' }));
    expect(result.current.perms.find((p) => p.kind === 'screenRecording')?.state).toBe('denied');
  });

  it('a failed reading shows 未读到', async () => {
    vi.spyOn(window.agenticComplex!.permissions, 'status').mockRejectedValue({ code: 'failed' });
    const { result } = renderHook(() => usePerms(window.agenticComplex!));
    await waitFor(() => expect(result.current.perms.every((p) => p.state === 'unread')).toBe(true));
  });

  it('asks the system for a permission that was never asked', async () => {
    const ask = vi.spyOn(window.agenticComplex!.permissions, 'request').mockResolvedValue('granted');
    const perms = PERMISSIONS.map((p) => (p.kind === 'microphone' ? { ...p, state: 'notDetermined' as const } : p));
    render(<Harness d={d}><SettingsCtx.Consumer>{(c) => <SettingsCtx.Provider value={{ ...c!, perms }}><ActGroup /></SettingsCtx.Provider>}</SettingsCtx.Consumer></Harness>);
    await openPerms();
    await click(within(document.querySelector('[data-row="microphone"]') as HTMLElement).getByRole('button', { name: '允许' }));
    expect(ask).toHaveBeenCalledWith('microphone');
  });

  it('opens system settings when 允许 brings up no prompt, and keeps 去系统设置', async () => {
    vi.spyOn(window.agenticComplex!.permissions, 'request').mockResolvedValue('notDetermined');
    const open = vi.spyOn(window.agenticComplex!.permissions, 'openSettings');
    const perms = [
      ...PERMISSIONS.map((p) => (p.kind === 'microphone' ? { ...p, state: 'notDetermined' as const } : p)),
      { kind: 'inputMonitoring' as const, label: '输入监控', purpose: '按住说话的热键', features: ['按住说话'], state: 'notDetermined' as const },
    ];
    render(<Harness d={d}><SettingsCtx.Consumer>{(c) => <SettingsCtx.Provider value={{ ...c!, perms }}><ActGroup /></SettingsCtx.Provider>}</SettingsCtx.Consumer></Harness>);
    await openPerms();
    const mic = within(document.querySelector('[data-row="microphone"]') as HTMLElement);
    expect(within(document.querySelector('[data-row="inputMonitoring"]') as HTMLElement).getByRole('button', { name: '去系统设置' })).toBeTruthy();
    await click(mic.getByRole('button', { name: '允许' }));
    expect(open).toHaveBeenCalledWith('microphone');
    expect(mic.getByRole('button', { name: '去系统设置' })).toBeTruthy();
    expect(screen.getByTestId('toast').textContent).toBe('已打开系统设置 › 麦克风与语音识别 │ 允许 Agentic Complex 后回来点「重新检测」');
  });

  it('reports failure when the native system settings pane cannot open', async () => {
    const open = vi.spyOn(window.agenticComplex!.permissions, 'openSettings').mockRejectedValue({ code: 'failed' });
    const perms = PERMISSIONS.map((p) => p.kind === 'microphone' ? { ...p, state: 'denied' as const } : p);
    render(<Harness d={d}><SettingsCtx.Consumer>{(c) => <SettingsCtx.Provider value={{ ...c!, perms }}><ActGroup /></SettingsCtx.Provider>}</SettingsCtx.Consumer></Harness>);
    await openPerms();
    await click(within(document.querySelector('[data-row="microphone"]') as HTMLElement).getByRole('button', { name: '去系统设置' }));
    expect(open).toHaveBeenCalledWith('microphone');
    expect(screen.getByTestId('toast').textContent).toContain('没能打开系统设置');
  });

  it('gives the actual Terminal dependency when the automation probe is inconclusive', async () => {
    const ask = vi.spyOn(window.agenticComplex!.permissions, 'request').mockResolvedValue('notDetermined');
    const perms = PERMISSIONS.map((p) => p.kind === 'automation' ? { ...p, state: 'notDetermined' as const } : p);
    render(<Harness d={d}><SettingsCtx.Consumer>{(c) => <SettingsCtx.Provider value={{ ...c!, perms }}><ActGroup /></SettingsCtx.Provider>}</SettingsCtx.Consumer></Harness>);
    await openPerms();
    await click(within(document.querySelector('[data-row="automation"]') as HTMLElement).getByRole('button', { name: '允许' }));
    expect(ask).toHaveBeenCalledWith('automation');
    expect(screen.getByTestId('toast').textContent).toContain('请先打开「终端」');
  });

  it('the 操作电脑 band switch in 能做 can be turned on in the native main window, and there is no second switch for it', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    expect(window.agenticComplex!.capabilities.computerUse).toBe(false);
    render(<Harness d={d}><ActGroup /></Harness>);
    const band = document.querySelector('[data-row="plugins.computer_use"]') as HTMLElement;
    expect(screen.getAllByRole('switch', { name: '操作电脑' })).toEqual([within(band).getByRole('switch', { name: '操作电脑' })]);
    expect(band.textContent).not.toContain('不支持');
    await click(within(band).getByRole('switch', { name: '操作电脑' }));
    expect(save).toHaveBeenCalledWith({ 'plugins.computer_use': true });
  });
});

describe('fake bridge capabilities', () => {
  it('match the shell per surface', () => {
    const main = createFakeBridge({ surface: 'main', still: true }).capabilities;
    const stack = createFakeBridge({ surface: 'stack', still: true }).capabilities;
    expect([main.screenCapture, main.computerUse, main.pushToTalk, main.clickThrough, main.avatar, main.runInTerminal]).toEqual([false, false, false, false, true, true]);
    expect([stack.avatar, stack.systemSettings, stack.runInTerminal, stack.revealInFinder, stack.nativeFilePicker, stack.clickThrough]).toEqual([true, false, false, true, false, true]);
  });
});
