// First-run guide (pages/onboarding): 角色 → 对话 → 声音 → 完成 over the bridge's onboarding ops, each row saving the settings page's value.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, OnboardingOps, OnboardingState } from '../../src/bridge/protocol';
import { demoOps } from '../../src/pages/onboarding/demo';
import { stepMarks } from '../../src/pages/onboarding/marks';
import { OnboardingPage } from '../../src/pages/onboarding/Page';

let calls: string[];
/** Every `permissions.*` call the guide makes. */
let asked: string[];
/** Every `settings.save` the guide makes. */
let saves: Array<Record<string, unknown>>;

/** `tokenSet` is what /diag/state's connections.tts.token_set says; `diagReads` counts its reads. */
let diagReads: number;

function install(over: Partial<OnboardingOps> = {}, opts: { testOk?: boolean; tokenSet?: boolean } = {}) {
  const fake = createFakeBridge({ surface: 'onboarding', still: true });
  const log = <K extends keyof OnboardingOps>(k: K) =>
    ((...a: unknown[]) => {
      calls.push(`${k}${a.length && a[0] !== undefined ? ` ${JSON.stringify(a[0])}` : ''}`);
      return (fake.onboarding[k] as (...x: unknown[]) => unknown)(...a);
    }) as OnboardingOps[K];
  const onboarding: OnboardingOps = { state: log('state'), advance: log('advance'), back: log('back'), goto: log('goto'), skip: log('skip'), complete: log('complete'), ...over };
  const permissions = Object.fromEntries(
    Object.entries(fake.permissions).map(([k, f]) => [k, (...a: unknown[]) => (asked.push(k), (f as (...x: unknown[]) => unknown)(...a))]),
  ) as unknown as AgenticComplexBridge['permissions'];
  const settings = { ...fake.settings, save: (c: Record<string, never>) => (saves.push(c), fake.settings.save(c)) };
  const agentd = {
    ...fake.agentd,
    request: ((method, path, body) => {
      if (path === '/model/test' && opts.testOk === false)
        return Promise.resolve({ status: 200, body: { ok: false, kernel: 'pi', provider: null, model: '', elapsed_ms: 0, tokens: null, cost_usd: null } });
      if (path !== '/diag/state') return fake.agentd.request(method, path, body);
      diagReads += 1;
      return fake.agentd.request(method, path, body).then((r) => {
        const d = r.body as { connections?: { tts?: Record<string, unknown> } };
        if (opts.tokenSet === undefined || !d.connections?.tts) return r;
        return { ...r, body: { ...d, connections: { ...d.connections, tts: { ...d.connections.tts, token_set: opts.tokenSet } } } };
      });
    }) as AgenticComplexBridge['agentd']['request'],
  };
  window.agenticComplex = { ...fake, onboarding, permissions, settings, agentd };
}

function mount() {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(<RouterProvider router={router} />);
}

const guide = () => document.querySelector('[data-page="onboarding"]') as HTMLElement;
const step = () => guide().getAttribute('data-step');
const bar = () => within(screen.getByRole('group', { name: '首次设置操作' }));
const press = (name: string | RegExp) => fireEvent.click(bar().getByRole('button', { name }));
const roster = () => screen.findByRole('radiogroup', { name: '角色名册' });

async function toStep(n: number) {
  for (let i = Number(step()); i < n; i += 1) {
    await waitFor(() => expect(bar().getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false));
    press('下一步');
    await waitFor(() => expect(step()).toBe(String(i + 1)));
  }
}

