// 每日简报 › 总览：今日一句、6 项读数（和近 7 天比在 ⓘ 里），左栏待批准（今天）、做完了和聊了什么，右栏在做（今天）、提醒和前一天的观察日报（关着时换成她这一天的一句）。
// 做完了、聊了什么、观察日报和已提醒的提醒是折叠段，默认收起；有出错时自动打开。
// 读数点开它数的那些：出错是这一天的出错列表，其余去各自的页面或页签。
import { useState, type ReactNode } from 'react';
import { formatClock } from '../../domain';
import { toCanonical } from '../../domain/ids';
import { secToMs } from '../../domain/units';
import type { WireBriefError } from '../../domain/wire';
import type { Task } from '../../domain/work';
import { Btn, Empty, Fold, InfoTip, Region, Row, SecHead, Sheet } from '../../ui';
import { BriefsSec } from '../observe/BriefsSec';
import { useBriefs } from '../observe/useBriefs';
import { ITEMS, readouts, type ItemMeta } from './briefDay';
import type { BriefTabProps } from './briefTabs';
import type { Reminder } from './load';
import type { DayConv } from './loadBrief';
import type { Go, NavTarget } from './nav';
import s from './OverviewTab.module.css';
import type { DayLine } from './today';

export interface OverviewTabProps extends BriefTabProps {
  isToday: boolean;
  /** 今日一句; undefined while it is read, null when the day has none. */
  line: DayLine | null | undefined;
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

/** The same amount as plain text, for the ⓘ. */
function amountText(meta: ItemMeta, v: number): string {
  if (meta.kind === 'min') {
    const h = Math.floor(v / 60);
    const m = Math.round(v % 60);
    return h ? `${h} 小时 ${String(m).padStart(2, '0')} 分` : `${m} 分`;
  }
  if (meta.kind === 'sec') return `${Math.round(v / 60)} 分`;
  if (meta.kind === 'usd') return `$${v.toFixed(2)}`;
  return `${+v.toFixed(1)}${meta.unit ? ` ${meta.unit}` : ''}`;
}

function Panel({ title, count, right, nav, children }: { title: string; count?: number | undefined; right?: ReactNode; nav?: string; children: ReactNode }) {
  return (
    <section className={s.pn} aria-label={title} data-nav-target={nav}>
      <SecHead title={title} count={count} right={right} />
      {children}
    </section>
  );
}

/** The daily observation brief of the day before `date`, folded to its three counts: open, the counts and first detail; 看全文 opens the list. */
function ObsBrief({ date }: { date: string }) {
  const b = useBriefs();
  const [open, setOpen] = useState(false);
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  const want = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  const r = b.reports.find((x) => x.period === 'daily' && x.date === want && x.state === 'completed');
  return (
    <div className={s.pn}>
      <Fold
        id="obs"
        variant="head"
        label="前一日观察日报"
        summary={r ? `记录 ${r.observed_details.length} │ 问题 ${r.recurring_problems.length} │ 建议 ${r.next_steps.length}` : undefined}
        autoOpen={b.list.isError}
        right={<Btn size="sm" variant="text" onClick={() => setOpen(true)}>查看全文 ›</Btn>}
      >
        <Region q={b.list} what="观察日报" reserve={{ rows: 3 }} isEmpty={() => !r} empty={{ text: '前一日无观察日报' }}>
          {() =>
            r && (
              <>
                <div className={s.yb}>
                  {([[r.observed_details.length, '观察记录'], [r.recurring_problems.length, '反复问题'], [r.next_steps.length, '建议步骤']] as const).map(([n, k]) => (
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
      </Fold>
      {open && (
        <Sheet open title="观察日报" width={480} onClose={() => setOpen(false)}>
          <BriefsSec no="01" />
        </Sheet>
      )}
    </div>
  );
}

/** Each error kind's word, and the title of a row without one. */
const ERR_KIND: Record<WireBriefError['kind'], [string, string]> = {
  task: ['任务', '未命名任务'],
  run: ['角色进程', '角色运行失败'],
  turn: ['对话', '该轮对话未能完成'],
  session: ['编码会话', '编码会话出错'],
};

/** The day's 出错, the very `/brief/day` errors the readout counts, newest first: a row opens its task, else its turn in
 *  诊断 › 对话轮次; a task's row with a trace also opens that trace. A coding session has nowhere to open. */
export function ErrorSheet({ errors, isToday, go, onClose }: { errors: WireBriefError[] | undefined; isToday: boolean; go: Go; onClose: () => void }) {
  return (
    <Sheet open title="异常记录" width={480} onClose={onClose}>
      <Region q={{ status: errors ? 'success' : 'pending', data: errors && [...errors].sort((a, b) => b.at - a.at) }} what="异常记录" reserve={{ rows: 3 }} empty={{ text: isToday ? '今日无异常记录' : '当日无异常记录' }}>
        {(list) => (
          <div className={s.rows}>
            {list.map((e) => {
              const [kind, untitled] = ERR_KIND[e.kind];
              const trace = e.trace_id ?? e.turn_id;
              const open: NavTarget | null = e.task_id ? { page: 'tasks', sel: toCanonical(e.task_id) } : trace ? { page: 'diag', tab: 'turns', turn: trace } : null;
              return (
                <div key={`${e.kind}:${e.id}:${e.at}`} className={s.er}>
                  <Row
                    height="compact"
                    category={e.task_id ? 'mission' : 'neutral'}
                    title={e.title ?? untitled}
                    sub={
                      <>
                        <span className="num">{formatClock(secToMs(e.at))}</span> │ {kind}
                        {e.reason && ` │ ${e.reason}`}
                      </>
                    }
                    data-err
                    disabled={!open}
                    onClick={() => open && go(open)}
                  />
                  {e.task_id && trace && (
                    <Btn size="sm" variant="text" onClick={() => go({ page: 'diag', tab: 'turns', turn: trace })}>
                      对话轮次 ›
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Region>
    </Sheet>
  );
}

const KIND: Record<'self' | 'reply' | 'miss', string> = { self: '主动', reply: '回你', miss: '没回' };

const reminderRow = (r: Reminder) => <Row key={r.id} height="compact" title={r.title} sub={r.triggered ? '已提醒' : '未到时间'} right={<span className="num">{formatClock(r.due_at)}</span>} />;

export function OverviewTab(p: OverviewTabProps) {
  const { day, isToday } = p;
  const sw = day.switches;
  const work = sw.agent || sw.code;
  const ids = readouts(day, p.pins);
  const her = day.her.lines[0];
  const latest = p.done?.[0];
  const lastConv = p.convs?.[0];
  const ahead = p.reminders.filter((r) => !r.triggered);
  const past = p.reminders.filter((r) => r.triggered);
  // The ones already rung fold away only when the list is longer than a fold's 3 flat rows.
  const foldPast = p.reminders.length > 3 && past.length > 0;
  return (
    <div className={s.ov} data-tab="ov">
      <Panel title={isToday ? '今日摘要' : '当日摘要'} right={p.line?.origin === 'local' ? `${isToday ? '今日' : '当日'}数据汇总，非角色生成日报` : undefined}>
        <p className={s.line} data-selectable="">
          {p.line === undefined ? '—' : (p.line?.text ?? '当日尚无日报')}
        </p>
      </Panel>
      <ul className={s.band} aria-label="读数">
        {ids.map((id) => {
          const meta = ITEMS[id];
          const it = day.items[id];
          const diff = it.avg7 == null ? null : it.today - it.avg7;
          const link = p.links[id];
          return (
            <li key={id} className={s.ro} data-item={id} data-err={(id === 'err' && it.today > 0) || undefined}>
              {link && <button type="button" className={s.hit} aria-label={`${meta.name} ${amountText(meta, it.today)}，${link.to}`} onClick={link.open} />}
              <span className={`${s.v} num`}>{amount(meta, it.today)}</span>
              <span className={s.k}>
                <span className={s.kn}>{meta.name}</span>
                {diff != null && <InfoTip label={`${meta.name}：与近 7 日均值对比`}>{`较近 7 日均值${diff < 0 ? '少' : '多'} ${amountText(meta, Math.abs(diff))}`}</InfoTip>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className={s.cols}>
        <div className={s.col}>
          {isToday && work && <div className={s.pn}>{p.pending}</div>}
          {work && (
            <div className={s.pn}>
              <Fold
                id="done"
                variant="head"
                label="已完成"
                count={p.done?.length}
                rows={p.done?.length}
                autoOpen={!!p.done?.some((x) => x.failed)}
                summary={latest && <>最近：{latest.task.title || '未命名任务'} <span className="num">{formatClock(latest.task.updated_at)}</span></>}
              >
                <Region q={{ status: p.done ? 'success' : 'pending', data: p.done }} what="已完成任务" reserve={{ rows: 3 }} empty={{ text: isToday ? '今日尚无已完成任务' : '当日无已完成任务' }}>
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
              </Fold>
            </div>
          )}
          <div className={s.pn}>
            <Fold
              id="convs"
              variant="head"
              label={isToday ? '今日对话' : '当日对话'}
              count={p.convs?.length}
              rows={p.convs?.length}
              autoOpen={p.convs === null}
              summary={lastConv && <>最近：{lastConv.title} <span className="num">{formatClock(lastConv.turns[0]?.t0 ?? lastConv.updated_at)}</span></>}
            >
              <Region q={{ status: p.convs === undefined ? 'pending' : p.convs ? 'success' : 'error', data: p.convs ?? undefined, error: p.convs === null ? new Error('未能读取对话记录') : undefined }} what="对话" reserve={{ rows: 3 }} empty={{ text: '无对话记录' }}>
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
            </Fold>
          </div>
        </div>
        <div className={s.col}>
          {isToday && work && p.running && <div className={s.pn} data-nav-target="running">{p.running}</div>}
          <Panel title="提醒" count={p.reminders.length} nav="reminders">
            {p.reminders.length ? (
              <div className={s.rows}>
                {(foldPast ? ahead : p.reminders).map(reminderRow)}
                {foldPast && (
                  <Fold id="reminded" label="已提醒" count={past.length} summary={past.map((r) => `${r.title} ${formatClock(r.due_at)}`).join(' │ ')}>
                    <div className={s.rows}>{past.map(reminderRow)}</div>
                  </Fold>
                )}
              </div>
            ) : (
              <Empty inline title={isToday ? '今日无提醒事项' : '当日无提醒事项'} />
            )}
          </Panel>
          {sw.read ? (
            <ObsBrief date={day.date} />
          ) : (
            <Panel title={isToday ? '角色今日发言' : '角色当日发言'} right={<Btn size="sm" variant="text" onClick={() => p.go('char')}>查看角色动态 ›</Btn>}>
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
                <Empty inline title={isToday ? '今日尚未发言' : '当日未见发言'} />
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
