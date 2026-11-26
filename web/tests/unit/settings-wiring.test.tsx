// Settings wiring: what each row sends (bridge op or agentd method, path, body) and how backend shapes show.
import { useMemo, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { WireDiagConnections, WireRuntimePublic } from '../../src/domain/wire';
import { PERMISSIONS, WIRE_DIAG_BUDGET, WIRE_DIAG_CONNECTIONS, WIRE_DIAG_GATE, WIRE_DIAG_HOOKS, WIRE_OBSERVATION, WIRE_TTS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { ApplyBar } from '../../src/pages/settings/ApplyBar';
import { failure } from '../../src/pages/settings/api';
import { runtimeView, SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { AboutGroup } from '../../src/pages/settings/groups/About';
import { DataGroup } from '../../src/pages/settings/groups/Data';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { KeysGroup } from '../../src/pages/settings/groups/Keys';
import { PiSections } from '../../src/pages/settings/groups/Model';
import { ActGroup } from '../../src/pages/settings/groups/Act';
import { SeeGroup } from '../../src/pages/settings/groups/See';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { TtsSecretRows } from '../../src/pages/settings/groups/SpeakService';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import type { WireBlacklist, WireDiagSlice, WireModelSettings, WireScope } from '../../src/pages/settings/wire';
import { setPlugins } from '../../src/shell/plugins';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

type Loaded = {
  native: Native;
  runtime: WireRuntimePublic;
  models: WireModelSettings;
  blacklist: WireBlacklist;
  scopes: WireScope[];
  diag: WireDiagSlice;
};

const DIAG: WireDiagSlice = { gate: WIRE_DIAG_GATE, budget: WIRE_DIAG_BUDGET, hooks: WIRE_DIAG_HOOKS, connections: WIRE_DIAG_CONNECTIONS, observation: WIRE_OBSERVATION };

async function load(): Promise<Loaded> {
  const get = async <T,>(p: string) => (await window.agenticComplex!.agentd.request<T>('GET', p)).body as T;
  return {
    native: await demoNative(null),
    runtime: await get<WireRuntimePublic>('/character/runtime'),
    models: await get<WireModelSettings>('/model/settings'),
    blacklist: await get<WireBlacklist>('/blacklist'),
    scopes: (await get<{ scopes: WireScope[] }>('/agent/scopes')).scopes,
    diag: DIAG,
  };
}

function Harness({ d, init = {}, reload = () => {}, goRow = () => {}, children }: { d: Loaded; init?: ModelInit; reload?: SettingsCtxValue['reload']; goRow?: SettingsCtxValue['goRow']; children: ReactNode }) {
  const view = useMemo(() => diagView(d.diag), [d.diag]);
  const model = useSettingsModel(init, { native: d.native, runtime: d.runtime, models: d.models });
  const runtime = runtimeView(d.runtime);
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
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
    blacklist: d.blacklist,
    scopes: d.scopes,
    reload,
    perms: PERMISSIONS,
    recheckPerms: async () => 'granted',
    goRow,
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.confirm && (
        <div role="dialog" aria-label={model.confirm.title}>
          {model.confirm.list?.map((x) => <p key={x}>{x}</p>)}
          <p>{model.confirm.note}</p>
          <button type="button" onClick={() => void model.confirm?.onConfirm()}>
            {model.confirm.confirmLabel}
          </button>
        </div>
      )}
      {model.toast && <output data-testid="toast">{model.toast.message}</output>}
      {model.toast?.action && (
        <button type="button" data-testid="toast-action" onClick={model.toast.action.onClick}>
          {model.toast.action.label}
        </button>
      )}
    </SettingsCtx.Provider>
  );
}

let d: Loaded;
let request: MockInstance<AgenticComplexBridge['agentd']['request']>;
beforeEach(async () => {
  // The restart notice is kept in localStorage across pages.
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
const sent = (method: string, path: string) => request.mock.calls.find((c) => c[0] === method && c[1] === path)?.[2];
describe('native rows (settings.schema / read / save)', () => {
  it('shows the schema options and saves the option value, not the label', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const asr = screen.getByRole('radiogroup', { name: '语音识别语言' });
    expect(within(asr).getAllByRole('radio').map((r) => r.textContent)).toEqual(['跟随系统', '中文', 'English']);
    await click(within(asr).getByRole('radio', { name: '中文' }));
    expect(save).toHaveBeenCalledWith({ asr: 'zh-CN' });
  });

  it('picking the option already chosen sends nothing (Seg fires onChange for it too)', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const asr = screen.getByRole('radiogroup', { name: '语音识别语言' });
    const chosen = within(asr).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    expect(chosen?.textContent).toBe('跟随系统');
    await click(chosen!);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByTestId('toast')).toBeNull();
    await click(within(asr).getByRole('radio', { name: '中文' }));
    expect(save).toHaveBeenCalledWith({ asr: 'zh-CN' });
  });

  it('marks a restart from the schema flag only (backend yes, notification routing no)', async () => {
    render(<Harness d={d}><SpeakGroup /><ActGroup /><ApplyBar /></Harness>);
    await click(screen.getByRole('radio', { name: '完成：不提示' }));
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
    await click(screen.getByRole('switch', { name: '外部接入' }));
    expect(screen.getByRole('region', { name: '未应用的改动' }).textContent).toContain('1 项重启后台服务后生效');
  });

  it('a refused save shows a fixed reason instead of a fake saved toast; the shell text goes to the console', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [], error: 'asr_locale: zh-CN' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness d={d}><SpeakGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '语音识别语言' })).getByRole('radio', { name: '中文' }));
    expect(screen.getByTestId('toast').textContent).toBe('没有保存「语音识别语言」：桌面端没有接受这次修改');
    expect(warn).toHaveBeenCalledWith('settings.save refused', 'asr_locale: zh-CN');
  });

  it('asks before a destructive switch goes off, logs consent, then saves', async () => {
    const consent = vi.spyOn(window.agenticComplex!.settings, 'confirmDestructive');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '允许读取窗口文本' }));
    expect(save).not.toHaveBeenCalled();
    await click(within(screen.getByRole('dialog', { name: '关闭「允许读取窗口文本」并删除已收集的内容？' })).getByRole('button', { name: '关闭并删除' }));
    expect(consent).toHaveBeenCalledWith('wintext');
    expect(save).toHaveBeenCalledWith({ wintext: false });
  });

  it('keeps the warning of a save the running backend did not take, with no 已更改 over it', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: ['wintext'], error: undefined });
    render(<Harness d={d}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '屏幕感知' }));
    expect(screen.getByTestId('toast').textContent).toBe('已保存，允许读取窗口文本要重启 Agentic Complex 后生效');
    expect(screen.queryByTestId('toast-action')).toBeNull();
  });

  it('撤销 of a destructive switch turned on asks before it goes off again, and does nothing once the row changed since', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const off = { ...d, native: { ...d.native, saved: { ...d.native.saved, wintext: false } } };
    const ui = render(<Harness d={off}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '允许读取窗口文本' }));
    expect(save).toHaveBeenCalledTimes(1);
    await click(screen.getByTestId('toast-action'));
    expect(screen.getByRole('dialog', { name: '关闭「允许读取窗口文本」并删除已收集的内容？' })).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    ui.unmount();

    // Turned off elsewhere (config.json read again) before 撤销.
    const again = render(<Harness d={off}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '允许读取窗口文本' }));
    again.rerender(<Harness d={{ ...off, native: { ...off.native, saved: { ...off.native.saved } } }}><SeeGroup /></Harness>);
    await click(screen.getByTestId('toast-action'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('toast').textContent).toBe('「允许读取窗口文本」已经又改过，没有撤销');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('the delete confirm says how many records go, from settings.previewDestructive', async () => {
    const preview = vi.spyOn(window.agenticComplex!.settings, 'previewDestructive').mockResolvedValue({ total: 214, counts: { task_understanding: 214 } });
    for (const [id, label] of [['wintext', '允许读取窗口文本'], ['web', '允许读取网页正文'], ['typing', '允许读取当前输入文本']] as const) {
      const on = { ...d, native: { ...d.native, saved: { ...d.native.saved, [id]: true } } };
      const ui = render(<Harness d={on}><SeeGroup /></Harness>);
      await click(screen.getByRole('switch', { name: label }));
      expect(preview).toHaveBeenLastCalledWith(id);
      expect(screen.getByRole('dialog', { name: `关闭「${label}」并删除已收集的内容？` }).textContent).toContain('将删除 214 条');
      ui.unmount();
    }
  });

  it('a preview that fails says 条数未知 and still lets the switch go off', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'previewDestructive').mockRejectedValue({ code: 'failed', detail: 'agentd 503' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '允许读取窗口文本' }));
    const dialog = screen.getByRole('dialog', { name: '关闭「允许读取窗口文本」并删除已收集的内容？' });
    expect(dialog.textContent).toContain('条数未知');
    expect(dialog.textContent).not.toContain('agentd 503');
    await click(within(dialog).getByRole('button', { name: '关闭并删除' }));
    expect(save).toHaveBeenCalledWith({ wintext: false });
  });

  it('turns 屏幕感知 on and off without a confirm (records stay)', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SeeGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '屏幕感知' }));
    await click(screen.getByRole('switch', { name: '屏幕感知' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).toHaveBeenLastCalledWith({ 'plugins.screen_awareness': false });
  });

  it('恢复默认 saves the schema defaults: every read switch ends up off', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const consent = vi.spyOn(window.agenticComplex!.settings, 'confirmDestructive');
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '恢复默认…' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '恢复默认' }));
    expect(consent.mock.calls.map((c) => c[0]).sort()).toEqual(['web', 'wintext']);
    expect(save).toHaveBeenCalledWith({ wintext: false, web: false, shot: false });
    expect(screen.getByTestId('toast').textContent).toBe('已恢复默认设置');
  });

  it('恢复默认 says up front which reading switches go off', async () => {
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '恢复默认…' }));
    const card = screen.getByRole('dialog').textContent;
    expect(card).toContain('将关闭：允许读取窗口文本、允许读取网页正文、屏幕识读时附带截图');
  });

  it('marks a restart by each row\'s schema even when the shell answers restart=backend', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'save').mockResolvedValue({ restart: 'backend', notApplied: [] });
    render(<Harness d={d}><SpeakGroup /><ApplyBar /></Harness>);
    await click(screen.getByRole('radio', { name: '完成：不提示' }));
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
  });
});

