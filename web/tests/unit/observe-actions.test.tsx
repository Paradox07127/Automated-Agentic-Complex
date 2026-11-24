// 观察页的写操作：排除名单只在这次真的加入或移除时给「撤销」；删除片段的确认只写它真删的东西，记忆未读完时也提到记忆。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { del, post, put } from '../../src/bridge/agentd';
import { toast } from '../../src/shell/toast';
import { KEY } from '../../src/pages/observe/data';
import { useActions, type ObserveActions } from '../../src/pages/observe/useActions';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
vi.mock('../../src/bridge/agentd', async (original) => ({ ...(await original<typeof import('../../src/bridge/agentd')>()), post: vi.fn(), put: vi.fn(), del: vi.fn() }));

const EPISODE = { id: 'ep-1', start: 0, end: 60_000, title: '修 HostLink', apps: [] };

function mount(qc = new QueryClient()) {
  const out: { act: ObserveActions | null } = { act: null };
  function Probe() {
    out.act = useActions(() => {});
    return <>{out.act.confirmNode}</>;
  }
  render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return () => out.act!;
}

/** The second argument of the last toast. */
const lastOpts = () => vi.mocked(toast).mock.calls.at(-1)?.[1];

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockReset();
  vi.mocked(post).mockReset();
  vi.mocked(put).mockReset();
  vi.mocked(del).mockReset();
});

describe('observe actions', () => {
  it('resume writes the pause off before it says so', async () => {
    const actions = mount();
    vi.mocked(put).mockResolvedValueOnce({ paused_until: null });
    act(() => actions().resume());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已恢复观察', {}));
    expect(put).toHaveBeenCalledWith('/observation/paused', expect.anything());
  });

  it('offers 撤销 for an exclusion only when the rule was added now', async () => {
    const actions = mount();
    vi.mocked(post).mockResolvedValueOnce({ added: false, deleted: { events: 0, context: 0, observations: 0 } });
    act(() => actions().addRule('app', 'Code'));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(lastOpts()).toEqual({});
    vi.mocked(post).mockResolvedValueOnce({ added: true, deleted: { events: 0, context: 0, observations: 0 } });
    act(() => actions().addRule('app', 'Code'));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(lastOpts()?.action?.label).toBe('撤销');
  });

  it('offers 撤销 for a removal only when the rule was there', async () => {
    const actions = mount();
    const rule = { field: 'app_names', kind: 'app', value: 'Code' } as const;
    vi.mocked(del).mockResolvedValueOnce({ removed: false });
    act(() => actions().removeRule(rule));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(lastOpts()).toEqual({});
    vi.mocked(del).mockResolvedValueOnce({ removed: true });
    act(() => actions().removeRule(rule));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(lastOpts()?.action?.label).toBe('撤销');
  });

  it('names the summary and the memories, never screenshots, and mentions memories while they load', () => {
    const qc = new QueryClient();
    const actions = mount(qc);
    act(() => actions().deleteEpisode(EPISODE, 0, () => {}));
    expect(screen.getByText('这个片段的摘要将被删除，相关记忆也会删除。')).toBeTruthy();
    expect(screen.queryByText(/截图/)).toBeNull();
    act(() => qc.setQueryData(KEY.memory, { facts: [] }));
    act(() => actions().deleteEpisode(EPISODE, 2, () => {}));
    expect(screen.getByText('这个片段的摘要将被删除，由它生成的 2 条记忆也会一并删除。')).toBeTruthy();
  });
});
