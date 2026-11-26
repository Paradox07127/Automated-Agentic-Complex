// SNS chat motion: game clips of snsfriendpanel (sns_friend_in, the contact cell's in and selected frame, dialog change, the empty dialog).
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { gameClips, type GameClip } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';
import chat from './Chat.module.css';

/** Plays a clip under root once, on mount; unmounting drops it. */
function Play({ clip, root }: { clip: GameClip; root: RefObject<Element | null> }) {
  useGameClip(clip, root, { autoplay: true });
  return null;
}

/** sns_friend_in on the list and dialog columns; sns_frienddialog_change on head, messages and composer after each switch of conversation. */
export function useChatMotion(conv: string | null, still: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useGameClip(gameClips.snsFriendIn, ref, { autoplay: !still });
  const [seen, setSeen] = useState({ conv, switched: false });
  if (seen.conv !== conv) setSeen({ conv, switched: seen.switched || seen.conv != null });
  const node = seen.switched && conv != null && !still ? <Play key={conv} clip={gameClips.snsDialogChange} root={ref} /> : null;
  return { ref, node };
}

/** sns_friendcell_in on every contact cell under root, once they are there. */
export function CellsIn({ root }: { root: RefObject<Element | null> }) {
  return <Play clip={gameClips.snsCellIn} root={root} />;
}

/** No conversation: sns_barkerrightnoselected_in's backdrop mask and tips bar around the empty state. */
export function ChatEmpty({ still, children }: { still: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useGameClip(gameClips.snsEmptyIn, ref, { autoplay: !still });
  return (
    <div ref={ref} className={chat.empty}>
      <i className={chat.emptyMask} data-g="mask" aria-hidden="true" />
      <div className={chat.tips} data-g="tips">
        {children}
      </div>
    </div>
  );
}
