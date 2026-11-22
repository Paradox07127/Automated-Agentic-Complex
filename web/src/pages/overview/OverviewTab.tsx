// 每日简报 › 总览：今日一句、6 项读数，左栏待批准（今天）、做完了和聊了什么，右栏在做（今天）、提醒和前一天的观察日报（关着时换成她这一天的一句）。
import { useState, type ReactNode } from 'react';
import { formatClock } from '../../domain';
import type { Task } from '../../domain/work';
import { Btn, Region, Row, SecHead, Sheet } from '../../ui';
import { BriefsSec } from '../observe/BriefsSec';
import { useBriefs } from '../observe/useBriefs';
import { ITEMS, readouts, type ItemMeta } from './briefDay';
import type { BriefTabProps } from './briefTabs';
import type { Reminder } from './load';
import type { DayConv } from './loadBrief';
import type { Go } from './nav';
import s from './OverviewTab.module.css';

export interface OverviewTabProps extends BriefTabProps {
  isToday: boolean;
  /** 今日一句; undefined while it is read, null when the day has none. */
  line: string | null | undefined;
  /** 待批准, drawn only today with Agent 内核 or 编码会话 on. */
  pending: ReactNode;
  /** 在做, drawn only today; false with its plug-ins off. */
  running: ReactNode;
  /** Tasks finished or failed that day, newest first; undefined while read. */
  done: Array<{ task: Task; failed: boolean }> | undefined;
  /** Conversations touched that day; null when they could not be read, undefined while read. */
  convs: DayConv[] | null | undefined;
  reminders: Reminder[];
  onTask: (id: string) => void;
  goPage: Go;
}

/** A readout in its item's unit: min as h/m, sec as m, usd as $. */
function amount(meta: ItemMeta, v: number): ReactNode {
  if (meta.kind === 'min') {
    const h = Math.floor(v / 60);
    const m = Math.round(v % 60);
    return h ? <>{h}<small>h</small>{String(m).padStart(2, '0')}<small>m</small></> : <>{m}<small>m</small></>;
  }
  if (meta.kind === 'sec') return <>{Math.round(v / 60)}<small>m</small></>;
  if (meta.kind === 'usd') return <><small>$</small>{v.toFixed(2)}</>;
  return <>{+v.toFixed(1)}{meta.unit && <small>{meta.unit}</small>}</>;
}

function Panel({ title, count, right, nav, children }: { title: string; count?: number | undefined; right?: ReactNode; nav?: string; children: ReactNode }) {
  return (
    <section className={s.pn} aria-label={title} data-nav-target={nav}>
      <SecHead title={title} count={count} right={right} />
      {children}
    </section>
  );
}

/** The daily observation brief of the day before `date`: its three counts and first detail; 看全文 opens the list. */
function ObsBrief({ date }: { date: string }) {
  const b = useBriefs();
  const [open, setOpen] = useState(false);
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  const want = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  const r = b.reports.find((x) => x.period === 'daily' && x.date === want && x.state === 'completed');
  return (
    <Panel title="前一天的观察日报" right={<Btn size="sm" variant="text" onClick={() => setOpen(true)}>看全文 ›</Btn>}>
      <Region q={b.list} what="观察日报" reserve={{ rows: 3 }} isEmpty={() => !r} empty={{ text: '前一天没有观察日报' }}>
        {() =>
          r && (
            <>
              <div className={s.yb}>
                {([[r.observed_details.length, '看到的事'], [r.recurring_problems.length, '反复卡住的'], [r.next_steps.length, '建议下一步']] as const).map(([n, k]) => (
                  <div key={k}>
                    <b className="num">{n}</b>
                    <span>{k}</span>
                  </div>
                ))}
              </div>
              {r.observed_details[0] && (
                <p className={s.quote} data-selectable="">
                  {r.observed_details[0].detail}
                </p>
              )}
            </>
          )
        }
      </Region>
      {open && (
        <Sheet open title="观察日报" width={480} onClose={() => setOpen(false)}>
          <BriefsSec no="01" />
        </Sheet>
      )}
    </Panel>
  );
}

const KIND: Record<'self' | 'reply' | 'miss', string> = { self: '主动', reply: '回你', miss: '没回' };

