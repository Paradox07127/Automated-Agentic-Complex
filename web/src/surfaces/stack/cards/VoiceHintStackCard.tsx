import { Btn } from '../../../ui';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { HudCard } from '../HudCard';
import { priorityOf, type DesktopStackCard } from '../model';
import body from './NoticeBody.module.css';
import styles from './DesktopNotice.module.css';

/** 语音提示卡（P3，stk）：按住说话的录音、结果（2.5 秒后自己走）和模型下载；麦克风被拒时一直留着，等你关掉或去设置。 */
export interface VoiceHintStackCardProps {
  card: Extract<DesktopStackCard, { variant: 'voice' }>;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function VoiceHintStackCard({ card, top, highlight, act }: VoiceHintStackCardProps) {
  const denied = card.phase === 'mic_denied';
  const fraction = Math.max(0, Math.min(1, card.fraction ?? 0));
  const meta =
    card.phase === 'listening' && card.elapsed_s != null
      ? `${pad(Math.floor(card.elapsed_s / 60))}:${pad(card.elapsed_s % 60)}`
      : card.phase === 'downloading' && card.total_mb != null
        ? `${Math.round(card.received_mb ?? 0)} / ${Math.round(card.total_mb)} MB`
        : undefined;
  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <HudCard
        title={card.title}
        state={denied ? 'failed' : card.phase === 'discarded' ? 'warning' : card.phase === 'sent' ? 'done' : 'running'}
        label={`语音：${card.title}`}
        eyebrow="Voice"
        priority={priorityOf(card)}
        top={top}
        meta={meta && <span className={styles.meta}>{meta}</span>}
        onClose={denied ? () => act({ type: 'archive', id: card.id }) : undefined}
        footer={
          denied && (
            <Btn variant="secondary" size="sm" onClick={() => act({ type: 'open', to: { page: 'settings', group: 'perm' }, message: '已在主窗口打开：设置 › 权限与授权' })}>
              去权限与授权
            </Btn>
          )
        }
      >
        {card.phase === 'downloading' ? (
          <>
            <p className={body.line}>下载会继续，可以松开 │ {Math.round(fraction * 100)}%</p>
            <div className={styles.prog} role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
              <i style={{ width: `${fraction * 100}%` }} />
            </div>
          </>
        ) : (
          <p className={body.t}>{card.text || '正在听…'}</p>
        )}
      </HudCard>
    </CardFrame>
  );
}
