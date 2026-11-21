import { useContext, useState } from 'react';
import { InSession, QuestionBox } from '../../../features/approval';
import { Btn } from '../../../ui';
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
  // In a session card the question is QuestionBox's compact block, with no paper sheet around it.
  const inSession = useContext(InSession);
  const body = card.receipt ? (
    <>
      <h3 className={styles.title}>{card.item.title}</h3>
      <p className={styles.receipt} role="status">
        ✓ {card.receipt}
      </p>
    </>
  ) : cancelling ? (
    <>
      <h3 className={styles.title}>{card.item.title}</h3>
      <div className={styles.row} role="status">
        <span className={styles.receipt}>✓ {CANCEL_RECEIPT}</span>
        <Btn variant="ghost" size="sm" onClick={() => setCancelling(false)}>
          撤销
        </Btn>
      </div>
      <LifeLine
        totalS={UNDO_S}
        leftS={UNDO_S}
        paused={false}
        onEnd={() => {
          setCancelling(false);
          act({ type: 'cancel-question', id: card.id, expected_version: card.item.revision });
        }}
      />
    </>
  ) : (
    <QuestionBox
      question={card.item}
      now={now}
      secondaryEmphasis={!top}
      onAnswer={(answers) => act({ type: 'answer', id: card.id, expected_version: card.item.revision, answers, text: Object.values(answers).flat().join('，') })}
      onCancel={() => setCancelling(true)}
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
