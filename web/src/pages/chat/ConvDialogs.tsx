import { useId, useRef, type ReactNode } from 'react';
import type { Conversation } from '../../domain';
import { Btn, Icon, OverlayPortal, useOverlayFocus } from '../../ui';
import { Face } from './CharTabs';
import type { ChatCharacter } from './useChatData';
import styles from './ConvDialogs.module.css';

/** The white paper card over the whole window (prototype .swap): Esc or a click beside it closes it. */
function PaperCard(p: { title: string; warn?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <OverlayPortal>
      <PaperBody {...p} />
    </OverlayPortal>
  );
}

function PaperBody({ title, warn, onClose, children }: { title: string; warn?: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  const head = useId();
  return (
    <div className={styles.back} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={styles.card} data-warn={warn || undefined} data-theme="light" role="dialog" aria-modal="true" aria-labelledby={head} tabIndex={-1} onKeyDown={trap}>
        <h4 id={head} className={styles.h}>
          {title}
        </h4>
        {children}
      </div>
    </div>
  );
}

export function DeleteCard({ conv, onClose, onArchive, onDelete }: { conv: Conversation | null; onClose: () => void; onArchive: (c: Conversation) => void; onDelete: (c: Conversation) => void }) {
  if (!conv) return null;
  const pick = (f: (c: Conversation) => void) => () => {
    onClose();
    f(conv);
  };
  return (
    <PaperCard title={`删除「${conv.title}」？`} warn onClose={onClose}>
      <p className={styles.p}>{`这个话题里的 ${conv.turn_count} 轮对话一起删除，删除后找不回。${conv.archived ? '' : '只是不想看到，可以归档。'}`}</p>
      <div className={styles.row}>
        <Btn size="sm" variant="secondary" onClick={onClose}>
          先不删
        </Btn>
        {!conv.archived && (
          <Btn size="sm" variant="ghost" onClick={pick(onArchive)}>
            改成归档
          </Btn>
        )}
        <Btn size="sm" variant="danger" icon="g-delete" onClick={pick(onDelete)}>
          删除
        </Btn>
      </div>
    </PaperCard>
  );
}

export interface SwapAsk {
  who: ChatCharacter;
  /** The character on the desktop now, when known. */
  from: ChatCharacter | null;
  /** The line waiting to go to her; empty from her tab's menu. */
  text: string;
}

/** 换她出来: she is not on the desktop; yes brings her out (and then sends the line). */
export function SwapCard({ ask, onPick }: { ask: SwapAsk | null; onPick: (yes: boolean) => void }) {
  if (!ask) return null;
  const { who, from, text } = ask;
  return (
    <PaperCard title={`换${who.name}出来回你？`} onClose={() => onPick(false)}>
      <div className={styles.who2} aria-hidden="true">
        {from && (
          <>
            <Face c={from} />
            <Icon name="g-send" size={16} />
          </>
        )}
        <Face c={who} />
      </div>
      {text && <q className={styles.q}>{text}</q>}
      <p className={styles.p}>{`${who.name}现在不在桌面上。${from ? `${from.name}会回到列表里。` : ''}${text ? `换好后这句话发给${who.name}。` : ''}`}</p>
      <div className={styles.row}>
        <Btn size="sm" variant="secondary" onClick={() => onPick(false)}>
          先不换
        </Btn>
        <Btn size="sm" variant="primary" icon="g-switch" onClick={() => onPick(true)}>
          {text ? '换出来并发送' : '换出来'}
        </Btn>
      </div>
    </PaperCard>
  );
}
