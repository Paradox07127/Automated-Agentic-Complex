import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CountdownLine, CountdownRing } from '../../charts';
import { AGENT_NAME, type Approval, type ApprovalOutcome } from '../../domain';
import type { CardAction } from '../../surfaces/stack/actions';
import { Btn, Menu, type MenuItem } from '../../ui';
import { Fold } from '../../ui/Fold';
import { actionLine } from './actionLine';
import type { ApprovalView } from './approvalView';
import { CmdBlock } from './CmdBlock';
import { dangerRuleText } from './dangerRule';
import { DecisionBar } from './DecisionBar';
import { DecisionReceipt } from './DecisionReceipt';
import { DiffPreview } from './DiffPreview';
import { InSession } from './inSession';
import { QueueBar } from './QueueBar';
import { SessionApproval } from './SessionApproval';
import { useCountdown } from './useCountdown';
import styles from './ApprovalCard.module.css';
import receiptStyles from './DecisionReceipt.module.css';

export type { ApprovalOutcome } from '../../domain';

/** 「命中危险规则：强制推送 Git 分支」; an unknown rule keeps only the head, its code in the tooltip. */
export function ruleLine(rule: string): string {
  const text = dangerRuleText(rule);
  return text === dangerRuleText('') ? text : `命中危险规则：${text}`;
}

/** 审批卡：主窗口和桌面共用；直角面板，按钮在卡内的 DecisionBar；危险时批准只能鼠标点。 */
export interface ApprovalCardProps {
  /** 审批数据；没有时从 view 读（桌面栈的角色审批） */
  approval?: Approval;
  /** 桌面栈的审批视图：预览块、⋯ 菜单、超时后果；links 为假时不显示会话 / 时间线 / 去终端 */
  view?: ApprovalView;
  /** ⋯ 菜单里一项的动作 */
  onExtra?: (action: CardAction) => void;
  /** 主窗口填满容器 / 桌面宽 360，默认 main */
  surface?: 'main' | 'desk';
  /** 叠放计数「1/3」 */
  position?: { index: number; total: number };
  /** 队列条「还有 N 张 · M 张危险」，不含当前这张 */
  queue?: { more: number; dangerous: number };
  /** 差异预览默认展开 */
  previewOpen?: boolean;
  /** 已处理的回执；null 为待决定 */
  outcome?: ApprovalOutcome | null;
  /** 没有 trace 关联时「时间线 ↗」禁用的原因，默认「后台暂不提供」 */
  timelineReason?: string;
  /** 「会话 ↗」不能跳时的原因；给了就禁用，没有 onOpenSession 时默认「没有会话关联」 */
  sessionReason?: string;
  /** 决定；派活卡附带选中的模式；主窗口的工具卡拒绝时可附一句理由 */
  onDecide?: (decision: 'allow' | 'deny' | 'allow_session', mode?: string, reason?: string) => void;
  /** 会话 ↗ */
  onOpenSession?: () => void;
  /** 时间线 ↗ */
  onOpenTimeline?: () => void;
  /** 桌面浮窗栈的白纸卡：胶带、右上倒计时、目录和链接收进折叠段、卡内底行放拒绝 / 批准胶囊；top 为假时批准降为次要按钮 */
  paper?: { top: boolean };
  /** 白纸卡的紧凑版（浮窗栈收起时的顶卡）：只有倒计时、标题和拒绝 / 批准。在会话卡里（InSession）白纸卡换成 SessionApproval */
  compact?: boolean;
  /** 危险批准点两次：第一次变「确认批准」，CONFIRM_MS 内再点才决定；白纸卡默认开 */
  confirmDanger?: boolean;
  /** 主窗口卡的规则、目录和链接：inline 摊开（默认）；fold 收进带计数的「详情」折叠 */
  details?: 'inline' | 'fold';
}

/** How long a dangerous 批准 stays 确认批准 waiting for the second click. */
export const CONFIRM_MS = 1000;

