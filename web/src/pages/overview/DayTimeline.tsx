import { useMemo, useState } from 'react';
import { formatClock, secToMs } from '../../domain';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { useGo } from '../../shell/nav';
import { Btn, Icon, OpenSec, Region, Sheet, type IconName, type RegionSource } from '../../ui';
import { localDate, memoriesOf, pageNow, parseEp } from '../observe/data';
import { EpisodeDetail } from '../observe/EpisodeDetail';
import { EpisodeEvidence } from '../observe/EpisodeEvidence';
import { episodeApps, rankFromSummary } from '../observe/model';
import { useActions } from '../observe/useActions';
import { useObserve } from '../observe/useObserve';
import { TIMELINE_CAP, type TimelineEntry, type TodaySource, type WireSessionSummary } from './today';
import s from './DayTimeline.module.css';

export const SOURCE: Record<TodaySource, { icon: IconName; label: string }> = {
  claude: { icon: 'tool', label: 'Claude Code' },
  codex: { icon: 'tool', label: 'Codex' },
  role: { icon: 'user', label: '角色任务' },
  own: { icon: 'bolt', label: '派发的会话' },
  app: { icon: 'grid', label: '前台' },
  web: { icon: 'hub', label: '网站' },
  chat: { icon: 'send', label: '对话' },
};

const ORIGIN: Record<TimelineEntry['origin'], string> = { l1: '会话摘要', episode: '活动片段', segment: '编码记录', conv: '对话记录' };

export interface DayTimelineProps {
  q: RegionSource<TimelineEntry[]>;
  /** The L1 rows behind `open.summary` entries. */
  summaries: readonly WireSessionSummary[];
  now: number;
  /** Section title; defaults to 今日时间线. */
  title?: string;
  /** Entries other than a session summary, which opens here. */
  onOpen: (e: TimelineEntry) => void;
}

function Entry({ e, now, onOpen }: { e: TimelineEntry; now: number; onOpen: () => void }) {
  const devMode = useDevMode();
  const src = SOURCE[e.source];
  const span = `${formatClock(e.t0)}–${e.t1 >= now ? '现在' : formatClock(e.t1)}`;
  return (
    <li>
      <button type="button" className={s.entry} data-entry={e.id} data-source={e.source} aria-label={`${span} ${src.label} ${e.title}，查看详情`} onClick={onOpen}>
        <span className={s.time}>{span}</span>
        <span className={s.src} aria-hidden="true">
          <Icon name={src.icon} size={14} />
          {src.label}
        </span>
        <span className={s.title}>{e.title}</span>
        {devMode && <span className={s.tag}>{ORIGIN[e.origin]}</span>}
        <span className={s.go} aria-hidden="true">
          <Icon name="chev" size={14} />
        </span>
      </button>
    </li>
  );
}

function SummarySheet({ row, onClose }: { row: WireSessionSummary; onClose: () => void }) {
  return (
    <Sheet open title={row.title} width={480} onClose={onClose}>
      <div className={s.sheet}>
        <p className={`${s.cap} num`}>
          {formatClock(secToMs(row.start))}–{formatClock(secToMs(row.end))}
          {row.project ? ` │ ${row.project}` : ''}
        </p>
        {row.goal && (
          <div>
            <div className={s.eb}>目标</div>
            <p data-selectable="">{row.goal}</p>
          </div>
        )}
        <div>
          <div className={s.eb}>做了什么</div>
          {row.did.length ? (
            <ul className={s.items}>
              {row.did.map((d, i) => (
                <li key={i} data-selectable="">
                  {d.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.cap}>没有记下</p>
          )}
        </div>
        <div>
          <div className={s.eb}>结果</div>
          <p data-selectable="">{row.outcome || '还没有结果'}</p>
        </div>
        {row.next_steps.length > 0 && (
          <div>
            <div className={s.eb}>下一步</div>
            <ul className={s.items}>
              {row.next_steps.map((x, i) => (
                <li key={i} data-selectable="">
                  {x}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** 今日时间线: short rows (time, source icon, title), newest first, the first 30 until 展开全部; a row opens its detail. */
export function DayTimeline({ q, summaries, now, title = '今日时间线', onOpen }: DayTimelineProps) {
  const [all, setAll] = useState(false);
  const [sum, setSum] = useState<string | null>(null);
  const open = summaries.find((r) => r.id === sum) ?? null;
  return (
    <div data-nav-target="timeline" data-g="rewards">
      <OpenSec title={title} count={q.data?.length}>
        <Region q={q} what="时间线" reserve={{ rows: 6 }} empty={{ text: '这一天还没有活动' }}>
          {(entries) => (
            <>
              <ul className={s.list}>
                {(all ? entries : entries.slice(0, TIMELINE_CAP)).map((e) => (
                  <Entry key={e.id} e={e} now={now} onOpen={() => (e.open.summary ? setSum(e.open.summary) : onOpen(e))} />
                ))}
              </ul>
              {!all && entries.length > TIMELINE_CAP && (
                <div className={s.more}>
                  <Btn size="sm" variant="text" onClick={() => setAll(true)}>
                    展开全部 {entries.length} 条
                  </Btn>
                </div>
              )}
            </>
          )}
        </Region>
      </OpenSec>
      {open && <SummarySheet row={open} onClose={() => setSum(null)} />}
    </div>
  );
}

/** One episode's detail in a sheet; `ep` is the `ep` URL value (`{id}` or `{id}@{date}`). Mounts the observe reads only while open. */
export function EpisodeSheet({ ep, onClose }: { ep: string; onClose: () => void }) {
  const flags = useDemo();
  const go = useGo();
  const ref = parseEp(ep);
  const d = useObserve(flags, ref?.date ?? localDate(pageNow()), undefined);
  const act = useActions(() => {});
  const [evidence, setEvidence] = useState<string | null>(null);
  const rank = useMemo(() => rankFromSummary(d.apps), [d.apps]);
  const e = d.episodes.find((x) => x.id === ref?.id) ?? null;
  const mems = e ? memoriesOf(d.facts, e.id) : [];
  return (
    <>
      <Sheet open title="活动片段" width={480} onClose={onClose}>
        <Region q={d.src.eps} what="活动片段" reserve={{ height: 160 }} isEmpty={() => !e} empty={{ text: '这个片段已经不在了' }}>
          {() => (
            <EpisodeDetail
              episode={e}
              apps={e ? episodeApps(e, d.spans?.segs ?? null, d.now) : []}
              memories={mems}
              rank={rank}
              now={d.now}
              onMemory={(id) => go({ page: 'memory', sel: id })}
              onExclude={act.exclude}
              onDelete={() => e && act.deleteEpisode(e, mems.length, onClose)}
              onEvidence={() => e && setEvidence(e.id)}
            />
          )}
        </Region>
      </Sheet>
      <EpisodeEvidence id={evidence} onClose={() => setEvidence(null)} />
      {act.confirmNode}
    </>
  );
}
