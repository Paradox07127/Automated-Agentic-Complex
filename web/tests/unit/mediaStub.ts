import { vi } from 'vitest';

/** jsdom has no matchMedia: queries in `on` match, and `set` flips one and fires its change listeners. */
export function stubMatchMedia(on = new Set<string>()) {
  const listeners = new Map<string, Set<() => void>>();
  const of = (q: string) => listeners.get(q) ?? listeners.set(q, new Set()).get(q)!;
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q,
    get matches() {
      return on.has(q);
    },
    addEventListener: (_: string, f: () => void) => of(q).add(f),
    removeEventListener: (_: string, f: () => void) => of(q).delete(f),
  }));
  return {
    set(q: string, matches: boolean) {
      if (matches) on.add(q);
      else on.delete(q);
      of(q).forEach((f) => f());
    },
  };
}
