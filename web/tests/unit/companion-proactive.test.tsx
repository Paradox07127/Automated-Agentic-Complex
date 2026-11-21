import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PERMISSIONS, WIRE_DIAG_GATE } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { GatePanel } from '../../src/pages/diag/GatePanel';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { setDevMode } from '../../src/shell/devMode';

let native: Native;

function Harness({ children }: { children: ReactNode }) {
  const model = useSettingsModel({}, { native, runtime: null });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime: null,
    runtimeChecking: false,
    recheckRuntime: async () => null,
    models: null,
    diag: diagView(null),
    blacklist: null,
    scopes: [],
    runs: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage: () => {},
  };
  return <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>;
}

beforeEach(async () => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
  setDevMode(false);
});

afterEach(() => {
  cleanup();
  setDevMode(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.agenticComplex;
});

describe('主动提示 switch and developer proactive readout', () => {
  it('shows 主动提示 off by default and sends PUT /proactive/settings {"companion_mode": true} on click', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const toggle = await screen.findByRole('switch', { name: '主动提示' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    screen.getByText('发现可以帮忙的时机时主动提示。任务结果和你设置的提醒仍会送达。');

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('maps session, task, and repeat mute categories in 声音 settings', async () => {
    vi.spyOn(window.agenticComplex!.agentd, 'request').mockImplementation(
      async (_method, path) =>
        ({
          status: 200,
          body: path === '/proactive/mutes' ? { muted: ['session', 'task', 'repeat'] } : { companion_mode: false },
        }) as never,
    );
    render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    await screen.findByRole('group', { name: '会话出事时告诉你' });
    screen.getByRole('group', { name: '任务停了时提醒' });
    screen.getByRole('group', { name: '重复的事建议做成定时任务' });
  });

  it('shows proactive stats readout in GatePanel only when developer mode is on', async () => {
    const { unmount } = render(<GatePanel cooldowns={[]} gate={WIRE_DIAG_GATE} />);
    expect(screen.queryByText(/有回应/)).toBeNull();
    unmount();

    setDevMode(true);
    render(<GatePanel cooldowns={[]} gate={WIRE_DIAG_GATE} />);
    const line = await screen.findByText(/近 7 天主动/);
    expect(line.textContent).toBe('近 7 天主动 10 条 │ 有回应 5（50%） │ 点了建议 2');
    const table = screen.getByRole('table', { name: '近 7 天主动发言回应' });
    expect(table.textContent).toContain('comment');
    expect(table.textContent).toContain('stuck');
    expect(table.textContent).toContain('signal.check_failed');
  });

  it('shows — rate when shown is 0 and refreshes at most every 60 s', async () => {
    vi.useFakeTimers();
    setDevMode(true);
    const request = vi
      .spyOn(window.agenticComplex!.agentd, 'request')
      .mockResolvedValue({ status: 200, body: { comment: { shown: 0, replied: 0, accepted: 0, feedback: 0 } } } as never);

    render(<GatePanel cooldowns={[]} gate={WIRE_DIAG_GATE} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/近 7 天主动/).textContent).toBe('近 7 天主动 0 条 │ 有回应 0（—） │ 点了建议 0');
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
