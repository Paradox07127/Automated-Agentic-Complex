// 定时任务页（网页）：domain/schedules 适配与触发器格式、今天页「进行中」节头入口、定时任务列表/启用/编辑/新建/立即运行/删除。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { formatTrigger, fromSchedule, scheduleItemView, WEEKDAYS } from '../../src/domain/schedules';
import { NOW } from '../../src/mock/fixtures';
import { C1 } from '../../src/mock/fixtures/ids';
import { resetSchedules } from '../../src/mock/schedules';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { SchedulesPage } from '../../src/pages/schedules/Page';
import { HeaderSlotContext } from '../../src/shell/headerSlot';
import { ToastHost } from '../../src/shell/toast';

function install() {
  resetSchedules();
  const bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(bridge.diag, 'subscribe').mockImplementation(() => () => {});
  return vi.spyOn(bridge.agentd, 'request');
}

type Spy = ReturnType<typeof install>;
const sent = (spy: Spy, method: string, path: string) => spy.mock.calls.filter(([m, p]) => m === method && p === path);

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  localStorage.clear();
});

function mountSchedules(search = '', bottom: HTMLElement | null = null) {
  const root = createRootRoute({
    component: () => (
      <HeaderSlotContext.Provider value={bottom ? { setSub: () => {}, right: null, action: null, bottom } : null}>
        <SchedulesPage />
        <ToastHost />
      </HeaderSlotContext.Provider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/schedules?still=1${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('domain/schedules adapt and formatting', () => {
  it('marks agent_proposal with 她提议 and enabled=false with the enable button', () => {
    const proposal = fromSchedule({
      schedule_id: 'schedule-2',
      title: '每周五整理周报',
      instruction: '汇总本周完成的任务与草稿',
      trigger: { kind: 'weekly', weekday: 5, at: '17:00' },
      enabled: false,
      created_from: 'agent_proposal',
      conversation_id: null,
      next_run_at: null,
      last_run_at: null,
      last_job_id: null,
      created_at: 1793811600,
      updated_at: 1793811600,
    });
    expect(proposal.created_from).toBe('agent_proposal');
    expect(proposal.enabled).toBe(false);
    const view = scheduleItemView(proposal);
    expect(view.proposalTag).toBe('她提议');
    expect(view.actionKind).toBe('enable_button');
    expect(view.actionLabel).toBe('启用');

    const userEnabled = fromSchedule({
      schedule_id: 'schedule-1',
      title: '日报',
      instruction: '总结仓库变化',
      trigger: { kind: 'daily', at: '18:30', weekdays: [1, 2, 3, 4, 5] },
      enabled: true,
      created_from: 'user',
      conversation_id: 'conversation-1',
      next_run_at: 1793835000,
      last_run_at: 1793811600,
      last_job_id: 'job-1',
      created_at: 1793811600,
      updated_at: 1793811600,
    });
    const enabledView = scheduleItemView(userEnabled);
    expect(enabledView.proposalTag).toBeNull();
    expect(enabledView.actionKind).toBe('toggle');
    expect(userEnabled.next_run_at).toBe(1793835000 * 1000);
    expect(userEnabled.last_run_at).toBe(1793811600 * 1000);
  });

  it('formats weekdays as 一…日 and local trigger descriptions', () => {
    expect(WEEKDAYS.map((w) => w.label)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    expect(formatTrigger({ kind: 'daily', at: '18:30', weekdays: [1, 2, 3, 4, 5] })).toBe('周一、二、三、四、五 18:30');
    expect(formatTrigger({ kind: 'weekly', weekday: 7, at: '09:00' })).toBe('每周日 09:00');
    expect(formatTrigger({ kind: 'session_done', target: 'codex', project: 'Endfield' })).toContain('Codex');
    expect(formatTrigger({ kind: 'session_done', target: 'codex', project: 'Endfield' })).toContain('Endfield');
  });
});

describe('overview RunningSection header entry', () => {
  const READY = { status: 'success', data: true } as const;

  it('shows 「定时任务 · n 个开着」 when n > 0 and 「定时任务」 when none, jumping to schedules', () => {
    const go = vi.fn();
    const { rerender } = render(
      <RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={() => {}} schedules={2} />,
    );
    const linkWithCount = screen.getByRole('button', { name: /定时任务 │ 2 个开着/ });
    fireEvent.click(linkWithCount);
    expect(go).toHaveBeenLastCalledWith({ page: 'schedules' });

    rerender(<RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={() => {}} schedules={0} />);
    const linkZero = screen.getByRole('button', { name: '定时任务' });
    expect(linkZero.textContent).toBe('定时任务');
  });
});

describe('schedules page', () => {
  it('新建定时任务 sits once in the bottom action bar; an empty list keeps only the one in its empty state', async () => {
    install();
    const bottom = document.body.appendChild(document.createElement('div'));
    mountSchedules('', bottom);
    const region = await screen.findByRole('region', { name: '定时任务' });
    await within(region).findByText('日报');
    expect(screen.getAllByRole('button', { name: '新建定时任务' })).toEqual([within(bottom).getByRole('button', { name: '新建定时任务' })]);
    cleanup();
    bottom.replaceChildren();
    mountSchedules('&state=empty', bottom);
    const empty = await screen.findByRole('region', { name: '定时任务' });
    await within(empty).findByText('还没有定时任务');
    expect(screen.getAllByRole('button', { name: '新建定时任务' })).toEqual([within(empty).getByRole('button', { name: '新建定时任务' })]);
    bottom.remove();
  });

  it('lists user schedule and agent proposal with 「她提议」 tag and primary 「启用」 button', async () => {
    install();
    mountSchedules();
    const region = await screen.findByRole('region', { name: '定时任务' });
    expect(await within(region).findByText('日报')).toBeTruthy();
    expect(within(region).getByText('每周五整理周报')).toBeTruthy();
    expect(within(region).getByText('她提议')).toBeTruthy();

    const enableBtn = within(region).getByRole('button', { name: '启用' });
    expect(enableBtn.getAttribute('data-variant')).toBe('primary');

    const toggle = within(region).getByRole('switch', { name: /日报/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('enables an agent proposal and toggles an enabled schedule via PUT /schedules/:id', async () => {
    const spy = install();
    mountSchedules();
    const region = await screen.findByRole('region', { name: '定时任务' });
    const enableBtn = await within(region).findByRole('button', { name: '启用' });

    await act(async () => {
      fireEvent.click(enableBtn);
    });
    await waitFor(() =>
      expect(sent(spy, 'PUT', '/schedules/schedule-2')).toEqual([['PUT', '/schedules/schedule-2', { enabled: true }]]),
    );
    await waitFor(() => expect(within(region).getByRole('switch', { name: /每周五整理周报/ }).getAttribute('aria-checked')).toBe('true'));

    const dailySwitch = within(region).getByRole('switch', { name: /日报/ });
    await act(async () => {
      fireEvent.click(dailySwitch);
    });
    await waitFor(() =>
      expect(sent(spy, 'PUT', '/schedules/schedule-1')).toEqual([['PUT', '/schedules/schedule-1', { enabled: false }]]),
    );
  });

  it('edits trigger and instruction via PUT /schedules/:id', async () => {
    const spy = install();
    mountSchedules();
    const region = await screen.findByRole('region', { name: '定时任务' });
    await within(region).findByText('日报');

    fireEvent.click(within(region).getByRole('button', { name: '编辑「日报」' }));
    const dialog = await screen.findByRole('dialog', { name: /编辑定时任务/ });

    const instructionInput = within(dialog).getByLabelText('指令');
    fireEvent.change(instructionInput, { target: { value: '总结今日提交与未决问题' } });

    const timeInput = within(dialog).getByLabelText('时间');
    fireEvent.change(timeInput, { target: { value: '19:00' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '周六' }));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    });

    await waitFor(() =>
      expect(sent(spy, 'PUT', '/schedules/schedule-1')).toEqual([
        [
          'PUT',
          '/schedules/schedule-1',
          {
            title: '日报',
            instruction: '总结今日提交与未决问题',
            trigger: { kind: 'daily', at: '19:00', weekdays: [1, 2, 3, 4, 5, 6] },
            scope_id: null,
            conversation_id: 'conversation-1',
          },
        ],
      ]),
    );
    expect(await within(region).findByText('总结今日提交与未决问题')).toBeTruthy();
    expect(within(region).getByText('周一、二、三、四、五、六 19:00')).toBeTruthy();
  });

  it('runs a schedule now via POST /schedules/:id/run and deletes via DELETE /schedules/:id', async () => {
    const spy = install();
    mountSchedules();
    const region = await screen.findByRole('region', { name: '定时任务' });
    await within(region).findByText('日报');

    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: '立即运行「日报」' }));
    });
    await waitFor(() => expect(sent(spy, 'POST', '/schedules/schedule-1/run')).toHaveLength(1));

    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: '删除「每周五整理周报」' }));
    });
    await waitFor(() => expect(sent(spy, 'DELETE', '/schedules/schedule-2')).toHaveLength(1));
    await waitFor(() => expect(within(region).queryByText('每周五整理周报')).toBeNull());
  });

  it('creates a schedule with the selected scope and conversation IDs', async () => {
    const spy = install();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mountSchedules();
    const region = await screen.findByRole('region', { name: '定时任务' });
    await within(region).findByText('日报');

    fireEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
    const dialog = await screen.findByRole('dialog', { name: /新建定时任务/ });

    fireEvent.change(within(dialog).getByLabelText('标题'), { target: { value: '晨间待办检查' } });
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: '梳理今日优先事项' } });
    fireEvent.change(within(dialog).getByLabelText('时间'), { target: { value: '09:30' } });
    const scope = await within(dialog).findByRole('option', { name: '/Users/lin/Documents/周报' });
    fireEvent.change(within(dialog).getByLabelText('授权资料'), { target: { value: (scope as HTMLOptionElement).value } });
    fireEvent.change(within(dialog).getByLabelText('关联对话'), { target: { value: C1 } });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    });

    await waitFor(() =>
      expect(sent(spy, 'POST', '/schedules')).toEqual([
        [
          'POST',
          '/schedules',
          {
            title: '晨间待办检查',
            instruction: '梳理今日优先事项',
            trigger: { kind: 'daily', at: '09:30', weekdays: [1, 2, 3, 4, 5] },
            scope_id: '5c0be1f2a3d4e5f60718293a4b5c6d7e',
            conversation_id: C1,
            enabled: true,
          },
        ],
      ]),
    );
    expect(await within(region).findByText('晨间待办检查')).toBeTruthy();
  });
});
