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
    <PaperCard title={`确认删除「${conv.title}」？`} warn onClose={onClose}>
      <p className={styles.p}>{`该对话中的 ${conv.turn_count} 轮记录将被一并删除，且无法恢复。${conv.archived ? '' : '如仅需暂时隐藏，可选择归档。'}`}</p>
      <div className={styles.row}>
        <Btn size="sm" variant="secondary" onClick={onClose}>
          取消
        </Btn>
        {!conv.archived && (
          <Btn size="sm" variant="ghost" onClick={pick(onArchive)}>
            改为归档
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
    <PaperCard title={`切换角色「${who.name}」出场？`} onClose={() => onPick(false)}>
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
      <p className={styles.p}>{`${who.name} 当前未在桌面显示。${from ? `${from.name} 将返回角色列表。` : ''}${text ? `切换完成后将把该消息发送给 ${who.name}。` : ''}`}</p>
      <div className={styles.row}>
        <Btn size="sm" variant="secondary" onClick={() => onPick(false)}>
          取消
        </Btn>
        <Btn size="sm" variant="primary" icon="g-switch" onClick={() => onPick(true)}>
          {text ? '切换并发送' : '切换出场'}
        </Btn>
      </div>
    </PaperCard>
  );
}
