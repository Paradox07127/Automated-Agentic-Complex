import { useMemo } from 'react';
import { useRouterState } from '@tanstack/react-router';

export type DemoState = 'loading' | 'empty' | 'error';

/** Global URL state shared by every page: `?state=…&still=1&demo=…&theme=light`. */
export interface DemoFlags {
  state: DemoState | null;
  still: boolean;
  demo: string | null;
  /** Only an explicit `theme=`; null follows the system appearance. */
  theme: 'dark' | 'light' | null;
}

const states: readonly string[] = ['loading', 'empty', 'error'];

export function parseDemo(search: string): DemoFlags {
  const q = new URLSearchParams(search);
  const state = q.get('state');
  const theme = q.get('theme');
  return {
    state: state && states.includes(state) ? (state as DemoState) : null,
    still: q.get('still') === '1',
    demo: q.get('demo'),
    theme: theme === 'light' || theme === 'dark' ? theme : null,
  };
}

export function useDemo(): DemoFlags {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => parseDemo(search), [search]);
}
