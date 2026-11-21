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
import { failure, readGateEvents } from '../../src/pages/settings/api';
import { runtimeView, SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { AdvGroup } from '../../src/pages/settings/groups/Adv';
import { DataGroup } from '../../src/pages/settings/groups/Data';
import { KernelGroup } from '../../src/pages/settings/groups/Kernel';
import { KeysGroup } from '../../src/pages/settings/groups/Keys';
import { ModelGroup } from '../../src/pages/settings/groups/Model';
import { PermGroup } from '../../src/pages/settings/groups/Perm';
import { PrivacyGroup } from '../../src/pages/settings/groups/Privacy';
import { SpeakGroup, tomorrowMorning } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel, type ModelInit } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { searchSettings } from '../../src/pages/settings/registry';
import type { WireBlacklist, WireDiagSlice, WireModelSettings, WireScope } from '../../src/pages/settings/wire';

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

function Harness({ d, init = {}, children }: { d: Loaded; init?: ModelInit; children: ReactNode }) {
  const view = useMemo(() => diagView(d.diag), [d.diag]);
  const model = useSettingsModel(init, { native: d.native, runtime: d.runtime, models: d.models, pauses: view.pauses });
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
    runs: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'granted',
    goRow: () => {},
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      {children}
      {model.confirm && (
        <div role="dialog" aria-label={model.confirm.title}>
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
const pick = async (select: string, option: string) => {
  await click(screen.getByRole('button', { name: select }));
  await click(screen.getByRole('option', { name: option }));
};

describe('native rows (settings.schema / read / save)', () => {
  it('shows the schema options and saves the option value, not the label', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const tts = screen.getByRole('radiogroup', { name: '语音合成来源' });
    expect(within(tts).getAllByRole('radio').map((r) => r.textContent)).toEqual(['远端', '关闭（无语音）']);
    await click(within(tts).getByRole('radio', { name: '关闭（无语音）' }));
    expect(save).toHaveBeenCalledWith({ tts: 'local' });
  });

  it('picking the option already chosen sends nothing (Seg fires onChange for it too)', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const tts = screen.getByRole('radiogroup', { name: '语音合成来源' });
    const chosen = within(tts).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    expect(chosen?.textContent).toBe('远端');
    await click(chosen!);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByTestId('toast')).toBeNull();
    await click(within(tts).getByRole('radio', { name: '关闭（无语音）' }));
    expect(save).toHaveBeenCalledWith({ tts: 'local' });
  });

  it('marks a restart from the schema flag only (backend yes, notification routing no)', async () => {
    render(<Harness d={d}><SpeakGroup /><ApplyBar /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '完成' })).getByRole('radio', { name: '不提示' }));
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
    await click(screen.getByRole('switch', { name: '静音' }));
    expect(screen.getByRole('region', { name: '未应用的改动' }).textContent).toContain('1 项重启后台服务后生效');
  });

  it('a refused save shows a fixed reason instead of a fake saved toast; the shell text goes to the console', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [], error: 'voice_service: remote' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness d={d}><SpeakGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '语音合成来源' })).getByRole('radio', { name: '关闭（无语音）' }));
    expect(screen.getByTestId('toast').textContent).toBe('没有保存「语音合成来源」：桌面端没有接受这次修改');
    expect(warn).toHaveBeenCalledWith('settings.save refused', 'voice_service: remote');
  });

  it('asks before a destructive switch goes off, logs consent, then saves', async () => {
    const consent = vi.spyOn(window.agenticComplex!.settings, 'confirmDestructive');
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '窗口文字' }));
    expect(save).not.toHaveBeenCalled();
    await click(within(screen.getByRole('dialog', { name: '关闭「窗口文字」并删除已收集的内容？' })).getByRole('button', { name: '关闭并删除' }));
    expect(consent).toHaveBeenCalledWith('wintext');
    expect(save).toHaveBeenCalledWith({ wintext: false });
  });

  it('the delete confirm says how many records go, from settings.previewDestructive', async () => {
    const preview = vi.spyOn(window.agenticComplex!.settings, 'previewDestructive').mockResolvedValue({ total: 214, counts: { task_understanding: 214 } });
    for (const [id, label] of [['wintext', '窗口文字'], ['web', '网页正文'], ['typing', '输入的文字']] as const) {
      const on = { ...d, native: { ...d.native, saved: { ...d.native.saved, [id]: true } } };
      const ui = render(<Harness d={on}><PrivacyGroup /></Harness>);
      await click(screen.getByRole('switch', { name: label }));
      expect(preview).toHaveBeenLastCalledWith(id);
      expect(screen.getByRole('dialog', { name: `关闭「${label}」并删除已收集的内容？` }).textContent).toContain('将删除 214 条');
      ui.unmount();
    }
  });

  it('a preview that fails says 条数未知 and still lets the switch go off', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'previewDestructive').mockRejectedValue({ code: 'failed', detail: 'agentd 503' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '窗口文字' }));
    const dialog = screen.getByRole('dialog', { name: '关闭「窗口文字」并删除已收集的内容？' });
    expect(dialog.textContent).toContain('条数未知');
    expect(dialog.textContent).not.toContain('agentd 503');
    await click(within(dialog).getByRole('button', { name: '关闭并删除' }));
    expect(save).toHaveBeenCalledWith({ wintext: false });
  });

  it('turns observation off without a confirm (records stay)', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    await click(screen.getByRole('switch', { name: '观察屏幕活动' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).toHaveBeenCalledWith({ observe: false });
  });

  it('恢复默认 saves the schema defaults: every read switch ends up off', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const consent = vi.spyOn(window.agenticComplex!.settings, 'confirmDestructive');
    render(<Harness d={d}><AdvGroup /></Harness>);
    await click(screen.getByRole('button', { name: '恢复默认…' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '恢复默认' }));
    expect(consent.mock.calls.map((c) => c[0]).sort()).toEqual(['web', 'wintext']);
    expect(save).toHaveBeenCalledWith({ rest: '0', wintext: false, web: false, shot: false });
    expect(screen.getByTestId('toast').textContent).toBe('已恢复默认设置');
  });

  it('恢复默认 says up front which reading switches go off', async () => {
    render(<Harness d={d}><AdvGroup /></Harness>);
    await click(screen.getByRole('button', { name: '恢复默认…' }));
    expect(screen.getByRole('dialog').textContent).toContain('会关掉：窗口文字、网页正文、屏幕识读时附上截图；另有 1 项选项回到默认');
  });

  it('marks a restart by each row\'s schema even when the shell answers restart=backend', async () => {
    vi.spyOn(window.agenticComplex!.settings, 'save').mockResolvedValue({ restart: 'backend', notApplied: [] });
    render(<Harness d={d}><SpeakGroup /><ApplyBar /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '完成' })).getByRole('radio', { name: '不提示' }));
    expect(screen.queryByRole('region', { name: '未应用的改动' })).toBeNull();
  });
});

