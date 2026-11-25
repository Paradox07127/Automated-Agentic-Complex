import { formatClock } from '../../domain';
import { Btn } from '../../ui';
import type { ApprovalOutcome } from './ApprovalCard';
import { expiredNote, type ApprovalOrigin } from './approvalView';
import styles from './DecisionReceipt.module.css';

/** 决定回执：已批准 / 已拒绝 / 已超时写后果加「去终端」/ 没送达 / 被别处处理「已在终端批准 · hh:mm」。 */
export interface DecisionReceiptProps {
  /** 回执 */
  outcome: ApprovalOutcome;
  /** 发起方，例如「Codex」，用在超时后果里 */
  agent?: string;
  /** 去终端；只有编码工具的 hook 审批有 */
  onGoTerminal?: () => void;
  /** 卡从哪来：hook 超时后工具回到自己终端里的确认框；自有会话和派活卡没有终端可去 */
  origin: ApprovalOrigin;
}

const LABEL: Record<ApprovalOutcome['kind'], string> = {
  approved: '已批准',
  denied: '已拒绝',
  expired: '已超时 │ 请求已失效',
  failed: '没能送达决定',
  elsewhere: '已在终端批准',
};

export function DecisionReceipt({ outcome, agent = '会话', onGoTerminal, origin }: DecisionReceiptProps) {
  const { kind } = outcome;
  const hook = origin === 'hook';
  const label = kind === 'expired' && hook ? '已超时 │ 已回到终端里确认' : kind === 'failed' || kind === 'expired' ? LABEL[kind] : (outcome.text ?? LABEL[kind]);
  return (
    <div data-stub="DecisionReceipt" className={styles.root} data-kind={kind} role="status">
      <div className={styles.line}>
        <span className={styles.mark} aria-hidden="true" />
        <span>
          {label}
          {kind !== 'expired' && (
            <>
              {' │ '}
              <span className="num">{formatClock(outcome.at)}</span>
            </>
          )}
        </span>
      </div>
      {kind === 'expired' && (
        <p className={styles.note}>
          后果：{expiredNote(origin, agent)}
          {hook && <> <span className={styles.unverified}>▲ 未验证</span></>}
        </p>
      )}
      {kind === 'elsewhere' && <p className={styles.note}>这张卡被别处处理了，这里不用再点</p>}
      {kind === 'failed' && outcome.text && <p className={styles.note}>{outcome.text}</p>}
      {hook && (kind === 'expired' || kind === 'failed') && (
        // Wrapped so the grid does not stretch the link across the card.
        <span>
          <Btn variant="link" disabled={!onGoTerminal} disabledReason="没有会话关联" onClick={onGoTerminal}>
            去终端 ↗
          </Btn>
        </span>
      )}
    </div>
  );
}
