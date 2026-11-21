// First-run guide (pages/onboarding): steps over the bridge's onboarding ops, the demo layer and the copy helpers.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge, type FakeBridgeOptions } from '../../src/bridge/fake';
import type { AgenticComplexBridge, OnboardingOps } from '../../src/bridge/protocol';
import { WIRE_RUNTIME } from '../../src/mock/fixtures/wire/system';
import { commandLabel, footHint, keyLabel, readyLead, shortCommand } from '../../src/pages/onboarding/copy';
import { VoiceStep } from '../../src/pages/onboarding/Voice';
import { demoOps, demoReady } from '../../src/pages/onboarding/demo';
import { OnboardingPage } from '../../src/pages/onboarding/Page';
import { navigate } from '../../src/shell/nav';

vi.mock('../../src/shell/nav', async (orig) => ({ ...(await orig()), navigate: vi.fn() }));

let calls: string[];
let copied: string[];

function install(over: Partial<OnboardingOps> = {}, routes: FakeBridgeOptions['routes'] = []) {
  const fake = createFakeBridge({ surface: 'onboarding', still: true, routes });
  const log = <K extends keyof OnboardingOps>(k: K) =>
    ((...a: unknown[]) => {
      calls.push(`${k}${a.length && a[0] !== undefined ? ` ${JSON.stringify(a[0])}` : ''}`);
      return (fake.onboarding[k] as (...x: unknown[]) => unknown)(...a);
    }) as OnboardingOps[K];
  const onboarding: OnboardingOps = {
    state: log('state'),
    advance: log('advance'),
    back: log('back'),
    skip: log('skip'),
    complete: log('complete'),
    requestPermission: log('requestPermission'),
    openSettings: log('openSettings'),
    onVoiceTrial: fake.onboarding.onVoiceTrial,
    ...over,
  };
  const bridge: AgenticComplexBridge = { ...fake, onboarding, clipboard: { writeText: async (t) => void copied.push(t) } };
  window.agenticComplex = bridge;
}

function mount(search = '') {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(<RouterProvider router={router} />);
}

const guide = () => screen.getByRole('dialog');
const step = () => guide().getAttribute('data-step');
const press = (name: string | RegExp) => fireEvent.click(within(guide()).getByRole('button', { name }));

