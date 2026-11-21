import { Btn } from '../../../ui';
import { Fold } from '../../../ui/Fold';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { keycapsFor } from '../keys';
import { priorityOf, type StackCard } from '../model';
import styles from './NoticeBody.module.css';

/** 任务出错卡（stk 红头）：正文是任务名和一行原因，完整原因收进「出错详情」；[看出错] 打开任务详情；只能手动关。 */
export interface ErrorStackCardProps {
  card: Extract<StackCard, { kind: 'error' }>;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

export function ErrorStackCard({ card, top, highlight, act }: ErrorStackCardProps) {
  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title="任务出错"
        state="error"
        label={`任务出错：${card.title}`}
        alarm
        priority={priorityOf(card)}
        top={top}
        onClose={() => act({ type: 'archive', id: card.id })}
        escKey={top && keycapsFor(card).esc}
        footer={
          <Btn variant="secondary" size="sm" onClick={() => act({ type: 'open', to: { page: 'overview', sel: card.task_id }, message: `已在主窗口打开：任务 › ${card.title}` })}>
            看出错
          </Btn>
        }
      >
        <p className={styles.t}>{card.title}</p>
        <p className={styles.line}>{card.reason}</p>
        <Fold id={`error-${card.id}`} label="出错详情">
          <p className={styles.desc}>{card.reason}</p>
        </Fold>
      </HudCard>
    </CardFrame>
  );
}