beforeEach(() => {
  diagReads = 0;
  calls = [];
  asked = [];
  saves = [];
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('onboarding page', () => {
  it('walks the four steps; the account tests itself, and 和她聊几句 completes to talk', async () => {
    install();
    mount();
    await roster();
    await waitFor(() => expect(step()).toBe('1'));
    expect(screen.getByRole('tablist', { name: '首次设置的步骤' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['角色', '对话', '声音', '完成']);
    await toStep(2);
    await within(guide()).findByText(/^已连上 │ 回复/);
    await toStep(4);
    expect(guide().getAttribute('aria-label')).toBe('首次设置 │ 完成');
    expect(guide().textContent).toContain('示例乙 已在桌面就位');
    press('和她聊几句');
    await waitFor(() => expect(calls).toContain('complete {"destination":"talk"}'));
    expect(calls.filter((c) => c.startsWith('advance'))).toEqual(['advance', 'advance', 'advance']);
  });

  it('打开主窗口 completes to home', async () => {
    install();
    mount();
    await roster();
    await toStep(4);
    press('打开主窗口');
    await waitFor(() => expect(calls).toContain('complete {"destination":"home"}'));
  });

  it('without a tested account 下一步 waits; 稍后再连 passes the step as skipped', async () => {
    install({}, { testOk: false });
    mount();
    await roster();
    await toStep(2);
    await within(guide()).findByText('没连上：模型没有回复');
    const next = bar().getByRole('button', { name: '下一步' });
    expect(next).toHaveProperty('disabled', true);
    expect(next.getAttribute('title')).toBe('先连上账号并测试通过，或点「稍后再连」');
    press('稍后再连');
    await waitFor(() => expect(step()).toBe('3'));
    expect(calls).toContain('advance {"skip":true}');
    expect(screen.getAllByRole('tab')[1]?.querySelector('[data-step]')?.getAttribute('data-step')).toBe('skip');
  });

  it('和她对话 saves plugins.light_ai at once and folds the account rows and the voice step', async () => {
    install();
    mount();
    await roster();
    await toStep(2);
    const sw = await screen.findByRole('switch', { name: '和她对话' });
    await waitFor(() => expect(sw.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(sw);
    await waitFor(() => expect(saves).toEqual([{ 'plugins.light_ai': false }]));
    await within(guide()).findByText('关着 │ 打开后可以设：模型服务、账号');
    expect(screen.queryByRole('group', { name: '模型服务' })).toBeNull();
    await toStep(3);
    expect(guide().textContent).toContain('对话关着 │ 打开后可以设：她念出回答、按住说话');
  });

  it('a step cell jumps there; Q goes back', async () => {
    install();
    mount();
    await roster();
    fireEvent.click(screen.getByRole('tab', { name: '03 声音' }));
    await waitFor(() => expect(step()).toBe('3'));
    expect(calls).toContain('goto 3');
    fireEvent.keyDown(window, { key: 'q' });
    await waitFor(() => expect(step()).toBe('2'));
  });

  it('asks the permissions 按住说话 needs only on 声音, and reads them again when the window comes back', async () => {
    install();
    mount();
    await roster();
    await toStep(3);
    const row = await screen.findByRole('group', { name: '输入监控' });
    expect(within(row).getByText('还没问过')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '允许' }));
    await waitFor(() => expect(asked).toContain('request'));
    const before = asked.filter((k) => k === 'status').length;
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(asked.filter((k) => k === 'status').length).toBeGreaterThan(before));
  });

  it.each([
    [true, '已保存'],
    [false, '还没有保存'],
  ])('reads the voice token as saved from /diag/state token_set %s', async (tokenSet, note) => {
    install({}, { tokenSet });
    mount();
    await roster();
    await toStep(3);
    const row = await screen.findByRole('group', { name: '令牌' });
    await waitFor(() => expect(row.textContent).toContain(note));
  });

  it('reads /diag/state again after saving the voice token', async () => {
    install({}, { tokenSet: false });
    mount();
    await roster();
    await toStep(3);
    const row = await screen.findByRole('group', { name: '令牌' });
    fireEvent.change(within(row).getByLabelText('令牌', { selector: 'input' }), { target: { value: 'secret' } });
    const before = diagReads;
    fireEvent.click(within(row).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(diagReads).toBeGreaterThan(before));
  });

  it('跳过引导 asks on white paper, then ends the guide', async () => {
    install();
    mount();
    await roster();
    fireEvent.click(within(guide().querySelector('header') as HTMLElement).getByRole('button', { name: '跳过引导' }));
    const paper = await screen.findByRole('dialog', { name: '跳过首次设置？' });
    fireEvent.click(within(paper).getByRole('button', { name: '跳过' }));
    await waitFor(() => expect(calls).toContain('skip'));
  });

  it('shows a failed completion in the bar and stays on 完成', async () => {
    const failed = async (): Promise<OnboardingState> => ({ ...(await createFakeBridge({ surface: 'onboarding', still: true }).onboarding.state()), step: 4, completionError: '配置没有存上' });
    install({ complete: failed });
    mount();
    await roster();
    await toStep(4);
    press('和她聊几句');
    await waitFor(() => expect(bar().getByRole('alert').textContent).toBe('配置没有存上'));
    expect(step()).toBe('4');
  });

  it('waits for the guide state on the shared indeterminate LoadBar', async () => {
    install({ state: () => new Promise<OnboardingState>(() => {}) });
    mount();
    expect(await screen.findByText('正在读取首次设置…')).toBeTruthy();
    const load = document.querySelector('[data-stub="LoadBar"]');
    expect(load?.hasAttribute('data-indeterminate')).toBe(true);
    expect(load?.getAttribute('aria-valuenow')).toBeNull();
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
    const alert = await within(document.body).findByText('没有连上桌面端，请重试');
    fail = false;
    fireEvent.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: '重试' }));
    await roster();
  });
});

describe('onboarding demo layer', () => {
  const base = () => createFakeBridge({ surface: 'onboarding', still: true }).onboarding;

  it('opens later steps with the steps before them passed, and fails on state=error', async () => {
    expect((await demoOps(base(), 'chat', null).state()).step).toBe(2);
    const done = await demoOps(base(), 'done', null).state();
    expect(done.step).toBe(4);
    expect(done.steps.map((s) => s.result)).toEqual(['done', 'done', 'done', 'todo']);
    await expect(demoOps(base(), null, 'error').state()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('onboarding step marks', () => {
  it('draws done, todo, skip and the orange mark for a passed step that still needs something', async () => {
    const ops = base();
    await ops.advance();
    await ops.advance({ skip: true });
    const s = await ops.advance();
    expect(stepMarks(s, { chat: false, voice: true })).toEqual({ 1: 'done', 2: 'skip', 3: 'mark', 4: undefined });
    expect(stepMarks(await ops.goto(1), { chat: false, voice: false })).toEqual({ 1: 'done', 2: 'skip', 3: 'done', 4: 'todo' });
  });

  function base() {
    return createFakeBridge({ surface: 'onboarding', still: true }).onboarding;
  }
});