/** The Approval fields the card reads; windows may be null for a role approval. */
type Fields = Pick<Approval, 'id' | 'title' | 'tool' | 'source' | 'cmd' | 'content_preview' | 'summary_truncated' | 'orig_len' | 'cwd' | 'dangerous' | 'danger_rule' | 'dispatch' | 'scope_ok' | 'since' | 'agent' | 'display_session'> & {
  window_s: number | null;
  seconds_left: number | null;
};

const fieldsOf = (v: ApprovalView): Fields => ({
  id: v.id,
  title: v.title,
  tool: v.tool,
  source: v.origin,
  cmd: v.cmd ?? undefined,
  content_preview: v.diff ?? undefined,
  summary_truncated: v.truncated,
  orig_len: v.origLen ?? undefined,
  cwd: v.cwd,
  dangerous: v.dangerous,
  danger_rule: v.dangerRule ?? undefined,
  dispatch: v.dispatch,
  scope_ok: v.allowSession,
  since: v.since,
  agent: '',
  display_session: null,
  window_s: v.windowS,
  seconds_left: v.secondsLeft,
});

export function ApprovalCard({ approval: given, view, onExtra, surface = 'main', position, queue, previewOpen, outcome = null, timelineReason, sessionReason, onDecide, onOpenSession, onOpenTimeline, paper, compact, confirmDanger = paper != null, details = 'inline' }: ApprovalCardProps) {
  const approval: Fields = given ?? fieldsOf(view!);
  const inSession = useContext(InSession);
  const left = useCountdown(approval.seconds_left, outcome == null);
  const [scope, setScope] = useState(false);
  const [hint, setHint] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);
  const dispatch = approval.dispatch;
  const [mode, setMode] = useState(dispatch?.mode);
  const danger = approval.dangerous;
  const expired = outcome == null && left != null && left <= 0;
  const shown: ApprovalOutcome | null = outcome ?? (expired ? { kind: 'expired', at: approval.since + (approval.window_s ?? 0) * 1000 } : null);
  const live = shown == null;
  const agent = AGENT_NAME[approval.agent] ?? (approval.agent || '会话');
  const sourceTip = [approval.source, approval.display_session].filter(Boolean).join(' │ ');
  const decide = (session: boolean) => onDecide?.(!danger && approval.scope_ok && session ? 'allow_session' : 'allow', dispatch ? mode : undefined);
  const decideAllow = () => decide(scope);
  const twice = danger && confirmDanger;
  const allow = () => {
    if (!twice) return decideAllow();
    clearTimeout(confirmTimer.current);
    if (!confirming) {
      setConfirming(true);
      confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_MS);
      return;
    }
    setConfirming(false);
    decideAllow();
  };
  const approveLabel = twice && confirming ? '确认批准' : '批准';
  const deny = () => onDecide?.('deny');
  const timelineOff = !onOpenTimeline || !!timelineReason;
  const sessionOff = !onOpenSession || !!sessionReason;

  // Esc denies from anywhere in the card; ⏎ approves only when the card itself has focus; DecisionBar guards its own buttons.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!live) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      deny();
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      if (danger) setHint(true);
      else allow();
    }
  };

  const links = (!view || view.links) && (
    <p className={styles.meta}>
      {approval.cwd && (
        <span>
          目录 <code>{approval.cwd}</code>
        </span>
      )}
      <button type="button" className={styles.link} aria-disabled={sessionOff || undefined} title={sessionOff ? (sessionReason ?? '没有会话关联') : '打开这个会话'} onClick={sessionOff ? undefined : onOpenSession}>
        会话 ↗
      </button>
      <button type="button" className={styles.link} aria-disabled={timelineOff || undefined} title={timelineOff ? (timelineReason ?? '后台暂不提供') : '在诊断时间线里定位'} onClick={timelineOff ? undefined : onOpenTimeline}>
        时间线 ↗
      </button>
    </p>
  );
  const scopeBox = live && !danger && approval.scope_ok && (
    <label className={styles.chk}>
      <input type="checkbox" checked={scope} onChange={(e) => setScope(e.target.checked)} />
      本会话都允许同类操作
    </label>
  );
  const dispatchMeta = (
    <>
      {dispatch && (
        <p className={styles.meta}>
          <span>派给</span>
          <code>{AGENT_NAME[dispatch.target] ?? dispatch.target}</code>
          <span>{dispatch.prompt}</span>
        </p>
      )}
      {live && dispatch && dispatch.modes.length > 1 && (
        <p className={styles.meta} role="radiogroup" aria-label="运行模式">
          {dispatch.modes.map((m) => (
            <label key={m} className={styles.chk}>
              <input type="radio" name={`mode-${approval.id}`} checked={mode === m} onChange={() => setMode(m)} />
              {MODE_LABEL[m] ?? m}
            </label>
          ))}
        </p>
      )}
    </>
  );
  const body = (
    <>
      {approval.cmd && <CmdBlock cmd={approval.cmd} truncated={approval.summary_truncated} origLen={approval.orig_len} paper={paper != null} />}
      {approval.content_preview && <DiffPreview preview={approval.content_preview} defaultOpen={previewOpen} />}
      {dispatchMeta}
    </>
  );
  const preview = view?.previewText && <pre className={styles.preview}>{view.previewText}</pre>;
  const more: MenuItem[] = (view?.extra ?? []).map((x) => ({ kind: 'item', label: x.label, onSelect: () => onExtra?.(x.action) }));
  // Without links the timeout says what happened to the call, with no 去终端.
  const receipt =
    shown &&
    (view && !view.links && shown.kind === 'expired' ? (
      <div data-stub="DecisionReceipt" className={receiptStyles.root} data-kind="expired" role="status">
        <div className={receiptStyles.line}>
          <span className={receiptStyles.mark} aria-hidden="true" />
          <span>已超时 │ 请求已失效</span>
        </div>
        <p className={receiptStyles.note}>后果：{view.expiredNote}</p>
      </div>
    ) : (
      <DecisionReceipt outcome={shown} agent={agent} hook={!dispatch} onGoTerminal={onOpenSession} />
    ));
  const title = (
    <>
      {danger && (
        <span className={styles.dsq} aria-hidden="true">
          ■{' '}
        </span>
      )}
      {approval.title}
      {danger && <span className={styles.vh}>（危险操作）</span>}
    </>
  );
  const rule = danger && approval.danger_rule && (
    <p className={styles.rule} title={approval.danger_rule}>
      {ruleLine(approval.danger_rule)}
    </p>
  );

  const minor = details === 'fold' && (rule || links) ? <Fold id={`approval-details-${approval.id}`} label="详情" count={(rule ? 1 : 0) + (links ? (approval.cwd ? 3 : 2) : 0)}>{rule}{links}</Fold> : null;

  // Enter or Space on a dangerous 批准 shows the same hint as Enter on the card.
  const onPaperKey = (e: KeyboardEvent<HTMLElement>) => {
    onKeyDown(e);
    if (live && danger && (e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('[data-approve]')) setHint(true);
  };

  if (paper && inSession) {
    const line = actionLine({ tool: approval.tool, cmd: approval.cmd, title: approval.title, dispatch, previewText: view?.previewText });
    return (
      <SessionApproval
        title={approval.title}
        line={line}
        dangerous={danger}
        dangerRule={approval.danger_rule ?? null}
        cmd={approval.cmd && line.kind !== 'file' && line.kind !== 'url' && <CmdBlock cmd={approval.cmd} truncated={approval.summary_truncated} origLen={approval.orig_len} />}
        diff={approval.content_preview ?? null}
        details={<>{rule}{dispatchMeta}{preview}{links}</>}
        source={[approval.source, approval.tool].filter(Boolean).join(' │ ')}
        live={live}
        receipt={receipt}
        outcome={shown?.kind}
        left={left}
        windowS={approval.window_s}
        hint={hint}
        approveLabel={approveLabel}
        primary={!position || position.index === 1}
        more={more}
        onAllow={allow}
        onAlways={!danger && approval.scope_ok ? () => decide(true) : undefined}
        onDeny={deny}
        onKeyDown={onPaperKey}
      />
    );
  }

  if (paper) {
    return (
      <div className={styles.wrap} data-surface={surface}>
        <article
          data-stub="ApprovalCard"
          data-theme="light"
          className={styles.paper}
          data-surface={surface}
          data-dangerous={danger || undefined}
          data-outcome={shown?.kind}
          data-compact={compact || undefined}
          tabIndex={0}
          aria-label={`审批：${approval.title}`}
          onKeyDown={onPaperKey}
        >
          <header className={styles.pHead}>
            <span className={styles.pLeft} aria-hidden="true">
              <span className={styles.pArt} data-art-slot="paper-tape" aria-hidden="true" />
              <span className={styles.tape}>
                <i />
                <i />
                <i />
              </span>
            </span>
            {live && <CountdownRing secondsLeft={left} windowS={approval.window_s} onPaper />}
            {position && (
              <span className={`${styles.pCount} num`}>
                {position.index}/{position.total}
              </span>
            )}
          </header>
          {!compact && (
            <p className={styles.pSrc}>
              {approval.tool && (
                <span className={styles.kv}>
                  <b aria-hidden="true">Tool</b>
                  <code>{approval.tool}</code>
                </span>
              )}
              <span className={styles.source} title={sourceTip}>{approval.source}</span>
            </p>
          )}
          <h3 className={styles.pTitle}>{title}</h3>
          {!compact && (
            <>
              {rule}
              {body}
              {preview}
              <Fold id={`approval-${approval.id}`} label="详情" summary={approval.cwd ?? undefined}>
                {links}
                {live && <p className={styles.meta}>悬停不暂停倒计时</p>}
                {scopeBox}
              </Fold>
            </>
          )}
          {receipt}
          {live && danger && hint && (
            <p className={styles.pHint} role="alert">
              危险操作只能用鼠标点击「批准」
            </p>
          )}
          {live && (
            <div className={styles.pFoot}>
              {more.length > 0 && <Menu label="更多操作" icon="more" items={more} align="right" />}
              <Btn variant="secondary" size="lg" tail="close" onClick={deny}>
                拒绝
              </Btn>
              {!danger && approval.scope_ok && (
                <Btn variant="secondary" size="lg" onClick={() => decide(true)}>
                  本对话都允许
                </Btn>
              )}
              <span data-approve="" className={styles.approve}>
                <Btn variant={danger ? 'danger' : paper.top ? 'primary' : 'secondary'} size="lg" tail="check" mouseOnly={danger} onClick={allow}>
                  {approveLabel}
                </Btn>
              </span>
            </div>
          )}
          {live && <CountdownLine secondsLeft={left} windowS={approval.window_s} />}
        </article>
        {queue && <QueueBar more={queue.more} dangerous={queue.dangerous} />}
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-surface={surface}>
      <article
        data-stub="ApprovalCard"
        className={styles.card}
        data-surface={surface}
        data-dangerous={danger || undefined}
        data-outcome={shown?.kind}
        tabIndex={0}
        aria-label={`审批：${approval.title}`}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <h3 className={styles.title}>{title}</h3>
          {position && <span className={`${styles.count} num`}>{position.index}/{position.total}</span>}
        </header>
        <p className={styles.src}>
          <code>{approval.tool}</code>
          <span className={styles.source} title={sourceTip}>{approval.source}</span>
        </p>
        {!minor && rule}
        {body}
        {preview}
        {minor ?? links}
        {scopeBox}
        {receipt}
        {live && (
          <DecisionBar
            inset
            kind="approval"
            dangerous={danger}
            meta={<CountdownRing size="mini" secondsLeft={left} windowS={approval.window_s} />}
            primary={{ label: approveLabel, kbd: '⏎', onClick: allow }}
            secondary={[{ label: '拒绝', kbd: 'esc', onClick: deny, withReason: dispatch ? undefined : (r) => onDecide?.('deny', undefined, r) }, ...(!danger && approval.scope_ok ? [{ label: '本对话都允许', onClick: () => decide(true) }] : [])]}
            more={more}
            onEscape={deny}
            hint={hint}
          />
        )}
        {live && <CountdownLine secondsLeft={left} windowS={approval.window_s} />}
      </article>
      {queue && <QueueBar more={queue.more} dangerous={queue.dangerous} />}
    </div>
  );
}

/** sessions/own.py MODES. */
const MODE_LABEL: Readonly<Record<string, string>> = { read_only: '只读', workspace_write: '可改工作区' };