describe('native app actions', () => {
  it('deletes all local data after the in-app confirm card lists what goes', async () => {
    const wipe = vi.spyOn(window.agenticComplex!.settings, 'wipeLocalData');
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '删除全部…' }));
    expect(wipe).not.toHaveBeenCalled();
    await click(within(screen.getByRole('dialog', { name: '确认删除所有本地数据？' })).getByRole('button', { name: '删除全部' }));
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('toast').textContent).toBe('已删除所有本地数据');
  });

  it('sends the test cards and opens the folders in a shell without avatar or revealInFinder', async () => {
    const caps = window.agenticComplex!.capabilities as { avatar: boolean; revealInFinder: boolean };
    caps.avatar = false;
    caps.revealInFinder = false;
    try {
      const action = vi.spyOn(window.agenticComplex!.app, 'action');
      render(<Harness d={d}><SpeakGroup /><DataGroup /><AboutGroup /></Harness>);
      await click(screen.getByRole('button', { name: '测试审批卡' }));
      await click(screen.getByRole('button', { name: '测试播报' }));
      await click(within(document.getElementById('set-datadir')!).getByRole('button', { name: /打开/ }));
      await click(within(document.getElementById('set-logdir')!).getByRole('button', { name: /打开/ }));
      expect(action.mock.calls.map((c) => c[0])).toEqual(['test_approval_card', 'test_announcement', 'open_data_folder', 'reveal_logs']);
    } finally {
      caps.avatar = true;
      caps.revealInFinder = true;
    }
  });
});

