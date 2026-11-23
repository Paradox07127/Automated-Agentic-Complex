import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('主动提示 and developer proactive readout', () => {
  it('reads 主动提示 off by default and sends PUT /proactive/settings {"companion_mode": true} with 主动, false with 只在我问时', async () => {
    const request = vi.spyOn(window.agenticComplex!.agentd, 'request');
    render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const seg = await screen.findByRole('radiogroup', { name: '会不会主动找你' });
    await act(async () => {});
    const active = within(seg).getByRole('radio', { name: '主动' });
    expect(active.getAttribute('aria-checked')).toBe('false');
    // What 主动 does sits in the row's ⓘ; the line under 只在我问时 says results and reminders still arrive.
    const row = within(document.getElementById('set-speakWhen')!);
    expect(row.getByRole('tooltip', { hidden: true }).textContent).toMatch(/^主动：看到能帮忙的时机时提示，也会说出想法/);
    row.getByText('只回答你；任务结果和你设的提醒照常送达');

    await act(async () => {
      fireEvent.click(active);
    });
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: true });
    expect(active.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      fireEvent.click(within(seg).getByRole('radio', { name: '只在我问时' }));
    });
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/settings', { companion_mode: false });
    expect(active.getAttribute('aria-checked')).toBe('false');
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
