// 编码工具接入: the install commands come from `app.info` `hookInstallSteps`, never from a path the page knows.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AppInfo, AgenticComplexBridge } from '../../src/bridge/protocol';
import { PERMISSIONS, WIRE_DIAG_BUDGET, WIRE_DIAG_CONNECTIONS, WIRE_DIAG_GATE, WIRE_OBSERVATION } from '../../src/mock/fixtures';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { HooksSection } from '../../src/pages/settings/groups/ModelHooks';
import { useSettingsModel } from '../../src/pages/settings/model';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

const HOOKS = { claude: { installed: false, last_at: null }, codex: { installed: false, last_at: null } };
const DIAG = diagView({ gate: WIRE_DIAG_GATE, budget: WIRE_DIAG_BUDGET, hooks: HOOKS, connections: WIRE_DIAG_CONNECTIONS, observation: WIRE_OBSERVATION });

function Harness() {
  const model = useSettingsModel({}, { native: null, runtime: null });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff: false,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native: null,
    runtime: null,
    runtimeChecking: false,
    recheckRuntime: async () => null,
    models: null,
    diag: DIAG,
    blacklist: null,
    scopes: [],
    runs: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'granted',
    goRow: () => {},
    goPage: () => {},
  };
  return (
    <SettingsCtx.Provider value={ctx}>
      <HooksSection />
    </SettingsCtx.Provider>
  );
}

let bridge: AgenticComplexBridge;
let info: AppInfo;
beforeEach(async () => {
  bridge = createFakeBridge({ surface: 'main', still: true, capabilities: { runInTerminal: true } });
  window.agenticComplex = bridge;
  info = await bridge.app.info();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const steps = (name: string) => screen.getByRole('list', { name: `${name} 接入步骤` });

describe('coding-tool hook install steps', () => {
  it('runs the dry run the app gave for this tool', async () => {
    expect(info.hookInstallSteps).toHaveLength(2);
    const run = vi.spyOn(bridge.open, 'runInTerminal');
    render(<Harness />);
    const first = await waitFor(() => {
      const b = within(steps('Claude Code')).getAllByRole('button', { name: '在终端运行' })[0]!;
      expect(b.getAttribute('aria-disabled')).toBeNull();
      return b;
    });
    expect(within(steps('Claude Code')).getAllByRole('listitem')[0]!.textContent).toContain(info.hookInstallSteps[0]!.label);
    await act(async () => void fireEvent.click(first));
    expect(run).toHaveBeenCalledWith(`${info.hookInstallSteps[0]!.command} --target claude`);
  });

  it('disables both terminal steps when this build gives no installer', async () => {
    vi.spyOn(bridge.app, 'info').mockResolvedValue({ ...info, hookInstallSteps: [] });
    render(<Harness />);
    await waitFor(() => expect(within(steps('Codex')).getByText('这个版本没有提供安装命令')).toBeTruthy());
    const buttons = within(steps('Codex')).getAllByRole('button', { name: '在终端运行' });
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(document.body.textContent).not.toMatch(/install_hooks/);
  });
});