describe('native app actions', () => {
  it('deletes all local data behind the shell\'s own confirm only', async () => {
    const wipe = vi.spyOn(window.agenticComplex!.settings, 'wipeLocalData');
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '删除所有…' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('toast').textContent).toBe('已删除所有本地数据');
  });

  it('sends the test cards and opens the folders in a shell without avatar or revealInFinder', async () => {
    const caps = window.agenticComplex!.capabilities as { avatar: boolean; revealInFinder: boolean };
    caps.avatar = false;
    caps.revealInFinder = false;
    try {
      const action = vi.spyOn(window.agenticComplex!.app, 'action');
      render(<Harness d={d}><SpeakGroup /><DataGroup /><AdvGroup /></Harness>);
      await click(screen.getByRole('button', { name: '测试审批卡' }));
      await click(screen.getByRole('button', { name: '测试播报' }));
      await click(screen.getByRole('button', { name: '打开文件夹' }));
      await click(screen.getByRole('button', { name: '打开日志目录' }));
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
    const check = vi.spyOn(window.agenticComplex!.settings, 'validateHotkey').mockResolvedValue({ ok: false, conflictWith: '临时全部点穿' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    const { container } = render(<Harness d={d}><KeysGroup /></Harness>);
    await click(within(container.querySelector('[data-row="hk_hide"]')!).getByRole('button', { name: '更改' }));
    expect(screen.getByTestId('toast').textContent).toBe('⌃⌥P 已被「临时全部点穿」占用，「显示 / 隐藏角色」保持不变');
    check.mockRejectedValue({ code: 'invalid_hotkey' });
    await click(within(container.querySelector('[data-row="hk_hide"]')!).getByRole('button', { name: '更改' }));
    expect(screen.getByTestId('toast').textContent).toBe('⌃⌥P 不能用作热键：要带 ⌃、⌥ 或 ⌘，或者用 F1–F12');
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
    await click(within(row).getByRole('button', { name: '选择' }));
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
    expect(within(grid).getByRole('row', { name: /Pi/ }).textContent).toContain('随应用提供');
    expect(screen.queryByText('内核原生会话恢复')).toBeNull();
    expect(document.querySelector('[data-row="maxCost"]')).toBeNull();
    expect(document.querySelector('[data-row="cap-native_shell"]')?.textContent).toContain('已接通');
  });

  it('shows the cost cap as an editable row only on Pi', async () => {
    render(<Harness d={d} init={{ draft: { kernel: 'pi' } }}><KernelGroup /></Harness>);
    const row = document.querySelector('[data-row="maxCost"]') as HTMLElement;
    expect(row).not.toBeNull();
    await click(within(row).getByRole('button', { name: '单次费用上限 增加' }));
    expect(within(row).getByRole('button', { name: '单次费用上限 减少' }).hasAttribute('disabled')).toBe(false);
    cleanup();
    render(<Harness d={d} init={{ draft: { kernel: 'codex' } }}><KernelGroup /></Harness>);
    expect(document.querySelector('[data-row="maxCost"]')).toBeNull();
  });

  it('switches history retention through a PUT', async () => {
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '历史归档' })).getByRole('radio', { name: '30 天' }));
    expect(sent('PUT', '/character/runtime')).toMatchObject({ history_retention: '30d' });
  });
});

