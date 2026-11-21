import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { CmdRoot } from '../../src/surfaces/desktop/CmdRoot';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { logInfo } from '../../src/surfaces/desktop/hooks/useMountedLog';
import { RingRoot } from '../../src/surfaces/desktop/RingRoot';
import { stubMatchMedia } from './mediaStub';

// Each desktop entry writes `mounted <surface> <route>` to native's ui.log through the bridge's `window.logInfo`.

type Webkit = { webkit?: { messageHandlers: { efLog: { postMessage: (body: unknown) => void } } } };

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  delete (window as Webkit).webkit;
  window.location.hash = '';
});

/** Mounts `Root` on a fake stack bridge; the `logInfo` calls and any post to the old `efLog` handler. */
function mount(Root: ComponentType, hash: string) {
  window.location.hash = hash;
  const efLog = vi.fn();
  (window as Webkit).webkit = { messageHandlers: { efLog: { postMessage: efLog } } };
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  const logInfo = vi.spyOn(bridge.window, 'logInfo');
  window.agenticComplex = bridge;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Root />
    </QueryClientProvider>,
  );
  return { logInfo, efLog };
}

describe('mounted lines', () => {
  it.each([
    [BubbleRoot, '#/bubble', 'mounted bubble #/bubble'],
    [HudRoot, '#/hud', 'mounted hud #/hud'],
    [RingRoot, '#/ring', 'mounted ring #/ring'],
    [CmdRoot, '#/cmd', 'mounted cmd #/cmd'],
  ] as const)('entry %# sends one window.logInfo and nothing to window.webkit', (Root, hash, line) => {
    const { logInfo, efLog } = mount(Root, hash);
    expect(logInfo.mock.calls).toEqual([[line]]);
    expect(efLog).not.toHaveBeenCalled();
  });

  it('does nothing outside the shell', () => {
    expect(() => logInfo('x')).not.toThrow();
  });
});
