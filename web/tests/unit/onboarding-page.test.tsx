// First-run guide (pages/onboarding): 选角色 → 怎么陪你 → 完成 over the bridge's onboarding ops, the demo layer and the copy helpers.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, OnboardingOps } from '../../src/bridge/protocol';
import { footHint } from '../../src/pages/onboarding/copy';
import { demoOps } from '../../src/pages/onboarding/demo';
import { OnboardingPage } from '../../src/pages/onboarding/Page';
import { navigate } from '../../src/shell/nav';

vi.mock('../../src/shell/nav', async (orig) => ({ ...(await orig()), navigate: vi.fn() }));

let calls: string[];
/** Every `permissions.*` call the guide makes. */
let asked: string[];

function install(over: Partial<OnboardingOps> = {}) {
  const fake = createFakeBridge({ surface: 'onboarding', still: true });
  const log = <K extends keyof OnboardingOps>(k: K) =>
    ((...a: unknown[]) => {
      calls.push(`${k}${a.length && a[0] !== undefined ? ` ${JSON.stringify(a[0])}` : ''}`);
      return (fake.onboarding[k] as (...x: unknown[]) => unknown)(...a);
    }) as OnboardingOps[K];
  const onboarding: OnboardingOps = { state: log('state'), advance: log('advance'), back: log('back'), complete: log('complete'), ...over };
  const permissions = Object.fromEntries(
    Object.entries(fake.permissions).map(([k, f]) => [k, (...a: unknown[]) => (asked.push(k), (f as (...x: unknown[]) => unknown)(...a))]),
  ) as unknown as AgenticComplexBridge['permissions'];
  window.agenticComplex = { ...fake, onboarding, permissions };
}

function mount() {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(<RouterProvider router={router} />);
}

const guide = () => screen.getByRole('dialog');
const step = () => guide().getAttribute('data-step');
const press = (name: string | RegExp) => fireEvent.click(within(guide()).getByRole('button', { name }));
/** What each step shows must not be a permission, a hook or a terminal command. */
const plain = () => expect(guide().textContent).not.toMatch(/hook|终端|install_hooks|权限|麦克风|辅助功能|屏幕录制|ENDFIELD/i);

async function walk(companion: '只陪伴' | '陪伴加对话') {
  await within(document.body).findByRole('list', { name: '角色名册' });
  plain();
  press('下一步');
  await waitFor(() => expect(step()).toBe('2'));
  plain();
  expect(within(guide()).getByLabelText('第 2 步，共 3 步').textContent).toBe('02/03');
  const choices = within(guide()).getByRole('radiogroup', { name: '怎么陪你' });
  expect(within(choices).getAllByRole('radio').map((r) => r.querySelector('b')?.textContent)).toEqual(['只陪伴', '陪伴加对话']);
  expect(within(guide()).getByRole('button', { name: '下一步' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(within(choices).getByRole('radio', { name: new RegExp(`^${companion}`) }));
  expect(within(choices).getByRole('radio', { name: new RegExp(`^${companion}`) }).getAttribute('aria-checked')).toBe('true');
  press('下一步');
  await waitFor(() => expect(step()).toBe('3'));
  plain();
}

beforeEach(() => {
  calls = [];
  asked = [];
  vi.mocked(navigate).mockClear();
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('onboarding page', () => {
  it('只陪伴 walks the three steps without a permission request or a hook step and completes with pet', async () => {
    install();
    mount();
    await walk('只陪伴');
    expect(guide().getAttribute('aria-label')).toBe('首次设置 │ 已在桌面就位');
    press('完成');
    await waitFor(() => expect(calls).toContain('complete {"companion":"pet"}'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ page: 'character' }));
    expect(asked).toEqual([]);
    expect(calls.filter((c) => !/^(state|advance|complete)/.test(c))).toEqual([]);
  });

  it('陪伴加对话 completes with chat and lands on 设置 › AI 账号', async () => {
    install();
    mount();
    await walk('陪伴加对话');
    press('完成');
    await waitFor(() => expect(calls).toContain('complete {"companion":"chat"}'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ page: 'settings', group: 'model' }));
    expect(asked).toEqual([]);
  });

  it('the closing screen has one sentence and a button to 设置 › 能做, where the capability bands are', async () => {
    install();
    mount();
    await walk('只陪伴');
    expect(within(guide()).getAllByRole('paragraph')).toHaveLength(1);
    press('打开插件设置');
    await waitFor(() => expect(calls).toContain('complete {"companion":"pet","destination":"plugins"}'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ page: 'settings', group: 'perm' }));
  });

  it('has one set of page controls: 上一步 and 下一步 or 完成 in the footer, no media arrows', async () => {
    install();
    mount();
    await walk('陪伴加对话');
    const names = () => within(guide()).getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
    expect(names().filter((n) => /上一|下一|完成|跳过|稍后/.test(n) && n !== '打开插件设置')).toEqual(['上一步', '完成']);
    expect(within(guide()).queryByRole('button', { name: /上一页|下一页/ })).toBeNull();
    const foot = guide().querySelector('footer') as HTMLElement;
    expect(within(foot).getByRole('button', { name: '上一步' })).toBeTruthy();
    expect(within(foot).getByRole('button', { name: '完成' })).toBeTruthy();
  });

  it('上一步 goes back through the bridge and keeps the choice', async () => {
    install();
    mount();
    await walk('陪伴加对话');
    press('上一步');
    await waitFor(() => expect(step()).toBe('2'));
    expect(calls.filter((c) => c === 'back')).toHaveLength(1);
    expect(within(guide()).getByRole('radio', { name: /^陪伴加对话/ }).getAttribute('aria-checked')).toBe('true');
    press('上一步');
    await waitFor(() => expect(step()).toBe('1'));
    expect(within(guide()).queryByRole('button', { name: '上一步' })).toBeNull();
  });

  it('names the product Agentic Complex, not ENDFIELD', async () => {
    install();
    mount();
    await within(document.body).findByRole('list', { name: '角色名册' });
    expect(guide().querySelector('header')?.textContent).toContain('Agentic Complex');
    expect(document.body.textContent).not.toContain('ENDFIELD');
  });

  it('shows a failed completion in the footer and stays on the closing screen', async () => {
    install({
      complete: async () => ({ ...(await createFakeBridge({ surface: 'onboarding', still: true }).onboarding.state()), step: 3, completionError: '配置没有存上' }),
    });
    mount();
    await walk('只陪伴');
    press('完成');
    await waitFor(() => expect(within(guide()).getByRole('alert').textContent).toBe('配置没有存上'));
    expect(step()).toBe('3');
    expect(navigate).not.toHaveBeenCalled();
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
    expect(within(guide()).getByText('01/03')).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await within(document.body).findByRole('list', { name: '角色名册' });
  });
});

describe('onboarding demo layer', () => {
  const base = () => createFakeBridge({ surface: 'onboarding', still: true }).onboarding;

  it('opens later steps and fails on state=error', async () => {
    expect((await demoOps(base(), 'step2', null).state()).step).toBe(2);
    expect((await demoOps(base(), 'step3', null).state()).step).toBe(3);
    await expect(demoOps(base(), null, 'error').state()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('onboarding copy', () => {
  it('puts an error before the step hint', () => {
    expect(footHint(1, '没存上')).toEqual({ text: '没存上', danger: true });
    expect(footHint(2, null)).toEqual({ text: '之后可在 设置 › 能做 中修改', danger: false });
  });
});
