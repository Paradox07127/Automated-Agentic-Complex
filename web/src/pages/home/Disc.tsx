import { useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import type { PendingItem, Question } from '../../domain';
import { dangerRuleText } from '../../features/approval';
import type { Go } from '../../shell/nav';
import { Btn, Icon } from '../../ui';
import { KIND_LABEL } from '../overview/pending';
import { Slab, unit } from '../../ui/game/Slab';
import styles from './Disc.module.css';

type Approval = PendingItem & { kind: 'approval' };

export interface DiscProps {
  /** The disc's accessible name. */
  title: string;
  /** What waits on the user now, most urgent first. */
  urgent: readonly PendingItem[];
  /** Absent while 日报与简报 is off: nothing reads today's runs. */
  report: Report | null;
  /** What runs now; null while neither 编码会话 nor 个人代理 is on. */
  running: readonly RunItem[] | null;
  act: {
    onApprove: (item: Approval, decision: 'allow' | 'deny' | 'allow_session', reason?: string) => void;
    onAnswer: (item: Question, label: '允许' | '拒绝') => void;
    onReply: (item: Question, answers: Record<string, string[]>) => void;
  };
  go: Go;
}

/** Options one click can answer; a question with more, or several questions, is answered on 每日简报. */
const QUICK = 3;

/** The first waiting item, decided here: an approval by 批准 / 拒绝, a one-question choice by its options. */
function Focus({ item, act, go }: { item: PendingItem; act: DiscProps['act']; go: Go }) {
  const open = () => go({ page: 'overview', sel: item.id, focus: `item-${item.id}` });
  // A call that hit a danger rule is not approved from here in one click: its card on 每日简报 shows the whole command.
  const danger = item.kind !== 'review' && item.dangerous ? dangerRuleText(item.danger_rule ?? '') : null;
  const one = item.kind === 'question' && item.interaction_kind === 'question' && item.questions.length === 1 ? item.questions[0] : undefined;
  return (
    <div className={styles.focus} data-depth="" role="group" aria-label={`${KIND_LABEL[item.kind]}：${item.title}`}>
      <button type="button" className={styles.focusT} onClick={open}>
        <b>{item.title}</b>
        <span>{item.source}</span>
        {danger && <em>命中危险规则：{danger}</em>}
      </button>
      <div className={styles.focusActs}>
        {danger && item.kind !== 'review' ? (
          <>
            <Btn size="sm" variant="secondary" onClick={open}>查看</Btn>
            <Btn size="sm" variant="secondary" onClick={() => (item.kind === 'approval' ? act.onApprove(item, 'deny') : act.onAnswer(item, '拒绝'))}>拒绝</Btn>
          </>
        ) : item.kind === 'approval' ? (
          <>
            <Btn size="sm" variant="primary" onClick={() => act.onApprove(item, 'allow')}>批准</Btn>
            <Btn size="sm" variant="secondary" onClick={() => act.onApprove(item, 'deny')}>拒绝</Btn>
          </>
        ) : item.kind === 'question' && item.interaction_kind === 'approval' ? (
          <>
            <Btn size="sm" variant="primary" onClick={() => act.onAnswer(item, '允许')}>允许</Btn>
            <Btn size="sm" variant="secondary" onClick={() => act.onAnswer(item, '拒绝')}>拒绝</Btn>
          </>
        ) : item.kind === 'question' && one && one.options.length > 0 && one.options.length <= QUICK ? (
          one.options.map((o) => (
            <Btn key={o.label} size="sm" variant="secondary" onClick={() => act.onReply(item, { [one.id]: [o.label] })}>{o.label}</Btn>
          ))
        ) : (
          <Btn size="sm" variant="secondary" onClick={open}>{item.kind === 'review' ? '去复核' : '去回答'}</Btn>
        )}
      </div>
    </div>
  );
}

/** Today's work for the disc's report: runs finished and started today, and what runs now (absent while nothing counts it). */
export interface Report {
  done: number;
  total: number;
  running?: number | null;
}

const REPORT = { w: 272, h: 58 } as const;
/** The plaque's ends cut like the game's level plaque. */
const REPORT_PTS = [[0.04, 0], [0.96, 0], [1, 0.5], [0.96, 1], [0.04, 1], [0, 0.5]] as const;

/** The report plaque at the disc's foot, as the game's 探索等级 plaque over its stamina bar: done / total and a bar. */
function ReportPlate({ done, total, running, onClick }: Report & { onClick: () => void }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <button type="button" className={styles.report} aria-label={`今日任务 完成 ${done} / ${total}`} onClick={onClick}>
      <Slab pts={unit(REPORT_PTS, REPORT.w, REPORT.h)} w={REPORT.w} h={REPORT.h} depth={6} tone="dark">
      <span className={styles.repIn}>
      <span className={styles.repHead}>
        <span className={styles.repLabel}>今日任务</span>
        <b className="num">{String(done).padStart(2, '0')}</b>
        <span className={`${styles.repOf} num`}>/ {String(total).padStart(2, '0')}</span>
        {running != null && <span className={styles.repRun}>在做 {running}</span>}
      </span>
      <span className={styles.repBar} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className={`${styles.repPct} num`} aria-hidden="true">{pct}%</span>
      </span>
      </Slab>
    </button>
  );
}

/** A running conversation, task or coding session on the 在做 page. */
export interface RunItem {
  id: string;
  kind: '对话' | '任务' | '编码';
  title: string;
  /** Agent or project, when known. */
  sub: string | null;
  go: () => void;
}

