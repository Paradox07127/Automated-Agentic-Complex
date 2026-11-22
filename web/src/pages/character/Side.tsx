import type { ReactNode } from 'react';
import { navigate } from '../../shell/nav';
import { SetPanel } from './CharacterSettings';
import type { RailItem } from './Rail';
import type { CharTab } from './sections';

/** What the stage previews in the MMD section: the dance, the click that asked for it, 一次 or 循环. */
export interface StagePreview {
  action: string | undefined;
  request: number | undefined;
  loop: boolean;
}

/** A section in the panel in place of the panes. `tabs`: the 设定 tabs that have rows. MMD: `node` is its panel and her setlist, `band` while the setlist stands under the stage. */
export type Side =
  | { of: 'set'; tab: CharTab; tabs: readonly CharTab[]; node: ReactNode }
  | { of: 'photo'; node: ReactNode }
  | { of: 'mmd'; node: ReactNode; band: boolean; preview: StagePreview };

export const go = (to: Omit<Extract<Parameters<typeof navigate>[0], { page: 'character' }>, 'page'>) => navigate({ page: 'character', ...to });

/** Where each rail item goes. */
export const GO: Record<RailItem, () => void> = {
  overview: () => go({}),
  look: () => go({ pane: 'look' }),
  motion: () => go({ pane: 'motion' }),
  set: () => go({ tab: 'behavior' }),
  photo: () => go({ view: 'photo' }),
  mmd: () => go({ view: 'mmd' }),
};

/** 设定 with its tab bar; 拍照 and MMD draw their own frame. */
export function SidePanel({ side }: { side: Side }) {
  if (side.of !== 'set') return <>{side.node}</>;
  return (
    <SetPanel tabs={side.tabs} tab={side.tab} onTab={(t) => go({ tab: t })}>
      {side.node}
    </SetPanel>
  );
}
