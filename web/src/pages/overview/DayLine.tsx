import { useState } from 'react';
import { useDevMode } from '../../shell/devMode';
import { Icon, Sheet } from '../../ui';
import { BriefsSec } from '../observe/BriefsSec';
import type { DayLine as DayLineView, WireDaySummary } from './today';
import s from './DayTimeline.module.css';

function Part({ title, items }: { title: string; items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className={s.eb}>{title}</div>
      <ul className={s.items}>
        {items.map((x, i) => (
          <li key={i} data-selectable="">
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DaySheet({ d }: { d: WireDaySummary }) {
  return (
    <div className={s.sheet}>
      <p data-selectable="">{d.headline}</p>
      {d.partial && <p className={s.cap}>这一天还没过完，日报会继续更新</p>}
      {d.projects.map((p) => (
        <div key={p.project}>
          <div className={s.eb}>{p.project}</div>
          <p data-selectable="">{p.summary}</p>
          <ul className={s.items}>
            {p.tasks.map((t) => (
              <li key={t.task_id} data-selectable="">
                {t.title}：{t.progress}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <Part title="还没收尾" items={d.open_loops} />
      <Part title="明天" items={d.tomorrow} />
    </div>
  );
}

export interface DayLineProps {
  /** Undefined while it is read; null when the day has nothing to say. */
  line: DayLineView | null | undefined;
  /** The L3 day summary behind an `l3` line. */
  day: WireDaySummary | null;
}

/** 日报 in the page header: its label and title carry the L3 headline, else today's counts; it opens the day summary, or the observation briefs without one. */
export function DayLine({ line, day }: DayLineProps) {
  const [open, setOpen] = useState(false);
  const devMode = useDevMode();
  const text = line === undefined ? '—' : (line?.text ?? '这一天还没有日报');
  return (
    <>
      <button type="button" className={s.day} data-day-line={line?.origin} aria-label={`一句话日报：${text}，查看详情`} title={text} onClick={() => setOpen(true)}>
        日报
        {devMode && line && <span className={s.tag}>{line.origin === 'l3' ? '日报' : '本地计数'}</span>}
        <span className={s.go} aria-hidden="true">
          <Icon name="chev" size={14} />
        </span>
      </button>
      {open && (
        <Sheet open title="日报" width={480} onClose={() => setOpen(false)}>
          {line?.origin === 'l3' && day ? <DaySheet d={day} /> : <BriefsSec no="01" />}
        </Sheet>
      )}
    </>
  );
}
