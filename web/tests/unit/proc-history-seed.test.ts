import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useProcSamples } from '../../src/pages/diag/useProcSamples';

describe('process samples', () => {
  it('start with the shell history from before the page opened', () => {
    const now = Date.now();
    const history = [
      { at: now - 20_000, cpuPercent: 3, memoryMB: 100 },
      { at: now - 10_000, cpuPercent: 5, memoryMB: 110 },
    ];
    const read = { data: { agentd: { state: 'running', pid: 1, cpuPercent: 7, memoryMB: 120, history } }, dataUpdatedAt: now + 1, refetch: () => undefined };
    const { result } = renderHook(() => useProcSamples(read, 1_000_000, false));
    expect(result.current.map((s) => s.cpu.agentd)).toEqual([3, 5, 7]);
    expect(result.current[0]!.at).toBeLessThan(result.current[1]!.at);
    expect(result.current[1]!.at).toBeLessThan(1_000_000);
  });
});
