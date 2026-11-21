import type { ReactNode } from 'react';
import { Btn } from '../../../ui';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { keycapsFor } from '../keys';
import { priorityOf, type StackCard } from '../model';
import { AvatarLoadingStackCard } from './AvatarLoadingStackCard';
import { ComputerUseStackCard } from './ComputerUseStackCard';
import { DropCard } from './DropCard';
import { VoiceHintStackCard } from './VoiceHintStackCard';
import styles from './NoticeBody.module.css';

/** A reminder's 延后 choices; the minutes agentd's snooze takes. */
const SNOOZE: ReadonlyArray<[5 | 15 | 60, string]> = [
  [5, '5 分钟'],
  [15, '15 分钟'],
  [60, '1 小时'],
];

/** 通知卡（P2/P3，stk）：提醒、看一下回执、完成、简报、继续任务；原生自己发的电脑操作、语音提示、角色加载、交给她各有自己的卡。 */
export interface NoticeStackCardProps {
  card: Extract<StackCard, { kind: 'notice' }>;
  index: number;
  top: boolean;
  /** 栈时钟（epoch ms），角色恢复倒计时用；不给时取当前时间 */
  now?: number;
  highlight?: boolean;
  act: Act;
}

export function NoticeStackCard({ card, top, now, highlight, act }: NoticeStackCardProps) {
  const caps = keycapsFor(card);
  const priority = priorityOf(card);
  const frame = (node: ReactNode) => (
    <CardFrame cardId={card.id} highlight={highlight}>
      {node}
    </CardFrame>
  );

  switch (card.variant) {
    case 'computer':
      return <ComputerUseStackCard card={card} top={top} highlight={highlight} act={act} />;
    case 'voice':
      return <VoiceHintStackCard card={card} top={top} highlight={highlight} act={act} />;
    case 'loading':
      return <AvatarLoadingStackCard card={card} top={top} now={now ?? Date.now()} highlight={highlight} act={act} />;
    case 'drop':
      return <DropCard card={card} top={top} highlight={highlight} act={act} />;
    case 'reminder': {
      const commitment = card.commitment_id;
      return frame(
        <HudCard
          title="提醒"
          state="warning"
          label={`提醒：${card.title}`}
          eyebrow="Reminder"
          look="tips"
          priority={priority}
          top={top}
          onClose={() => act({ type: 'collapse', id: card.id })}
          escKey={top && caps.esc}
          footer={
            commitment && (
              <>
                {SNOOZE.map(([minutes, label]) => (
                  <Btn key={minutes} variant="secondary" size="sm" onClick={() => act({ type: 'snooze', id: card.id, commitment, minutes })}>
                    {label}
                  </Btn>
                ))}
                <Btn variant="ghost" size="sm" onClick={() => act({ type: 'complete', id: card.id, commitment })}>
                  完成
                </Btn>
              </>
            )
          }
        >
          <p className={styles.t}>{card.title}</p>
        </HudCard>,
      );
    }
    case 'look':
      return frame(
        <HudCard title="屏幕识读" label={card.title} state="done" eyebrow="Look" look="toast" priority={priority} top={top}>
          <p className={styles.t}>{card.title}</p>
        </HudCard>,
      );
    case 'done':
      return frame(
        <HudCard title={card.title} state="done" eyebrow="Notice" look="finish" priority={priority} top={top}>
          {card.body && <p className={styles.desc}>{card.body}</p>}
        </HudCard>,
      );
    case 'brief':
      return frame(
        <HudCard title={card.title} eyebrow="Brief" look="toast" priority={priority} top={top}>
          {card.body && <p className={styles.desc}>{card.body}</p>}
        </HudCard>,
      );
    case 'resume':
      return frame(
        <HudCard
          title={card.title}
          state="awaiting_input"
          eyebrow="Notice"
          look="toast"
          priority={priority}
          top={top}
          footer={
            <Btn
              variant="secondary"
              size="sm"
              onClick={() => act({ type: 'open', to: { page: 'overview', sel: card.task_id ?? undefined }, message: '已在主窗口打开：任务' })}
            >
              打开任务
            </Btn>
          }
        />,
      );
  }
}
