// 简报「她」页签：她每小时的发言叠精神和心情，今天的话、你碰她、她为什么开口，动作、新记住的事和她替你动手（或她在桌面上）。
import type { ReactNode } from 'react';
import { appNow } from '../../bridge/clock';
import { HourArea } from '../../charts';
import { formatClock } from '../../domain';
import { Btn } from '../../ui';
import type { BriefCount, BriefDay } from './briefDay';
import type { BriefTabProps } from './briefTabs';
import { useGo } from './nav';
import st from './HerTab.module.css';

const pad = (n: number) => String(n).padStart(2, '0');

/** Unix seconds → hour of `day` (0–24, fractional); `now` only while the day is still running. */
export function dayClock(day: BriefDay): { hour: (t: number) => number; now: number | undefined } {
  const day0 = new Date(`${day.date}T00:00:00`).getTime() / 1000;
  const hour = (t: number) => (t - day0) / 3600;
  return { hour, now: day.partial ? hour(appNow() / 1000) : undefined };
}

/** Dark data plate: a black tag, a rule running into a short twill, an optional action at the right. */
export function Panel({ tag, count, sub, act, className, children }: { tag: string; count?: number; sub?: ReactNode; act?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`${st.pn} ${className ?? ''}`} data-theme="dark" aria-label={tag}>
      <div className={st.ph}>
        <span className={st.tag}>
          {tag}
          {count != null && <span className={st.cnt}>[{count}]</span>}
        </span>
        <span className={st.rule} aria-hidden="true" />
        {sub && <span className={st.sub}>{sub}</span>}
        {act}
      </div>
      {children}
    </section>
  );
}

/** One big figure of the side column: yellow for the lead figure, ink for the rest. */
export function Big({ v, k, lead }: { v: ReactNode; k: string; lead?: boolean }) {
  return (
    <div className={`${st.big} ${lead ? st.lead : ''}`}>
      <span className={st.v}>{v}</span>
      <span className={st.k}>
        <i className={st.warn} aria-hidden="true" />
        {k}
      </span>
    </div>
  );
}

/** Ranked bars with the whole label: BarList's 64 px label column cuts reasons like「卡住时问要不要帮忙」. */
export function Bars({ rows, label, yellow }: { rows: Array<{ key: string; label: string; value: number; readout: string }>; label: string; yellow?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className={st.bars} role="img" aria-label={`${label}：${rows.map((r) => `${r.label} ${r.readout}`).join('，')}`}>
      {rows.map((r) => (
        <li key={r.key}>
          <span>{r.label}</span>
          <i className={yellow ? st.y : undefined} style={{ width: `${(r.value / max) * 100}%` }} />
          <b>{r.readout}</b>
        </li>
      ))}
    </ol>
  );
}

const KIND = { self: '主动', miss: '主动 │ 没回', reply: '回你' } as const;