type Tab = 'pending' | 'running';

/** Rows the 在做 page lists before "另有 N 个". */
const RUN_ROWS = 3;

function Running({ items, go }: { items: readonly RunItem[]; go: Go }) {
  if (items.length === 0) return <p className={styles.calm}>没有正在做的事</p>;
  const more = items.length - RUN_ROWS;
  return (
    <div className={styles.list}>
      {items.slice(0, RUN_ROWS).map((r) => (
        <button key={r.id} type="button" className={styles.row} aria-label={`${r.kind}：${r.title}`} onClick={r.go}>
          <span className={styles.kind}>{r.kind}</span>
          <span className={styles.rowT}>
            {r.title}
            {r.sub && <small>{r.sub}</small>}
          </span>
          <Icon name="chev" size={12} />
        </button>
      ))}
      {more > 0 && (
        <button type="button" className={styles.row} aria-label={`另有 ${more} 个在做`} onClick={() => go({ page: 'overview', focus: 'running' })}>
          <Icon name="bolt" size={14} />
          <span className={styles.rowT}>另有 {more} 个</span>
          <Icon name="chev" size={12} />
        </button>
      )}
    </div>
  );
}

const TAB_NAME: Record<Tab, string> = { pending: '待批准', running: '在做' };

/** A drag or trackpad swipe this far across the panel, in stage px, turns the page. */
const SWIPE = 40;
/** One trackpad swipe sends many wheel events: after a turn, the rest within this many ms are ignored. */
const SWIPE_MS = 450;
/** Sideways wheel events further apart than this many ms belong to separate gestures and do not add up. */
const GESTURE_GAP_MS = 150;

/** The centre disc over the map: tabs for what waits on the user and what runs, over today's report. */
export function Disc({ title, urgent, report, running, act, go }: DiscProps) {
  const tabs: Tab[] = ['pending', ...(running ? (['running'] as const) : [])];
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = picked && tabs.includes(picked) ? picked : urgent.length > 0 || !running?.length ? 'pending' : 'running';
  const count: Record<Tab, number | null> = { pending: urgent.length, running: running?.length ?? null };
  // dir: which way the last turn went, for the panel's slide; swiped: the last drag turned (or tried to turn) the page,
  // so the click it ends in is not a press; wheel: the swipe so far, when it last moved and when it last turned.
  const [dir, setDir] = useState<1 | -1>(1);
  const swiped = useRef(false);
  const wheel = useRef({ dx: 0, last: 0, at: 0 });
  const pick = (t: Tab) => {
    setDir(tabs.indexOf(t) < tabs.indexOf(tab) ? -1 : 1);
    setPicked(t);
  };
  const turn = (d: 1 | -1) => {
    const next = tabs[tabs.indexOf(tab) + d];
    if (next) pick(next);
  };
  // The release is read on the window: a drag may end outside the panel.
  const onDown = (e: PointerEvent) => {
    const [x, y] = [e.clientX, e.clientY];
    swiped.current = false;
    const end = (u: globalThis.PointerEvent) => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const [dx, dy] = [u.clientX - x, u.clientY - y];
      if (u.type !== 'pointerup' || Math.abs(dx) <= SWIPE || Math.abs(dx) <= Math.abs(dy)) return;
      swiped.current = true;
      turn(dx < 0 ? 1 : -1);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (!swiped.current) return;
    swiped.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const w = wheel.current;
    if (e.timeStamp - w.at < SWIPE_MS) return;
    if (e.timeStamp - w.last > GESTURE_GAP_MS) w.dx = 0;
    w.dx += e.deltaX;
    w.last = e.timeStamp;
    if (Math.abs(w.dx) < SWIPE) return;
    turn(w.dx > 0 ? 1 : -1);
    wheel.current = { dx: 0, last: e.timeStamp, at: e.timeStamp };
  };
  const [first, ...rest] = urgent;
  return (
    <section className={styles.disc} aria-label={title} data-g="map" data-busy={first ? '' : undefined}>
      {tabs.length > 1 && (
        <div className={styles.tabs} role="tablist" aria-label="圆盘">
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === tab} className={styles.tab} onClick={() => pick(t)}>
              {TAB_NAME[t]}
              {count[t] != null && count[t] > 0 && <b className="num">{count[t]}</b>}
            </button>
          ))}
        </div>
      )}
      <div
        key={tab}
        className={styles.panel}
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-label={TAB_NAME[tab]}
        data-dir={dir}
        onPointerDown={tabs.length > 1 ? onDown : undefined}
        onClickCapture={onClickCapture}
        onWheel={tabs.length > 1 ? onWheel : undefined}
      >
        {tab === 'running' && running ? (
          <Running items={running} go={go} />
        ) : first ? (
          <>
            <Focus item={first} act={act} go={go} />
            {rest.length > 0 && (
              <button type="button" className={styles.row} aria-label={`另有 ${rest.length} 件待处理`} onClick={() => go({ page: 'overview', focus: 'pending' })}>
                <Icon name="hand" size={14} />
                <span className={styles.rowT}>另有 {rest.length} 件</span>
                <Icon name="chev" size={12} />
              </button>
            )}
          </>
        ) : (
          <p className={styles.calm}>没有要你批准的事</p>
        )}
      </div>
      {report && <ReportPlate {...report} onClick={() => go({ page: 'overview' })} />}
    </section>
  );
}