describe('pi 账号与凭据', () => {
  it('applies the provider through POST /model/settings and tests with the real round trip', async () => {
    render(<Harness d={d} init={{ draft: { svc: 'openai' } }}><ApplyBar /></Harness>);
    await click(screen.getByRole('button', { name: '应用' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'openai' });
    cleanup();
    render(<Harness d={d}><ModelGroup /></Harness>);
    await click(screen.getByRole('button', { name: '测试' }));
    expect(sent('POST', '/model/test')).toEqual({});
    expect(document.querySelector('[data-row="mtest"]')?.textContent).toMatch(/已连通 │ Codex │ claude-haiku-5-5 │ \d+ ms/);
  });

  it('saves and removes the API key for the provider on screen', async () => {
    render(<Harness d={{ ...d, models: { ...d.models, provider: 'anthropic' } }}><ModelGroup /></Harness>);
    fireEvent.change(document.querySelector('input[aria-label="API Key"]')!, { target: { value: 'sk-ant-0123456789' } });
    await click(within(document.querySelector('[data-row="apikey"]')!).getByRole('button', { name: '保存' }));
    expect(sent('POST', '/model/settings')).toEqual({ provider: 'anthropic', api_key: 'sk-ant-0123456789' });
    await click(within(document.querySelector('[data-row="apikey"]')!).getByRole('button', { name: '移除' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '移除' }));
    expect(request.mock.calls.filter((c) => c[1] === '/model/settings').at(-1)?.[2]).toEqual({ provider: 'anthropic', clear_key: true });
  });

  it('unbinds a coding tool through agentd and shows the hook state from /diag/state', async () => {
    render(<Harness d={d}><ModelGroup /></Harness>);
    const claude = document.querySelector('[data-row="hooks"]')!;
    expect(claude.textContent).toContain('已接入');
    expect(document.querySelector('[data-row="hooks2"]')?.textContent).toContain('已安装，未收到事件');
    await click(within(claude as HTMLElement).getByRole('button', { name: '解绑' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '解绑' }));
    expect(sent('POST', '/integrations/hooks/disconnect')).toEqual({ target: 'claude' });
  });
});

describe('隐私 and 数据 through agentd', () => {
  it('lists the blacklist and adds, removes and restores through /blacklist', async () => {
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    expect(screen.getByText(/网站 │ icbc\.com\.cn/)).toBeTruthy();
    await click(screen.getByRole('button', { name: '移除 icbc.com.cn' }));
    expect(sent('DELETE', '/blacklist')).toEqual({ field: 'domains', value: 'icbc.com.cn' });
    fireEvent.change(screen.getByLabelText('要排除的内容'), { target: { value: '微信' } });
    await click(screen.getByRole('switch', { name: '顺手删掉已记下的' }));
    await click(screen.getByRole('button', { name: '添加' }));
    expect(sent('POST', '/blacklist')).toBeUndefined();
    const ask = screen.getByRole('dialog', { name: '添加「微信」并删掉已记下的？' });
    expect(ask.textContent).toContain('不能恢复');
    await click(within(ask).getByRole('button', { name: '添加并删除' }));
    expect(sent('POST', '/blacklist')).toEqual({ field: 'app_names', value: '微信', delete_existing: true });
    expect(screen.getByTestId('toast').textContent).toBe('已添加「微信」，删掉已记下的 4 条');
    await click(screen.getByRole('button', { name: '恢复默认排除' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '恢复默认' }));
    expect(sent('POST', '/blacklist/defaults')).toEqual({});
  });

  it('switches to allow mode and adds and removes allow entries with list allow', async () => {
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    await click(within(screen.getByRole('radiogroup', { name: '读取方式' })).getByRole('radio', { name: '只读名单里的' }));
    expect(sent('POST', '/blacklist/mode')).toEqual({ mode: 'allow' });
    // The mock keeps the mode across tests; put it back before the next one reads it.
    await window.agenticComplex!.agentd.request('POST', '/blacklist/mode', { mode: 'deny' });
    cleanup();
    render(<Harness d={{ ...d, blacklist: { ...d.blacklist, mode: 'allow' } }}><PrivacyGroup /></Harness>);
    expect(screen.getByText('只读取这些应用和网站')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复默认排除' })).toBeNull();
    await click(screen.getByRole('button', { name: '移除 github.com' }));
    expect(sent('DELETE', '/blacklist')).toEqual({ list: 'allow', field: 'domains', value: 'github.com' });
    fireEvent.change(screen.getByLabelText('要读取的内容'), { target: { value: 'Xcode' } });
    await click(screen.getByRole('button', { name: '添加' }));
    expect(sent('POST', '/blacklist')).toEqual({ list: 'allow', field: 'app_names', value: 'Xcode' });
    expect(screen.getByTestId('toast').textContent).toBe('已添加「Xcode」');
  });

  it('says nothing is read in allow mode with an empty allow list', () => {
    const blacklist: WireBlacklist = { ...d.blacklist, mode: 'allow', allow: { bundle_ids: [], app_names: [], domains: [] } };
    render(<Harness d={{ ...d, blacklist }}><PrivacyGroup /></Harness>);
    expect(screen.getByText('什么都不读')).toBeTruthy();
  });

  it('pauses and resumes observation with whole minutes', async () => {
    render(<Harness d={d}><PrivacyGroup /></Harness>);
    await click(screen.getByRole('button', { name: '暂停 1 小时' }));
    expect(sent('PUT', '/observation/paused')).toEqual({ minutes: 60 });
    await click(screen.getByRole('button', { name: '现在恢复' }));
    expect(request.mock.calls.filter((c) => c[1] === '/observation/paused').at(-1)?.[2]).toEqual({ minutes: 0 });
  });

  it('deletes recent records and the activity log, and says how many', async () => {
    render(<Harness d={d}><DataGroup /></Harness>);
    await click(screen.getByRole('button', { name: '1 小时' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    expect(request).toHaveBeenCalledWith('DELETE', '/observation?range=1h', undefined);
    expect(screen.getByTestId('toast').textContent).toBe('已删掉最近 1 小时 看到的 28 条');
    await click(screen.getByRole('button', { name: '清空…' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '清空' }));
    expect(request).toHaveBeenCalledWith('DELETE', '/attention', undefined);
    expect(screen.getByTestId('toast').textContent).toBe('已清空活动记录 1180 条');
  });

  it('shows redactions, today\'s gate and the voice state from /diag/state', () => {
    render(<Harness d={d}><PrivacyGroup /><SpeakGroup /></Harness>);
    expect(document.querySelector('[data-row="mask"]')?.textContent).toContain('密钥 2 │ 邮箱 5 │ 电话 0');
    // The gate is a plate with a cumulative step chart and the cooldown list, not a bracket meter.
    const gate = document.querySelector('[data-row="gate"]');
    expect(gate?.textContent).toContain('今日发言闸门');
    expect(gate?.textContent).toContain('主动发言冷却 3 分');
    expect(document.querySelector('[data-row="tts"]')?.textContent).toContain('远端不通');
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
  const sourceSeg = () => screen.queryByRole('radiogroup', { name: '语音合成来源' });

  it('shows「语音不可用」without the voice service row for a build with no TTS', () => {
    const { tts: _unset, ...saved } = d.native.saved;
    render(<Harness d={{ ...withTts(WIRE_TTS.off), native: { ...d.native, saved } }}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('语音不可用');
    expect(sourceSeg()).toBeNull();
  });

  it('keeps the voice service row for voice_service local, with local named as no voice', () => {
    render(<Harness d={withTts(WIRE_TTS.off, { tts: 'local' })}><SpeakGroup /></Harness>);
    expect(row()?.textContent).not.toContain('语音不可用');
    expect(within(sourceSeg()!).getByRole('radio', { name: '关闭（无语音）' })).toBeTruthy();
    expect(row()?.textContent).toContain('不发声，只显示文字');
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
    expect(row()?.textContent).toContain('没有连上语音服务，只显示文字');
    unmount();
    render(<Harness d={withTts(WIRE_TTS.ready)}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('角色隐藏时，主动发言只显示文字');
    expect(row()?.textContent).not.toContain('没有连上语音服务');
  });

  it('labels the external source', () => {
    render(<Harness d={withTts({ ...WIRE_TTS.unreachable, provider: 'remote-ws' })}><SpeakGroup /></Harness>);
    expect(within(row() as HTMLElement).getByText('外部服务')).toBeTruthy();
    expect(row()?.textContent).toContain('远端不通');
  });

  it('counts the retry seconds down on an unreachable voice', () => {
    render(<Harness d={withTts({ ...WIRE_TTS.unreachable, retry_after_s: 12 })}><SpeakGroup /></Harness>);
    expect(row()?.textContent).toContain('远端不通 │ 12 秒后可重试');
  });

  it('reconnects an unreachable voice through POST /voice/reset and shows the state it answers', async () => {
    let answer: (r: { status: number; body: unknown }) => void = () => {};
    render(<Harness d={withTts(WIRE_TTS.unreachable)}><SpeakGroup /></Harness>);
    request.mockImplementationOnce(() => new Promise((ok) => (answer = ok as typeof answer)));
    await click(within(row() as HTMLElement).getByRole('button', { name: '重新连接' }));
    expect(request).toHaveBeenCalledWith('POST', '/voice/reset', {});
    expect(row()?.textContent).toContain('检测中');
    await act(async () => answer({ status: 200, body: { tts: { provider: 'remote-ws', state: 'ready', reason: null, retry_after_s: null } } }));
    expect(row()?.textContent).toContain('在线');
    expect(within(row() as HTMLElement).queryByRole('button', { name: '重新连接' })).toBeNull();
  });

  it('toasts the reason when the reset fails and shows the voice as before', async () => {
    render(<Harness d={withTts(WIRE_TTS.cold)}><SpeakGroup /></Harness>);
    request.mockResolvedValueOnce({ status: 0, body: null, error: { code: 'offline' } } as never);
    await click(within(row() as HTMLElement).getByRole('button', { name: '重新连接' }));
    expect(screen.getByTestId('toast').textContent).toBe('没能重新连接语音：后台已断开');
    expect(row()?.textContent).toContain('冷启动（第一句会慢）');
  });
});

describe('识别语言', () => {
  it('offers follow-the-system, Chinese and English and saves the locale', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const asr = screen.getByRole('radiogroup', { name: '识别语言' });
    expect(within(asr).getAllByRole('radio').map((r) => r.textContent)).toEqual(['跟随系统', '中文', 'English']);
    await click(within(asr).getByRole('radio', { name: 'English' }));
    expect(save).toHaveBeenCalledWith({ asr: 'en-US' });
  });
});

describe('回复语言', () => {
  it('sits after 识别语言 with its five choices and saves reply_language through PUT /character/runtime', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    expect(document.querySelector('[data-row="asr"] + [data-row="replyLang"]')).not.toBeNull();
    const reply = screen.getByRole('radiogroup', { name: '回复语言' });
    expect(within(reply).getAllByRole('radio').map((r) => r.textContent)).toEqual(['跟随对话', '简体中文', 'English', '日本語', '按内核设置']);
    expect(within(reply).getByRole('radio', { name: '跟随对话' }).getAttribute('aria-checked')).toBe('true');
    await click(within(reply).getByRole('radio', { name: '按内核设置' }));
    expect(sent('PUT', '/character/runtime')).toEqual({ reply_language: 'harness' });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('外部语音服务', () => {
  const local = (): Loaded => ({ ...d, native: { ...d.native, saved: { ...d.native.saved, tts: 'local' } } });
  const testRow = () => document.querySelector('[data-row="ttsTest"]');

  it('shows the address, token and test rows once the external source is picked', async () => {
    render(<Harness d={local()}><SpeakGroup /></Harness>);
    expect(screen.queryByRole('textbox', { name: '服务地址' })).toBeNull();
    expect(screen.queryByRole('button', { name: '测试连接' })).toBeNull();
    await click(within(screen.getByRole('radiogroup', { name: '语音合成来源' })).getByRole('radio', { name: '远端' }));
    expect(screen.getByRole('textbox', { name: '服务地址' })).toBeTruthy();
    expect(document.querySelector('[data-row="ttsUrl"]')?.textContent).toContain('http 或 https 地址；不填时只出文字');
    expect(screen.getByLabelText('令牌', { selector: 'input' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeTruthy();
  });

  it('shows the tunnel host and ensure script only for the external source and saves them under their ids', async () => {
    const { unmount } = render(<Harness d={local()}><SpeakGroup /></Harness>);
    expect(screen.queryByRole('textbox', { name: 'SSH 转发主机' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '按需启动脚本' })).toBeNull();
    unmount();
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const host = screen.getByRole('textbox', { name: 'SSH 转发主机' });
    const script = screen.getByRole('textbox', { name: '按需启动脚本' });
    expect(host.getAttribute('placeholder')).toBe('ssh 主机名（可留空）');
    expect(script.getAttribute('placeholder')).toBe('远程主机上的绝对路径（可留空）');
    expect(document.querySelector('[data-row="ttsTunnelHost"]')?.textContent).toContain('留空就不建隧道');
    expect(document.querySelector('[data-row="ttsEnsureScript"]')?.textContent).toContain('留空就不按需启动');
    fireEvent.change(host, { target: { value: ' voice-box ' } });
    await act(async () => void fireEvent.blur(host));
    expect(save).toHaveBeenCalledWith({ ttsTunnelHost: 'voice-box' });
    fireEvent.change(script, { target: { value: '/srv/tts/ensure.sh' } });
    await act(async () => void fireEvent.blur(script));
    expect(save).toHaveBeenCalledWith({ ttsEnsureScript: '/srv/tts/ensure.sh' });
  });

  it('tests the address and token on screen and shows the first audio time', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const url = screen.getByRole('textbox', { name: '服务地址' });
    fireEvent.change(url, { target: { value: 'https://tts.example:8443' } });
    await act(async () => void fireEvent.blur(url));
    fireEvent.change(screen.getByLabelText('令牌', { selector: 'input' }), { target: { value: ' secret ' } });
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect(sent('POST', '/voice/test')).toEqual({ url: 'https://tts.example:8443', token: 'secret' });
    expect(testRow()?.textContent).toContain('通过 │ 首声 320 ms');
  });

  it('leaves an empty token out of the test', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect(Object.keys(sent('POST', '/voice/test') as object)).toEqual(['url']);
  });

  it('leaves an empty address out of the test, so agentd tests the voice in use', async () => {
    render(<Harness d={{ ...d, native: { ...d.native, saved: { ...d.native.saved, ttsUrl: '' } } }}><SpeakGroup /></Harness>);
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect(sent('POST', '/voice/test')).toEqual({});
  });

  it('tests with the token just saved, though the field is empty again', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    fireEvent.change(screen.getByLabelText('令牌', { selector: 'input' }), { target: { value: 'secret' } });
    await click(screen.getByRole('button', { name: '保存' }));
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect((sent('POST', '/voice/test') as { token?: string }).token).toBe('secret');
  });

  it.each([
    ['http_401', '令牌不对'],
    ['invalid_url', '地址不可用：要以 http:// 或 https:// 开头'],
    ['unreachable', '连不上'],
    ['http_502', '服务返回 502'],
    ['bad_stream', '返回的不是语音流'],
    ['timeout', '超时'],
  ])('shows the failure %s as %s', async (reason, text) => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    request.mockResolvedValueOnce({ status: 200, body: { ok: false, first_audio_ms: null, total_ms: null, reason } } as never);
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect(testRow()?.textContent).toContain(text);
  });

  it('says the voice is not enabled when agentd has no relay', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    request.mockResolvedValueOnce({ status: 503, body: { error: 'no_tts' }, error: { code: 'no_tts' } } as never);
    await click(screen.getByRole('button', { name: '测试连接' }));
    expect(testRow()?.textContent).toContain('语音没有启用');
  });

  it('saves the token through POST /voice/token and never reads it back', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
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

describe('喝水提醒', () => {
  it('shows the row with the 90 minute default from the preview data', () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    const row = screen.getByText('喝水提醒').closest('li, div[id], [data-row]') ?? document.body;
    expect(row.textContent).toContain('90 分钟');
  });

  it('is found by searching 喝水', () => {
    expect(searchSettings('喝水')).toContainEqual(expect.objectContaining({ id: 'water', group: 'speak' }));
  });

  it('is hidden when the shell schema has no water row', () => {
    const { water: _water, ...rows } = d.native.rows;
    render(<Harness d={{ ...d, native: { ...d.native, rows } }}><SpeakGroup /></Harness>);
    expect(screen.queryByText('喝水提醒')).toBeNull();
    expect(screen.getAllByText('休息提醒').length).toBeGreaterThan(0);
  });
});

describe('免打扰', () => {
  it('starts quiet with epoch seconds and switches meeting mode on and off', async () => {
    render(<Harness d={d}><SpeakGroup /></Harness>);
    await click(screen.getByRole('button', { name: '开始' }));
    await click(screen.getByRole('menuitem', { name: '1 小时' }));
    const until = (sent('PUT', '/observation/quiet') as { until: number }).until;
    expect(Number.isInteger(until)).toBe(true);
    expect(document.querySelector('[data-row="dnd_quiet"]')?.textContent).toContain('还剩');
    await click(screen.getByRole('switch', { name: '开会模式' }));
    expect(sent('PUT', '/observation/meeting')).toEqual({ on: true });
  });

  it('「到明早」is the next 07:00', () => {
    expect(new Date(tomorrowMorning(new Date(2026, 9, 29, 14, 32).getTime())).toString()).toBe(new Date(2026, 9, 30, 7, 0).toString());
    expect(new Date(tomorrowMorning(new Date(2026, 9, 29, 6, 0).getTime())).toString()).toBe(new Date(2026, 9, 29, 7, 0).toString());
  });
});

describe('资料范围 with picked handles', () => {
  it('creates a scope from two picked folders and revokes by scope_id', async () => {
    const root = { handle: 'h-root', displayName: '周报' };
    const out = { handle: 'h-out', displayName: '产物' };
    vi.spyOn(window.agenticComplex!.files, 'pickFolder').mockResolvedValueOnce(root).mockResolvedValueOnce(out);
    // With a shell bridge the page reads the real clock; keep the fixture scope unexpired.
    d.scopes = d.scopes.map((x) => ({ ...x, expires_at: Date.now() / 1000 + 3600 }));
    render(<Harness d={d}><PermGroup /></Harness>);
    await click(screen.getByRole('button', { name: '添加文件夹…' }));
    expect(sent('POST', '/agent/scopes')).toEqual({ roots: [root], output_root: out });
    await click(screen.getByRole('button', { name: '撤销授权' }));
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

describe('settings page limits', () => {
  it('reads the gate events with a limit within trace_store PAGE_MAX (200)', async () => {
    await readGateEvents('2026-01-01T00:00:00+08:00').catch(() => undefined);
    const path = request.mock.calls.map((c) => c[1]).find((p) => p.startsWith('/trace/decisions'))!;
    const limit = Number(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('limit'));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(200);
  });
});
