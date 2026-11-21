import { useState } from 'react';
import { getBridge } from '../../../bridge';
import { Btn } from '../../../ui';
import { Fold } from '../../../ui/Fold';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { priorityOf, type DesktopStackCard } from '../model';
import body from './NoticeBody.module.css';
import styles from './DesktopNotice.module.css';

/** 电脑操作卡（P0，常驻，stk）：正在操作哪个应用、这一步在做什么；窗口和范围收进折叠段；[收起] 只折进队列条，红色 [停止] 停下这次操作。 */
export interface ComputerUseStackCardProps {
  card: Extract<DesktopStackCard, { variant: 'computer' }>;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

export function ComputerUseStackCard({ card, top, highlight, act }: ComputerUseStackCardProps) {
  const [stop, setStop] = useState<{ state: 'idle' | 'busy' | 'done' } | { state: 'failed'; text: string }>({ state: 'idle' });
  const onStop = () => {
    setStop({ state: 'busy' });
    getBridge().computerUse.stop().then(
      () => setStop({ state: 'done' }),
      (e: unknown) => setStop({ state: 'failed', text: e instanceof Error ? e.message : String(e) }),
    );
  };
  const subject = card.target_app ? `${card.title}「${card.target_app}」` : card.title;
  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title="电脑操作"
        state="running"
        label={`电脑操作：${subject}`}
        eyebrow="Computer"
        priority={priorityOf(card)}
        top={top}
        urgent
        footer={
          <>
            <Btn variant="ghost" size="sm" onClick={() => act({ type: 'collapse', id: card.id })}>
              收起
            </Btn>
            <Btn variant="danger" size="sm" icon="stop" loading={stop.state === 'busy'} disabled={stop.state === 'done'} disabledReason="已停止" onClick={onStop}>
              {stop.state === 'done' ? '已停止' : '停止'}
            </Btn>
          </>
        }
      >
        <p className={body.t}>{subject}</p>
        <p className={body.line}>{card.action}</p>
        <div className={styles.prog} data-ind={card.phase === 'paused' ? undefined : ''} aria-hidden="true">
          <i />
        </div>
        {stop.state === 'failed' && <p className={styles.err}>没能停止：{stop.text}</p>}
        <Fold id={`computer-${card.id}`} label="窗口与范围" count={card.scopes.length || undefined}>
          {card.target_title && <p className={body.desc}>窗口：{card.target_title}</p>}
          {card.scopes.length > 0 ? (
            <ul className={styles.chips}>
              {card.scopes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className={body.desc}>没有限定范围</p>
          )}
        </Fold>
      </HudCard>
    </CardFrame>
  );
}
