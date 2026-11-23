import { approvalView, type ApprovalStackItem } from '../../../features/approval';
import { Btn } from '../../../ui/Btn';
import { Icon } from '../../../ui/Icon';
import type { CardAction } from '../../stack/actions';
import styles from './ConfirmCard.module.css';

export interface ConfirmCardProps {
  card: ApprovalStackItem;
  /** The other approvals waiting behind this one. */
  more: number;
  tail?: 'left' | 'right' | 'bottom' | null;
  act: (a: CardAction) => void;
  /** 详情: the task or session it came from. */
  onDetails: () => void;
}

/**
 * 要你批准 on the white paper card (the chat page's `.swap`): the striped top edge, the tag with the time left, the title,
 * where it came from, the command, the time-left line, 详情 and 拒绝 / 批准. It does not go by itself; ✕ folds it into the
 * status mark's 待批准 n.
 */
export function ConfirmCard({ card, more, tail = null, act, onDetails }: ConfirmCardProps) {
  const v = approvalView(card);
  const allow = v.action('allow');
  const deny = v.action('deny');
  const left = v.secondsLeft != null && v.windowS ? Math.max(0, Math.min(1, v.secondsLeft / v.windowS)) : null;
  const shown = v.cmd ?? v.previewText;
  return (
    <div
      className={styles.paper}
      data-theme="light"
      data-region=""
      data-confirm=""
      data-danger={v.dangerous || undefined}
      data-tail={tail ?? undefined}
      role="alertdialog"
      aria-label={`要你批准：${v.title}`}
    >
      <span className={styles.drag} data-drag="" aria-hidden="true" />
      <p className={styles.tag}>
        <span aria-hidden="true">◆</span> 要你批准{more > 0 && ` │ 还有 ${more} 项`}
        {v.secondsLeft != null && <span className={styles.time}>剩 {Math.ceil(v.secondsLeft)} 秒</span>}
        <button type="button" className={styles.fold} aria-label="折起" title="折起" onClick={() => act({ type: 'collapse', id: card.id })}>
          <Icon name="close" size={14} />
        </button>
      </p>
      <h4 className={styles.title}>{v.title}</h4>
      {v.origin && <p className={styles.who}>{v.origin}</p>}
      {shown && <q className={styles.cmd}>{shown}</q>}
      {left != null && (
        <div className={styles.left} aria-hidden="true">
          <i style={{ transform: `scaleX(${left})` }} />
        </div>
      )}
      <div className={styles.row}>
        <button type="button" className={styles.link} onClick={onDetails}>
          详情
        </button>
        {deny && (
          <Btn variant="secondary" size="sm" onClick={() => act(deny)}>
            拒绝
          </Btn>
        )}
        {allow && (
          <Btn variant="primary" size="sm" mouseOnly={v.dangerous} onClick={() => act(allow)}>
            批准
          </Btn>
        )}
      </div>
      {tail && (
        <svg className={styles.tail} viewBox="0 0 12 10" aria-hidden="true">
          <path d="M0 0h12L2 10z" />
        </svg>
      )}
    </div>
  );
}
