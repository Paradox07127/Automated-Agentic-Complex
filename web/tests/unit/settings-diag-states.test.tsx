// Settings error state, the gate chart's proactive-only count, no 浮层背景 row, diag offline and process rows, empty flow counts, onboarding error.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { CharacterSettings } from '../../src/pages/character/CharacterSettings';
import { DgFlow } from '../../src/pages/diag/DgFlow';
import { demoShotRuns } from '../../src/mock/settings';
import { flowOf } from '../../src/pages/diag/flow';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
import { OnboardingPage } from '../../src/pages/onboarding/Page';
import { SettingsPage } from '../../src/pages/settings/Page';
import { searchSettings } from '../../src/pages/settings/registry';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount(component: () => React.ReactNode, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('今天发出的截图 counts the screenshots the user asked for too', () => {
  it('has a user_vision run in the preview data; diag leaves the count to 记忆管线', () => {
    expect(new Set(demoShotRuns(null).map((r) => r.kind))).toEqual(new Set(['observation_vision', 'user_vision']));
    const obs = flowOf({ turns: [], decisions: [], since: 0, failAt: {}, voiceDown: false, hookSub: '', hourly: null }).nodes.find((n) => n.id === 'obs');
    expect([obs?.station, obs?.stat]).toEqual(['obs', null]);
  });
});

describe('settings error state', () => {
  it('names the cause once above the group; rows keep their text and the segmented control its labels', async () => {
    mount(SettingsPage, '&state=error&group=privacy');
    const grain = await screen.findByRole('radiogroup', { name: '看多细' });
    // A disabled switch keeps the cause as its hidden description for screen readers.
    expect(screen.getAllByText('读取设置失败，这一组暂不能修改').filter((el) => !el.closest('[hidden]'))).toHaveLength(1);
    expect(document.body.textContent).not.toContain('不可用：');
    expect(document.body.textContent).not.toContain('后台服务没有运行');
    expect(within(grain).getAllByRole('radio').map((r) => r.textContent)).toEqual(['仅读状态', '焦点语义', '窗口摘要']);
  });

  it('has no English decoration tags or group heading', async () => {
    mount(SettingsPage, '&group=privacy');
    await screen.findByRole('region', { name: '外发总览' });
    const nav = screen.getByRole('tablist', { name: '设置分组' });
    expect(nav.textContent).not.toContain('Agent');
    expect(nav.textContent).toContain('内核');
    expect(nav.textContent).not.toContain('智能体');
    expect(document.body.textContent).not.toMatch(/OUTBOUND|GATE|KERNEL/);
  });
});

describe('浮层背景 row', () => {
  it('is gone: the overlays draw their own background', async () => {
    mount(SettingsPage, '&group=speak');
    await screen.findByRole('radiogroup', { name: '听写语言' });
    expect(screen.queryByRole('radiogroup', { name: '浮层背景' })).toBeNull();
    expect(document.getElementById('set-overlay_background')).toBeNull();
    expect(searchSettings('浮层背景')).toEqual([]);
  });
});

describe('点击角色 row', () => {
  it('defaults to interaction and saves either choice without a restart', async () => {
    const fake = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = fake;
    render(
      <QueryClientProvider client={client()}>
        <CharacterSettings tab="behavior" offline={false} onRestart={() => {}} avatar={false} onTab={() => {}} toast={() => {}} />
      </QueryClientProvider>,
    );
    const seg = await screen.findByRole('radiogroup', { name: '点击角色' });
    const radios = within(seg).getAllByRole('radio');
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['角色互动', 'true'],
      ['打开快速输入', 'false'],
    ]);
    for (const [label, value] of [['打开快速输入', 'quick_input'], ['角色互动', 'interact']] as const) {
      const radio = within(seg).getByRole('radio', { name: label });
      fireEvent.click(radio);
      await waitFor(async () => expect((await fake.settings.read()).saved.avatar_click).toBe(value));
      await waitFor(() => expect(radio.getAttribute('aria-checked')).toBe('true'));
    }
    const row = (await fake.settings.schema()).find((r) => r.id === 'avatar_click');
    expect(row).toMatchObject({ group: '@character', default: 'interact', restart: 'none' });
    expect(searchSettings('点击角色')).toEqual([expect.objectContaining({ id: 'avatar_click', group: '@character', section: '角色 › 行为', effect: 'instant' })]);
    expect(searchSettings('快速输入').some((r) => r.id === 'avatar_click')).toBe(true);
  });
});

const SUP = { agentd: { state: 'running', pid: 1, cpuPercent: 3.42, memoryMB: 168 }, avatar: { state: 'stopped', pid: null } } as const;
const noop = () => {};

const procs = (agentdGone: boolean) =>
  render(
    <Processes rows={processesOf(SUP, 'connected')} error={null} onRetry={noop} samples={[]} now={0} metric="cpu" onMetric={noop} uptime={{}} agentdGone={agentdGone} actions={{}} highlight={null} onRestart={noop} onLogs={noop} />,
  ).container;

describe('diag process rows', () => {
  it('a stopped process says so and offers 重启; a missing uptime is 运行 —', () => {
    const container = procs(false);
    const row = (k: string) => container.querySelector<HTMLElement>(`[data-nav-target="proc-${k}"]`)!;
    expect(row('agentd').textContent).toMatch(/168\s*MB/);
    expect(row('agentd').textContent).toContain('运行 —');
    expect(row('avatar').textContent).toContain('已停止');
    expect(within(row('avatar')).getByRole('button', { name: '重启' })).toBeTruthy();
  });

  it('agentd gone: its row says 没有响应 and drops its readings; the others keep theirs', () => {
    const container = procs(true);
    const row = (k: string) => container.querySelector<HTMLElement>(`[data-nav-target="proc-${k}"]`)!;
    expect(row('agentd').textContent).toContain('没有响应');
    expect(row('agentd').textContent).not.toMatch(/168\s*MB/);
    expect(row('avatar').textContent).toContain('已停止');
  });
});

describe('diag empty flow', () => {
  it('counts an unvisited node as 0 次; the 记忆管线 stations keep no count', () => {
    const { nodes, edges } = flowOf({ turns: [], decisions: [], since: 0, failAt: {}, voiceDown: false, hookSub: '未安装', hourly: null });
    const { container } = render(<DgFlow nodes={nodes} edges={edges} sel={null} onPick={noop} onStation={noop} live={null} dead={false} calm />);
    const plates = [...container.querySelectorAll('button')].filter((b) => !b.textContent?.includes('编码 hook'));
    const counts = plates.filter((b) => !b.hasAttribute('data-station')).map((b) => b.children[2]?.textContent);
    expect(counts.length).toBe(10);
    expect(counts.every((c) => c === '0 次')).toBe(true);
    expect(plates.filter((b) => b.hasAttribute('data-station')).map((b) => b.children[2]?.textContent)).toEqual(['记忆管线 ›', '记忆管线 ›', '记忆管线 ›']);
  });
});

describe('onboarding', () => {
  it('keeps its English micro labels out of the screen reader', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'onboarding', still: true });
    mount(OnboardingPage, '');
    await screen.findByRole('radiogroup', { name: '角色名册' });
    for (const el of document.querySelectorAll('[data-stub="MicroLabel"]')) expect(el.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('keeps the step card and offers 重试 when the guide cannot be read', async () => {
    const fake = createFakeBridge({ surface: 'onboarding', still: true });
    window.agenticComplex = { ...fake, onboarding: { ...fake.onboarding, state: () => Promise.reject({ code: 'offline', detail: '' }) } };
    mount(OnboardingPage, '');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('没有连上桌面端，请重试')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('首次设置');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
