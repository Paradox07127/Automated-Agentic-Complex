// 简报「时间」页签（屏幕感知开着才挂载）：每小时在电脑前的分钟数、暂停和提醒，读数栏，截图配额或外发前遮蔽、她开口你回了两条胶囊，应用占比和网站。
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HourArea } from '../../charts';
import { formatClock } from '../../domain';
import { readDiag } from '../settings/api';
import type { BriefTabProps } from './briefTabs';
import { Bars, Big, dayClock, Panel } from './HerTab';
import { useGo } from './nav';
import her from './HerTab.module.css';
import st from './TimeTab.module.css';

const dur = (m: number) => (
  <>
    {m >= 60 && (
      <>
        {Math.floor(m / 60)}
        <small>h</small>
      </>
    )}
    {m >= 60 ? String(m % 60).padStart(2, '0') : m}
    <small>m</small>
  </>
);

const plain = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`);

// Ink ramp of the app shares, darkest first; the fifth step is the hatch.
const INK = ['var(--ef-text-1)', 'var(--ef-ink-s1)', 'var(--ef-ink-s2)', 'var(--ef-ink-s3)', 'var(--ef-hatch)', 'var(--ef-rule)'];

/** Capsule meter of the game's power page: `ratio` 0–1 fills it, `children` is the readout. */
function Pill({ icon, label, ratio, children }: { icon: ReactNode; label: string; ratio: number; children: ReactNode }) {
  const pct = Math.round(Math.min(1, ratio) * 100);
  return (
    <div className={st.pill} role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      {icon}
      <span>{label}</span>
      <span className={st.bar} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className={st.n}>{children}</span>
    </div>
  );
}

const glyph = (d: string) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} fillRule="evenodd" />
  </svg>
);

export function TimeTab({ day }: BriefTabProps) {
  const go = useGo();
  const { items, focus, her: said } = day;
  const { hour, now } = dayClock(day);
  const diag = useQuery({ queryKey: ['settings', 'diag'], queryFn: readDiag, enabled: items.shot.enabled });
  // Daily screenshot limit; null until /diag/state is read or when agentd sends no budget.
  const limit = diag.data?.budget?.screenshots?.limit ?? null;
  // Masking has no limit: its capsule reads against the 7-day average, full at or above it.
  return (
    <div className={her.view}>
      <section className={her.power} data-theme="dark" aria-label="在电脑前">
        <div className={her.chart}>
          <HourArea
            label="每小时在电脑前的分钟数"
            name="在电脑前"
            unit="分钟 / 小时"
            hours={items.fg.hours ?? []}
            max={60}
            now={now}
            pauses={focus.pauses.map(([a, b]) => [hour(a), hour(b)])}
            marks={(items.rem.hours ?? []).flatMap((n, h) => (n ? [{ h: h + 0.5, label: `提醒 ${n} 个` }] : []))}
            tip={(v) => `在电脑前 ${v} 分钟`}
          />
          <button type="button" className={st.lk} onClick={() => go({ page: 'trace' })}>
            每段做了什么，在运行记录的今日时间线看 ›
          </button>
        </div>
        <div className={her.side}>
          <Big lead v={dur(items.fg.today)} k="在电脑前" />
          <Big v={dur(focus.away_min)} k="离开" />
          <Big v={focus.longest ? dur(focus.longest.minutes) : '—'} k={focus.longest ? `最长一段 │ ${formatClock(focus.longest.start * 1000)} 起` : '最长一段'} />
        </div>
      </section>
      <div className={st.pills}>
        {items.shot.enabled ? (
          <Pill icon={glyph('M2 2h7v3H5v4H2zM15 2h7v7h-3V5h-4zM2 15h3v4h4v3H2zM19 15h3v7h-7v-3h4zM9 9h6v6H9z')} label="截图配额" ratio={limit ? items.shot.today / limit : 0}>
            {items.shot.today}
            <small>{limit == null ? ' 张' : ` / ${limit} 张`}</small>
          </Pill>
        ) : (
          <Pill icon={glyph('M2 5h20v14H2zM5 8v8h14V8zM7 10h10v4H7z')} label="外发前遮蔽" ratio={items.mask.today / Math.max(1, items.mask.today, items.mask.avg7 ?? 0)}>
            {items.mask.today}
            <small>{` 处 │ 均值 ${items.mask.avg7 ?? '—'}`}</small>
          </Pill>
        )}
        <Pill icon={glyph('M3 3h18v13H10l-5 4v-4H3z')} label="她开口你回了" ratio={said.said.self ? said.said.replied / said.said.self : 0}>
          {said.said.replied}
          <small>{` / ${said.said.self} 次`}</small>
        </Pill>
      </div>
      <div className={focus.sites.length ? st.two : undefined}>
        <Panel tag="应用">
          <div className={st.comp} role="img" aria-label={`应用占比：${focus.apps.map((a) => `${a.name} ${a.minutes} 分钟`).join('，')}`}>
            {focus.apps.map((a, i) => (
              <i key={a.name} style={{ flex: a.minutes, background: INK[i] }} title={`${a.name} ${plain(a.minutes)}`} />
            ))}
          </div>
          <ul className={st.apps}>
            {focus.apps.map((a, i) => (
              <li key={a.name}>
                <i style={{ background: INK[i] }} />
                <span>{a.name}</span>
                <b>{plain(a.minutes)}</b>
              </li>
            ))}
          </ul>
        </Panel>
        {focus.sites.length > 0 && (
          <Panel tag="网站">
            <Bars label="网站" rows={focus.sites.map((s) => ({ key: s.host, label: s.host, value: s.minutes, readout: plain(s.minutes) }))} />
          </Panel>
        )}
      </div>
    </div>
  );
}
