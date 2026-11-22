// The stage's live preview during a switch the page did not start (tray or menu bar): it hides as for the page's own switch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { Stage, type StageProps } from '../../src/pages/character/Stage';

const RECT = { x: 40, y: 120, width: 600, height: 360, top: 120, left: 40, right: 640, bottom: 480, toJSON: () => ({}) } as DOMRect;
const ZERO = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
let show: Mock<(at: PreviewPlacement) => Promise<boolean>>;
let hide: Mock<() => Promise<void>>;

beforeEach(() => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  show = vi.fn(async (_at: PreviewPlacement) => true);
  hide = vi.fn(async () => {});
  window.agenticComplex = { ...bridge, avatar: { ...bridge.avatar, preview: { ...bridge.avatar.preview, show, hide } } };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.previewStage !== undefined ? RECT : ZERO;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

const noop = () => {};
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const stage = (over: Partial<StageProps> = {}) => (
  <QueryClientProvider client={qc}>
    <Stage name="" activity={null} offline={false} backoff={null} onRestart={noop} sw={{ phase: 'idle' }} currentName="示例乙" onRetry={noop} onDismiss={noop} characterId="si" {...over} />
  </QueryClientProvider>
);

describe('Stage during a switch from the tray', () => {
  it('hides the live preview while the host switches, with the page’s own switch idle', async () => {
    const { rerender } = render(stage());
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    rerender(stage({ switching: true }));
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
  });
});
