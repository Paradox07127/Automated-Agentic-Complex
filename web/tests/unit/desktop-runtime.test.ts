import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopState, AgenticComplexBridge, RuntimeProcess, RuntimeSnapshot } from '../../src/bridge/protocol';
import { useDesktopState } from '../../src/surfaces/desktop/hooks/useDesktopState';

// The desktop panels take the character and the agentd/avatar pips from app.runtime; the rest stays desktop.onState.

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const STATE: DesktopState = {
  hidden: true,
  clickThroughAll: false,
  freeRoam: false,
  quietUntil: null,
  dock: { open: false, side: 'right', compact: false },
  character: { id: 'voice_a', name: '示例甲' },
  characters: [
    { id: 'voice_a', name: '示例甲' },
    { id: 'cedar', name: '示例丙' },
  ],
  screens: [{ id: '1', name: '内建显示器', current: true }],
  hotkeys: { hk_quick: '⌃Space' },
  pips: { agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'running', pid: 2, backoff: null }, voice: 'denied' },
  computerUseActive: false,
  plugins: ['light_ai'],
};

const proc = (state: RuntimeProcess['state'], extra: Partial<RuntimeProcess> = {}): RuntimeProcess => ({
  state, pid: null, backoff: null, reason: null, stage: null, ...extra,
});

function snapshot(current: string | null, agentd: RuntimeProcess, avatar: RuntimeProcess): RuntimeSnapshot {
  return {
    revision: 3,
    phase: 'degraded',
    config_error: null,
    processes: { agentd, avatar },
    character: { current, shown: current, agentd: current, pending: null, switching: false, failure: null },
    visibility: { hidden: false, reason: null, fullscreen_hidden: false, click_through_all: false },
    tts: { provider: 'none', state: 'off', reason: null, retry_after_s: null },
    services: {
      tts: { mode: 'off', state: null, pid: null, detail: null },
      motion: { mode: 'off', state: null, pid: null, detail: null },
      llm: { mode: 'off', state: null, pid: null, detail: null },
    },
    degraded: [],
  };
}

/** A native bridge whose desktop.onState pushes STATE; `runtime` answers app.runtime and onRuntime keeps its callback. */
function install(runtime: () => Promise<RuntimeSnapshot>) {
  const fake = createFakeBridge({ surface: 'stack', still: true });
  const pushes: ((s: RuntimeSnapshot) => void)[] = [];
  const bridge: AgenticComplexBridge = {
    ...fake,
    app: {
      ...fake.app,
      runtime,
      onRuntime: (cb) => {
        pushes.push(cb);
        return () => {};
      },
    },
    desktop: { ...fake.desktop, onState: (cb) => (queueMicrotask(() => cb(STATE)), () => {}) },
  };
  window.agenticComplex = bridge;
  return { push: (s: RuntimeSnapshot) => act(() => pushes.forEach((cb) => cb(s))) };
}

describe('useDesktopState over app.runtime', () => {
  it('takes the character and the agentd/avatar pips from the runtime snapshot', async () => {
    install(async () => snapshot('cedar', proc('backoff', { backoff: 3 }), proc('failed', { reason: 'crash', pid: 77 })));
    const { result } = renderHook(() => useDesktopState());
    await waitFor(() => expect(result.current?.character?.id).toBe('cedar'));
    expect(result.current).toEqual({
      ...STATE,
      character: { id: 'cedar', name: '示例丙' },
      pips: {
        agentd: { state: 'backoff(3)', pid: null, backoff: 3 },
        avatar: { state: 'failed(crash)', pid: 77, backoff: null },
        voice: 'denied',
      },
    });
  });

  it('follows each snapshot onRuntime pushes', async () => {
    const { push } = install(async () => snapshot('voice_a', proc('running', { pid: 1 }), proc('running', { pid: 2 })));
    const { result } = renderHook(() => useDesktopState());
    await waitFor(() => expect(result.current).toEqual(STATE));
    push(snapshot('cedar', proc('port_in_use'), proc('gpu_hold')));
    expect(result.current?.character).toEqual({ id: 'cedar', name: '示例丙' });
    expect(result.current?.pips.agentd.state).toBe('portInUse');
    expect(result.current?.pips.avatar.state).toBe('gpuHold');
    // No character in the snapshot yet: desktop.onState's stays.
    push(snapshot(null, proc('starting'), proc('running', { pid: 9 })));
    expect(result.current?.character).toEqual(STATE.character);
    expect(result.current?.pips.agentd).toEqual({ state: 'starting', pid: null, backoff: null });
  });

  it('keeps desktop.onState as it is when app.runtime is not implemented', async () => {
    install(() => Promise.reject(Object.assign(new Error('not_implemented: app.runtime'), { code: 'not_implemented' })));
    const { result } = renderHook(() => useDesktopState());
    await waitFor(() => expect(result.current).not.toBeNull());
    await act(async () => {});
    expect(result.current).toEqual(STATE);
  });
});
