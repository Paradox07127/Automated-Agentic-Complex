import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { CountdownLine } from '../../charts';
import { formatRemaining, isUrgent } from '../../domain';
import { Btn, Menu, type MenuItem } from '../../ui';
import type { ActionLine } from './actionLine';
import { dangerRuleText } from './dangerRule';
import { DiffPreview, diffCounts } from './DiffPreview';
import styles from './SessionApproval.module.css';

/**
 * 会话卡里的紧凑审批：第一行动作和对象，危险时一个红色小标；第二行「差异 / 命令 / 详情」默认收起，点开在块内展开；
 * 第三行剩余秒数和拒绝 / 本对话都允许 / 批准。倒计时是块顶的一条细线。决定和按键都由 ApprovalCard 传进来。
 */
export interface SessionApprovalProps {
  /** 读屏名称里的标题 */
  title: string;
  line: ActionLine;
  dangerous: boolean;
  dangerRule: string | null;
  /** 「命令」展开后的命令块；没有时不显示这个开关 */
  cmd: ReactNode;
  /** 「差异」展开后的 unified diff */
  diff: string | null;
  /** 「详情」里来源后面的内容：危险规则、派活、预览、目录和链接 */
  details: ReactNode;
  /** 来源一行，例如「Codex · 修 HostLink 断线重连」 */
  source: string;
  /** 待决定；为假时只剩第一行和回执 */
  live: boolean;
  /** 已决定 / 已超时的回执 */
  receipt: ReactNode;
  outcome?: string;
  left: number | null;
  windowS: number | null;
  /** 危险审批收到回车时的提示 */
  hint: boolean;
  approveLabel: string;
  /** 批准是这一屏的主按钮 */
  primary: boolean;
  more: MenuItem[];
  onAllow: () => void;
  /** 本对话都允许；没有时隐藏 */
  onAlways?: () => void;
  /** 本对话都允许之后不再问的范围，写在按钮那一行上面 */
  grants?: string | null;
  onDeny: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

type Open = 'diff' | 'cmd' | 'details' | null;

const TARGET_LABEL: Partial<Record<ActionLine['kind'], string>> = { file: '文件', url: '地址' };

export function SessionApproval({ title, line, dangerous, dangerRule, cmd, diff, details, source, live, receipt, outcome, left, windowS, hint, approveLabel, primary, more, onAllow, onAlways, grants, onDeny, onKeyDown }: SessionApprovalProps) {
  const [open, setOpen] = useState<Open>(null);
  const flip = (o: Exclude<Open, null>) => setOpen((cur) => (cur === o ? null : o));
  const counts = diff ? diffCounts(diff) : null;
  const tab = (o: Exclude<Open, null>, label: ReactNode) => (
    <button type="button" className={styles.tab} aria-expanded={open === o} onClick={() => flip(o)}>
      {label}
    </button>
  );
  const targetLabel = TARGET_LABEL[line.kind];

  return (
    <article
      data-stub="SessionApproval"
      className={styles.block}
      data-dangerous={dangerous || undefined}
      data-outcome={outcome}
      tabIndex={0}
      aria-label={`审批：${title}${dangerous ? '（危险操作）' : ''}`}
      onKeyDown={onKeyDown}
    >
      {live && (
        <div className={styles.top}>
          <CountdownLine secondsLeft={left} windowS={windowS} />
        </div>
      )}
      <p className={styles.what}>
        <span data-action="" className={styles.action} title={line.full}>
          {line.verb && <b>{line.verb}</b>}
          {line.verb && ' '}
          <span className={styles.target}>{line.target}</span>
        </span>
        {dangerous && (
          <span data-danger-mark="" className={styles.danger}>
            <i aria-hidden="true" />
            {dangerRule ? dangerRuleText(dangerRule) : '危险操作'}
          </span>
        )}
      </p>
      {live && (
        <div className={styles.tabs}>
          {diff &&
            tab(
              'diff',
              counts ? (
                <>
                  差异{' '}
                  <span className="num">
                    <span className={styles.add}>+{counts.added}</span> <span className={styles.del}>−{counts.removed}</span>
                  </span>
                </>
              ) : (
                '内容'
              ),
            )}
          {cmd && tab('cmd', '命令')}
          {tab('details', '详情')}
        </div>
      )}
      {live && open === 'diff' && diff && <DiffPreview preview={diff} bare />}
      {live && open === 'cmd' && cmd}
      {live && open === 'details' && (
        <div className={styles.details}>
          <p className={styles.meta}>{source}</p>
          {targetLabel && line.full !== line.target && (
            <p className={styles.meta}>
              {targetLabel} <code>{line.full}</code>
            </p>
          )}
          {details}
        </div>
      )}
      {receipt}
      {live && onAlways && grants && <p className={styles.meta}>{grants}</p>}
      {live && (
        <div className={styles.foot}>
          <span data-left="" className={`${styles.left} num`} role="timer" data-urgent={isUrgent(left) || undefined}>
            {formatRemaining(left)}
          </span>
          {more.length > 0 && <Menu label="更多操作" icon="more" items={more} align="right" />}
          <Btn variant="secondary" size="sm" onClick={onDeny}>
            拒绝
          </Btn>
          {onAlways && (
            <Btn variant="secondary" size="sm" onClick={onAlways}>
              本对话都允许
            </Btn>
          )}
          <span data-approve="">
            <Btn variant={dangerous ? 'danger' : primary ? 'primary' : 'secondary'} size="sm" mouseOnly={dangerous} onClick={onAllow}>
              {approveLabel}
            </Btn>
          </span>
        </div>
      )}
      {live && dangerous && hint && (
        <p className={styles.hint} role="alert">
          危险操作只能用鼠标点击「批准」
        </p>
      )}
    </article>
  );
}
