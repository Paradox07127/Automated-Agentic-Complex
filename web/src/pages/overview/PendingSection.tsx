import { useRef, type ReactNode } from 'react';
import type { PendingItem, Question, Session, VisualStateKey } from '../../domain';
import { formatClock } from '../../domain';
import { ApprovalCard, QuestionBox } from '../../features/approval';
import { Btn, OpenSec, Paper, Region, StatusTag, type RegionSource } from '../../ui';
import { ExpandRow } from '../../ui/game';
import { CompleteFx, GroupHead, useCellIn } from './MissionFx';
import type { Go } from './nav';
import { focusOf, isExpired, KIND_LABEL, leftAt } from './pending';
import { Pip } from './Pip';
import styles from './Page.module.css';

/** Receipt of the last decision taken here; the focus item has already moved on. */
export interface DecidedReceipt {
  id: string;
  title: string;
  text: string;
  at: number;
}

export interface PendingSectionProps {
  /** The `/agent/snapshot` read the items come from. */
  q: RegionSource<unknown>;
  /** Already sorted with sortPending and without decided items. */
  items: PendingItem[];
  now: number;
  /** Snapshot time the seconds_left values were read at. */
  at: number;
  sessions: Session[];
  receipt: DecidedReceipt | null;
  go: Go;
  onApprove: (item: PendingItem & { kind: 'approval' }, decision: 'allow' | 'deny' | 'allow_session', reason?: string) => void;
  /** A character approval (an interaction of kind approval) is decided with its one label. */
  onAnswer: (item: Question, label: '允许' | '拒绝') => void;
  /** A question answered in place. */
  onReply: (item: Question, answers: Record<string, string[]>) => void;
  onJumpSession: (session: Session) => void;
}


const ROW_STATE: Record<PendingItem['kind'], VisualStateKey> = { approval: 'awaiting_approval', question: 'awaiting_input', review: 'needs_review' };

const rowState = (item: PendingItem): VisualStateKey => (item.kind === 'question' && item.interaction_kind === 'approval' ? 'awaiting_approval' : ROW_STATE[item.kind]);

/** 01 待处理：「紧要」组头下，排在第一的那项是一张白纸卡，其余是可展开行，行尾黄块写状态；点开一行，它的卡放在行下。 */
export function PendingSection(p: PendingSectionProps) {
  const { items, now, at } = p;
  const open = items.filter((x) => !isExpired(x, now, at));
  const focus = focusOf(items, now, at);
  const rest = focus ? open.filter((x) => x.id !== focus.id) : [];
  const loaded = p.q.data !== undefined;
  let body;
  if (!focus) {
    body = (
      <div className={styles.none}>
        <Pip tone="ok" label="当前没有待处理事项" />
      </div>
    );
  } else {
    body = (
      <>
        {p.receipt && <Receipt key={p.receipt.id} r={p.receipt} />}
        <GroupHead className={styles.grp} icon={<span className={styles.grpIc}>!!!</span>}>
          紧要
        </GroupHead>
        <Card p={p} item={focus} nav />
        {rest.map((item) => (
          <RowCell key={item.id} id={item.id}>
            <ExpandRow label={`${item.title}，${KIND_LABEL[item.kind]}`} end={<StatusTag state={rowState(item)} />} body={<Card p={p} item={item} />}>
              <span className={styles.rowT}>{item.title}</span>
              <span className={styles.rowS}>
                {KIND_LABEL[item.kind]} │ {item.source}
              </span>
            </ExpandRow>
          </RowCell>
        ))}
      </>
    );
  }
  return (
    <div className={styles.need} data-nav-target="pending" data-g="listBody">
      <OpenSec no="01" title="待处理" count={loaded ? open.length : undefined}>
        {/* About the focus card's height, so the rows below do not jump when it lands. */}
        <Region q={p.q} what="待处理" reserve={{ height: 220 }} skel="cards" isEmpty={() => false}>
          {() => body}
        </Region>
      </OpenSec>
    </div>
  );
}

/** A pending card; it fades in as a mission cell. `nav`: the card is the item's landing target (an opened row's card has its row). */
function Card({ p, item, nav }: { p: PendingSectionProps; item: PendingItem; nav?: boolean }) {
  const ref = useCellIn<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.focus} data-item={item.id} data-nav-target={nav ? `item-${item.id}` : undefined} data-g="cell">
      <Paper priority={item.kind === 'approval' && item.dangerous ? 0 : 1} label={`待处理：${item.title}`}>
        <Focus {...p} item={item} />
      </Paper>
    </div>
  );
}

function RowCell({ id, children }: { id: string; children: ReactNode }) {
  const ref = useCellIn<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.pRow} data-g="cell" data-pending-row={id} data-nav-target={`item-${id}`}>
      {children}
    </div>
  );
}

/** The receipt of a decision, entering as the task complete popup. */
function Receipt({ r }: { r: DecidedReceipt }) {
  const ref = useRef<HTMLParagraphElement>(null);
  return (
    <p ref={ref} className={styles.receipt} role="status">
      <CompleteFx root={ref} />
      <span className={styles.okText}>✓ {r.text}</span> │ {r.title} │ <span className="num">{formatClock(r.at)}</span>
    </p>
  );
}

/** An external session jumps to its terminal; anything else opens the task. */
function openSession(p: PendingSectionProps, item: PendingItem) {
  const session = item.kind === 'approval' ? p.sessions.find((s) => s.id === item.session_id) : undefined;
  if (session && session.kind === 'ext') p.onJumpSession(session);
  else {
    const sel = item.task_id ?? session?.task_id;
    p.go(sel ? { page: 'tasks', sel } : { page: 'overview' });
  }
}

/** The card's content: approvals decide here, questions are answered here, reviews open their task. */
function Focus(p: PendingSectionProps & { item: PendingItem }) {
  const { item, now, at, go } = p;
  if (item.kind === 'approval') {
    return (
      <ApprovalCard
        approval={{ ...item, seconds_left: leftAt(item, now, at) ?? item.seconds_left }}
        onDecide={(d, _mode, reason) => p.onApprove(item, d, reason)}
        onOpenSession={() => openSession(p, item)}
      />
    );
  }
  const head = (
    <div className={styles.cardH}>
      <span className={styles.tag}>{KIND_LABEL[item.kind]}</span>
      <span className={styles.src}>{item.source}</span>
    </div>
  );
  if (item.kind === 'question' && item.interaction_kind === 'approval') {
    return (
      <>
        {head}
        <h4 className={styles.cardT}>{item.title}</h4>
        <div className={styles.btnRow}>
          <Btn variant="ring" kbd="esc" onClick={() => p.onAnswer(item, '拒绝')}>
            拒绝
          </Btn>
          <Btn variant="primary" onClick={() => p.onAnswer(item, '允许')}>
            允许
          </Btn>
        </div>
      </>
    );
  }
  if (item.kind === 'question') {
    return (
      <>
        {head}
        <h4 className={styles.cardT}>{item.title}</h4>
        <QuestionBox question={{ ...item, seconds_left: leftAt(item, now, at) }} now={now} compact onAnswer={(a) => p.onReply(item, a)} />
      </>
    );
  }
  return (
    <>
      {head}
      <h4 className={styles.cardT}>{item.title}</h4>
      {item.verification_source === 'unverified' && <p className={styles.warnText}>▲ 未验证</p>}
      <div className={styles.btnRow}>
        <Btn variant="secondary" size="sm" tail="chev" onClick={() => go({ page: 'overview', sel: item.id, focus: `item-${item.id}` })}>
          前往复核
        </Btn>
      </div>
    </>
  );
}
