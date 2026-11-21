import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel } from '../../src/pages/settings/model';

// The muted kinds in 设置 › 声音; the bubble's 关闭此类 is in bubble.test.tsx.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.agenticComplex;
  window.location.hash = '';
});

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

describe('settings › 声音 › muted kinds', () => {
  beforeEach(async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    native = await demoNative(null);
  });

  it('says once, under 她什么时候开口, that thoughts come with 主动', async () => {
    native = { ...native, saved: { ...native.saved, speakUp: false } };
    vi.spyOn(window.agenticComplex!.agentd, 'request').mockResolvedValue({ status: 200, body: { muted: [] } });
    const { container } = render(<Harness><SpeakGroup /></Harness>);
    await act(async () => {});
    expect(screen.queryByText('想法需要打开「主动发言」')).toBeNull();
    expect(container.textContent?.match(/想法/g)).toHaveLength(1);
    expect(container.querySelector('[data-row="speakWhen"]')?.textContent).toContain('想法');
  });

  it('lists each muted kind with 恢复, which puts the rest back', async () => {
    const request = vi
      .spyOn(window.agenticComplex!.agentd, 'request')
      .mockImplementation(async (method) => ({ status: 200, body: { muted: method === 'GET' ? ['comment', 'stuck'] : ['stuck'] } }) as never);
    render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const comment = await screen.findByRole('group', { name: '久盯一个窗口时搭话' });
    screen.getByRole('group', { name: '卡住时问要不要帮忙' });
    await act(async () => fireEvent.click(within(comment).getByRole('button', { name: '恢复' })));
    expect(request).toHaveBeenCalledWith('PUT', '/proactive/mutes', { muted: ['stuck'] });
    expect(screen.queryByRole('group', { name: '久盯一个窗口时搭话' })).toBeNull();
  });

  it('leaves the row out while none is muted, and drops it once the last kind is restored', async () => {
    vi.spyOn(window.agenticComplex!.agentd, 'request').mockResolvedValue({ status: 200, body: { muted: [] } });
    const { container } = render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    await act(async () => {});
    expect(container.querySelector('[data-row="mutes"]')).toBeNull();
    expect(screen.queryByText('已关掉的主动发言')).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(window.agenticComplex!.agentd, 'request').mockImplementation(async (method) => ({ status: 200, body: { muted: method === 'GET' ? ['comment'] : [] } }) as never);
    const again = render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const comment = await screen.findByRole('group', { name: '久盯一个窗口时搭话' });
    expect(again.container.querySelector('[data-row="mutes"]')?.textContent).toContain('在气泡的「更多操作」里点「关闭此类」可以关掉一类');
    await act(async () => fireEvent.click(within(comment).getByRole('button', { name: '恢复' })));
    expect(again.container.querySelector('[data-row="mutes"]')).toBeNull();
  });
});