describe('hot keys', () => {
  it('records, checks, then saves; hk_focus is gone', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'recordHotkey').mockResolvedValue('⌃⌥J');
    const check = vi.spyOn(window.agenticComplex!.settings, 'validateHotkey');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const { container } = render(<Harness d={d}><KeysGroup /></Harness>);
    expect(container.querySelector('[data-row="hk_focus"]')).toBeNull();
    expect(container.querySelector('[data-row="hk_hide"]')?.textContent).toContain('⌃⌥H');
    await click(within(container.querySelector('[data-row="hk_hide"]')!).getByRole('button', { name: '更改' }));
    expect(check).toHaveBeenCalledWith('hk_hide', '⌃⌥J');
    expect(save).toHaveBeenCalledWith({ hk_hide: '⌃⌥J' });
  });

  it('names the row a combo is taken by, and refuses an invalid combo in plain words', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'recordHotkey').mockResolvedValue('⌃⌥P');
    const check = vi.spyOn(window.agenticComplex!.settings, 'validateHotkey').mockResolvedValue({ ok: false, conflictWith: '切换全局鼠标穿透' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const { container } = render(<Harness d={d}><KeysGroup /></Harness>);
    await click(within(container.querySelector('[data-row="hk_hide"]')!).getByRole('button', { name: '更改' }));
    expect(screen.getByTestId('toast').textContent).toBe('⌃⌥P 已被「切换全局鼠标穿透」占用，「显示或隐藏角色」保持不变');
    check.mockRejectedValue({ code: 'invalid_hotkey' });
    await click(within(container.querySelector('[data-row="hk_hide"]')!).getByRole('button', { name: '更改' }));
    expect(screen.getByTestId('toast').textContent).toBe('⌃⌥P 不能用作快捷键：须包含 ⌃、⌥ 或 ⌘，或使用 F1–F12');
    expect(save).not.toHaveBeenCalled();
  });

  it('shows an empty hot key as 未设置, and 清除 saves "" for one', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const native = { ...d.native, saved: { ...d.native.saved, hk_look: '' } };
    const { container } = render(<Harness d={{ ...d, native }}><KeysGroup /></Harness>);
    const row = (id: string) => container.querySelector(`[data-row="${id}"]`)!;
    expect(row('hk_look').textContent).toContain('未设置');
    expect(row('hk_look').textContent).not.toContain('⌃⌥L');
    expect(within(row('hk_look') as HTMLElement).queryByRole('button', { name: '清除' })).toBeNull();
    await click(within(row('hk_hide') as HTMLElement).getByRole('button', { name: '清除' }));
    expect(save).toHaveBeenCalledWith({ hk_hide: '' });
    expect(row('hk_hide').textContent).toContain('未设置');
  });
});

