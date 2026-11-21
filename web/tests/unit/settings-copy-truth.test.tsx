import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import type { Native } from '../../src/pages/settings/native';
import { SpeakGroup } from '../../src/pages/settings/groups/Speak';
import { useSettingsModel, type Pauses } from '../../src/pages/settings/model';

// Settings copy that has to say what agentd and the bubble actually do.

let native: Native;

function Harness({ children, pauses }: { children: ReactNode; pauses?: Partial<Pauses> }) {
  const model = useSettingsModel({ pauses }, { native, runtime: null });
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

const row = (container: HTMLElement, id: string) => container.querySelector(`[data-row="${id}"]`)?.textContent ?? '';

beforeEach(async () => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  native = await demoNative(null);
  vi.spyOn(window.agenticComplex.agentd, 'request').mockResolvedValue({ status: 200, body: { muted: [] } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

describe('settings copy matches behavior', () => {
  it('says a reminder due in 免打扰 │ 安静 shows a card without sound (announce.py _commitments_due)', () => {
    const { container } = render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    const text = row(container, 'dnd_quiet');
    expect(text).not.toContain('提醒不触发');
    expect(text).toContain('开会并暂停观察；提醒只出卡片、不出声，朝向决策关闭');
  });

  it('says the same while 安静 runs', () => {
    const { container } = render(
      <Harness pauses={{ quiet: Date.now() + 3_600_000 }}>
        <SpeakGroup />
      </Harness>,
    );
    const readout = screen.getByRole('status');
    expect(readout.textContent).not.toContain('提醒不触发');
    expect(readout.textContent).toContain('│ 提醒只出卡片、不出声');
    expect(row(container, 'dnd_quiet')).not.toContain('提醒不触发');
  });

  it('names the bubble button 关闭此类 under 更多操作', async () => {
    const { container } = render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    await screen.findByText('没有关掉的类别。在气泡的「更多操作」里点「关闭此类」可以关掉一类');
    expect(row(container, 'mutes')).not.toContain('长按或右键');
  });
});
