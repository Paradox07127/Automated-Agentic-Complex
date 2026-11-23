import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { LOG_IDS, useLogs } from '../../src/pages/trace/useLogs';
import type { LogRead } from '../../src/bridge/logs';

it('waits for an outstanding log read after a sources failure before retrying the same cursor', async () => {
  vi.useFakeTimers();
  const bridge = createFakeBridge({ surface: 'main', still: true, routes: [] });
  window.agenticComplex = bridge;
  const empty: LogRead = { lines: [], cursor: { agentd: 10 }, truncated: [] };
  const read = vi.spyOn(bridge.logs, 'read').mockResolvedValue(empty);
  const sources = vi.spyOn(bridge.logs, 'sources').mockResolvedValue({ sources: [], dirs: { support: '', web: '' } });
  const hook = renderHook(() => useLogs(true, true));
  try {
    await act(async () => {});
    expect(hook.result.current.status).toBe('ok');
    expect(read).toHaveBeenCalledTimes(LOG_IDS.length);
    let finish!: (r: LogRead) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    sources.mockRejectedValueOnce(new Error('disconnected'));
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(read).toHaveBeenCalledTimes(LOG_IDS.length + 1);
    await act(async () => finish({ ...empty, cursor: { agentd: 20 } }));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(read).toHaveBeenCalledTimes(LOG_IDS.length + 2);
    expect(read.mock.lastCall?.[0].after).toEqual({ agentd: 10 });
  } finally {
    hook.unmount();
    vi.useRealTimers();
    delete window.agenticComplex;
  }
});
