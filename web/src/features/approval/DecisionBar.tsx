import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatRemaining, type VisualStateKey } from '../../domain';
import { Btn, Menu, StatusTag, type MenuItem } from '../../ui';
import styles from './DecisionBar.module.css';

/** 「等你决定」条里的一个操作。 */
export interface DecisionAction {
  /** 按钮文字 */
  label: string;
  /** 键帽，例如 esc、⏎ */
  kbd?: string;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因 */
  disabledReason?: string;
  /** 正在提交 */
  loading?: boolean;
  /** 点击 */
  onClick?: () => void;
  /** 附一句理由再执行：按钮旁多一个「附理由」，展开输入框，回车带理由执行，Esc 收起 */
  withReason?: (reason: string) => void;
}

/** 「等你决定」条：一个对象一条，审批、提问、复核共用；主按钮在最右；危险审批的批准只能用鼠标点。 */
export interface DecisionBarProps {
  /** 等什么：决定状态标记的颜色、形状和文字 */
  kind: 'approval' | 'question' | 'review';
  /** 要决定的对象，一行 */
  title?: string;
  /** 一行元信息：剩余时间、未验证、产物 0/2 已看 */
  meta?: ReactNode;
  /** 危险审批：主按钮用危险样式，不响应回车和空格 */
  dangerous?: boolean;
  /** 主操作：批准、提交、接受 */
  primary: DecisionAction;
  /** 二级操作，最多 2 个，排在主按钮左边 */
  secondary?: DecisionAction[];
  /** 其余操作，收进 ⋯ */
  more?: MenuItem[];
  /** Esc：拒绝或关闭 */
  onEscape?: () => void;
  /** 外层（例如获得焦点的卡片）收到回车时要求显示「只能用鼠标点」 */
  hint?: boolean;
  /** 放在卡片底行：不画自己的边框，只留上分隔线 */
  inset?: boolean;
  /** 同屏已有别的主操作：主按钮降为 secondary */
  secondaryEmphasis?: boolean;
}

const STATE: Record<DecisionBarProps['kind'], VisualStateKey> = { approval: 'awaiting_approval', question: 'awaiting_input', review: 'needs_review' };

const isActivation = (e: KeyboardEvent<HTMLElement>) => e.key === 'Enter' || e.key === ' ';
const onApprove = (e: KeyboardEvent<HTMLElement>) => !!(e.target as HTMLElement).closest('[data-approve]');

export function DecisionBar({ kind, title, meta, dangerous, primary, secondary = [], more, onEscape, hint, inset, secondaryEmphasis }: DecisionBarProps) {
  const [blocked, setBlocked] = useState(false);
  // Which secondary action's reason field is open, by index: the actions are new objects on every render.
  const [reason, setReason] = useState<{ i: number; text: string } | null>(null);

  // Esc decides from anywhere in the bar; a dangerous approve swallows Enter/Space so only a click approves.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else if (dangerous && isActivation(e) && onApprove(e)) {
      e.preventDefault();
      e.stopPropagation();
      setBlocked(true);
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dangerous && isActivation(e) && onApprove(e)) e.preventDefault();
  };
  // The field keeps Enter and Esc to itself, so neither reaches the bar's or the card's deny and approve keys.
  const onReasonKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || (e.key !== 'Enter' && e.key !== 'Escape') || !reason) return;
    e.preventDefault();
    e.stopPropagation();
    setReason(null);
    const action = secondary[reason.i];
    const text = reason.text.trim();
    if (e.key === 'Enter') (text ? action?.withReason?.(text) : action?.onClick?.());
  };

  return (
    <div data-stub="DecisionBar" className={styles.bar} data-kind={kind} data-dangerous={dangerous || undefined} data-inset={inset || undefined} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <div className={styles.what}>
        <StatusTag state={STATE[kind]} />
        {title && (
          <span className={styles.title} title={title}>
            {title}
          </span>
        )}
        {meta != null && <span className={styles.meta}>{meta}</span>}
      </div>
      <div className={styles.acts}>
        {more && more.length > 0 && <Menu label="更多操作" icon="more" items={more} align="right" />}
        {secondary.slice(0, 2).map((a, i) => (
          // Index key: a toggling label must not remount the button and drop focus.
          <Fragment key={i}>
            <Btn variant="secondary" kbd={a.kbd} disabled={a.disabled} disabledReason={a.disabledReason} loading={a.loading} onClick={a.onClick}>
              {a.label}
            </Btn>
            {a.withReason && (
              <Btn variant="link" label={`${a.label}并附一句理由`} aria-expanded={reason?.i === i} disabled={a.disabled} disabledReason={a.disabledReason} onClick={() => setReason(reason?.i === i ? null : { i, text: '' })}>
                附理由
              </Btn>
            )}
          </Fragment>
        ))}
        <span data-approve="" className={styles.approve}>
          <Btn
            variant={dangerous ? 'danger' : secondaryEmphasis ? 'secondary' : 'primary'}
            kbd={dangerous ? undefined : primary.kbd}
            mouseOnly={dangerous}
            disabled={primary.disabled}
            disabledReason={primary.disabledReason}
            loading={primary.loading}
            onClick={primary.onClick}
          >
            {primary.label}
          </Btn>
        </span>
      </div>
      {reason && (
        <input
          className={styles.reason}
          type="text"
          aria-label={`${secondary[reason.i]?.label ?? ''}理由`}
          placeholder="一句理由，回车发出，esc 收起"
          maxLength={500}
          autoFocus
          value={reason.text}
          onChange={(e) => setReason({ i: reason.i, text: e.target.value })}
          onKeyDown={onReasonKey}
        />
      )}
      {dangerous && (hint || blocked) && (
        <p className={styles.hint} role="alert">
          危险操作只能用鼠标点击「{primary.label}」
        </p>
      )}
    </div>
  );
}

export const DecisionBarDemos: Array<{ name: string; props: DecisionBarProps }> = [
  { name: 'approval', props: { kind: 'approval', title: 'git push origin main', meta: formatRemaining(32), primary: { label: '批准', kbd: '⏎' }, secondary: [{ label: '拒绝', kbd: 'esc' }] } },
  { name: 'danger', props: { kind: 'approval', title: 'rm -rf build/', meta: formatRemaining(18), dangerous: true, primary: { label: '批准' }, secondary: [{ label: '拒绝', kbd: 'esc' }] } },
  { name: 'danger-hint', props: { kind: 'approval', title: 'rm -rf build/', dangerous: true, hint: true, primary: { label: '批准' }, secondary: [{ label: '拒绝', kbd: 'esc' }] } },
  {
    name: 'review',
    props: {
      kind: 'review',
      title: '复核 v2',
      meta: '未验证 │ 产物 0/2 已看',
      primary: { label: '接受 v2' },
      secondary: [{ label: '驳回…' }],
      more: [{ kind: 'item', label: '复制路径' }],
    },
  },
  { name: 'question', props: { kind: 'question', title: '周报要不要包含外部会话？', meta: '不限时 │ 等了 4 分', primary: { label: '回答' } } },
];
