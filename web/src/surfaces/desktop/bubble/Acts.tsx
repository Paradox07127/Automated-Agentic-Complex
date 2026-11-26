import { useId, useState } from 'react';
import { getBridge } from '../../../bridge';
import { Icon } from '../../../ui';
import styles from './Bubble.module.css';

/** The votes 有用 and 少说点 post as POST /feedback `value`. */
export type Vote = 'useful' | 'less';

const VOTES: { value: Vote; label: string }[] = [
  { value: 'useful', label: '有帮助' },
  { value: 'less', label: '减少此类提示' },
];

export interface ActsProps {
  /** What 复制 copies and 回复 quotes. */
  text: string;
  replyLabel?: string;
  onReply: () => void;
  /** 关闭此类, for a thought or a line she said on her own; null hides it. */
  onMute: (() => void) | null;
  /** 关闭, only the line or thought shown now; null hides it. */
  onClose: (() => void) | null;
  /** 有用 and 少说点, for a thought or a line she said on her own: the vote already sent for it; null hides them. */
  vote: { sent: Vote | null; send: (value: Vote) => void } | null;
  /** 停止, while her foreground turn thinks or streams; null hides it. */
  onStop?: (() => void) | null;
}

/** 停止 in the bubble's own capsule, beside 回复 or alone while she thinks. */
export function StopAct({ onStop }: { onStop: () => void }) {
  return (
    <button type="button" className={styles.act} data-region="" onClick={onStop}>
      停止
    </button>
  );
}

/** The bubble keeps reply in view and puts copying and feedback in a disclosure. */
export function Acts({ text, replyLabel = '回复', onReply, onMute, onClose, vote, onStop = null }: ActsProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const moreId = useId();
  return (
    <div className={styles.acts} data-bubble-acts="">
      <button type="button" className={styles.act} data-region="" onClick={onReply}>
        {replyLabel}
      </button>
      {onStop && <StopAct onStop={onStop} />}
      {text && <button type="button" className={styles.act} data-region="" title="更多操作" aria-label="更多操作" aria-expanded={expanded} aria-controls={moreId} onClick={() => setExpanded((value) => !value)}>
        <Icon name="more" size={16} />
      </button>}
      {onClose && (
        <button type="button" className={styles.x} data-region="" title="关闭" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      )}
      {expanded && <div id={moreId} className={styles.moreActs}>
        <button type="button" className={styles.act} data-region="" onClick={() => void getBridge().clipboard.writeText(text).then(() => setCopied('done'), () => setCopied('failed'))}>
          复制
        </button>
        {vote &&
        VOTES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={styles.act}
            data-region=""
            disabled={vote.sent != null}
            aria-label={vote.sent === value ? `${label}（已发送）` : undefined}
            onClick={() => vote.send(value)}
          >
            {vote.sent === value ? `${label} ✓` : label}
          </button>
        ))}
        {onMute && (
          <button type="button" className={styles.act} data-region="" onClick={onMute}>
            关闭此类
          </button>
        )}
        {copied !== 'idle' && <span className={styles.note} role="status">{copied === 'done' ? '已复制' : '复制失败'}</span>}
      </div>}
    </div>
  );
}