const TOUCH: Array<{ key: keyof BriefDay['her']['touch']; label: string; d: string }> = [
  { key: 'pat', label: '摸头', d: 'M5 12V6a1.5 1.5 0 0 1 3 0v5h1V4a1.5 1.5 0 0 1 3 0v7h1V5a1.5 1.5 0 0 1 3 0v7h1V8a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-2a7 7 0 0 1-6-3.5L2 14l2-1.5z' },
  { key: 'pinch', label: '捏脸', d: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM8 8h2.2v3H8zM13.8 8H16v3h-2.2zM6.5 14.5l2-1 1.5 1.5 2-1.5 2 1.5 1.5-1.5 2 1-3.5 3h-4z' },
  { key: 'drag', label: '拖她', d: 'M12 1l4 4h-3v6h6V8l4 4-4 4v-3h-6v6h3l-4 4-4-4h3v-6H5v3l-4-4 4-4v3h6V5H8z' },
  { key: 'wheel', label: '右键轮盘', d: 'M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
];

const counted = (list: BriefCount[], unit: string) => list.map((c) => ({ key: c.key, label: c.label, value: c.count, readout: `${c.count} ${unit}` }));

export function HerTab({ day }: BriefTabProps) {
  const go = useGo();
  const { items, her } = day;
  const { hour, now } = dayClock(day);
  const hours = items.line.hours ?? [];
  const why = her.why.reduce((n, c) => n + c.count, 0);
  const tools = her.tools;
  const actBtn = (text: string, onClick: () => void) => (
    <Btn size="sm" variant="text" onClick={onClick}>
      {text} ›
    </Btn>
  );
  return (
    <div className={st.view}>
      <section className={st.power} data-theme="dark" aria-label="她这一天">
        <div className={st.chart}>
          <HourArea
            label="每小时发言和精神、心情"
            name="发言"
            unit="句 / 小时"
            hours={hours}
            max={Math.ceil(Math.max(10, ...hours) / 10) * 10}
            now={now}
            lineRange={[-0.4, 1]}
            lines={[
              { id: 'energy', label: '精神', pts: her.mood.map(([t, e]) => [hour(t), e]) },
              { id: 'mood', label: '心情', dash: true, pts: her.mood.map(([t, , v]) => [hour(t), v]) },
            ]}
            tip={(v) => `发言 ${v} 句`}
          />
        </div>
        <div className={st.side}>
          <Big
            lead
            v={
              <>
                {items.line.today}
                <small>句</small>
              </>
            }
            k={`发言 │ 主动 ${her.said.self}`}
          />
          {items.voice.enabled ? (
            <Big
              v={
                <>
                  {Math.round(items.voice.today / 60)}
                  <small>m</small>
                </>
              }
              k="出声"
            />
          ) : (
            <Big
              v={
                <>
                  {items.touch.today}
                  <small>次</small>
                </>
              }
              k="你碰她"
            />
          )}
          <Big
            v={
              <>
                {items.motion.today}
                <small>次</small>
              </>
            }
            k={her.motions[0] ? `动作 │ 最多是${her.motions[0].label}` : '动作'}
          />
        </div>
      </section>
      <div className={st.gridA}>
        <Panel tag="今天的话" count={her.lines.length} act={actBtn('在对话里看全部', () => go({ page: 'chat' }))}>
          <ul className={st.lines}>
            {her.lines.map((l) => (
              <li key={`${l.kind}${l.at}`}>
                <p>{l.text}</p>
                <footer>
                  <span className={st.kind} data-kind={l.kind}>
                    {KIND[l.kind]}
                  </span>
                  <span className={st.num}>{formatClock(l.at * 1000)}</span>
                  <span>{l.note}</span>
                </footer>
              </li>
            ))}
          </ul>
        </Panel>
        <div className={st.col}>
          <Panel tag="你碰她">
            <ul className={st.touch}>
              {TOUCH.map((t) => (
                <li key={t.key}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d={t.d} fillRule="evenodd" />
                  </svg>
                  <b className={st.num}>{her.touch[t.key]}</b>
                  <span>{t.label}</span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel tag="她为什么开口" sub={`共 ${why} 次 │ 你回了 ${her.said.replied} 次`}>
            <Bars label="她为什么开口" rows={counted(her.why, '次')} />
          </Panel>
        </div>
      </div>
      <div className={st.gridC}>
        <Panel tag="做得最多的动作">
          <Bars label="做得最多的动作" rows={counted(her.motions, '次')} yellow />
        </Panel>
        <Panel tag="新记住的事" act={actBtn('去记忆', () => go({ page: 'memory', view: 'about' }))}>
          <Big
            lead
            v={
              <>
                {items.mem.today}
                <small>条</small>
              </>
            }
            k={`近 7 天日均 ${items.mem.avg7 ?? '—'} 条`}
          />
        </Panel>
        {tools.enabled ? (
          <Panel tag="她替你动手">
            <Bars label="她替你动手" rows={counted(tools.by_name, '次')} />
            <p className={st.sub}>{`改了 ${tools.files_changed} 个文件 │ 跑了 ${Math.floor(tools.run_minutes / 60)} h ${pad(tools.run_minutes % 60)} m │ ${tools.asked} 次先问了你`}</p>
          </Panel>
        ) : (
          <Panel tag="她在桌面上">
            <Bars label="她在桌面上" rows={her.desk.map((d) => ({ key: d.key, label: d.label, value: d.minutes ?? d.count, readout: d.minutes == null ? `${d.count} 次` : `${d.minutes} m` }))} />
          </Panel>
        )}
      </div>
    </div>
  );
}
