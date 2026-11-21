import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { fakeAnchor } from '../../src/bridge/fake/desktop';
import type { DesktopAnchor, AgenticComplexBridge } from '../../src/bridge/protocol';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { useContentSize } from '../../src/surfaces/desktop/hooks/useContentSize';
import { stubMatchMedia } from './mediaStub';

// The desktop panels size themselves from what native gives them, not from their own window.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';

const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const resizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (resizeObserver) globalThis.ResizeObserver = resizeObserver;
  else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
  delete window.agenticComplex;
  window.location.hash = '';
});

function stackBridge(): AgenticComplexBridge {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  return bridge;
}

describe('useContentSize', () => {
  let size = { width: 0, height: 0 };
  let observed: () => void = () => {};

  function Panel() {
    const ref = useRef<HTMLDivElement>(null);
    useContentSize(ref);
    return <div ref={ref} />;
  }

  it('skips 1 px jitter and reports a change of 2 px, rounded', () => {
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => ({}) }));
    const bridge = stackBridge();
    const sent = vi.spyOn(bridge.window, 'setContentSize').mockImplementation(() => {});
    size = { width: 464, height: 54.4 };
    render(<Panel />);
    expect(sent.mock.calls).toEqual([[{ width: 464, height: 54 }]]);
    for (const height of [55, 54, 55.4, 53.6, 55]) {
      size = { width: 464, height };
      observed();
    }
    expect(sent).toHaveBeenCalledTimes(1);
    size = { width: 464, height: 56 };
    observed();
    expect(sent.mock.calls.at(-1)).toEqual([{ width: 464, height: 56 }]);
  });
});

describe('HUD height', () => {
  /** The expanded HUD; `push` hands the page an anchor. */
  async function mount(anchor: DesktopAnchor | null) {
    const read = vi.fn(() => 768);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: read });
    const bridge = stackBridge();
    vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => {
      if (anchor) queueMicrotask(() => cb(anchor));
      return () => {};
    });
    window.location.hash = '#/hud?demo=default&still=1';
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HudRoot />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^展开全部/ }));
    await act(async () => {});
    const list = document.querySelector<HTMLElement>('[data-hud-row]')?.parentElement;
    return { list, read };
  }

  it('clamps the expanded list to a share of the room native gives, and never reads the window height', async () => {
    const { list, read } = await mount({ ...fakeAnchor('hud', null), room: { width: 456, height: 300 } });
    expect(list?.style.maxHeight).toBe('180px');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not clamp before the first anchor', async () => {
    const { list, read } = await mount(null);
    expect(list?.style.maxHeight).toBe('');
    expect(read).not.toHaveBeenCalled();
  });
});
