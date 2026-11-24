// 任务页「定时」页签：domain/schedules 适配与触发器格式、今天页「进行中」节头入口、定时任务列表/启用/编辑/新建/立即运行/删除。
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
import { TasksPage } from '../../src/pages/tasks/Page';
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

function mountTasks(search = '', bottom: HTMLElement | null = null) {
  const root = createRootRoute({
    component: () => (
      <HeaderSlotContext.Provider value={bottom ? { setSub: () => {}, right: null, action: null, bottom } : null}>
        <TasksPage />
        <ToastHost />
      </HeaderSlotContext.Provider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [`/tasks?still=1&tab=sched${search}`] }),
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
  it('marks agent_proposal with 角色提议 and enabled=false with the enable button', () => {
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
      accepted_at: null,
    });
    expect(proposal.accepted_at).toBeNull();
    expect(proposal.created_from).toBe('agent_proposal');
    expect(proposal.enabled).toBe(false);
    const view = scheduleItemView(proposal);
    expect(view.proposalTag).toBe('角色提议');
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
      accepted_at: 1793811600,
    });
    const enabledView = scheduleItemView(userEnabled);
    expect(enabledView.proposalTag).toBeNull();
    expect(enabledView.actionKind).toBe('toggle');
    expect(userEnabled.next_run_at).toBe(1793835000 * 1000);
    expect(userEnabled.last_run_at).toBe(1793811600 * 1000);
    expect(userEnabled.accepted_at).toBe(1793811600 * 1000);
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

  it('shows 「定时任务 │ n 个开着」 when n > 0 and 「定时任务」 when none, jumping to the 定时 tab of the tasks page', () => {
    const go = vi.fn();
    const { rerender } = render(
      <RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={() => {}} schedules={2} />,
    );
    const linkWithCount = screen.getByRole('button', { name: /定时任务 │ 2 个开着/ });
    fireEvent.click(linkWithCount);
    expect(go).toHaveBeenLastCalledWith({ page: 'tasks', tab: 'sched' });

    rerender(<RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={() => {}} schedules={0} />);
    const linkZero = screen.getByRole('button', { name: '定时任务' });
    expect(linkZero.textContent).toBe('定时任务');
  });
});