export function OverviewTab(p: OverviewTabProps) {
  const { day, isToday } = p;
  const sw = day.switches;
  const work = sw.agent || sw.code;
  const ids = readouts(day, p.pins);
  const her = day.her.lines[0];
  return (
    <div className={s.ov} data-tab="ov">
      <Panel title="今日一句">
        <p className={s.line} data-selectable="">
          {p.line === undefined ? '—' : (p.line ?? '这一天还没有日报')}
        </p>
      </Panel>
      <ul className={s.band} aria-label="读数">
        {ids.map((id) => {
          const meta = ITEMS[id];
          const it = day.items[id];
          const diff = it.avg7 == null ? null : it.today - it.avg7;
          return (
            <li key={id} className={s.ro} data-item={id} data-err={(id === 'err' && it.today > 0) || undefined}>
              <span className={`${s.v} num`}>{amount(meta, it.today)}</span>
              <span className={s.k}>{meta.name}</span>
              {diff != null && (
                <span className={`${s.d} num`} data-dn={diff < 0 || undefined}>
                  比近 7 天均值{diff < 0 ? '少' : '多'} {amount(meta, Math.abs(diff))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className={s.cols}>
        <div className={s.col}>
          {isToday && work && <div className={s.pn}>{p.pending}</div>}
          {work && (
            <Panel title="做完了" count={p.done?.length}>
              <Region q={{ status: p.done ? 'success' : 'pending', data: p.done }} what="做完的任务" reserve={{ rows: 3 }} empty={{ text: isToday ? '今天还没有做完的任务' : '那天没有做完的任务' }}>
                {(rows) => (
                  <div className={s.rows}>
                    {rows.map(({ task, failed }) => (
                      <Row
                        key={task.id}
                        height="compact"
                        category="mission"
                        title={task.title || '未命名任务'}
                        sub={`${task.source === 'role' ? '角色任务' : '编码任务'}${failed ? ' │ 出错' : ''}`}
                        right={<span className="num">{formatClock(task.updated_at)}</span>}
                        data-err={failed || undefined}
                        onClick={() => p.onTask(task.id)}
                      />
                    ))}
                  </div>
                )}
              </Region>
            </Panel>
          )}
          <Panel title={isToday ? '今天聊了什么' : '那天聊了什么'} count={p.convs?.length}>
            <Region q={{ status: p.convs === undefined ? 'pending' : p.convs ? 'success' : 'error', data: p.convs ?? undefined, error: p.convs === null ? new Error('对话没有读到') : undefined }} what="对话" reserve={{ rows: 3 }} empty={{ text: '没有对话' }}>
              {(rows) => (
                <div className={s.rows}>
                  {rows.map((c) => (
                    <Row
                      key={c.id}
                      height="compact"
                      title={c.title}
                      sub={
                        <>
                          <span className="num">{formatClock(c.turns[0]?.t0 ?? c.updated_at)}</span> │ <span className="num">{c.turns.length}</span> 轮
                        </>
                      }
                      right="打开 ›"
                      onClick={() => p.goPage({ page: 'chat', conv: c.id })}
                    />
                  ))}
                </div>
              )}
            </Region>
          </Panel>
        </div>
        <div className={s.col}>
          {isToday && work && p.running && <div className={s.pn} data-nav-target="running">{p.running}</div>}
          <Panel title="提醒" count={p.reminders.length} nav="reminders">
            {p.reminders.length ? (
              <div className={s.rows}>
                {p.reminders.map((r) => (
                  <Row key={r.id} height="compact" title={r.title} sub={r.triggered ? '已提醒' : '还没到'} right={<span className="num">{formatClock(r.due_at)}</span>} />
                ))}
              </div>
            ) : (
              <p className={s.none}>{isToday ? '今天没有提醒' : '那天没有提醒'}</p>
            )}
          </Panel>
          {sw.read ? (
            <ObsBrief date={day.date} />
          ) : (
            <Panel title="她今天说的一句" right={<Btn size="sm" variant="text" onClick={() => p.go('her')}>看她这一天 ›</Btn>}>
              {her ? (
                <div className={s.said}>
                  <p data-selectable="">{her.text}</p>
                  <footer>
                    <span className={s.kind} data-kind={her.kind}>
                      {KIND[her.kind]}
                    </span>
                    <span className="num">{formatClock(her.at * 1000)}</span>
                    <span>{her.note}</span>
                  </footer>
                </div>
              ) : (
                <p className={s.none}>这一天她没有开口</p>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
