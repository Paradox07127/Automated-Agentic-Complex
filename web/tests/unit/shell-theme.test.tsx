import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDemo } from '../../src/shell/demo';
import { useSystemTheme, type AppearanceFeed, type ThemeName } from '../../src/shell/useSystemTheme';
import { stubMatchMedia } from './mediaStub';

const LIGHT = '(prefers-color-scheme: light)';
const media = stubMatchMedia();
const theme = () => document.documentElement.dataset.theme;

afterEach(() => {
  cleanup();
  media.set(LIGHT, false);
  document.documentElement.removeAttribute('data-theme');
});

describe('useSystemTheme', () => {
  it('starts in the system appearance and follows it while open', () => {
    media.set(LIGHT, true);
    renderHook(() => useSystemTheme(null));
    expect(theme()).toBe('light');
    act(() => media.set(LIGHT, false));
    expect(theme()).toBe('dark');
    act(() => media.set(LIGHT, true));
    expect(theme()).toBe('light');
  });

  it('lets theme= win over the system', () => {
    media.set(LIGHT, true);
    const { rerender } = renderHook(({ p }: { p: string | null }) => useSystemTheme(p), { initialProps: { p: 'dark' as string | null } });
    expect(theme()).toBe('dark');
    act(() => media.set(LIGHT, true));
    expect(theme()).toBe('dark');
    rerender({ p: null });
    expect(theme()).toBe('light');
  });

  it('takes a native appearance feed and unsubscribes on unmount', () => {
    let push: ((t: ThemeName) => void) | null = null;
    const feed: AppearanceFeed = (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    };
    const { unmount } = renderHook(() => useSystemTheme(null, feed));
    expect(theme()).toBe('dark');
    act(() => push?.('light'));
    expect(theme()).toBe('light');
    unmount();
    expect(push).toBeNull();
  });
});

describe('theme URL flag', () => {
  it('is null unless theme= says light or dark', () => {
    expect(parseDemo('').theme).toBeNull();
    expect(parseDemo('?theme=bogus').theme).toBeNull();
    expect(parseDemo('?theme=dark').theme).toBe('dark');
    expect(parseDemo('?theme=light').theme).toBe('light');
  });
});