describe('角色内核 → PUT /character/runtime patches', () => {
  it('applies the kernel and limits without sending the existing executable', async () => {
    render(<Harness d={{ ...d, runtime: { ...d.runtime, executable: '/opt/bin/codex' } }} init={{ draft: { kernel: 'pi', maxCost: 2 } }}><ApplyBar /></Harness>);
    await click(screen.getByRole('button', { name: '应用' }));
    const body = sent('PUT', '/character/runtime') as Record<string, unknown>;
    expect(body).toEqual({ backend: 'pi', runtime_source: 'bundled', max_budget_usd: 2 });
  });

  it('shows the workspace and sends a picked folder as its handle', async () => {
    const folder = { handle: 'ws-handle', displayName: 'Work' };
    const pick = vi.spyOn(window.agenticComplex!.files, 'pickFolder').mockResolvedValueOnce(folder);
    render(<Harness d={d}><KernelGroup /><ApplyBar /></Harness>);
    const row = document.querySelector('[data-row="workspace"]') as HTMLElement;
    expect(within(row).getByText('~/AgenticComplex')).toBeTruthy();
    await click(within(row).getByRole('button', { name: '选择…' }));
    expect(pick).toHaveBeenCalledWith({ purpose: 'session_cwd' });
    expect(row.querySelector('code')?.textContent).toBe('Work');
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('PUT', '/character/runtime')).toEqual({ workspace_dir: folder });
  });

  it('has no tool-round, run-time or ACP permission rows', () => {
    render(<Harness d={d} init={{ draft: { kernel: 'acp' } }}><KernelGroup /></Harness>);
    for (const id of ['maxTools', 'maxTime', 'acpPerm']) expect(document.querySelector(`[data-row="${id}"]`)).toBeNull();
  });

  it('shows the backend titles, sources and the capabilities agentd reports', async () => {
    render(<Harness d={d}><KernelGroup /></Harness>);
    const grid = screen.getByRole('grid', { name: '内核' });
    expect(within(grid).getByRole('row', { name: /Codex/ }).textContent).toContain('本机已安装');
    expect(within(grid).getByRole('row', { name: /Pi/ }).textContent).toContain('随应用内置');
    expect(screen.queryByText('内核原生会话恢复')).toBeNull();
    expect(document.querySelector('[data-row="maxCost"]')).toBeNull();
    // What the kernel can do sits on its card as chips, one per capability agentd reports as wired.
    expect(within(screen.getByRole('list', { name: 'Codex 支持的能力' })).getByText('内核原生执行工具')).toBeTruthy();
  });

  it('shows the cost cap as an editable row only on Pi', async () => {
    render(<Harness d={d} init={{ draft: { kernel: 'pi' } }}><KernelGroup /></Harness>);
    const row = document.querySelector('[data-row="maxCost"]') as HTMLElement;
    expect(row).not.toBeNull();
    await click(within(row).getByRole('button', { name: '单次运行费用上限：增加' }));
    expect(within(row).getByRole('button', { name: '单次运行费用上限：减少' }).hasAttribute('disabled')).toBe(false);
    cleanup();
    render(<Harness d={d} init={{ draft: { kernel: 'codex' } }}><KernelGroup /></Harness>);
    expect(document.querySelector('[data-row="maxCost"]')).toBeNull();
  });

  it('switches history retention through a PUT', async () => {
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '历史记录保留时长' })).getByRole('radio', { name: '30 天' }));
    expect(sent('PUT', '/character/runtime')).toMatchObject({ history_retention: '30d' });
  });
});

describe('pi 账号与凭据', () => {
  it('applies the provider through POST /model/settings and tests with the real round trip', async () => {
    render(<Harness d={d} init={{ draft: { svc: 'openai' } }}><ApplyBar /></Harness>);
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'openai' });
    cleanup();
    render(<Harness d={d}><PiSections /></Harness>);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(sent('POST', '/model/test')).toEqual({});
    expect(document.querySelector('[data-row="mtest"]')?.textContent).toMatch(/已连通 │ Codex │ claude-haiku-5-5 │ \d+ ms/);
  });

  it('saves and removes the API key for the provider on screen', async () => {
    render(<Harness d={{ ...d, models: { ...d.models, provider: 'anthropic' } }}><PiSections /></Harness>);
    // A saved key shows 已保存 until 替换 opens the field.
    await click(within(document.querySelector('[data-row="apikey"]')!).getByRole('button', { name: '替换' }));
    fireEvent.change(document.querySelector('input[aria-label="API Key"]')!, { target: { value: 'sk-ant-0123456789' } });
    await click(within(document.querySelector('[data-row="apikey"]')!).getByRole('button', { name: '保存' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'anthropic', api_key: 'sk-ant-0123456789' });
    await click(within(document.querySelector('[data-row="apikey"]')!).getByRole('button', { name: '移除' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '移除' }));
    expect(request.mock.calls.filter((c) => c[1] === '/model/settings').at(-1)?.[2]).toEqual({ provider: 'anthropic', clear_key: true });
  });

  it('unbinds a coding tool through agentd and shows the hook state from /diag/state', async () => {
    render(<Harness d={d}><SeeGroup /></Harness>);
    const claude = document.querySelector('[data-row="hooks"]')!;
    expect(claude.textContent).toContain('已接入');
    expect(document.querySelector('[data-row="hooks2"]')?.textContent).toContain('已安装，没收到事件');
    await click(within(claude as HTMLElement).getByRole('button', { name: '解绑' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '解绑' }));
    expect(sent('POST', '/integrations/hooks/disconnect')).toEqual({ target: 'claude' });
  });
});

