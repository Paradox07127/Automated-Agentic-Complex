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

/** 角色加载卡（P2，stk）：加载中、意外退出后的恢复倒计时、加载失败；失败时 [重新启动] 重启角色进程，[关闭] 收进历史。 */
export interface AvatarLoadingStackCardProps {
  card: Extract<DesktopStackCard, { variant: 'loading' }>;
  top: boolean;
  now: number;
  highlight?: boolean;
  act: Act;
}

export function AvatarLoadingStackCard({ card, top, now, highlight, act }: AvatarLoadingStackCardProps) {
  const [restart, setRestart] = useState<{ state: 'idle' | 'busy' | 'sent' } | { state: 'failed'; text: string }>({ state: 'idle' });
  const failed = card.phase === 'failed';
  const onRestart = () => {
    setRestart({ state: 'busy' });
    getBridge().supervisor.restart('avatar').then(
      () => setRestart({ state: 'sent' }),
      (e: unknown) => setRestart({ state: 'failed', text: e instanceof Error ? e.message : String(e) }),
    );
  };
  const left = card.retry_at != null ? Math.max(0, Math.ceil((card.retry_at - now) / 1000)) : null;
  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title={failed ? '角色加载失败' : '角色加载'}
        state={failed ? 'failed' : card.phase === 'recovering' ? 'waiting' : 'running'}
        label={`角色：${card.title}`}
        alarm={failed}
        look="toast"
        priority={priorityOf(card)}
        top={top}
        footer={
          failed && (
            <>
              <Btn variant="secondary" size="sm" icon="refresh" loading={restart.state === 'busy'} disabled={restart.state === 'sent'} disabledReason="已重新启动" onClick={onRestart}>
                {restart.state === 'sent' ? '正在重新启动' : '重新启动'}
              </Btn>
              <Btn variant="ghost" size="sm" onClick={() => act({ type: 'archive', id: card.id })}>
                关闭
              </Btn>
            </>
          )
        }
      >
        {failed ? <p className={body.t}>{card.title}</p> : (
          <div className={styles.loading}>
            <span className={styles.spinner} aria-hidden="true" />
            <div className={styles.loadingText}>
              <p className={body.t}>{card.title}</p>
              {card.phase === 'recovering' && left != null && <p className={body.line}>{left > 0 ? `${left} 秒后重试` : '正在重试'}</p>}
              {card.character && <p className={body.line}>{card.character}</p>}
            </div>
          </div>
        )}
        {restart.state === 'failed' && <p className={styles.err}>没能重新启动：{restart.text}</p>}
        {failed && (
          <Fold id={`loading-${card.id}`} label="说明">
            <p className={body.desc}>可以重新启动角色后再试；还是不行就去诊断看角色进程。</p>
            <Btn variant="ghost" size="sm" onClick={() => act({ type: 'open', to: { page: 'diag', item: 'avatar', focus: 'proc-avatar' }, message: '已在主窗口打开：诊断 › 角色' })}>
              去诊断
            </Btn>
          </Fold>
        )}
      </HudCard>
    </CardFrame>
  );
}
