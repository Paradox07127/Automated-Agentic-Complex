// First-run step 3's 角色内核 block: the auto-picked local CLI, the one-click terminal login, and the closing copy.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { WireInstalledRuntime, WireRuntimePublic } from '../../src/domain/wire';
import { WIRE_RUNTIME } from '../../src/mock/fixtures/wire/system';
import { KernelBlock } from '../../src/pages/onboarding/Kernel';
import { OnboardingPage } from '../../src/pages/onboarding/Page';

let reads: string[];
let puts: unknown[];
let ran: string[];

const row = (backend: WireInstalledRuntime['backend'], authenticated: boolean): WireInstalledRuntime =>
  ({ ...(WIRE_RUNTIME.installed_runtimes.find((r) => r.backend === backend) as WireInstalledRuntime), authenticated });

const CASES: Record<'codex' | 'pi' | 'codexOut' | 'none', WireRuntimePublic> = {
  codex: { ...WIRE_RUNTIME, auto_selected: true, installed_runtimes: [row('codex', true)], selected_runtime: row('codex', true) },
  pi: { ...WIRE_RUNTIME, backend: 'pi', runtime_source: 'bundled', auto_selected: true, installed_runtimes: [row('codex', true)], selected_runtime: null },
  codexOut: {
    ...WIRE_RUNTIME,
    auto_selected: true,
    ready: false,
    error: 'native_login_required',
    installed_runtimes: [row('codex', false)],
    selected_runtime: row('codex', false),
  },
  none: { ...WIRE_RUNTIME, auto_selected: true, ready: false, error: 'local_runtime_missing', installed_runtimes: [], selected_runtime: null },
};

function install(wire: WireRuntimePublic) {
  const fake = createFakeBridge({
    surface: 'onboarding',
    still: true,
    routes: [
      { method: 'GET', path: '/character/runtime', handler: ({ query }) => (reads.push(query.toString()), { status: 200, body: wire }) },
      { method: 'PUT', path: '/character/runtime', handler: ({ body }) => (puts.push(body), { status: 200, body: wire }) },
    ],
  });
  const runInTerminal = fake.open.runInTerminal;
  const bridge: AgenticComplexBridge = {
    ...fake,
    onboarding: { ...fake.onboarding, state: async () => ({ ...(await fake.onboarding.state()), step: 3 }) },
    open: { ...fake.open, runInTerminal: async (c) => (await runInTerminal(c), void ran.push(c)) },
  };
  window.agenticComplex = bridge;
}

function mount() {
  const root = createRootRoute({ component: OnboardingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(<RouterProvider router={router} />);
}

const block = () => screen.findByRole('region', { name: '角色内核' });

beforeEach(() => {
  reads = [];
  puts = [];
  ran = [];
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('onboarding kernel block', () => {
  it('the onboarding surface may read agentd and run a terminal command', () => {
    expect(createFakeBridge({ surface: 'onboarding', still: true }).capabilities.runInTerminal).toBe(true);
  });

  it('shows the logged-in Codex agentd picked, sits above the hooks, and sends no PUT', async () => {
    install(CASES.codex);
    mount();
    const b = await block();
    expect(await within(b).findByText('已连接 Codex（沿用本机登录）')).toBeTruthy();
    expect(reads).toEqual(['refresh=1']);
    const hooks = screen.getByRole('dialog').querySelector('[data-hook]') as HTMLElement;
    expect(b.compareDocumentPosition(hooks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(puts).toEqual([]);
  });

  it('改用 Codex saves the logged-in local CLI over the bundled Pi', async () => {
    install(CASES.pi);
    mount();
    const b = await block();
    fireEvent.click(await within(b).findByRole('button', { name: '改用 Codex' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ backend: 'codex', runtime_source: 'local' });
  });

  it('a logged-out Codex offers its login command in the terminal, and only on click', async () => {
    install(CASES.codexOut);
    mount();
    const b = await block();
    const cmd = '/opt/homebrew/bin/codex login';
    expect(await within(b).findByText(cmd)).toBeTruthy();
    expect(within(b).getByText('未登录')).toBeTruthy();
    expect(ran).toEqual([]);
    fireEvent.click(within(b).getByRole('button', { name: '在终端登录' }));
    await waitFor(() => expect(ran).toEqual([cmd]));
    fireEvent.click(within(b).getByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(reads).toEqual(['refresh=1', 'refresh=1']));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(reads).toHaveLength(3));
    expect(puts).toEqual([]);
  });

  it('says where to connect later when neither CLI is installed', async () => {
    install(CASES.none);
    mount();
    const b = await block();
    expect(await within(b).findByText('本机没有找到 Claude Code 或 Codex。安装并登录其中一个后点「重新检测」，或在 设置 › pi 账号与凭据 填 API key')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /^跳过/ })).toBeTruthy();
  });

  it('without a usable kernel offers 改填 API Key, and a usable one hides it', async () => {
    const used: number[] = [];
    install(CASES.codexOut);
    render(<KernelBlock onUseApiKey={() => used.push(1)} />);
    const b = await block();
    fireEvent.click(await within(b).findByRole('button', { name: '改填 API Key（DeepSeek / OpenAI 兼容）' }));
    expect(used).toEqual([1]);
    cleanup();
    install(CASES.codex);
    render(<KernelBlock onUseApiKey={() => used.push(2)} />);
    expect(await within(await block()).findByText('已连接 Codex（沿用本机登录）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /改填 API Key/ })).toBeNull();
  });

  it('the closing screen says a click on her interacts', async () => {
    install(CASES.codex);
    mount();
    await block();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^完成设置/ }));
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-step')).toBe('4'));
    expect(screen.getByText('点她互动，右键打开菜单；按住 右⌥ 说话。')).toBeTruthy();
  });
});