beforeEach(() => {
  calls = [];
  copied = [];
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('onboarding page', () => {
  it('opens full screen on step 1 with the five permissions, the page index and the tally', async () => {
    install();
    mount();
    await screen.findByRole('button', { name: '查看可选权限' });
    press('查看可选权限');
    const list = await screen.findByRole('list', { name: '系统权限' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(guide().getAttribute('aria-label')).toBe('首次设置 │ 开始使用 Agentic Complex');
    expect(guide().parentElement).toBe(document.body);
    expect(within(guide()).getByLabelText('第 1 步，共 4 步').textContent).toBe('01/04');
    expect(within(guide()).getByText('2/5 已允许')).toBeTruthy();
    expect(within(guide()).queryByText('1/2 已接入')).toBeNull();
    // The highlight ring marks the one row that still needs System Settings.
    expect(list.querySelector('[data-kind="accessibility"] [data-guide-ring]')).not.toBeNull();
    expect(list.querySelectorAll('[data-guide-ring]')).toHaveLength(1);
    // Only accessibility (undetermined, granted in System Settings) needs the settings button.
    const buttons = within(list).getAllByRole('button', { name: /前往系统设置/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(calls).toContain('openSettings "accessibility"'));
  });

  it('walks steps 1 → 2 → 3 → ready and saves the call name on the way', async () => {
    install();
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    const name = within(guide()).getByRole('textbox', { name: '名字' });
    expect((name as HTMLInputElement).value).toBe('阿砚');
    fireEvent.change(name, { target: { value: '小林' } });
    expect(within(guide()).getByText('称呼 小林')).toBeTruthy();
    press(/^下一步/);
    await waitFor(() => expect(step()).toBe('3'));
    expect(calls).toContain('advance {"callName":"小林","birthday":""}');

    const codex = guide().querySelector('[data-hook="codex"]') as HTMLElement;
    expect(within(codex).getAllByRole('button', { name: /复制/ })).toHaveLength(3);
    fireEvent.click(within(codex).getAllByRole('button', { name: /复制/ })[1] as HTMLElement);
    await waitFor(() => expect(copied[0]).toMatch(/\/bin\/agentic-complex-hook' --target codex$/));
    expect(within(codex).getByText('python3 …/install_hooks.py --target codex')).toBeTruthy();

    press(/^完成设置/);
    await waitFor(() => expect(step()).toBe('4'));
    expect(calls).not.toContain('complete');
    expect(within(guide()).getByText('权限 2 / 5，称呼 小林，编码工具 1 / 2')).toBeTruthy();
    press(/开始对话/);
    await waitFor(() => expect(calls).toContain('complete "chat"'));
  });

  it('改填 API Key on step 3 completes to model and lands on pi 账号与凭据', async () => {
    const none = { ...WIRE_RUNTIME, ready: false, error: 'local_runtime_missing', installed_runtimes: [], selected_runtime: null };
    install({}, [{ method: 'GET', path: '/character/runtime', handler: () => ({ status: 200, body: none }) }]);
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    press(/^下一步/);
    await waitFor(() => expect(step()).toBe('3'));
    fireEvent.click(await within(document.body).findByRole('button', { name: '改填 API Key（DeepSeek / OpenAI 兼容）' }));
    await waitFor(() => expect(calls).toContain('complete "model"'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ page: 'settings', group: 'model' }));
  });

  it('goes back through the bridge and from the closing screen locally', async () => {
    install();
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    press(/^跳过/);
    await waitFor(() => expect(step()).toBe('3'));
    press(/^跳过/);
    await waitFor(() => expect(step()).toBe('4'));
    press('上一步');
    await waitFor(() => expect(step()).toBe('3'));
    expect(calls.filter((c) => c === 'back')).toHaveLength(0);
    // The media panel's left arrow goes back one step through the bridge.
    press('上一页');
    await waitFor(() => expect(step()).toBe('2'));
    press('上一页');
    await waitFor(() => expect(step()).toBe('1'));
    expect(calls.filter((c) => c === 'back')).toHaveLength(2);
  });

  it('先使用角色 on step 1 closes the guide for later', async () => {
    install();
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^先使用角色/);
    await waitFor(() => expect(calls).toContain('skip'));
  });

  it('a failed read keeps 先使用角色 next to 重试, and keeps the first-run choice visible', async () => {
    install({
      state: async () => {
        throw { code: 'offline', detail: '' };
      },
    });
    mount();
    expect(await within(document.body).findByText('没有连上桌面端，请重试')).toBeTruthy();
    expect(within(guide()).getByRole('button', { name: '重试' })).toBeTruthy();
    expect(within(guide()).queryByRole('button', { name: /^继续/ })).toBeNull();
    expect(guide().textContent).toContain('现在打开角色');
    press(/^先使用角色/);
    await waitFor(() => expect(calls).toContain('skip'));
  });

  it('shows a failed save in the footer and stays on step 2', async () => {
    install({
      advance: async () => {
        const s = await createFakeBridge({ surface: 'onboarding', still: true }).onboarding.state();
        return { ...s, step: 2, saveError: '称呼没有存上，请重试' };
      },
    });
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(within(guide()).getByRole('alert').textContent).toBe('称呼没有存上，请重试'));
    expect(step()).toBe('2');
  });

  it('reads an unreadable guide as an error with retry', async () => {
    let fail = true;
    install({
      state: async () => {
        if (fail) throw { code: 'offline', detail: '' };
        return createFakeBridge({ surface: 'onboarding', still: true }).onboarding.state();
      },
    });
    mount();
    const alert = await within(document.body).findByRole('alert');
    expect(alert.textContent).toContain('没有连上桌面端，请重试');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await within(document.body).findByRole('button', { name: '查看可选权限' });
  });

  it('shows the pushed push-to-talk try on step 2', async () => {
    let push: ((t: { levels: number[]; elapsed: string; transcript: string }) => void) | null = null;
    install({ onVoiceTrial: (cb) => ((push = cb), () => {}) });
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    act(() => push?.({ levels: [4, 9, 14], elapsed: '00:03', transcript: '今天先到这' }));
    expect(within(guide()).getByText('今天先到这')).toBeTruthy();
    expect(within(guide()).getByLabelText('时长 00:03')).toBeTruthy();
  });

  it('step 2 has the 陪伴模式 switch and only a click sends PUT /proactive/settings', async () => {
    install();
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    const toggle = await within(guide()).findByRole('switch', { name: '让她偶尔主动搭话（陪伴模式）' });
    await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/proactive/settings', undefined));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(request.mock.calls.filter(([m, p]) => m === 'PUT' && p === '/proactive/settings')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('asks for the undecided microphone from step 2', async () => {
    install();
    mount();
    await within(document.body).findByRole('button', { name: '查看可选权限' });
    press(/^继续/);
    await waitFor(() => expect(step()).toBe('2'));
    press('允许麦克风');
    await waitFor(() => expect(calls).toContain('requestPermission "microphone"'));
    await waitFor(() => expect(within(guide()).queryByRole('button', { name: '允许麦克风' })).toBeNull());
  });
});

describe('onboarding demo layer', () => {
  const base = () => createFakeBridge({ surface: 'onboarding', still: true }).onboarding;

  it('sparse is a new Mac: nothing granted or hooked up, no name and no try', async () => {
    const s = await demoOps(base(), 'sparse', null).state();
    expect(s.permissions.filter((p) => p.state === 'granted')).toHaveLength(0);
    expect(s.permissions.find((p) => p.kind === 'loginItem')).toMatchObject({ state: 'undetermined', needsSystemSettings: true });
    expect(s.callName).toBe('');
    expect(s.hooks.every((h) => !h.connected)).toBe(true);
    expect(s.trial.levels).toEqual([]);
  });

  it('denied refuses the microphone until System Settings grants it', async () => {
    const ops = demoOps(base(), 'denied-step2', null);
    const s = await ops.state();
    expect(s.step).toBe(2);
    expect(s.permissions.find((p) => p.kind === 'microphone')).toMatchObject({ state: 'denied', needsSystemSettings: true });
    const after = await ops.openSettings('microphone');
    expect(after.permissions.find((p) => p.kind === 'microphone')).toMatchObject({ state: 'granted', needsSystemSettings: false });
  });

  it('opens later steps and the closing screen, and fails on state=error', async () => {
    expect((await demoOps(base(), 'step3', null).state()).step).toBe(3);
    expect(demoReady('step4')).toBe(true);
    expect(demoReady('sparse')).toBe(false);
    await expect(demoOps(base(), null, 'error').state()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('onboarding copy', () => {
  it('names the talk key like the native hotkey label', () => {
    expect(keyLabel('right_option')).toBe('右⌥');
    expect(keyLabel('control+option+v')).toBe('⌃⌥V');
  });

  it('says the talk key is not set when it is empty instead of naming 右⌥', () => {
    expect(keyLabel('')).toBe('');
    expect(readyLead('')).not.toContain('右⌥');
    expect(readyLead('')).toContain('设置 › 快捷键');
    expect(readyLead('⌃⌥V')).toContain('按住 ⌃⌥V 说话');
    render(<VoiceStep mic={undefined} trial={{ levels: [], elapsed: '0.0s', transcript: '' }} keycap=""
      profile={{ callName: '', birthday: '' }} onProfile={() => {}} onOpen={() => {}} onRequest={() => {}} />);
    expect(document.body.textContent).toContain('还没设置按住说话的热键');
    expect(document.body.textContent).not.toMatch(/按住\s*说一句话|按住\s*试说/);
  });

  it('shows the release default keys and says where to change the talk key', () => {
    expect(keyLabel('right_option')).toBe('右⌥');
    expect(keyLabel('control+option+space')).toBe('⌃⌥Space');
    expect(readyLead(keyLabel('right_option'))).toContain('按住 右⌥ 说话');
    render(<VoiceStep mic={undefined} trial={{ levels: [], elapsed: '0.0s', transcript: '' }} keycap={keyLabel('right_option')}
      profile={{ callName: '', birthday: '' }} onProfile={() => {}} onOpen={() => {}} onRequest={() => {}} />);
    expect(document.body.textContent).toMatch(/按住\s*右⌥\s*说一句话/);
    expect(document.body.textContent).toContain('可在 设置 › 快捷键 中更换');
  });

  it('shortens the bundled installer and labels each step', () => {
    const cmd = "'/Applications/Agentic Complex.app/Contents/Resources/runtime/python/bin/python3' '/Applications/Agentic Complex.app/x/install_hooks.py' --target codex --dry-run";
    expect(shortCommand(cmd)).toBe('python3 …/install_hooks.py --target codex --dry-run');
    expect(shortCommand('python3 /opt/agentd/tools/install_hooks.py --target claude')).toBe('python3 …/install_hooks.py --target claude');
    const fixed = "'/A/python3' '/A/install_hooks.py' --hook-script '/Users/x/Library/Application Support/local.agenticcomplex.companion/bin/agentic-complex-hook' --target codex --dry-run";
    expect(shortCommand(fixed)).toBe('python3 …/install_hooks.py --target codex --dry-run');
    const windows = '"C:\\Users\\O Neil\\Agentic Complex\\python\\python.exe" -I -B "C:\\Users\\O Neil\\Agentic Complex\\agentd\\tools\\install_hooks.py" --hook-script "C:\\Users\\x\\bin\\agentic-complex-hook.cmd" --target codex --dry-run';
    expect(shortCommand(windows)).toBe('python …\\install_hooks.py --target codex --dry-run');
    expect(commandLabel(windows)).toBe('预览改动');
    expect(commandLabel(cmd)).toBe('预览改动');
    expect(commandLabel('/hooks')).toBe('在 Codex 中信任 hooks');
    expect(commandLabel('python3 x/install_hooks.py --target codex')).toBe('执行安装');
  });

  it('puts denied permissions before the step hint', () => {
    const mic = { kind: 'microphone' as const, title: '麦克风与语音识别', purpose: '', state: 'denied' as const, needsSystemSettings: true };
    expect(footHint(2, [mic], null)).toEqual({ text: '麦克风与语音识别已拒绝：按住说话不可用，可前往系统设置打开', danger: true });
    expect(footHint(3, [], null)).toEqual({ text: '不接入也可使用；之后可在 设置 › pi 账号与凭据 中接入', danger: false });
    expect(footHint(1, [mic], '没存上')).toEqual({ text: '没存上', danger: true });
  });
});
