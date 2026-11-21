import { act as flush, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { useSeenReceipt } from '../../src/surfaces/stack/useSeenReceipt';

// A reminder card on screen posts /commitments/<id>/seen once per id; agentd keeps only the first after it is due.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  delete (document as { visibilityState?: unknown }).visibilityState;
});

function Probe({ ids, shown }: { ids: readonly string[]; shown: boolean }) {
  useSeenReceipt(ids, shown);
  return null;
}

function mount(ids: readonly string[], shown: boolean) {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  const request = vi.spyOn(bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
  const view = render(<Probe ids={ids} shown={shown} />);
  const seen = () => request.mock.calls.filter(([, path]) => String(path).endsWith('/seen'));
  return { request, seen, rerender: (next: readonly string[], on: boolean) => flush(async () => view.rerender(<Probe ids={next} shown={on} />)) };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('useSeenReceipt', () => {
  it('posts each id once with an empty body while shown, and not again on a rerender', async () => {
    const m = mount(['a', 'b'], true);
    await flush(async () => {});
    expect(m.seen()).toEqual([
      ['POST', '/commitments/a/seen', {}],
      ['POST', '/commitments/b/seen', {}],
    ]);
    await m.rerender(['a', 'b'], true);
    expect(m.seen()).toHaveLength(2);
  });

  it('posts nothing while not shown, and posts once shown', async () => {
    const m = mount(['a'], false);
    await flush(async () => {});
    expect(m.seen()).toHaveLength(0);
    await m.rerender(['a'], true);
    expect(m.seen()).toEqual([['POST', '/commitments/a/seen', {}]]);
  });

  it('posts again for an id that left and came back', async () => {
    const m = mount(['a'], true);
    await flush(async () => {});
    await m.rerender([], true);
    await m.rerender(['a'], true);
    expect(m.seen()).toEqual([
      ['POST', '/commitments/a/seen', {}],
      ['POST', '/commitments/a/seen', {}],
    ]);
  });

  it('keeps a failed post inside the component', async () => {
    const m = mount([], true);
    m.request.mockRejectedValue(new Error('offline'));
    const errors = vi.fn();
    window.addEventListener('unhandledrejection', errors);
    await m.rerender(['a'], true);
    await flush(async () => {});
    window.removeEventListener('unhandledrejection', errors);
    expect(m.seen()).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('posts nothing while the page is hidden, and posts once it becomes visible', async () => {
    setVisibility('hidden');
    const m = mount(['a'], true);
    await flush(async () => {});
    expect(m.seen()).toHaveLength(0);
    setVisibility('visible');
    await flush(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(m.seen()).toEqual([['POST', '/commitments/a/seen', {}]]);
  });
});