describe('隐私 and 数据 through agentd', () => {
  it('lists the blacklist and adds, removes and restores through /blacklist', async () => {
    render(<Harness d={d}><SeeGroup /></Harness>);
    expect(screen.getByText(/网站 │ icbc\.com\.cn/)).toBeTruthy();
    await click(screen.getByRole('button', { name: '移除 icbc.com.cn' }));
    expect(sent('DELETE', '/blacklist')).toEqual({ field: 'domains', value: 'icbc.com.cn' });
    fireEvent.change(screen.getByLabelText('要排除的内容'), { target: { value: '微信' } });
    await click(screen.getByRole('switch', { name: '顺手删掉已记下的' }));
    await click(screen.getByRole('button', { name: '添加' }));
    expect(sent('POST', '/blacklist')).toBeUndefined();
    const ask = screen.getByRole('dialog', { name: '添加「微信」并删掉已记下的？' });
    expect(ask.textContent).toContain('不能恢复');
    expect(ask.textContent).toContain('删除从这些窗口记下的活动、上下文、观察记录和操作时间线，连同由它们生成的活动摘要、工作记录和记忆，不能恢复。');
    await click(within(ask).getByRole('button', { name: '添加并删除' }));
    expect(sent('POST', '/blacklist')).toEqual({ field: 'app_names', value: '微信', delete_existing: true });
    expect(screen.getByTestId('toast').textContent).toBe('已添加「微信」，删掉已记下的 4 条，连同相关的活动摘要、工作记录和记忆');
    await click(screen.getByRole('button', { name: '恢复默认排除' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '恢复默认' }));
    expect(sent('POST', '/blacklist/defaults')).toEqual({});
  });

  it('switches to allow mode and adds and removes allow entries with list allow', async () => {
    render(<Harness d={d}><SeeGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '名单过滤模式' })).getByRole('radio', { name: '仅允许名单' }));
    expect(sent('POST', '/blacklist/mode')).toEqual({ mode: 'allow' });
    // The mock keeps the mode across tests; put it back before the next one reads it.
    await window.agenticComplex!.agentd.request('POST', '/blacklist/mode', { mode: 'deny' });
    cleanup();
    render(<Harness d={{ ...d, blacklist: { ...d.blacklist, mode: 'allow' } }}><SeeGroup /></Harness>);
    expect(screen.getByText('允许读取的应用与网站')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复默认排除' })).toBeNull();
    await click(screen.getByRole('button', { name: '移除 github.com' }));
    expect(sent('DELETE', '/blacklist')).toEqual({ list: 'allow', field: 'domains', value: 'github.com' });
    fireEvent.change(screen.getByLabelText('要读取的内容'), { target: { value: 'Xcode' } });
    await click(screen.getByRole('button', { name: '添加' }));
    expect(sent('POST', '/blacklist')).toEqual({ list: 'allow', field: 'app_names', value: 'Xcode' });
    expect(screen.getByTestId('toast').textContent).toBe('已添加「Xcode」');
  });

  it('folds the chips past the first 8 into a Fold, and lays out 3 or fewer without a toggle', async () => {
    const apps = (n: number) => Array.from({ length: n }, (_, i) => `应用${i + 1}`);
    const list = (n: number): WireBlacklist => ({ ...d.blacklist, mode: 'deny', app_names: apps(n), bundle_ids: [], domains: [], title_patterns: [] });
    render(<Harness d={{ ...d, blacklist: list(12) }}><SeeGroup /></Harness>);
    expect(screen.queryByRole('button', { name: /全部 \d+ 项/ })).toBeNull();
    const fold = screen.getByRole('button', { name: /其余/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toContain('4');
    expect(screen.getByText(/应用 │ 应用8/)).toBeTruthy();
    expect(screen.queryByText(/应用 │ 应用9/)).toBeNull();
    await click(fold);
    expect(screen.getByText(/应用 │ 应用12/)).toBeTruthy();
    cleanup();
    render(<Harness d={{ ...d, blacklist: list(11) }}><SeeGroup /></Harness>);
    expect(screen.queryByRole('button', { name: /其余/ })).toBeNull();
    expect(screen.getByText(/应用 │ 应用11/)).toBeTruthy();
  });

  it('folds the allow list past the first 8 the same way', async () => {
    const allow = { bundle_ids: [], app_names: Array.from({ length: 10 }, (_, i) => `应用${i + 1}`), domains: [] };
    render(<Harness d={{ ...d, blacklist: { ...d.blacklist, mode: 'allow', allow } }}><SeeGroup /></Harness>);
    expect(screen.queryByRole('button', { name: /全部 \d+ 项/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /其余/ })).toBeNull();
    expect(screen.getByText(/应用 │ 应用10/)).toBeTruthy();
  });

  it('says nothing is read in allow mode with an empty allow list', () => {
    const blacklist: WireBlacklist = { ...d.blacklist, mode: 'allow', allow: { bundle_ids: [], app_names: [], domains: [] } };
    render(<Harness d={{ ...d, blacklist }}><SeeGroup /></Harness>);
    expect(screen.getByText('当前列表为空，不会读取任何应用或网站')).toBeTruthy();
  });

  it('deletes recent records and the activity log, and says how many', async () => {
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '1 小时' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    expect(request).toHaveBeenCalledWith('DELETE', '/observation?range=1h', undefined);
    expect(screen.getByTestId('toast').textContent).toBe('已删除最近 1 小时 的屏幕观察记录（共 28 条）');
    expect(document.querySelector('[data-row="delact"]')?.textContent).toContain('Trace 事件');
    await click(screen.getByRole('button', { name: '清空…' }));
    const ask = screen.getByRole('dialog');
    expect(ask.textContent).toContain('将删除全部屏幕观察记录、操作时间线、活动摘要与衍生记忆，以及全部 Trace 事件。');
    await click(within(ask).getByRole('button', { name: '清空' }));
    expect(request).toHaveBeenCalledWith('DELETE', '/attention', undefined);
    expect(screen.getByTestId('toast').textContent).toBe('已清空活动记录 1180 条、Trace 事件 96 条');
  });

  it('shows redactions and the voice state from /diag/state; the gate is on the diag page only', () => {
    render(<Harness d={d}><SeeGroup /><SpeakGroup /></Harness>);
    expect(document.querySelector('[data-row="mask"]')?.textContent).toContain('密钥 2 │ 邮箱 5 │ 电话 0');
    expect(document.querySelector('[data-row="gate"]')).toBeNull();
    expect(document.querySelector('[data-row="tts"]')?.textContent).toContain('无法连接：连接断开');
  });

  it('shows the voice as 未检测 before any speech has ended', () => {
    const diag: WireDiagSlice = { ...DIAG, connections: { ...WIRE_DIAG_CONNECTIONS, tts: { ...WIRE_DIAG_CONNECTIONS.tts, state: 'unknown' } } };
    expect(diagView(diag).voice?.state).toBe('unknown');
    render(<Harness d={{ ...d, diag }}><SpeakGroup /></Harness>);
    expect(document.querySelector('[data-row="tts"]')?.textContent).toContain('未检测');
  });
});

