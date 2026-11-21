import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { createAppRouter } from '../../src/shell/router';

describe('native window.onRoute', () => {
  afterEach(() => {
    delete (window as { agenticComplex?: AgenticComplexBridge }).agenticComplex;
    window.location.hash = '';
  });

  it('pushes each route the shell sends onto the router history', () => {
    const fake = createFakeBridge({ surface: 'main', still: true });
    let send: ((route: string) => void) | undefined;
    window.agenticComplex = {
      ...fake,
      window: {
        ...fake.window,
        onRoute: (cb) => {
          send = cb;
          return () => {};
        },
      },
    };
    const router = createAppRouter();
    expect(send).toBeTypeOf('function');
    send?.('/diag?tab=logs');
    expect(router.history.location.pathname).toBe('/diag');
    expect(router.history.location.search).toBe('?tab=logs');
    send?.('/chat?conv=c%261');
    expect(router.history.location.pathname).toBe('/chat');
    expect(new URLSearchParams(router.history.location.search).get('conv')).toBe('c&1');
  });

  it('keeps the fake bridge onRoute usable without a shell', () => {
    const off = createFakeBridge({ surface: 'main' }).window.onRoute(() => {});
    expect(off).toBeTypeOf('function');
    off();
    expect(() => createAppRouter()).not.toThrow();
  });
});
