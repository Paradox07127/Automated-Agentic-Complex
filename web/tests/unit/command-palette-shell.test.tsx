// Shell: ⌘K actions without an agentd route, stop by task id prefix, short Chinese failures, facts in agentd's shape.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import type { Task } from '../../src/domain';
import { mockRoutes } from '../../src/mock';
import { pick, TASKS, WIRE_FACTS } from '../../src/mock/fixtures';
import { T1, T3 } from '../../src/mock/fixtures/ids';
import { toast as pushToast } from '../../src/shell/toast';
import { CmdPalette, stopTask } from '../../src/shell/CmdPalette';
import { loadPaletteIndex, paletteItems } from '../../src/shell/CmdPalette.data';
import { look as runLook, openQuickInput as runQuickInput, resetDesktopOff } from '../../src/shell/desktopOps';
import { pageRoutes } from '../../src/shell/registry';
import { pluginsOn, pluginsReset } from './plugins';
import { pluginKey, setPlugins } from '../../src/shell/plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

beforeEach(() => vi.mocked(pushToast).mockClear());
afterEach(() => {
  cleanup();
  resetDesktopOff();
  vi.restoreAllMocks();
});

const serve = () => {
  const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
  return vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => dispatch(method, path, body));
};

const mount = (onClose = () => {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CmdPalette routes={pageRoutes} onClose={onClose} />
    </QueryClientProvider>,
  );

describe('⌘K actions that need the desktop', () => {
  it('屏幕识读 and 快速输入 run app.look / app.openQuickInput and say how it went', async () => {
    const spy = serve();
    const look = vi.spyOn(getBridge().app, 'look');
    const quick = vi.spyOn(getBridge().app, 'openQuickInput');
    const onClose = vi.fn();
    for (const name of ['屏幕识读', '快速输入']) {
      const ui = mount(onClose);
      const option = within(screen.getByRole('listbox')).getByRole('option', { name: new RegExp(name) });
      expect(option.getAttribute('aria-disabled')).toBeNull();
      await act(async () => fireEvent.click(option));
      ui.unmount();
    }
    expect(look).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.filter(([m]) => m !== 'GET')).toEqual([]);
    expect(vi.mocked(pushToast).mock.calls.map((c) => c[0])).toEqual(['正在识读前台窗口', '已打开快速输入']);
  });

  it('a refused look says agentd\'s reason in Chinese', async () => {
    serve();
    vi.spyOn(getBridge().app, 'look').mockRejectedValueOnce({ code: 'blocked', detail: 'secure_input' }).mockRejectedValueOnce({ code: 'failed', detail: 'POST /look status 409 paused' });
    await runLook();
    await runLook();
    expect(vi.mocked(pushToast).mock.calls.map((c) => c[0])).toEqual(['屏幕识读没有完成：正在输入密码', '屏幕识读没有完成：观察已暂停']);
  });

  it('a shell without the op turns the entry off with one reason line', async () => {
    serve();
    vi.spyOn(getBridge().app, 'openQuickInput').mockRejectedValueOnce({ code: 'not_implemented', detail: 'app.openQuickInput' });
    await runQuickInput();
    expect(vi.mocked(pushToast).mock.calls.map((c) => c[0])).toEqual(['这个版本的桌面端还不支持']);
    const onClose = vi.fn();
    mount(onClose);
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: /快速输入/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('这个版本的桌面端还不支持');
    await act(async () => fireEvent.click(option));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the off state does not leak into the next test', () => {
    serve();
    mount();
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: /快速输入/ });
    expect(option.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('⌘K stop', () => {
  const t1 = pick(TASKS, T1);
  // A running job: T1 waits for review, so jobs.py would not cancel it.
  const job: Task = { ...t1, id: T3, job_id: T3.slice(4), status: 'running' };
  const character: Task = { ...t1, id: 'task:character-run-77a2', job_id: null, task_id: 'character-run-77a2', target: 'character', run_id: 'run-77a2' };
  const coding: Task = { ...t1, id: 'task:t-c07a', job_id: null, task_id: 't-c07a', target: 'codex', source: 'code', run_id: 'run-5b20', generation: 2 };

  it('cancels by id prefix: a job, a character ledger row, else the run', async () => {
    const spy = serve();
    const toast = vi.mocked(pushToast);
    await stopTask(job);
    await stopTask(character);
    await stopTask(coding);
    expect(spy.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['POST', `/agent/jobs/${T3.slice(4)}/cancel`, {}],
      ['POST', '/tasks/character-run-77a2/cancel', {}],
      ['POST', '/agent/runs/run-5b20/cancel', { generation: 2 }],
    ]);
    expect(toast.mock.calls.map((c) => c[0])).toEqual([`已停止「${t1.title}」`, `已停止「${t1.title}」`, `已停止「${t1.title}」`]);
  });

  it('a job waiting for review answers cancelled:false: it says so instead of 已停止', async () => {
    serve();
    await stopTask(t1);
    expect(vi.mocked(pushToast).mock.calls.map((c) => c[0])).toEqual(['这个任务待验收，不能停止']);
  });

  it('cancelled:false for a job in any other state does not claim it waits for review', async () => {
    const spy = vi.spyOn(getBridge().agentd, 'request');
    spy.mockResolvedValueOnce({ status: 202, body: { job_id: T3.slice(4), cancelled: false } });
    await stopTask({ ...job, status: 'failed' });
    spy.mockResolvedValueOnce({ status: 202, body: { job_id: T3.slice(4), cancelled: false } });
    await stopTask(job);
    expect(vi.mocked(pushToast).mock.calls.map((c) => c[0])).toEqual(['这个任务已经结束，不用停止', '后台没有停下这个任务：它的状态已经变了，刷新后再看']);
  });

  it('offers stop only where agentd has a cancel route', () => {
    const none: Task = { ...coding, run_id: null };
    const index = { tasks: [job, character, coding, none].map((t, i) => ({ ...t, id: `${t.id}${i}` as Task['id'], status: 'running' as const })), deliveries: [], facts: [], missing: [] };
    const stops = paletteItems('停止', pageRoutes, index).filter((i) => i.run.kind === 'stop');
    expect(stops).toHaveLength(3);
  });

  it('does not offer stop for a job waiting for review, which jobs.py would not cancel', () => {
    const review = { ...job, status: 'needs_review' as const };
    const index = { tasks: [review, { ...character, status: 'needs_review' as const }], deliveries: [], facts: [], missing: [] };
    const stops = paletteItems('停止', pageRoutes, index).filter((i) => i.run.kind === 'stop');
    expect(stops.map((i) => i.key)).toEqual([`stop-${character.id}`]);
  });

  it('a failure says a short Chinese reason, never the backend detail', async () => {
    const toast = vi.mocked(pushToast);
    const spy = vi.spyOn(getBridge().agentd, 'request');
    spy.mockResolvedValueOnce({ status: 0, body: null, error: { code: 'offline', detail: 'connection refused by host' } });
    await stopTask(job);
    spy.mockResolvedValueOnce({ status: 404, body: { error: 'unknown_character_task' }, error: { code: 'unknown_character_task', detail: 'unknown_character_task' } });
    await stopTask(character);
    expect(toast.mock.calls.map((c) => c[0])).toEqual(['停止失败：后台已断开', '停止失败：后台没有这一项']);
  });
});

describe('⌘K search index', () => {
  it('reads GET /memory in agentd shape through fromFact', async () => {
    serve();
    const index = await loadPaletteIndex();
    expect(index.facts.map((f) => f.id)).toEqual(WIRE_FACTS.map((f) => f.fact_id));
    const first = WIRE_FACTS[0]!;
    const hit = paletteItems(first.text.slice(0, 4), pageRoutes, index).find((i) => i.hint === '记忆');
    expect(hit?.run).toEqual({ kind: 'nav', target: { page: 'memory', view: 'about', sel: first.fact_id } });
  });
});

describe('⌘K keys and reads', () => {
  it('Enter that commits an IME candidate runs nothing', async () => {
    serve();
    const onClose = vi.fn();
    mount(onClose);
    const input = screen.getByRole('combobox', { name: '命令' });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', isComposing: true }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('重新检测内核 says the kernel is not ready, with the reason, when agentd answers ready:false', async () => {
    const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
    vi.spyOn(getBridge().agentd, 'request').mockImplementation(async (method, path, body) => {
      const res = await dispatch(method, path, body);
      return path.startsWith('/character/runtime') && method === 'GET' ? { ...res, body: { ...(res.body as object), ready: false, error: 'missing_api_key' } } : res;
    });
    mount();
    const input = screen.getByRole('combobox', { name: '命令' });
    fireEvent.change(input, { target: { value: '重新检测' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    const [msg, opts] = vi.mocked(pushToast).mock.calls[0]!;
    expect(msg).toMatch(/尚未就绪 │ 还没有保存这个服务的 API Key$/);
    expect(opts).toEqual({ severity: 'warning' });
  });

  it('reads the index again after 个人代理 flips', async () => {
    const spy = serve();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const open = () =>
      render(
        <QueryClientProvider client={qc}>
          <CmdPalette routes={pageRoutes} onClose={() => {}} />
        </QueryClientProvider>,
      );
    const taskReads = () => spy.mock.calls.filter(([m, p]) => m === 'GET' && p === '/agent/tasks').length;
    const ui = open();
    await waitFor(() => expect(taskReads()).toBe(1));
    ui.unmount();
    act(() => setPlugins({ [pluginKey('personal_agent')]: false }));
    open();
    await waitFor(() => expect(spy.mock.calls.filter(([m, p]) => m === 'GET' && p === '/memory').length).toBe(2));
    expect(taskReads()).toBe(1);
    expect(within(screen.getByRole('listbox')).queryByRole('option', { name: /停止任务/ })).toBeNull();
  });
});
