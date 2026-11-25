import type { ReactNode } from 'react';
import { navigate } from '../../shell/nav';
import { SetPanel } from './CharacterSettings';
import type { RailItem } from './Rail';
import type { CharTab } from './sections';

/** A section in the panel in place of the panes. `tabs`: the 设定 tabs that have rows. */
export type Side = { of: 'set'; tab: CharTab; tabs: readonly CharTab[]; node: ReactNode };

export const go = (to: Omit<Extract<Parameters<typeof navigate>[0], { page: 'character' }>, 'page'>) => navigate({ page: 'character', ...to });

/** Where each rail item goes; MMD is a page of its own. */
export const GO: Record<RailItem, () => void> = {
  overview: () => go({}),
  look: () => go({ pane: 'look' }),
  motion: () => go({ pane: 'motion' }),
  set: () => go({ tab: 'behavior' }),
  mmd: () => navigate({ page: 'mmd' }),
};

/** 设定 with its tab bar. */
export function SidePanel({ side }: { side: Side }) {
  return (
    <SetPanel tabs={side.tabs} tab={side.tab} onTab={(t) => go({ tab: t })}>
      {side.node}
    </SetPanel>
  );
}
