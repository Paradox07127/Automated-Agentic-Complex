import { useContext, useEffect, useRef, useState } from 'react';
import { InSession, QuestionBox } from '../../../features/approval';
import { isStill } from '../../../features/approval/useCountdown';
import { Btn, Receipt } from '../../../ui';
import { CANCEL_RECEIPT, UNDO_S, type Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { LifeLine } from '../LifeLine';
import type { StackCard } from '../model';
import { PaperLine, PaperSheet } from './PaperSheet';
import styles from './paper.module.css';

/** 桌面提问卡（白纸）：复用 QuestionBox（题目、倒计时或「不限时 · 等了 N 分钟」、选项、自由文本）；取消请求先留 5 s「撤销」。 */
export interface QuestionStackCardProps {
  card: Extract<StackCard, { kind: 'question' }>;
  index: number;
  top: boolean;
  now: number;
  highlight?: boolean;
  act: Act;
}

export function QuestionStackCard({ card, top, now, highlight, act }: QuestionStackCardProps) {
  const [cancelling, setCancelling] = useState(false);
  /** The cancel as clicked: sent when the undo window ends, or at once if the card goes away first. */
  const pending = useRef<{ id: string; revision: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });
  const drop = () => {
    clearTimeout(pending.current?.timer);
    pending.current = null;
    setCancelling(false);
  };
  const flush = useRef(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    actRef.current({ type: 'cancel-question', id: p.id, expected_version: p.revision });
  }).current;
  useEffect(() => flush, [flush]);
  const revision = card.item.revision;
  useEffect(() => {
    if (pending.current && pending.current.revision !== revision) drop();
  }, [revision]);
  const startCancel = () => {
    const p: NonNullable<typeof pending.current> = { id: card.id, revision };
    pending.current = p;
    if (!isStill())
      p.timer = setTimeout(() => {
        setCancelling(false);
        flush();
      }, UNDO_S * 1000);
    setCancelling(true);
  };
  // In a session card the question is QuestionBox's compact block, with no paper sheet around it.
  const inSession = useContext(InSession);
  const body = card.receipt ? (
    <>
      <h3 className={styles.title}>{card.item.title}</h3>
      <Receipt>{card.receipt}</Receipt>
    </>
  ) : cancelling ? (
    <>
      <h3 className={styles.title}>{card.item.title}</h3>
      <div className={styles.row}>
        <Receipt tone="neutral">{CANCEL_RECEIPT}</Receipt>
        <Btn variant="ghost" size="sm" onClick={drop}>
          撤销
        </Btn>
      </div>
      <LifeLine totalS={UNDO_S} leftS={UNDO_S} paused={false} />
    </>
  ) : (
    <QuestionBox
      question={card.item}
      now={now}
      secondaryEmphasis={!top}
      onAnswer={(answers) => act({ type: 'answer', id: card.id, expected_version: card.item.revision, answers, text: Object.values(answers).flat().join('，') })}
      onCancel={startCancel}
    />
  );
  return (
    <CardFrame cardId={card.id} highlight={highlight} popup>
      {inSession ? (
        body
      ) : (
        <>
          <PaperLine />
          <PaperSheet code="QUESTION" priority={1} label={`提问：${card.item.title}`}>
            {body}
          </PaperSheet>
        </>
      )}
    </CardFrame>
  );
}
