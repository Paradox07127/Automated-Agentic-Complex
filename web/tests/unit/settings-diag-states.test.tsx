// Settings error state, the gate chart's proactive-only count, no 浮层背景 row, diag offline and process table, empty flow counts, onboarding error.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { CharacterSettings } from '../../src/pages/character/CharacterSettings';
import { DgFlow } from '../../src/pages/diag/DgFlow';
import { fromSummaryRun } from '../../src/domain/adapt/context';
import type { WireSummaryRun } from '../../src/domain/wire';
import { demoShotRuns } from '../../src/mock/settings';
import { flowOf } from '../../src/pages/diag/flow';
import { SUM_KIND } from '../../src/pages/diag/model';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
import { OnboardingPage } from '../../src/pages/onboarding/Page';
import { SettingsPage } from '../../src/pages/settings/Page';
import { searchSettings } from '../../src/pages/settings/registry';
import type { Health } from '../../src/domain';
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

const shot = (kind: string, error: string | null = null): WireSummaryRun => ({
  run_id: kind, kind, started_at: '2026-10-29T10:00:00+08:00', span_start: null, span_end: null, outcome: error ? 'released' : 'completed',
  error, attempt: 1, duration_ms: 1800, backend: 'pi', model: 'native', episode_id: null, reasons: [],
});

describe('今天发出的截图 counts the screenshots the user asked for too', () => {
  it('has a user_vision run in the preview data, the diag lane and the run sheet purpose', () => {
    expect(new Set(demoShotRuns(null).map((r) => r.kind))).toEqual(new Set(['observation_vision', 'user_vision']));
    const run = { ...fromSummaryRun(shot('user_vision')), at: 1 };
    const obs = flowOf({ turns: [], runs: [run], decisions: [], since: 0, failAt: {}, voiceDown: false, hookSub: '', hourly: null }).nodes.find((n) => n.id === 'obs');
    expect(obs?.stat?.count).toBe(1);
    expect(SUM_KIND.user_vision).toBe('图片理解（你发起）');
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
        <CharacterSettings tab="behavior" offline={false} avatar={false} onTab={() => {}} toast={() => {}} />
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

const HEALTH = { voice: { state: 'ready' } } as unknown as Health;
const SUP = { agentd: { state: 'running', pid: 1, cpuPercent: 3.42, memoryMB: 168 }, avatar: { state: 'stopped', pid: null } } as const;
const noop = () => {};

describe('diag process table', () => {
  it('heads the columns and writes 离线 / 未知 instead of a dash', () => {
    const rows = processesOf(SUP, 'connected', HEALTH, null);
    const { container } = render(<Processes q={{ status: 'success', data: rows }} uptime={{}} history={null} actions={{}} highlight={null} onRestart={noop} onLogs={noop} onVoice={noop} />);
    const head = container.querySelector('[data-colhead]');
    expect(head?.textContent).toBe('运行时长内存CPU');
    const row = (k: string) => container.querySelector(`[data-nav-target="proc-${k}"]`)?.textContent ?? '';
    expect(row('agentd')).toContain('未知');
    expect(row('agentd')).toContain('168 MB');
    expect(row('avatar')).toContain('离线');
    expect(container.textContent).not.toContain('—');
  });

  it('reads every row as unknown since the last data while agentd is gone, and the count agrees', () => {
    const at = new Date(2026, 9, 29, 14, 31).getTime();
    const rows = processesOf(SUP, 'connected', HEALTH, null);
    const { container } = render(<Processes q={{ status: 'success', data: rows }} uptime={{}} history={null} actions={{}} highlight={null} staleAt={at} onRestart={noop} onLogs={noop} onVoice={noop} />);
    const procs = [...container.querySelectorAll('[data-nav-target^="proc-"]')];
    expect(procs.every((r) => r.hasAttribute('data-stale') && r.textContent?.includes('未知 │ 上次 14:31'))).toBe(true);
    expect(container.textContent).not.toContain('运行中');
    expect(container.textContent).toContain('3 个 │ 3 个未知');
    expect(container.textContent).toContain('14:31 的数据');
  });
});

describe('diag empty flow', () => {
  it('counts an unvisited node as 0 次', () => {
    const { nodes, edges } = flowOf({ turns: [], runs: [], decisions: [], since: 0, failAt: {}, voiceDown: false, hookSub: '未安装', hourly: null });
    const { container } = render(<DgFlow nodes={nodes} edges={edges} path={[]} lit={[]} pulse={null} sel={null} onPick={noop} live={null} dead={false} calm />);
    const counts = [...container.querySelectorAll('button')].filter((b) => !b.textContent?.includes('编码 hook')).map((b) => b.lastElementChild?.textContent);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((c) => c === '0 次')).toBe(true);
  });
});

describe('onboarding', () => {
  it('has no English step eyebrow', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'onboarding', still: true });
    mount(OnboardingPage, '');
    await screen.findByRole('list', { name: '角色名册' });
    expect(screen.getByRole('dialog').textContent).not.toMatch(/STEP|PERMISSIONS/);
  });

  it('keeps the page index and offers 重试 when the guide cannot be read', async () => {
    const fake = createFakeBridge({ surface: 'onboarding', still: true });
    window.agenticComplex = { ...fake, onboarding: { ...fake.onboarding, state: () => Promise.reject({ code: 'offline', detail: '' }) } };
    mount(OnboardingPage, '');
    const guide = await screen.findByRole('dialog');
    await within(guide).findByText('没有连上桌面端，请重试');
    expect(within(guide).getByText('01/03')).toBeTruthy();
    expect(within(guide).getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
