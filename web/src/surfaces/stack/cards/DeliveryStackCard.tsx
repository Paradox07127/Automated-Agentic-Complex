import { useContext } from 'react';
import { InSession } from '../../../features/approval';
import { DeliveryChain } from '../../../features/delivery';
import { Btn, Icon } from '../../../ui';
import { Fold } from '../../../ui/Fold';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { keycapsFor } from '../keys';
import { LifeLine } from '../LifeLine';
import { priorityOf, type StackCard } from '../model';
import { useHover } from '../useHover';
import styles from './NoticeBody.module.css';

/** 交付卡（stk）：产物条（标题、版本和产物）、一行摘要、交付链和时间线收进折叠段；[看结果] 打开交付并发查看回执；20 s 后进历史，悬停暂停。 */
export interface DeliveryStackCardProps {
  card: Extract<StackCard, { kind: 'delivery' }>;
  index: number;
  top: boolean;
  now: number;
  highlight?: boolean;
  act: Act;
}

export function DeliveryStackCard({ card, top, now, highlight, act }: DeliveryStackCardProps) {
  const { delivery } = card;
  const hover = useHover<HTMLElement>();
  const inSession = useContext(InSession);
  const caps = keycapsFor(card);
  const first = delivery.artifacts[0];
  const ext = first?.name.split('.').at(-1)?.toUpperCase();
  const open = () => act({ type: 'open', to: { page: 'overview', sel: delivery.task_id }, message: '已打开交付 │ 已发送查看回执' });

  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title="交付"
        label={`交付：${card.title}`}
        eyebrow={inSession ? undefined : 'Delivery'}
        priority={priorityOf(card)}
        state="done"
        look="mission"
        onClose={() => act({ type: 'archive', id: card.id })}
        escKey={top && caps.esc}
        enterKey={top && caps.enter}
        top={top}
        hoverRef={hover.ref}
        hoverHandlers={hover.handlers}
        band={
          <div className={styles.dlv}>
            <span className={styles.ff} aria-hidden="true">
              ▶▶
            </span>
            <span className={styles.dt}>
              <b title={card.title}>{card.title}</b>
              <span>
                <span className="num">交付 v{delivery.version}</span> │ {first?.name ?? '无产物'}
              </span>
            </span>
            <span className={styles.thumb} aria-hidden="true">
              <Icon name="file" size={20} />
              {ext && <small>.{ext}</small>}
            </span>
          </div>
        }
        footer={
          <Btn variant="secondary" size="sm" onClick={open}>
            看结果
          </Btn>
        }
        life={<LifeLine totalS={card.lifeTotalS} leftS={card.lifeS} paused={hover.hovered} onEnd={() => act({ type: 'archive', id: card.id })} />}
      >
        <p className={styles.line} title={card.summary}>
          {card.summary}
        </p>
        <Fold id={`delivery-${card.id}`} label="交付链">
          <DeliveryChain delivery={delivery} now={now} size="compact" />
          <span>
            <Btn variant="ghost" size="sm" onClick={() => act({ type: 'open', to: { page: 'overview', sel: delivery.task_id }, message: '已在主窗口打开：任务时间线' })}>
              时间线
            </Btn>
          </span>
        </Fold>
      </HudCard>
    </CardFrame>
  );
}
