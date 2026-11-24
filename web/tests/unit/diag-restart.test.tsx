// 诊断 › 重启: a restart waits for supervisor.state to show a new pid, and reads it again while the diag stream is paused.
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { ProcessState, SupervisorTarget } from '../../src/bridge/protocol';
import { useDiagActions } from '../../src/pages/diag/useDiagActions';

type Sup = Record<SupervisorTarget, ProcessState>;
const sup = (pid: number): Sup => ({ agentd: { state: 'running', pid }, avatar: { state: 'running', pid: 7 } });

beforeEach(() => {
  vi.useFakeTimers();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

function mount(toast: ReturnType<typeof vi.fn>) {
  const out: { restart: ((t: 'agentd') => void) | null } = { restart: null };
  function Probe() {
    // As useSideReads: read once, then only when something invalidates it.
    const q = useQuery({ queryKey: ['diag', 'supervisor'], queryFn: () => window.agenticComplex!.supervisor.state(), retry: false, staleTime: Number.POSITIVE_INFINITY });
    out.restart = useDiagActions(0, toast as never, q.data ?? null).restart;
    return null;
  }
  const r = render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  );
  return { restart: () => out.restart!('agentd'), unmount: r.unmount };
}

describe('diag restart', () => {
  it('reads supervisor.state again until the new pid shows, with the stream paused', async () => {
    const reads = [sup(100), sup(100)];
    const state = vi.spyOn(window.agenticComplex!.supervisor, 'state').mockImplementation(async () => reads.shift() ?? sup(200));
    vi.spyOn(window.agenticComplex!.supervisor, 'restart').mockResolvedValue(undefined as never);
    const toast = vi.fn();
    const m = mount(toast);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(state).toHaveBeenCalledTimes(1);
    await act(async () => m.restart());
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(toast).toHaveBeenCalledWith('已重启后台服务', { severity: 'success' });
  });

  it('waits for nothing once unmounted before the shell answers', async () => {
    vi.spyOn(window.agenticComplex!.supervisor, 'state').mockResolvedValue(sup(100));
    let answer: () => void = () => {};
    vi.spyOn(window.agenticComplex!.supervisor, 'restart').mockReturnValue(new Promise<void>((resolve) => (answer = resolve)) as never);
    const toast = vi.fn();
    const m = mount(toast);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await act(async () => m.restart());
    m.unmount();
    await act(async () => answer());
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(toast).not.toHaveBeenCalled();
  });
});