describe('语音状态', () => {
  const withTts = (tts: WireDiagConnections['tts'], saved?: Native['saved']): Loaded => {
    const native = saved ? { ...d.native, saved: { ...d.native.saved, ...saved } } : d.native;
    return { ...d, native, diag: { ...DIAG, connections: { ...WIRE_DIAG_CONNECTIONS, tts } } };
  };
  const row = () => document.querySelector('[data-row="tts"]');
  const sourceSeg = () => screen.queryByRole('radiogroup', { name: '语音服务' });

  it('puts the voice row under 未接入 without the token row for a build with no TTS', () => {
    const { tts: _unset, ...saved } = d.native.saved;
    render(<Harness d={{ ...withTts(WIRE_TTS.off), native: { ...d.native, saved } }}><SpeakGroup /></Harness>);
    expect(row()?.closest('[data-stub="PowerState"]')?.getAttribute('data-state')).toBe('unlinked');
    expect(row()?.textContent).toContain('当前仅文字回复');
    expect(document.querySelector('[data-row="ttsToken"]')).toBeNull();
    expect(sourceSeg()).toBeNull();
  });

  it('has no 语音服务 choice: the service is set in 服务, the row only shows its state', () => {
    render(<Harness d={withTts(WIRE_TTS.ready)}><SpeakGroup /></Harness>);
    expect(row()?.closest('[data-stub="PowerState"]')).toBeNull();
    expect(sourceSeg()).toBeNull();
  });

  it.each([
    ['probing', '检测中'],
    ['cold', '冷启动（第一句会慢）'],
  ] as const)('shows %s as %s', (state, text) => {
    render(<Harness d={withTts(WIRE_TTS[state])}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain(text);
  });

  it('says the text-only fallback on an unreachable voice, and keeps the usual line when ready', () => {
    const { unmount } = render(<Harness d={withTts(WIRE_TTS.unreachable)}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('当前仅使用文字回复');
    unmount();
    render(<Harness d={withTts(WIRE_TTS.ready)}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('需自行部署外部语音服务并在「服务」中配置地址；本应用不内置语音合成模型');
    expect(row()?.textContent).not.toContain('只显示文字');
  });

  it('labels the external source', () => {
    render(<Harness d={withTts({ ...WIRE_TTS.unreachable, provider: 'remote-ws' })}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('无法连接：连接断开');
  });

  it('counts the retry seconds down on an unreachable voice', () => {
    render(<Harness d={withTts({ ...WIRE_TTS.unreachable, retry_after_s: 12 })}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('无法连接：连接断开 │ 12 秒后可重试');
  });

  it('reconnects an unreachable voice through POST /voice/reset and shows the state it answers', async () => {
    let answer: (r: { status: number; body: unknown }) => void = () => {};
    render(<Harness d={withTts(WIRE_TTS.unreachable)}><SpeakGroup /></Harness>);
    request.mockImplementationOnce(() => new Promise((ok) => (answer = ok as typeof answer)));
    await click(within(row() as HTMLElement).getByRole('button', { name: '重新连接' }));
    expect(request).toHaveBeenCalledWith('POST', '/voice/reset', {});
    expect(row()?.textContent).toContain('检测中');
    await act(async () => answer({ status: 200, body: { tts: { provider: 'remote-ws', state: 'ready', reason: null, retry_after_s: null } } }));
    expect(row()?.textContent).toContain('就绪');
    expect(within(row() as HTMLElement).queryByRole('button', { name: '重新连接' })).toBeNull();
  });

  it('toasts the reason when the reset fails and shows the voice as before', async () => {
    render(<Harness d={withTts(WIRE_TTS.cold)}><SpeakGroup /></Harness>);
    request.mockResolvedValueOnce({ status: 0, body: null, error: { code: 'offline' } } as never);
    await click(within(row() as HTMLElement).getByRole('button', { name: '重新连接' }));
    expect(screen.getByTestId('toast').textContent).toBe('重新连接语音服务失败：后台已断开');
    expect(row()?.textContent).toContain('冷启动（第一句会慢）');
  });
});

describe('听写语言', () => {
  it('offers follow-the-system, Chinese and English and saves the locale', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const asr = screen.getByRole('radiogroup', { name: '语音识别语言' });
    expect(within(asr).getAllByRole('radio').map((r) => r.textContent)).toEqual(['跟随系统', '中文', 'English']);
    await click(within(asr).getByRole('radio', { name: 'English' }));
    expect(save).toHaveBeenCalledWith({ asr: 'en-US' });
  });
});

describe('回复语言', () => {
  it('sits after 识别语言 with its five choices in a dropdown and saves reply_language through PUT /character/runtime', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    expect(document.querySelector('[data-row="asr"] + [data-row="replyLang"]')).not.toBeNull();
    await click(screen.getByRole('button', { name: '回复语言' }));
    const reply = screen.getByRole('listbox', { name: '回复语言' });
    expect(within(reply).getAllByRole('option').map((o) => o.textContent?.replace('（默认）', ''))).toEqual(['跟随对话', '简体中文', 'English', '日本語', '按内核设置']);
    expect(within(reply).getByRole('option', { name: /^跟随对话/ }).getAttribute('aria-selected')).toBe('true');
    await click(within(reply).getByRole('option', { name: /^按内核设置/ }));
    expect(sent('PUT', '/character/runtime')).toEqual({ reply_language: 'harness' });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('外部语音服务', () => {
  const testRow = () => document.querySelector('[data-row="ttsTest"]');

  it('说话 has no address, token or test of the voice service, only a row that leads to its card in 服务', async () => {
    const goRow = vi.fn();
    render(<Harness d={d} goRow={goRow}><SpeakGroup /></Harness>);
    for (const name of ['服务地址', 'SSH 转发主机', '按需启动脚本']) expect(screen.queryByRole('textbox', { name })).toBeNull();
    expect(screen.queryByLabelText('令牌', { selector: 'input' })).toBeNull();
    expect(screen.queryByRole('button', { name: '测试' })).toBeNull();
    const jump = document.querySelector('[data-row="ttsJump"]') as HTMLElement;
    expect(jump.textContent).toContain('位于「设置 › 服务 › 语音服务」');
    await click(within(jump).getByRole('button', { name: '前往服务' }));
    expect(goRow).toHaveBeenCalledWith('ttsToken', 'services');
  });

  it.each([
    [true, '令牌已保存'],
    [false, '令牌仅保存于后台服务，不予回显'],
  ])('reads token_set %s from /diag/state as %s', (token_set, note) => {
    const tts = { ...WIRE_TTS.ready, token_set };
    render(<Harness d={{ ...d, diag: { ...DIAG, connections: { ...WIRE_DIAG_CONNECTIONS, tts } } }}><TtsSecretRows pending={false} /></Harness>);
    expect(document.querySelector('[data-row="ttsToken"]')?.textContent).toContain(note);
  });

  it('tests the token on screen against the voice in use and shows the first audio time', async () => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    fireEvent.change(screen.getByLabelText('令牌', { selector: 'input' }), { target: { value: ' secret ' } });
    await click(screen.getByRole('button', { name: '测试' }));
    expect(sent('POST', '/voice/test')).toEqual({ token: 'secret' });
    expect(testRow()?.textContent).toContain('通过 │ 首包延迟 320 ms');
  });

  it('leaves an empty token out of the test', async () => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(sent('POST', '/voice/test')).toEqual({});
  });

  it('leaves the token just saved to agentd once the field is empty again', async () => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    fireEvent.change(screen.getByLabelText('令牌', { selector: 'input' }), { target: { value: 'secret' } });
    await click(screen.getByRole('button', { name: '保存' }));
    await click(screen.getByRole('button', { name: '测试' }));
    expect(sent('POST', '/voice/test')).toEqual({});
  });

  it('reads /diag/state again after saving the token', async () => {
    const reload = vi.fn();
    render(<Harness d={d} reload={reload}><TtsSecretRows pending={false} /></Harness>);
    fireEvent.change(screen.getByLabelText('令牌', { selector: 'input' }), { target: { value: 'secret' } });
    expect(reload).not.toHaveBeenCalled();
    await click(screen.getByRole('button', { name: '保存' }));
    expect(reload).toHaveBeenCalledWith('diag');
  });

  it.each([
    ['http_401', '令牌无效'],
    ['invalid_url', '地址格式无效：须以 http:// 或 https:// 开头'],
    ['unreachable', '无法连接'],
    ['http_502', '服务返回状态码 502'],
    ['bad_stream', '返回值非有效语音流'],
    ['timeout', '超时'],
  ])('shows the failure %s as %s', async (reason, text) => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    request.mockResolvedValueOnce({ status: 200, body: { ok: false, first_audio_ms: null, total_ms: null, reason } } as never);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(testRow()?.textContent).toContain(text);
  });

  it('says the voice is not enabled when agentd has no relay', async () => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    request.mockResolvedValueOnce({ status: 503, body: { error: 'no_tts' }, error: { code: 'no_tts' } } as never);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(testRow()?.textContent).toContain('语音服务未启用');
  });

  it('saves the token through POST /voice/token and never reads it back', async () => {
    render(<Harness d={d}><TtsSecretRows pending={false} /></Harness>);
    const token = screen.getByLabelText('令牌', { selector: 'input' }) as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    fireEvent.change(token, { target: { value: 'secret' } });
    await click(screen.getByRole('button', { name: '保存' }));
    expect(sent('POST', '/voice/token')).toEqual({ token: 'secret' });
    expect(token.value).toBe('');
    expect(screen.getByTestId('toast').textContent).toBe('令牌已保存');
  });
});

describe('AI 对话 over the AI tab', () => {
  it('holds the account and model rows under the switch and folds them into one line while it is off', async () => {
    const { unmount } = render(<Harness d={d} init={{ draft: { kernel: 'pi' } }}><KernelGroup /></Harness>);
    expect(screen.getByRole('switch', { name: '轻量 AI（对话、语音、记忆）' })).toBeTruthy();
    expect(document.querySelector('[data-row="svc"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: '模型' })).toBeTruthy();
    unmount();
    setPlugins({ 'plugins.light_ai': false });
    render(<Harness d={d} init={{ draft: { kernel: 'pi' } }}><KernelGroup /></Harness>);
    // The folded line also says what is gone while it is off.
    expect(screen.getByText(/未开启 │ 开启后可配置执行内核、账号与模型/).textContent).toContain('停用功能：日常对话、长期记忆与主动交互');
    expect(document.querySelector('[data-row="svc"]')).toBeNull();
    expect(screen.queryByRole('region', { name: '模型' })).toBeNull();
    expect(screen.queryByRole('region', { name: '当前内核' })).toBeNull();
  });
});

describe('资料范围 with picked handles', () => {
  it('creates a scope from two picked folders and revokes by scope_id', async () => {
    const root = { handle: 'h-root', displayName: '周报' };
    const out = { handle: 'h-out', displayName: '产物' };
    vi.spyOn(window.agenticComplex!.files, 'pickFolder').mockResolvedValueOnce(root).mockResolvedValueOnce(out);
    // With a shell bridge the page reads the real clock; keep the fixture scope unexpired.
    d.scopes = d.scopes.map((x) => ({ ...x, expires_at: Date.now() / 1000 + 3600 }));
    render(<Harness d={d}><ActGroup /></Harness>);
    await click(screen.getByRole('button', { name: '添加文件夹…' }));
    expect(sent('POST', '/agent/scopes')).toEqual({ roots: [root], output_root: out });
    await click(screen.getByRole('button', { name: '撤销授权' }));
    // agentd's revoke stops every run and clears what the continuous observation and the memory journal hold, not only this scope's.
    const ask = screen.getByRole('dialog').textContent;
    for (const what of ['所有运行中的任务与对话都将中止', '持续观察记录的分析上下文与摘要将被清空', '每日简报中的观察摘要将被清空', '记忆整理记录中的原文引用将被清除']) expect(ask).toContain(what);
    expect(ask).not.toContain('用这个范围的任务会停下');
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '撤销授权' }));
    expect(sent('POST', `/agent/scopes/${d.scopes[0]!.scope_id}/revoke`)).toEqual({});
  });
});

describe('errors', () => {
  it('reads offline as disconnected and a 409 as changed elsewhere, never raw codes', () => {
    expect(failure(new AgentdCallError(0, 'offline', undefined, null, 'x')).text).toBe('后台已断开');
    expect(failure(new AgentdCallError(409, 'extensions_version_changed', undefined, {}, 'x'))).toEqual({ text: '已在别处更新', conflict: true });
    expect(failure(new AgentdCallError(400, 'some_new_code', undefined, {}, 'x')).text).toBe('后台没有接受这次修改');
  });
});