describe('tasks page 定时 tab', () => {
  const bar = () => document.body.appendChild(document.createElement('div'));
  const list = () => screen.findByRole('region', { name: '任务列表' });
  const detail = () => screen.getByRole('region', { name: '详情' });

  it('新建定时任务 sits once in the bottom bar; an empty list keeps only the one in its empty state', async () => {
    install();
    const bottom = bar();
    mountTasks('', bottom);
    await within(await list()).findByText('日报');
    expect(screen.getAllByRole('button', { name: '新建定时任务' })).toEqual([within(bottom).getByRole('button', { name: '新建定时任务' })]);
    cleanup();
    bottom.replaceChildren();
    mountTasks('&state=empty', bottom);
    await screen.findByText('还没有定时任务');
    expect(screen.getAllByRole('button', { name: '新建定时任务' })).toHaveLength(1);
    expect(within(bottom).queryByRole('button', { name: '新建定时任务' })).toBeNull();
    bottom.remove();
  });

  it('groups her proposal under 角色提议的 with 「待你决定」 and the enabled one under 开着; the proposal offers a primary 启用', async () => {
    install();
    mountTasks('&sel=schedule-2');
    const region = await list();
    const proposed = await within(region).findByRole('listbox', { name: '角色提议的' });
    expect(within(proposed).getByText('每周五整理周报')).toBeTruthy();
    expect(within(proposed).getByText('待你决定')).toBeTruthy();
    expect(within(within(region).getByRole('listbox', { name: '开着' })).getByText('日报')).toBeTruthy();
    expect((await within(detail()).findByRole('button', { name: '启用' })).getAttribute('data-variant')).toBe('primary');
  });

  it('enables a proposal and switches an enabled schedule off via PUT /schedules/:id', async () => {
    const spy = install();
    mountTasks('&sel=schedule-2');
    await within(await list()).findByText('每周五整理周报');
    await act(async () => {
      fireEvent.click(await within(detail()).findByRole('button', { name: '启用' }));
    });
    await waitFor(() => expect(sent(spy, 'PUT', '/schedules/schedule-2')).toEqual([['PUT', '/schedules/schedule-2', { enabled: true }]]));
    fireEvent.click(within(await list()).getByRole('option', { name: /日报/ }));
    const onoff = await within(detail()).findByRole('radiogroup', { name: '启用「日报」' });
    expect(within(onoff).getByRole('radio', { name: '开' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(within(onoff).getByRole('radio', { name: '关' }));
    });
    await waitFor(() => expect(sent(spy, 'PUT', '/schedules/schedule-1')).toEqual([['PUT', '/schedules/schedule-1', { enabled: false }]]));
  });

  it('edits trigger and instruction via PUT /schedules/:id', async () => {
    const spy = install();
    const bottom = bar();
    mountTasks('&sel=schedule-1', bottom);
    await within(await list()).findByText('日报');
    fireEvent.click(await within(bottom).findByRole('button', { name: '编辑' }));
    const form = await screen.findByRole('form', { name: /编辑定时任务/ });
    fireEvent.change(within(form).getByLabelText('指令'), { target: { value: '总结今日提交与未决问题' } });
    fireEvent.change(within(form).getByLabelText('时间'), { target: { value: '19:00' } });
    fireEvent.click(within(form).getByRole('button', { name: '周六' }));
    await act(async () => {
      fireEvent.click(within(bottom).getByRole('button', { name: '保存' }));
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
    expect(await within(detail()).findByText('总结今日提交与未决问题')).toBeTruthy();
    expect(within(detail()).getByText(/每周一、二、三、四、五、六 19:00/)).toBeTruthy();
    bottom.remove();
  });

  it('runs a schedule now via POST /schedules/:id/run; 删除 asks first, then DELETEs /schedules/:id', async () => {
    const spy = install();
    const bottom = bar();
    mountTasks('&sel=schedule-1', bottom);
    await within(await list()).findByText('日报');
    await act(async () => {
      fireEvent.click(await within(bottom).findByRole('button', { name: '立即运行' }));
    });
    await waitFor(() => expect(sent(spy, 'POST', '/schedules/schedule-1/run')).toHaveLength(1));
    fireEvent.click(within(bottom).getByRole('button', { name: '删除定时任务' }));
    const ask = await screen.findByRole('dialog', { name: '删除「日报」？' });
    expect(sent(spy, 'DELETE', '/schedules/schedule-1')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: '删除' }));
    });
    await waitFor(() => expect(sent(spy, 'DELETE', '/schedules/schedule-1')).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('region', { name: '任务列表' })).queryByText('日报')).toBeNull());
    bottom.remove();
  });

  it('creates a schedule with the selected scope and conversation IDs', async () => {
    const spy = install();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const bottom = bar();
    mountTasks('', bottom);
    await within(await list()).findByText('日报');
    fireEvent.click(within(bottom).getByRole('button', { name: '新建定时任务' }));
    const form = await screen.findByRole('form', { name: /新建/ });
    fireEvent.change(within(form).getByLabelText('标题'), { target: { value: '晨间待办检查' } });
    fireEvent.change(within(form).getByLabelText('指令'), { target: { value: '梳理今日优先事项' } });
    fireEvent.change(within(form).getByLabelText('时间'), { target: { value: '09:30' } });
    const scope = await within(form).findByRole('option', { name: '/Users/lin/Documents/周报' });
    fireEvent.change(within(form).getByLabelText('授权资料'), { target: { value: (scope as HTMLOptionElement).value } });
    fireEvent.change(within(form).getByLabelText('关联对话'), { target: { value: C1 } });
    await act(async () => {
      fireEvent.click(within(bottom).getByRole('button', { name: '保存定时' }));
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
    expect(await within(await list()).findByText('晨间待办检查')).toBeTruthy();
    bottom.remove();
  });
});
