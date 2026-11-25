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
import { useSettingsModel } from '../../src/pages/settings/model';

// Settings copy that has to say what agentd and the bubble actually do.

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
  it('names the bubble button 关闭此类 under 更多操作', async () => {
    vi.spyOn(window.agenticComplex!.agentd, 'request').mockResolvedValue({ status: 200, body: { muted: ['comment'] } });
    const { container } = render(
      <Harness>
        <SpeakGroup />
      </Harness>,
    );
    await screen.findByText('可通过气泡「更多操作」中的「关闭此类」添加');
    expect(row(container, 'mutes')).not.toContain('长按或右键');
  });
});
