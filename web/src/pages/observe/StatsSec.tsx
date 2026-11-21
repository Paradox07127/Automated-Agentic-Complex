import { useState } from 'react';
import { ChartState, StackedBars } from '../../charts';
import { formatDuration } from '../../domain';
import { Plate, Region, Seg, type RegionSource } from '../../ui';
import type { NowData } from './data';
import { colorOf, hoursOf, shareOf, type AppRank, type ShareItem } from './model';
import type { SpanData } from './useObserve';
import s from './Panels.module.css';

export interface StatsSecProps {
  /** 区块编号 */
  no: string;
  rank: AppRank;
  spans: SpanData | null;
  /** Screenshot quota from /diag/state; null until it is read or when sharing is off. */
  shots: NowData['screenshots'];
  q: RegionSource<unknown>;
  /** Day start; the hour bars run 08–15. */
  start: number;
  paused: boolean;
  initialView: 'hr' | 'app';
}

const HOUR = 3_600_000;

/** 应用占比：一条比例条（段间 2 px 缝）加数值表。 */
function Share({ items }: { items: ShareItem[] }) {
  const total = items.reduce((n, x) => n + x.minutes, 0) || 1;
  const aria = `应用占比：${items.map((x) => `${x.label} ${x.minutes} 分`).join('，')}`;
  return (
    <div className={s.share} role="img" aria-label={aria}>
      <div className={s.shareBar} aria-hidden="true">
        {items.map((x) => (
          <i key={x.id} style={{ flexGrow: x.minutes, background: x.color }} />
        ))}
      </div>
      <div aria-hidden="true">
        {items.map((x) => (
          <div key={x.id} className={s.shareR}>
            <i style={{ background: x.color }} />
            <span>{x.label}</span>
            <span className={s.sub}>{x.sub ?? ''}</span>
            <span className={`${s.v} num`}>{x.minutes} 分</span>
            <span className={`${s.p} num`}>{Math.round((x.minutes / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const always = () => false;

/** 前台时长（板：按小时柱需要观察事件，应用占比来自 /attention/summary）；头部读数带今日截图额度。 */
export function StatsSec(p: StatsSecProps) {
  const [view, setView] = useState<'hr' | 'app'>(p.initialView);
  const share = shareOf(p.rank);
  const total = share.reduce((n, x) => n + x.minutes, 0);
  const hourly = p.spans != null && view === 'hr';
  const top = p.rank.order.slice(0, 3);
  const cats = [
    ...top.map((k, i) => ({
      id: k,
      label: k,
      color: colorOf((i + 1) as 1 | 2 | 3),
    })),
    ...(p.rank.order.length > 3 ? [{ id: 'other', label: '其他', color: colorOf('other') }] : []),
  ];
  const sh = p.shots;
  const reserve = p.paused ? 0 : (sh?.reserved ?? 0);
  return (
    <Plate no={p.no} label="前台时长">
      <div className={s.stat}>
        <div className={s.ph}>
          <b>前台时长</b>
          {p.q.data !== undefined && total > 0 && <span className={`${s.cap} num`}>{formatDuration(total * 60_000)}</span>}
          <span className={s.sp} />
          {sh && (
            <span className={s.cap} title={`已用 ${sh.used} 张 │ 预留 ${reserve} │ 已退回 ${sh.released}`}>
              今日截图{' '}
              <span className={`${s.t1} num`}>
                {sh.used}/{sh.limit}
              </span>{' '}
              张
            </span>
          )}
          {p.spans && (
            <Seg
              size="sm"
              label="统计方式"
              value={view}
              onChange={(v) => setView(v === 'app' ? 'app' : 'hr')}
              options={[
                { value: 'hr', label: '按小时' },
                { value: 'app', label: '应用占比' },
              ]}
            />
          )}
        </div>
        <div className={s.statB}>
          <Region q={p.q} what="前台时长" reserve={{ height: 132 }} isEmpty={always}>
            {() =>
              hourly && p.spans ? (
                <StackedBars label="按小时前台分钟" buckets={hoursOf(p.spans.segs, p.rank, p.start + 8 * HOUR, p.start + 15 * HOUR)} cats={cats} h={132} fmt={(v) => String(v)} frame={false} />
              ) : (
                <ChartState state={share.length === 0 ? 'empty' : 'ok'} emptyText="今天还没有前台记录" height={132}>
                  <Share items={share} />
                </ChartState>
              )
            }
          </Region>
        </div>
      </div>
    </Plate>
  );
}
