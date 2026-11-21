import { useMemo } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { appNow } from '../../bridge/clock';

export { call } from '../../bridge/agentd';

export const pageNow = appNow;

/** Page-specific hash query (`?tab=…&sel=…`) next to the shell's demo flags. */
export function usePageParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

export { useGo } from '../../shell/nav';
